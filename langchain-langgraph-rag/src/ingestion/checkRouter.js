// Sanity-check the router LLM setup without ingesting anything:
//   pnpm router:check path/to/some/file
import { loadAgents } from "./agentRegistry.js";
import { chooseAgentWithLLM } from "./llm-router.js";

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: pnpm router:check <file>");
  process.exit(1);
}

const agents = await loadAgents();
const started = Date.now();
try {
  const choice = await chooseAgentWithLLM(filePath, agents);
  console.error(`OK: chose "${choice}" in ${Date.now() - started}ms`);
} catch (error) {
  console.error(`FAILED: ${error.message}`);
  process.exit(1);
}
