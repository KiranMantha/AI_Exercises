import { createLogger } from "../logger.js";
import { buildRouterMessages } from "../systemPrompts/index.js";
import fs from "node:fs";
import path from "node:path";
import { extractJson, structuredOutputText } from "../llmJson.js";

const log = createLogger("ingestion");

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

// Reasoning models put their thinking in <think> blocks, and some wrap the
// JSON in a code fence. Pull out the JSON object and check the choice.
export function parseChoice(content, names) {
  const { agent, reason } = extractJson(content);
  if (!names.includes(agent)) throw new Error(`router LLM returned unknown agent "${agent}"`);
  return { agent, reason };
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
      // json_schema is the structured-output format OpenAI, LM Studio, vLLM
      // and Ollama share; json_object is rejected by LM Studio.
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "agent_choice",
          strict: true,
          schema: {
            type: "object",
            properties: {
              agent: { type: "string", enum: names },
              reason: { type: "string" },
            },
            required: ["agent", "reason"],
            additionalProperties: false,
          },
        },
      },
      messages: buildRouterMessages({
        agents,
        names,
        fileName: path.basename(filePath),
        sizeBytes: fs.statSync(filePath).size,
        sample: sampleOf(filePath),
      }),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`router LLM ${response.status}: ${await response.text()}`);

  const { choices } = await response.json();
  const { agent, reason } = parseChoice(structuredOutputText(choices[0].message), names);
  log.info("route.llm", { doc: path.basename(filePath), agent, reason });
  return agent;
}
