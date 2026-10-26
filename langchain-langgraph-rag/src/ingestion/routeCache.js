import crypto from "node:crypto";
import { db } from "../rag.js";

// Remembers the LLM's routing decision per extension, so an unrecognised
// extension costs one model call, not one per file. The key covers the
// candidate agents' names and descriptions, so editing an agent (or adding
// one) invalidates the decision automatically.
export function routeKey(extension, candidates) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([extension, candidates.map((agent) => [agent.name, agent.description])]))
    .digest("hex");
}

const getStmt = db.prepare("SELECT agent FROM routing_cache WHERE key = ?");
const setStmt = db.prepare(`
  INSERT INTO routing_cache (key, ext, agent, decided_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET agent = excluded.agent, decided_at = excluded.decided_at
`);

export const routeCache = {
  get: (key) => getStmt.get(key)?.agent,
  set: (key, extension, agent) => setStmt.run(key, extension, agent, new Date().toISOString()),
};
