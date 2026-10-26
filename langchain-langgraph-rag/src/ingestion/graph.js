import path from "node:path";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { chunkDocument } from "./chunker.js";
import { loadAgents } from "./agentRegistry.js";
import { chooseAgentWithLLM } from "./llm-router.js";
import { routeCache, routeKey } from "./routeCache.js";

// Bump when the chunker or an agent changes how documents are read, so
// existing documents are re-ingested.
export const PIPELINE_VERSION = "2";

const IngestState = Annotation.Root({
  filePath: Annotation({ reducer: (_previous, next) => next, default: () => "" }),
  // What agents return: readable units of a document, [{ text, page?, via? }].
  sections: Annotation({ reducer: (_previous, next) => next, default: () => [] }),
  // "ok", or why nothing was produced: "failed" | "unsupported".
  status: Annotation({ reducer: (_previous, next) => next, default: () => "ok" }),
  rows: Annotation({ reducer: (_previous, next) => next, default: () => [] }),
});

const agents = await loadAgents();

// Deterministic first: the agents that declare this file's extension. The
// LLM is consulted from the agents' descriptions only when that is
// ambiguous (several match) or empty (none match), and the decision is
// cached per extension. Extensionless files are decided on content, so they
// are never cached.
async function routeDocument(state) {
  const ext = path.extname(state.filePath).toLowerCase();
  const matches = agents.filter((agent) => agent.accepts.includes(ext));
  if (matches.length === 1) return matches[0].name;

  const candidates = matches.length ? matches : agents;
  const key = routeKey(ext, candidates);
  const cached = ext ? routeCache.get(key) : undefined;
  if (cached) return cached === "none" ? "skip" : cached;

  try {
    const choice = await chooseAgentWithLLM(state.filePath, candidates);
    if (ext) routeCache.set(key, ext, choice);
    return choice === "none" ? "skip" : choice;
  } catch (err) {
    console.error(
      `LLM router unavailable for ${path.basename(state.filePath)}: ${err.message}`,
    );
    return matches[0]?.name ?? "skip";
  }
}

const agentNode = (agent) => async (state) => {
  try {
    return { sections: await agent.process(state.filePath) };
  } catch (err) {
    console.error(
      `Skipping ${path.basename(state.filePath)}: ${err.name} (${err.message})`,
    );
    return { sections: [], status: "failed" };
  }
};

const skipNode = (state) => {
  console.error(`Skipping ${path.basename(state.filePath)}: no agent accepts it`);
  return { sections: [], status: "unsupported" };
};

// Chunk the whole document, so headings carry across pages and a paragraph
// split by a page break stays together.
const chunkNode = async (state) => {
  const doc = path.basename(state.filePath);
  const chunks = await chunkDocument(state.sections);
  const rows = chunks.map((chunk) => ({
    doc,
    source: citation(doc, chunk.page, chunk.pageEnd),
    page: chunk.page,
    pageEnd: chunk.pageEnd,
    section: chunk.section,
    via: chunk.via,
    text: chunk.text,
  }));
  return { rows };
};

const citation = (doc, page, pageEnd) =>
  page == null
    ? doc
    : `${doc} (p. ${page}${pageEnd != null && pageEnd !== page ? `-${pageEnd}` : ""})`;

const graph = new StateGraph(IngestState).addNode("skip", skipNode);
for (const agent of agents) graph.addNode(agent.name, agentNode(agent));
graph.addNode("chunk", chunkNode);

const agentNames = agents.map((agent) => agent.name);
graph.addConditionalEdges(START, routeDocument, [...agentNames, "skip"]);
for (const name of [...agentNames, "skip"]) graph.addEdge(name, "chunk");
graph.addEdge("chunk", END);

const ingestionGraph = graph.compile();

// Returns { status, rows }. Rows are chunks ready to embed; a status other
// than "ok" means the file could not be read and its rows are not meaningful.
export async function ingestFile(filePath) {
  const { status, rows } = await ingestionGraph.invoke({ filePath });
  return { status, rows };
}
