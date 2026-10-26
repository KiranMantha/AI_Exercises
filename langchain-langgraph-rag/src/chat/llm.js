import { extractJson, structuredOutputText } from "../llmJson.js";
import { createLogger, elapsedMs } from "../logger.js";

const log = createLogger("llm");

// Small chat model behind any OpenAI-compatible endpoint. Unset => the chat
// graph falls back to returning cited excerpts instead of a composed answer.
const BASE_URL = process.env.CHAT_BASE_URL;
const MODEL = process.env.CHAT_MODEL;
const TIMEOUT_MS = Number(process.env.CHAT_TIMEOUT_MS ?? 60_000);
// Optional: some small/reasoning models reject these parameters, so they are
// only sent when set.
const TEMPERATURE = process.env.CHAT_TEMPERATURE;
const MAX_TOKENS = process.env.CHAT_MAX_TOKENS;

// Token accounting for cost visibility. Cached-token counts are reported by
// providers that support prompt caching.
function normalizeUsage(usage) {
  if (!usage) return undefined;
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens,
  };
}

async function request(messages, responseFormat, onUsage, extraBody = {}) {
  const startedAt = performance.now();
  const kind = responseFormat ? "json" : extraBody.tools ? "tools" : "text";
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.CHAT_API_KEY && {
        authorization: `Bearer ${process.env.CHAT_API_KEY}`,
      }),
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      ...(responseFormat && { response_format: responseFormat }),
      ...extraBody,
      ...(TEMPERATURE && { temperature: Number(TEMPERATURE) }),
      ...(MAX_TOKENS && { max_tokens: Number(MAX_TOKENS) }),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    log.error("call.failed", { model: MODEL, kind, http_status: response.status, duration_ms: elapsedMs(startedAt) });
    throw new Error(`chat LLM ${response.status}: ${await response.text()}`);
  }
  const { choices, usage } = await response.json();
  const normalized = normalizeUsage(usage);
  log.info("call", {
    model: MODEL,
    kind,
    messages: messages.length,
    prompt_tokens: normalized?.promptTokens,
    completion_tokens: normalized?.completionTokens,
    cached_tokens: normalized?.cachedTokens,
    duration_ms: elapsedMs(startedAt),
  });
  onUsage?.(normalized);
  return choices[0].message;
}

export const chatLlm = {
  isConfigured: () => Boolean(BASE_URL && MODEL),

  // `onUsage` (optional) receives { promptTokens, completionTokens, cachedTokens }.
  async complete(messages, onUsage) {
    const message = await request(messages, undefined, onUsage);
    return stripThinking(message.content);
  },

  // One turn of a tool-using conversation. Returns the model's text (thinking
  // removed) and the tool calls it asked for, with arguments still as the JSON
  // string the model wrote, so the caller validates them.
  async completeWithTools(messages, tools, onUsage) {
    const message = await request(messages, undefined, onUsage, tools?.length ? { tools, tool_choice: "auto" } : {});
    return {
      content: stripThinking(message.content),
      toolCalls: (message.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function?.name,
        arguments: call.function?.arguments ?? "{}",
      })),
    };
  },

  // A call whose answer must be JSON matching `schema` (structured output).
  async completeJson(messages, name, schema, onUsage) {
    const message = await request(
      messages,
      { type: "json_schema", json_schema: { name, strict: true, schema } },
      onUsage,
    );
    return extractJson(structuredOutputText(message));
  },
};

// Reasoning models may inline their thinking in <think> blocks (some servers
// split it into reasoning_content instead). Users must only ever see the final
// answer, so thinking is dropped here. An unclosed block means the model ran
// out of tokens mid-thought, so there is no answer at all.
export function stripThinking(content) {
  const text = (content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "");
  return text.includes("<think>") ? "" : text.trim();
}
