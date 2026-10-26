import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { embeddings } from "./embeddings.js";
import { applyRelevanceGate, RERANK_MARGIN, RERANK_MIN_SCORE } from "./relevanceGate.js";
import { createLogger, elapsedMs, queryAttributes } from "./logger.js";
import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import {
  AutoTokenizer,
  AutoModelForSequenceClassification,
} from "@huggingface/transformers";

const log = createLogger("retrieval");

const DIM = 384; // all-MiniLM-L6-v2
const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? path.join(SRC_DIR, "docs.db");
const RRF_K = 60;
const CANDIDATE_MULTIPLIER = 3;
// How many candidates each retriever contributes and the reranker scores.
// Recall-oriented: a relevant chunk the reranker never sees cannot be found.
// Defaults to maxResults x 3; set RETRIEVAL_POOL_SIZE to go deeper (the
// reranker's cost grows with it). Choose it with `pnpm eval:retrieval`.
const POOL_SIZE = process.env.RETRIEVAL_POOL_SIZE
  ? Number(process.env.RETRIEVAL_POOL_SIZE)
  : undefined;
const poolSizeFor = (maxResults) => POOL_SIZE ?? maxResults * CANDIDATE_MULTIPLIER;
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "do",
  "does",
  "for",
  "how",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "was",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
]);
const RERANK_MODEL = process.env.RERANK_MODEL ?? "Xenova/ms-marco-MiniLM-L-6-v2";

const db = new Database(DB_PATH);
sqliteVec.load(db);

// The index is derived data, so a schema change rebuilds it (re-run ingest).
const SCHEMA_VERSION = 2;
if (db.pragma("user_version", { simple: true }) < SCHEMA_VERSION) {
  db.exec(`
    DROP TABLE IF EXISTS fts_chunks;
    DROP TABLE IF EXISTS vec_chunks;
    DROP TABLE IF EXISTS chunks;
    DROP TABLE IF EXISTS documents;
  `);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

db.exec(`
  -- One row per ingested file; drives incremental ingestion.
  CREATE TABLE IF NOT EXISTS documents (
    doc TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    pipeline_version TEXT NOT NULL,
    chunk_count INTEGER NOT NULL,
    ingested_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY,
    doc TEXT NOT NULL REFERENCES documents(doc),
    source TEXT NOT NULL,   -- citation, e.g. "deck.pdf (p. 9)"
    page INTEGER,           -- first page the chunk covers (PDFs)
    page_end INTEGER,
    section TEXT,           -- heading path, e.g. "Billing > Refunds"
    via TEXT,               -- parser that produced the text: text / ocr / ...
    text TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(doc);
  -- LLM routing decisions per file extension (see ingestion/routeCache.js).
  CREATE TABLE IF NOT EXISTS routing_cache (
    key TEXT PRIMARY KEY,
    ext TEXT NOT NULL,
    agent TEXT NOT NULL,    -- chosen agent name, or "none"
    decided_at TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
    embedding float[${DIM}]
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
    text,
    content='chunks',
    content_rowid='id',
    tokenize='porter unicode61'
  );
`);

const vecStmt = db.prepare(`
  SELECT c.id, c.doc, c.source, c.page, c.page_end, c.section, c.via, c.text, v.distance
  FROM vec_chunks v
  JOIN chunks c ON c.id = v.rowid
  WHERE v.embedding MATCH ? AND k = ?
  ORDER BY v.distance
`);

// bm25() returns lower values for better matches, so ORDER BY rank ascending.
const ftsStmt = db.prepare(`
  SELECT c.id, c.doc, c.source, c.page, c.page_end, c.section, c.via, c.text, bm25(fts_chunks) AS score
  FROM fts_chunks
  JOIN chunks c ON c.id = fts_chunks.rowid
  WHERE fts_chunks MATCH ?
  ORDER BY score
  LIMIT ?
`);

let rerankerPromise;
function getReranker() {
  rerankerPromise ??= Promise.all([
    AutoTokenizer.from_pretrained(RERANK_MODEL),
    AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL),
  ]);
  return rerankerPromise;
}

async function rerankScores(query, docs) {
  const [tokenizer, model] = await getReranker();
  const inputs = tokenizer(new Array(docs.length).fill(query), {
    text_pair: docs,
    padding: true,
    truncation: true,
  });
  const { logits } = await model(inputs);
  return Array.from(logits.data);
}

// Turn free text into a safe FTS5 query: quote each term, OR them together.
function toFtsQuery(query) {
  const terms = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, " ")
    .split(/\s+/)
    .filter((t) => t && !STOPWORDS.has(t))
    .map((t) => `"${t}"`);
  return terms.length ? terms.join(" OR ") : null;
}

// LangGraph state
const RetrievalState = Annotation.Root({
  query: Annotation({ reducer: (_, b) => b, default: () => "" }),
  maxResults: Annotation({ reducer: (_, b) => b, default: () => 5 }),
  vecResults: Annotation({ reducer: (_, b) => b, default: () => [] }),
  ftsResults: Annotation({ reducer: (_, b) => b, default: () => [] }),
  results: Annotation({ reducer: (_, b) => b, default: () => [] }),
  // Every reranked candidate before the relevance gate, best first. Used to
  // evaluate and calibrate the gate.
  candidates: Annotation({ reducer: (_, b) => b, default: () => [] }),
});

// Two branches run in parallel after START.
const vectorNode = async (state) => {
  const vector = await embeddings.embedQuery(state.query);
  const rows = vecStmt.all(new Float32Array(vector), poolSizeFor(state.maxResults));
  return { vecResults: rows };
};

const keywordNode = (state) => {
  const match = toFtsQuery(state.query);
  if (!match) return { ftsResults: [] };
  try {
    return { ftsResults: ftsStmt.all(match, poolSizeFor(state.maxResults)) };
  } catch (err) {
    log.warn("keyword_branch.failed", { error: err });
    return { ftsResults: [] }; // malformed FTS query: fall back to vectors only
  }
};

// Merge the two ranked lists with Reciprocal Rank Fusion.
const fuseNode = (state) => {
  const scores = new Map();
  const seen = new Map();

  const addList = (list) =>
    list.forEach((row, rank) => {
      const contribution = 1 / (RRF_K + rank + 1);
      scores.set(row.id, (scores.get(row.id) ?? 0) + contribution);
      if (!seen.has(row.id)) seen.set(row.id, row);
    });

  addList(state.vecResults);
  addList(state.ftsResults);

  const fused = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, poolSizeFor(state.maxResults))
    .map(([id, score]) => ({ ...seen.get(id), score }));

  return { results: fused };
};

const rerankNode = async (state) => {
  if (state.results.length === 0) return { results: [], candidates: [] };

  const scores = await rerankScores(
    state.query,
    state.results.map((row) => row.text),
  );

  const scored = state.results
    .map((row, index) => ({ ...row, score: scores[index] }))
    .sort((first, second) => second.score - first.score);

  return {
    candidates: scored,
    results: applyRelevanceGate(scored, { maxResults: state.maxResults }),
  };
};

const retrievalGraph = new StateGraph(RetrievalState)
  .addNode("vector", vectorNode)
  .addNode("keyword", keywordNode)
  .addNode("fuse", fuseNode)
  .addNode("rerank", rerankNode)
  .addEdge(START, "vector")
  .addEdge(START, "keyword")
  .addEdge("vector", "fuse")
  .addEdge("keyword", "fuse")
  .addEdge("fuse", "rerank")
  .addEdge("rerank", END)
  .compile();

// One log line per search: how many hits each branch found, what the reranker
// scored, and what the relevance gate let through.
async function runSearch(query, maxResults) {
  const startedAt = performance.now();
  const state = await retrievalGraph.invoke({ query, maxResults });
  log.info("search", {
    ...queryAttributes(query),
    max_results: maxResults,
    vector_hits: state.vecResults.length,
    keyword_hits: state.ftsResults.length,
    reranked: state.candidates.length,
    top_scores: state.candidates.slice(0, 3).map((chunk) => Number(chunk.score.toFixed(2))),
    kept: state.results.length,
    kept_chunk_ids: state.results.map((chunk) => chunk.id),
    gate_min_score: RERANK_MIN_SCORE,
    gate_margin: RERANK_MARGIN,
    rerank_model: RERANK_MODEL,
    duration_ms: elapsedMs(startedAt),
  });
  return state;
}

async function searchDocs(query, maxResults = 5) {
  const out = await runSearch(query, maxResults);
  return out.results;
}

// Same search, but also returns the candidates the relevance gate saw.
async function searchDocsDetailed(query, maxResults = 5) {
  const { results, candidates } = await runSearch(query, maxResults);
  return { results, candidates };
}

export {
  embeddings,
  toFtsQuery,
  db,
  DIM,
  DB_PATH,
  searchDocs,
  searchDocsDetailed,
};
