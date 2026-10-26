// Run chat scenarios against a live API and report PASS / FAIL / MANUAL:
//   pnpm eval:chat [scenarios.json]        (default: src/eval/chat-scenarios.json)
//   AGENT_URL=http://localhost:3001 pnpm eval:chat
//
// Every question that ever failed in front of a user belongs here as a
// scenario, so the same failure cannot come back unnoticed. Exits 1 on FAIL.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { judgeScenario } from "./chatJudge.js";

const AGENT_URL = (process.env.AGENT_URL ?? `http://localhost:${process.env.API_PORT ?? 3001}`).replace(/\/+$/, "");
const scenariosPath =
  process.argv.find((arg) => arg.endsWith(".json")) ??
  fileURLToPath(new URL("./chat-scenarios.json", import.meta.url));
const scenarios = JSON.parse(fs.readFileSync(scenariosPath, "utf8"));

async function ask(scenario) {
  const started = Date.now();
  const response = await fetch(`${AGENT_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: scenario.question, history: scenario.history ?? [] }),
    signal: AbortSignal.timeout(Number(process.env.CHAT_TIMEOUT_MS ?? 180_000) + 30_000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.error ?? "request failed"}`);
  return { body, ms: Date.now() - started };
}

const counts = { PASS: 0, FAIL: 0, MANUAL: 0 };
let tokens = 0;
console.log(`${scenarios.length} scenarios against ${AGENT_URL}\n`);

for (const scenario of scenarios) {
  let verdict;
  let ms = 0;
  let body = {};
  try {
    ({ body, ms } = await ask(scenario));
    verdict = judgeScenario(scenario, body, ms);
    tokens += (body.usage?.promptTokens ?? 0) + (body.usage?.completionTokens ?? 0);
  } catch (error) {
    verdict = { status: "FAIL", problems: [error.message] };
  }
  counts[verdict.status]++;
  const how = body.status ? `${body.status}${body.reason ? `:${body.reason}` : ""} layer=${body.enforcementLayer ?? "-"} calls=${body.usage?.calls ?? 0}` : "no response";
  console.log(`${verdict.status.padEnd(6)} ${String(scenario.id).padEnd(4)} ${scenario.title}  (${(ms / 1000).toFixed(1)}s, ${how})`);
  for (const problem of verdict.problems) console.log(`         - ${problem}`);
  if (verdict.status !== "PASS") console.log(`         answer: ${(body.answer ?? "").replace(/\s+/g, " ").slice(0, 200)}`);
}

console.log(`\n${counts.PASS} passed, ${counts.FAIL} failed, ${counts.MANUAL} manual. ${tokens} tokens used.`);
process.exit(counts.FAIL > 0 ? 1 : 0);
