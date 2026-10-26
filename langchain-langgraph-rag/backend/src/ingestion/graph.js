import path from "node:path";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { chunkDocument } from "./chunker.js";
import { loadAgents } from "./agentRegistry.js";
import { layoutSignature } from "../processPdf/layoutParser.js";
import { chooseAgentWithLLM } from "./llm-router.js";
import { routeCache, routeKey } from "./routeCache.js";
import { createLogger, elapsedMs } from "../logger.js";

const log = createLogger("ingestion");

// Bump when the chunker or an agent changes how documents are read, so
// existing documents are re-ingested.
const BASE_PIPELINE_VERSION = "8";

// What an indexed document was built with. Switching the PDF layout parser
// changes every PDF's text, so it is part of the version.
export const currentPipelineVersion = () => `${BASE_PIPELINE_VERSION}${layoutSignature()}`;

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
  const extension = path.extname(state.filePath).toLowerCase();
  const matches = agents.filter((agent) => agent.accepts.includes(extension));
  const decided = (agent, how) => {
    log.info("route", { doc: path.basename(state.filePath), extension, agent, how });
    return agent;
  };
  if (matches.length === 1) return decided(matches[0].name, "extension");

  const candidates = matches.length ? matches : agents;
  const key = routeKey(extension, candidates);
  const cached = extension ? routeCache.get(key) : undefined;
  if (cached) return decided(cached === "none" ? "skip" : cached, "cache");

  try {
    const choice = await chooseAgentWithLLM(state.filePath, candidates);
    if (extension) routeCache.set(key, extension, choice);
    return decided(choice === "none" ? "skip" : choice, "llm");
  } catch (err) {
    log.warn("route.llm_unavailable", { doc: path.basename(state.filePath), error: err });
    return decided(matches[0]?.name ?? "skip", "fallback");
  }
}

const agentNode = (agent) => async (state) => {
  const startedAt = performance.now();
  try {
    const sections = await agent.process(state.filePath);
    log.info("agent.done", {
      doc: path.basename(state.filePath),
      agent: agent.name,
      sections: sections.length,
      chars: sections.reduce((total, section) => total + section.text.length, 0),
      duration_ms: elapsedMs(startedAt),
    });
    return { sections };
  } catch (err) {
    log.error("agent.failed", { doc: path.basename(state.filePath), agent: agent.name, error: err });
    return { sections: [], status: "failed" };
  }
};

const skipNode = (state) => {
  log.warn("document.unsupported", { doc: path.basename(state.filePath) });
  return { sections: [], status: "unsupported" };
};

// Chunk the whole document, so headings carry across pages and a paragraph
// split by a page break stays together.
const chunkNode = async (state) => {
  const doc = path.basename(state.filePath);
  const startedAt = performance.now();
  const chunks = await chunkDocument(state.sections);
  log.info("chunked", {
    doc,
    sections: state.sections.length,
    chunks: chunks.length,
    chars: chunks.reduce((total, chunk) => total + chunk.text.length, 0),
    duration_ms: elapsedMs(startedAt),
  });
  const rows = chunks.map((chunk) => ({
    doc,
    source: citation(doc, chunk.page, chunk.pageEnd),
    page: chunk.page,
    pageEnd: chunk.pageEnd,
    section: chunk.section,
    via: chunk.via,
    text: `${documentTitle(doc)}\n\n${chunk.text}`,
  }));
  return { rows };
};

// Every chunk starts with its document's title, so a question that names the
// subject ("the Seltos ...") can match a chunk that never repeats the name,
// such as a table. Derived from the file name, never from its content.
export const documentTitle = (doc) =>
  path
    .parse(doc)
    .name.replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();

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
