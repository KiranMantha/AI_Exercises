const BASE_URL = () =>
  (process.env.LMSTUDIO_BASE_URL ?? "http://localhost:1234/v1").replace(/\/$/, "");
const MODEL = () =>
  process.env.LMSTUDIO_MODEL ??
  "mlx-qwen3.5-9b-claude-4.6-opus-reasoning-distilled-v2";

// Reasoning models may put <think>...</think> in message.content. It is not
// part of the answer and would pollute the history we send back, so strip it
// here, once, before anything stores the message. An unclosed trailing block
// (truncated output) is dropped too.
export function stripThink(content) {
  if (typeof content !== "string") return "";
  return content
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<think>[\s\S]*$/, "")
    .trim();
}

export async function chat({ messages, tools }) {
  const url = `${BASE_URL()}/chat/completions`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sk-lm-AMay0lHp:8ita9rzIJioOTV3TCdka",
      },
      body: JSON.stringify({
        model: MODEL(),
        messages,
        tools,
        tool_choice: "auto",
        temperature: 0,
      }),
    });
  } catch (err) {
    throw new Error(
      `Cannot reach LM Studio at ${url} (${err.cause?.code ?? err.message}). ` +
        "Start the server in LM Studio's Developer tab and load a model.",
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LM Studio returned HTTP ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  if (!choice?.message) {
    throw new Error(`Unexpected LM Studio response: ${JSON.stringify(data).slice(0, 500)}`);
  }

  const { message } = choice;
  const toolCalls = (message.tool_calls ?? []).map((call) => {
    const raw = call.function?.arguments;
    let args;
    if (raw === undefined || raw === null || raw === "") {
      args = {};
    } else if (typeof raw === "object") {
      args = raw;
    } else {
      try {
        args = JSON.parse(raw);
      } catch {
        throw new Error(
          `Invalid JSON in arguments for tool call "${call.function?.name}": ${raw}`,
        );
      }
    }
    return { id: call.id, name: call.function?.name, arguments: args };
  });

  return {
    content: stripThink(message.content),
    toolCalls,
    finishReason: choice.finish_reason,
  };
}
