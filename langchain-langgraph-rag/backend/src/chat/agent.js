import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { createLogger, loggedNode } from "../logger.js";
import { asksForJudgment } from "./route.js";
import { checkInput, checkOutput, cleanAnswer, sanitizeHistory } from "../guardrails/index.js";
import {
  AGENT_PROMPT_VERSION,
  buildAgentSystemPrompt,
  CITATION_REPAIR_MESSAGE,
  REFUSALS,
  TOOL_BUDGET_SPENT_MESSAGE,
  TOOL_LIMIT_REPLY,
  buildAgentQuestion,
  renderSources,
} from "../systemPrompts/index.js";

const logger = createLogger("chat");

// Model-driven retrieval: the chat model is an MCP client. It decides which
// document tools to call and with what, reads the results, and may search
// again with different words before answering. Around that loop sit the same
// guarantees as the fixed pipeline: an input guard, validated and budgeted
// tool calls, and an output check that every citation points at a result the
// tools actually returned this turn.

const MAX_ROUNDS = Number(process.env.CHAT_MAX_ROUNDS ?? 5);
const MAX_TOOL_CALLS = Number(process.env.CHAT_MAX_TOOL_CALLS ?? 6);
const EXCERPT_CHARS = 400;

const replace = { reducer: (_previous, next) => next };
const append = { reducer: (existing, incoming) => existing.concat(incoming), default: () => [] };

const AgentState = Annotation.Root({
  message: Annotation({ ...replace, default: () => "" }),
  history: Annotation({ ...replace, default: () => [] }),
  // The tool-use part of the conversation: assistant turns with tool calls
  // and the tool results that answered them.
  conversation: Annotation(append),
  // Every chunk the tools returned this turn, numbered in order of first
  // appearance. The number is what the model cites.
  sources: Annotation({ ...replace, default: () => [] }),
  pending: Annotation({ ...replace, default: () => [] }),
  // Set when the answer failed only on citations and the model gets one chance
  // to add them.
  repairs: Annotation({ ...replace, default: () => 0 }),
  repairing: Annotation({ ...replace, default: () => false }),
  rounds: Annotation({ ...replace, default: () => 0 }),
  toolLog: Annotation(append),
  usage: Annotation(append),
  answer: Annotation({ ...replace, default: () => "" }),
  cited: Annotation({ ...replace, default: () => [] }),
  status: Annotation({ ...replace, default: () => "answered" }),
  reason: Annotation({ ...replace, default: () => null }),
  layer: Annotation({ ...replace, default: () => null }),
});

const LAYERS = {
  invalid_input: "input_guard",
  blocked_input: "input_guard",
  ungrounded: "output_guard",
  llm_error: "llm_error",
};

const refuse = (reason, status = "refused", layer = LAYERS[reason] ?? null) => ({
  status,
  reason,
  layer,
  answer: REFUSALS[reason],
  cited: [],
});

const excerptOf = (text) =>
  text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS).trimEnd()}...` : text;

/**
 * mcp:  { tools: [OpenAI function definitions], call(name, args) -> MCP result }
 * llm:  { completeWithTools(messages, tools, onUsage) -> { content, toolCalls } }
 * Both are injected so the guard paths can be tested without a server or model.
 */
export function createAgentGraph({ mcp, llm, maxRounds = MAX_ROUNDS, maxToolCalls = MAX_TOOL_CALLS }) {
  const toolNames = new Set(mcp.tools.map((tool) => tool.function.name));

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

  // One model turn. Out of rounds, it gets no tools and is told to finish.
  const agent = async (state) => {
    const canUseTools = state.rounds < maxRounds;
    const messages = [
      { role: "system", content: buildAgentSystemPrompt({ judgment: asksForJudgment(state.message) }) },
      ...state.history,
      { role: "user", content: buildAgentQuestion(state.message) },
      ...state.conversation,
      ...(canUseTools
        ? []
        : [{ role: "user", content: TOOL_BUDGET_SPENT_MESSAGE }]),
    ];
    try {
      const { result, usage } = await timed(`agent_${state.rounds + 1}`, (onUsage) =>
        llm.completeWithTools(messages, canUseTools ? mcp.tools : [], onUsage),
      );
      const calls = canUseTools ? result.toolCalls.map((call, index) => ({
        ...call,
        id: call.id || `call_${state.rounds}_${index}`,
      })) : [];
      return {
        rounds: state.rounds + 1,
        repairing: false,
        usage: [usage],
        pending: calls,
        answer: calls.length ? "" : result.content,
        conversation: calls.length
          ? [
              {
                role: "assistant",
                content: result.content,
                tool_calls: calls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: call.arguments },
                })),
              },
            ]
          : [],
      };
    } catch (error) {
      logger.warn("llm.failed", { stage: "agent", round: state.rounds + 1, error });
      return refuse("llm_error", "error");
    }
  };

  // Execute the model's tool calls. Every call is validated and counted: the
  // model chooses the arguments, so nothing it sends is trusted.
  const runTools = async (state) => {
    const sources = [...state.sources];
    const numberOf = new Map(sources.map((source) => [source.id, source.n]));
    const seen = new Set(state.toolLog.map((entry) => entry.key));
    let made = state.toolLog.filter((entry) => entry.executed).length;
    const log = [];
    const toolMessages = [];

    // A passage keeps its number for the whole turn. One the model has
    // already been given is marked repeated, so it is not sent again: the
    // context grows with every round, and resending is most of the cost.
    const register = (chunk) => {
      const repeated = numberOf.has(chunk.id);
      if (!repeated) {
        sources.push({ ...chunk, n: sources.length + 1 });
        numberOf.set(chunk.id, sources.length);
      }
      return { ...chunk, n: numberOf.get(chunk.id), repeated };
    };

    for (const call of state.pending) {
      const entry = { round: state.rounds, name: call.name, args: null, executed: false, returned: 0 };
      const reply = async () => {
        if (!toolNames.has(call.name))
          return `Error: unknown tool "${call.name}". Available tools: ${[...toolNames].join(", ")}.`;
        let args;
        try {
          args = JSON.parse(call.arguments || "{}");
          if (args === null || typeof args !== "object" || Array.isArray(args)) throw new Error();
        } catch {
          return "Error: tool arguments must be a JSON object.";
        }
        entry.args = args;
        entry.key = `${call.name}:${JSON.stringify(args)}`;
        if (seen.has(entry.key)) return "You already made this exact call. Its results are above; do not repeat it.";
        if (made >= maxToolCalls)
          return TOOL_LIMIT_REPLY;
        seen.add(entry.key);
        made++;
        entry.executed = true;
        try {
          const result = await mcp.call(call.name, args);
          return toModel(result, register, entry);
        } catch (error) {
          entry.error = error.message;
          return `Error: ${error.message}`;
        }
      };
      const startedAt = performance.now();
      toolMessages.push({ role: "tool", tool_call_id: call.id, content: await reply() });
      logger.info("tool.call", {
        round: entry.round,
        tool: entry.name,
        argument_names: entry.args ? Object.keys(entry.args) : null,
        executed: entry.executed,
        returned: entry.returned,
        repeated: entry.repeated,
        error: entry.error,
        duration_ms: Math.round(performance.now() - startedAt),
      });
      log.push(entry);
    }
    return { sources, pending: [], conversation: toolMessages, toolLog: log };
  };

  const verify = (state) => {
    if (state.status === "error") return {};
    const verdict = checkOutput(state.answer, state.sources, { allowGapOpening: asksForJudgment(state.message) });
    // A correct answer that forgot its citations is worth one retry. Anything
    // that looks like manipulation (invented links, images) is not.
    const fixable = verdict.detail === "no_citation" || verdict.detail === "bad_citation";
    if (!verdict.ok && fixable && state.sources.length > 0 && state.repairs < 1)
      return {
        repairs: state.repairs + 1,
        repairing: true,
        conversation: [
          { role: "assistant", content: state.answer },
          { role: "user", content: CITATION_REPAIR_MESSAGE },
        ],
      };
    if (!verdict.ok)
      return refuse(verdict.reason, "refused", verdict.reason === "no_context" ? "model_refusal" : "output_guard");
    return { answer: cleanAnswer(verdict.text), cited: verdict.cited };
  };

  const stage = (name, node, summarize) => loggedNode(logger, name, node, summarize);

  return new StateGraph(AgentState)
    .addNode("guardInput", stage("guard_input", guardInput, (update) => ({ allowed: update.status !== "refused", reason: update.reason })))
    .addNode(
      "agent",
      stage("agent_turn", agent, (update, state) => ({
        round: update.rounds,
        tool_calls_requested: update.pending?.length,
        answered: update.pending?.length === 0,
        status: update.status,
        tools_allowed: state.rounds < maxRounds,
      })),
    )
    .addNode("tools", stage("tools", runTools, (update) => ({ sources_total: update.sources.length })))
    .addNode(
      "verify",
      stage("verify", verify, (update) => ({
        status: update.status,
        reason: update.reason,
        layer: update.layer,
        citations: update.cited,
        citation_repair: update.repairing || undefined,
      })),
    )
    .addEdge(START, "guardInput")
    .addConditionalEdges("guardInput", (state) => (state.status === "refused" ? END : "agent"), ["agent", END])
    .addConditionalEdges(
      "agent",
      (state) => {
        if (state.status === "error") return END;
        return state.pending.length > 0 ? "tools" : "verify";
      },
      ["tools", "verify", END],
    )
    .addEdge("tools", "agent")
    .addConditionalEdges("verify", (state) => (state.repairing ? "agent" : END), ["agent", END])
    .compile();
}

// Turn an MCP tool result into what the model reads: numbered, delimited
// sources for passages, plain text otherwise. Registers the chunks it sees.
function toModel(result, register, entry) {
  const text = (result.content ?? []).map((part) => part.text ?? "").join("\n");
  if (result.isError) {
    entry.error = text;
    return `Error: ${text}`;
  }
  const data = result.structuredContent;
  const passages = data?.results ?? data?.chunks;
  if (!passages) return text;
  const shown = passages.map((chunk) => register(chunk));
  entry.returned = shown.length;
  entry.repeated = shown.filter((chunk) => chunk.repeated).length;
  if (shown.length === 0) return "No relevant passages found.";
  if (entry.repeated === shown.length)
    return renderSources(shown) + "\nEvery passage was already returned by an earlier call. Try different wording, read a page, or answer.";
  return (
    renderSources(shown) +
    (data.truncated ? "\n(Output was cut. Read a specific page for the rest.)" : "") +
    (data.hasMore ? `\n(More results are available: call search_docs again with a larger offset.)` : "")
  );
}

const sum = (entries, key) => entries.reduce((total, entry) => total + (entry[key] ?? 0), 0);

// What the API returns: same shape as the fixed pipeline, plus the tool calls.
export async function runAgentChat(graph, { message, history }) {
  const state = await graph.invoke({ message, history }, { recursionLimit: 60 });
  return {
    status: state.status,
    answer: state.answer,
    reason: state.reason,
    enforcementLayer: state.layer,
    mode: "agent",
    promptVersion: AGENT_PROMPT_VERSION,
    rounds: state.rounds,
    toolCalls: state.toolLog.map(({ round, name, args, returned, repeated, error }) => ({
      round,
      name,
      args,
      returned,
      repeated,
      error,
    })),
    usage: {
      calls: state.usage.length,
      promptTokens: sum(state.usage, "promptTokens"),
      completionTokens: sum(state.usage, "completionTokens"),
      cachedTokens: sum(state.usage, "cachedTokens"),
      stages: state.usage,
    },
    sources: state.sources.map((source) => ({
      id: source.n,
      source: source.source,
      section: source.section ?? null,
      page: source.page ?? null,
      score: source.score ?? 0,
      excerpt: excerptOf(source.text),
      cited: state.cited.includes(source.n),
    })),
  };
}
