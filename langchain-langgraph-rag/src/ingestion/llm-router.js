import fs from "node:fs";
import path from "node:path";

// Fallback router for ambiguous or unmatched files. Talks to any
// OpenAI-compatible endpoint (a cloud provider, or a self-hosted server) and
// is only called when the deterministic match can't decide. Both variables
// must be set; otherwise it throws and the caller falls back to the first
// match.
const BASE_URL = process.env.ROUTER_BASE_URL;
const MODEL = process.env.ROUTER_MODEL;
const TIMEOUT_MS = Number(process.env.ROUTER_TIMEOUT_MS ?? 60_000);
const SAMPLE_BYTES = 500;

function sampleOf(filePath) {
  const buffer = Buffer.alloc(SAMPLE_BYTES);
  const fileDescriptor = fs.openSync(filePath, "r");
  const bytesRead = fs.readSync(fileDescriptor, buffer, 0, SAMPLE_BYTES, 0);
  fs.closeSync(fileDescriptor);
  const sample = buffer.subarray(0, bytesRead);
  // Binary files have nothing useful to show the model.
  return sample.includes(0) ? "(binary)" : sample.toString("utf8");
}

// Returns the chosen agent name, or "none".
export async function chooseAgentWithLLM(filePath, agents) {
  if (!BASE_URL || !MODEL)
    throw new Error("ROUTER_BASE_URL and ROUTER_MODEL must both be set");
  const names = [...agents.map((agent) => agent.name), "none"];

  const response = await fetch(`${BASE_URL}/chat/completions`, {
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
            ...agents.map((agent) => `- ${agent.name}: ${agent.description}`),
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
  if (!response.ok) throw new Error(`router LLM ${response.status}: ${await response.text()}`);

  const { choices } = await response.json();
  const { agent, reason } = JSON.parse(choices[0].message.content);
  if (!names.includes(agent)) throw new Error(`router LLM returned unknown agent "${agent}"`);
  console.error(`LLM router: ${path.basename(filePath)} -> ${agent} (${reason})`);
  return agent;
}
