import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AGENTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "agents",
);

// Plug and play: every .js file in ./agents is an agent. Drop one in to add
// a format; delete it to remove one.
export async function loadAgents() {
  const agents = [];
  for (const file of fs.readdirSync(AGENTS_DIR).filter((fileName) => fileName.endsWith(".js"))) {
    const { default: agent } = await import(path.join(AGENTS_DIR, file));
    for (const key of ["name", "description", "accepts", "process"])
      if (!agent?.[key]) throw new Error(`agents/${file} is missing "${key}"`);
    agents.push(agent);
  }
  const names = agents.map((agent) => agent.name);
  if (new Set(names).size !== names.length)
    throw new Error(`Duplicate agent names: ${names.join(", ")}`);
  return agents;
}
