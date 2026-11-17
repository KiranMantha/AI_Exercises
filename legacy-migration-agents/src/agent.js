import { chat as defaultChat } from "./llm.js";
import { toolSchemas, toolImpls } from "./tools.js";

export const MAX_STEPS = 6;

export const SYSTEM_PROMPT =
  "You are a research assistant with web access. Always call web_search first. " +
  "If the search snippets are not enough to answer, call fetch_page on the most relevant result. " +
  "Answer concisely and include the source URLs you used.";

async function runTool(call) {
  const impl = toolImpls[call.name];
  if (!impl) {
    return `Error: unknown tool "${call.name}". Available tools: ${Object.keys(toolImpls).join(", ")}.`;
  }
  try {
    return String(await impl(call.arguments ?? {}));
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

export async function runAgent(question, { onStep, chat = defaultChat } = {}) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: question },
  ];

  for (let step = 0; step < MAX_STEPS; step++) {
    const { content, toolCalls } = await chat({ messages, tools: toolSchemas });

    if (toolCalls.length === 0) return content;

    messages.push({
      role: "assistant",
      content,
      tool_calls: toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      })),
    });

    for (const call of toolCalls) {
      onStep?.({ step: step + 1, name: call.name, arguments: call.arguments });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: await runTool(call),
      });
    }
  }

  throw new Error(`Agent did not produce a final answer within ${MAX_STEPS} steps.`);
}
