import fs from "node:fs";
import path from "node:path";

// Fallback router for ambiguous or unmatched files. Talks to any
// OpenAI-compatible server (Ollama, vLLM, llama.cpp) and is only called when
// the deterministic match can't decide. Unconfigured => it throws and the
// caller falls back to the first match.
const BASE_URL = process.env.ROUTER_BASE_URL ?? "http://localhost:11434/v1";
const MODEL = process.env.ROUTER_MODEL;
const TIMEOUT_MS = Number(process.env.ROUTER_TIMEOUT_MS ?? 60_000);
const SAMPLE_BYTES = 500;

function sampleOf(filePath) {
  const buf = Buffer.alloc(SAMPLE_BYTES);
  const fd = fs.openSync(filePath, "r");
  const n = fs.readSync(fd, buf, 0, SAMPLE_BYTES, 0);
  fs.closeSync(fd);
  // Binary files have nothing useful to show the model.
  return buf.subarray(0, n).includes(0) ? "(binary)" : buf.subarray(0, n).toString("utf8");
}

// Returns the chosen agent name, or "none".
export async function chooseAgentWithLLM(filePath, agents) {
  if (!MODEL) throw new Error("ROUTER_MODEL is not set");
  const names = [...agents.map((a) => a.name), "none"];

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.ROUTER_API_KEY && {
        authorization: `Bearer ${process.env.ROUTER_API_KEY}`,
      }),
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            "Pick the agent that should read this document, or \"none\" if no agent fits.",
            `Reply with JSON only: {"agent": <one of ${JSON.stringify(names)}>, "reason": <short>}.`,
            "",
            "Agents:",
            ...agents.map((a) => `- ${a.name}: ${a.description}`),
            "",
            `File: ${path.basename(filePath)}`,
            `Size: ${fs.statSync(filePath).size} bytes`,
            `Start of file:\n${sampleOf(filePath)}`,
          ].join("\n"),
        },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`router LLM ${res.status}: ${await res.text()}`);

  const { choices } = await res.json();
  const { agent, reason } = JSON.parse(choices[0].message.content);
  if (!names.includes(agent)) throw new Error(`router LLM returned unknown agent "${agent}"`);
  console.error(`LLM router: ${path.basename(filePath)} -> ${agent} (${reason})`);
  return agent;
}
