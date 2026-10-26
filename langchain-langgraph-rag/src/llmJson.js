// Pull a JSON object out of model output. Reasoning models put thinking in
// <think> blocks, and some wrap the JSON in a code fence or prose.
export function extractJson(content) {
  const withoutThinking = (content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "");
  const json = withoutThinking.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error("model returned no JSON");
  return JSON.parse(json);
}

// With structured output, some servers (LM Studio with reasoning models)
// return the JSON in reasoning_content and leave content empty.
export function structuredOutputText({ content, reasoning_content: reasoningContent }) {
  return content?.trim() ? content : reasoningContent;
}
