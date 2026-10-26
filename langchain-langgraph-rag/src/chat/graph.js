import { createLogger, loggedNode } from "../logger.js";
import { asksForJudgment } from "./route.js";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { checkInput, checkOutput, cleanAnswer, sanitizeHistory } from "../guardrails/index.js";
import {
  CITATION_REPAIR_MESSAGE,
  PROMPT_VERSION,
  REFUSALS,
  RERANK_SCHEMA,
  REWRITE_SCHEMA,
  buildSystemPrompt,
  buildRerankMessages,
  buildRewriteMessages,
  buildUserMessage,
} from "../systemPrompts/index.js";

const MAX_SOURCES = Number(process.env.CHAT_MAX_SOURCES ?? 5);
const EXCERPT_CHARS = 400;
const SHORT_FOLLOW_UP_WORDS = 4;
// Second-stage (LLM) reranking, for questions the cheap reranker rejected but
// that are not obviously off-topic. Both are deployment settings; calibrate
// the floor with `pnpm eval:retrieval --target 0.99` (a recall-oriented bound).
const ADJUDICATE_BELOW = Number(process.env.RERANK_REJECT_BELOW ?? -Infinity);
const ADJUDICATE_CANDIDATES = Number(process.env.CHAT_RERANK_CANDIDATES ?? 8);
// When the model finds nothing helpful, retry once with alternative search
// queries (the documents may use different words than the user).
const QUERY_REWRITE = process.env.CHAT_QUERY_REWRITE !== "false";
const MAX_REWRITES = 3;
const MAX_REWRITE_CHARS = 200;

const replace = { reducer: (_previous, next) => next };

const ChatState = Annotation.Root({
  message: Annotation({ ...replace, default: () => "" }),
  history: Annotation({ ...replace, default: () => [] }),
  results: Annotation({ ...replace, default: () => [] }),
  // Every reranked candidate before the relevance gate, best first.
  candidates: Annotation({ ...replace, default: () => [] }),
  // Who decided the sources: "gate" (cheap reranker) or "llm" (second stage).
  rerankedBy: Annotation({ ...replace, default: () => "gate" }),
  rewritten: Annotation({ ...replace, default: () => false }),
  // The answer model itself said the sources do not cover the question.
  modelRefused: Annotation({ ...replace, default: () => false }),
  // One chance to add missing citations: the failed answer and the request.
  repairs: Annotation({ ...replace, default: () => 0 }),
  repairing: Annotation({ ...replace, default: () => false }),
  repairMessages: Annotation({ ...replace, default: () => [] }),
  answer: Annotation({ ...replace, default: () => "" }),
  cited: Annotation({ ...replace, default: () => [] }),
  // "answered" | "refused" | "error"
  status: Annotation({ ...replace, default: () => "answered" }),
  reason: Annotation({ ...replace, default: () => null }),
  // Which layer produced a refusal: input_guard | relevance_gate | llm_rerank |
  // model_refusal | output_guard | llm_error. Null for answers.
  layer: Annotation({ ...replace, default: () => null }),
  // How the answer was produced: "llm" | "extractive", or null when no answer
  // was composed (a refusal).
  mode: Annotation({ ...replace, default: () => null }),
  // One entry per model call: { stage, ms, promptTokens, completionTokens, cachedTokens }.
  usage: Annotation({
    reducer: (existing, incoming) => existing.concat(incoming),
    default: () => [],
  }),
});

const REFUSAL_LAYERS = {
  invalid_input: "input_guard",
  blocked_input: "input_guard",
  ungrounded: "output_guard",
  llm_error: "llm_error",
};

const refuse = (reason, status = "refused", layer = REFUSAL_LAYERS[reason] ?? null) => ({
  status,
  reason,
  layer,
  answer: REFUSALS[reason],
  cited: [],
});

const excerptOf = (text) =>
  text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS).trimEnd()}...` : text;

// A short follow-up ("and refunds?") has too little signal to retrieve on, so
// borrow the previous question.
function retrievalQuery(message, history) {
  const wordCount = message.split(/\s+/).length;
  const previousQuestion = history.filter((turn) => turn.role === "user").at(-1)?.content;
  return wordCount < SHORT_FOLLOW_UP_WORDS && previousQuestion
    ? `${previousQuestion} ${message}`
    : message;
}

// The model's proposed queries are search input, nothing more: keep a few
// short, distinct strings.
function cleanQueries(queries, original) {
  if (!Array.isArray(queries)) return [];
  const seen = new Set([original.toLowerCase()]);
  const kept = [];
  for (const query of queries) {
    const text = typeof query === "string" ? query.trim() : "";
    if (text.length < 3 || text.length > MAX_REWRITE_CHARS || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    kept.push(text);
  }
  return kept.slice(0, MAX_REWRITES);
}

const log = createLogger("chat");

const chunkIds = (chunks) => chunks.map((chunk) => chunk.id);

/**
 * The chat flow. `search(query, maxResults)` returns { results, candidates }:
 * the chunks that passed the relevance gate and every reranked candidate.
 * `llm` is { isConfigured(), complete(messages, onUsage), completeJson(messages,
 * name, schema, onUsage) }. Both are injected so the guard paths can be tested
 * without a database or a model.
 */
export function createChatGraph({
  search,
  llm,
  adjudicateBelow = ADJUDICATE_BELOW,
  adjudicateCandidates = ADJUDICATE_CANDIDATES,
  queryRewrite = QUERY_REWRITE,
}) {
  // Run one model call and record its latency and token usage.
  async function timed(stage, call) {
    const started = Date.now();
    let tokens;
    const result = await call((usage) => {
      tokens = usage;
    });
    return { result, usage: { stage, ms: Date.now() - started, ...tokens } };
  }

  const guardInput = (state) => {
    const verdict = checkInput(state.message);
    return verdict.ok
      ? { message: verdict.text, history: sanitizeHistory(state.history) }
      : refuse(verdict.reason);
  };

  const retrieve = async (state) =>
    search(retrievalQuery(state.message, state.history), MAX_SOURCES);

  // Cascade: the cheap gate decides when it is confident. When it rejects
  // everything but the best candidate is not obviously irrelevant, a model
  // reads the top candidates and picks the ones that help. It returns ids
  // only, validated against the list.
  const adjudicate = async (state) => {
    const pool = state.candidates.slice(0, adjudicateCandidates);
    try {
      const { result, usage } = await timed(state.rewritten ? "rerank_retry" : "rerank", (onUsage) =>
        llm.completeJson(
          buildRerankMessages(state.message, pool, { judgment: asksForJudgment(state.message) }),
          "relevant_passages",
          RERANK_SCHEMA,
          onUsage,
        ),
      );
      const ids = [...new Set(result.relevant)].filter(
        (id) => Number.isInteger(id) && id >= 1 && id <= pool.length,
      );
      return {
        rerankedBy: "llm",
        results: ids.slice(0, MAX_SOURCES).map((id) => pool[id - 1]),
        usage: [usage],
      };
    } catch (error) {
      log.warn("llm.failed", { stage: "rerank", error });
      return refuse("llm_error", "error");
    }
  };

  // The model found nothing helpful in what the first search returned. Ask it
  // for alternative queries, search again, and offer only chunks it has not
  // already seen. Best effort: any failure just ends in the normal refusal.
  const rewrite = async (state) => {
    // Chunks the models have already looked at are not offered again.
    const seen = new Set(
      [...state.results, ...state.candidates.slice(0, adjudicateCandidates)].map((chunk) => chunk.id),
    );
    // Start the retry from a clean slate: a refusal here is not final yet.
    const reset = {
      status: "answered",
      reason: null,
      layer: null,
      answer: "",
      cited: [],
      results: [],
      repairs: 0,
      repairing: false,
      repairMessages: [],
    };
    try {
      const { result, usage } = await timed("rewrite", (onUsage) =>
        llm.completeJson(buildRewriteMessages(state.message, { judgment: asksForJudgment(state.message) }), "alternative_queries", REWRITE_SCHEMA, onUsage),
      );
      const queries = cleanQueries(result.queries, state.message);
      const found = await Promise.all(queries.map((query) => search(query, MAX_SOURCES)));
      const fresh = new Map();
      for (const { candidates } of found)
        for (const chunk of candidates)
          if (!seen.has(chunk.id) && (fresh.get(chunk.id)?.score ?? -Infinity) < chunk.score)
            fresh.set(chunk.id, chunk);
      return {
        ...reset,
        rewritten: true,
        candidates: [...fresh.values()].sort((first, second) => second.score - first.score),
        usage: [usage],
      };
    } catch (error) {
      log.warn("llm.failed", { stage: "rewrite", error });
      return { ...reset, rewritten: true, candidates: [] };
    }
  };

  // No relevant chunks means no answer call: the reply is a fixed refusal.
  const noContext = (state) =>
    refuse(
      "no_context",
      "refused",
      state.modelRefused ? "model_refusal" : state.rerankedBy === "llm" ? "llm_rerank" : "relevance_gate",
    );

  const extractiveAnswer = (state) => ({
    mode: "extractive",
    cited: state.results.slice(0, 3).map((_result, index) => index + 1),
    answer: state.results
      .slice(0, 3)
      .map((result, index) => {
        const title = [result.source, result.section].filter(Boolean).join(" > ");
        return `**${title}** [${index + 1}]\n\n${excerptOf(result.text)}`;
      })
      .join("\n\n---\n\n"),
  });

  const composeAnswer = async (state) => {
    try {
      const { result: answer, usage } = await timed("compose", (onUsage) =>
        llm.complete(
          [
            { role: "system", content: buildSystemPrompt({ judgment: asksForJudgment(state.message) }) },
            ...state.history,
            { role: "user", content: buildUserMessage(state.message, state.results) },
            ...state.repairMessages,
          ],
          onUsage,
        ),
      );
      return { answer, mode: "llm", repairing: false, usage: [usage] };
    } catch (error) {
      log.warn("llm.failed", { stage: "compose", error });
      return refuse("llm_error", "error");
    }
  };

  const verifyAnswer = (state) => {
    if (state.status === "error") return {};
    const verdict = checkOutput(state.answer, state.results, { allowGapOpening: asksForJudgment(state.message) });
    // A correct answer that forgot its citations is worth one retry. Anything
    // that looks like manipulation (invented links, images) is not.
    const fixable = verdict.detail === "no_citation" || verdict.detail === "bad_citation";
    if (!verdict.ok && fixable && state.results.length > 0 && state.repairs < 1)
      return {
        repairs: state.repairs + 1,
        repairing: true,
        repairMessages: [
          { role: "assistant", content: state.answer },
          { role: "user", content: CITATION_REPAIR_MESSAGE },
        ],
      };
    if (!verdict.ok) {
      const modelRefused = verdict.reason === "no_context";
      return {
        ...refuse(verdict.reason, "refused", modelRefused ? "model_refusal" : "output_guard"),
        modelRefused,
      };
    }
    return { answer: cleanAnswer(verdict.text), cited: verdict.cited };
  };

  const refusalSummary = (update) => ({ status: update.status, reason: update.reason, layer: update.layer });
  const stage = (name, node, summarize) => loggedNode(log, name, node, summarize);

  return new StateGraph(ChatState)
    .addNode("guardInput", stage("guard_input", guardInput, (update) => ({ allowed: update.status !== "refused", reason: update.reason })))
    .addNode(
      "retrieve",
      stage("retrieve", retrieve, (update) => ({
        kept: update.results.length,
        candidates: update.candidates.length,
        best_score: update.candidates[0] && Number(update.candidates[0].score.toFixed(2)),
        kept_chunk_ids: chunkIds(update.results),
      })),
    )
    .addNode(
      "adjudicate",
      stage("adjudicate", adjudicate, (update) => ({
        reranked_by: update.rerankedBy,
        kept: update.results?.length,
        kept_chunk_ids: update.results && chunkIds(update.results),
        status: update.status,
      })),
    )
    .addNode(
      "rewrite",
      stage("rewrite", rewrite, (update) => ({ fresh_candidates: update.candidates.length })),
    )
    .addNode("noContext", stage("no_context", noContext, refusalSummary))
    .addNode("extractive", stage("extractive", extractiveAnswer, (update) => ({ cited: update.cited })))
    .addNode("compose", stage("compose", composeAnswer, (update) => ({ answer_chars: update.answer?.length, status: update.status })))
    .addNode(
      "verify",
      stage("verify", verifyAnswer, (update) => ({
        status: update.status,
        reason: update.reason,
        layer: update.layer,
        citations: update.cited,
        citation_repair: update.repairing || undefined,
      })),
    )
    .addEdge(START, "guardInput")
    .addConditionalEdges("guardInput", (state) => (state.status === "refused" ? END : "retrieve"), [
      "retrieve",
      END,
    ])
    .addConditionalEdges(
      "retrieve",
      (state) => {
        if (state.results.length > 0) return llm.isConfigured() ? "compose" : "extractive";
        const best = state.candidates[0]?.score;
        const uncertain = llm.isConfigured() && best !== undefined && best >= adjudicateBelow;
        return uncertain ? "adjudicate" : "noContext";
      },
      ["noContext", "compose", "extractive", "adjudicate"],
    )
    .addConditionalEdges(
      "adjudicate",
      (state) => {
        if (state.status === "error") return END;
        if (state.results.length > 0) return "compose";
        return queryRewrite && !state.rewritten ? "rewrite" : "noContext";
      },
      ["compose", "rewrite", "noContext", END],
    )
    .addConditionalEdges(
      "rewrite",
      (state) => (state.candidates.length > 0 ? "adjudicate" : "noContext"),
      ["adjudicate", "noContext"],
    )
    .addEdge("noContext", END)
    .addEdge("extractive", END)
    .addEdge("compose", "verify")
    // The model said "not in the documents" although the search returned
    // something: the search may have missed the right wording. Retry once.
    .addConditionalEdges(
      "verify",
      (state) => {
        if (state.repairing) return "compose";
        return state.layer === "model_refusal" && queryRewrite && !state.rewritten ? "rewrite" : END;
      },
      ["compose", "rewrite", END],
    )
    .compile();
}

const sum = (entries, key) => entries.reduce((total, entry) => total + (entry[key] ?? 0), 0);

// What the API returns: the outcome, the sources behind it, and the telemetry
// to explain it (which layer refused, which prompt, how many tokens).
export async function runChat(graph, { message, history }) {
  const state = await graph.invoke({ message, history });
  return {
    status: state.status,
    answer: state.answer,
    reason: state.reason,
    enforcementLayer: state.layer,
    mode: state.mode,
    rerankedBy: state.rerankedBy,
    rewritten: state.rewritten,
    promptVersion: PROMPT_VERSION,
    usage: {
      calls: state.usage.length,
      promptTokens: sum(state.usage, "promptTokens"),
      completionTokens: sum(state.usage, "completionTokens"),
      cachedTokens: sum(state.usage, "cachedTokens"),
      stages: state.usage,
    },
    sources: state.results.map((result, index) => ({
      id: index + 1,
      source: result.source,
      section: result.section ?? null,
      page: result.page ?? null,
      score: Number(result.score?.toFixed?.(3) ?? 0),
      excerpt: excerptOf(result.text),
      cited: state.cited.includes(index + 1),
    })),
  };
}
