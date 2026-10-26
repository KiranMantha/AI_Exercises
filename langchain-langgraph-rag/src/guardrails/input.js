// Input guardrails: what is checked before anything reaches retrieval or a model.
// The matching checks on what the model sends back are in output.js.

export const MAX_INPUT_CHARS = 1000;

// Heuristic only: a determined attacker will get past patterns. The real
// defences are that the model sees nothing but retrieved text and that its
// output is verified below. This just stops the obvious attempts cheaply.
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+|any\s+|the\s+|your\s+)?(previous|prior|above|earlier)\s+(instructions|prompts?|rules)/i,
  /disregard\s+(all\s+|any\s+|the\s+|your\s+)?(previous|prior|above|earlier)?\s*(instructions|prompts?|rules)/i,
  /(reveal|show|print|repeat|output|leak)\b.{0,40}\b(system\s+prompt|your\s+(instructions|rules|prompt))/i,
  /\byou\s+are\s+now\b/i,
  /\b(jailbreak|DAN\s+mode|developer\s+mode)\b/i,
  /pretend\s+(to\s+be|you\s+are)/i,
];

export function checkInput(message) {
  if (typeof message !== "string") return { ok: false, reason: "invalid_input" };
  const text = message.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  if (!text || text.length > MAX_INPUT_CHARS) return { ok: false, reason: "invalid_input" };
  if (INJECTION_PATTERNS.some((pattern) => pattern.test(text)))
    return { ok: false, reason: "blocked_input" };
  return { ok: true, text };
}

// Keep only well-formed recent turns, so the client can't smuggle in system
// messages or oversized content through the history.
export function sanitizeHistory(history, maxTurns = 6) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(
      (turn) =>
        (turn?.role === "user" || turn?.role === "assistant") &&
        typeof turn.content === "string" &&
        turn.content.trim(),
    )
    .slice(-maxTurns)
    .map((turn) => ({ role: turn.role, content: turn.content.slice(0, 2000) }));
}
