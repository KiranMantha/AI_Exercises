import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, embeddings, DIM } from "./rag.js";
import { ingestFile, currentPipelineVersion } from "./ingestion/graph.js";
import { configureLogging, createLogger, elapsedMs, startTrace } from "./logger.js";

configureLogging({ service: "docs-rag-ingest" });
startTrace();
const log = createLogger("ingestion");
const runStartedAt = performance.now();

const DOCS_DIR =
  process.env.DOCS_DIR ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), "docs");
const FORCE = process.argv.includes("--force");

const files = fs
  .readdirSync(DOCS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name);

log.info("run.start", {
  docs_dir: DOCS_DIR,
  force: FORCE,
  pipeline_version: currentPipelineVersion(),
  files: files.length,
});

const known = new Map(
  db
    .prepare("SELECT doc, hash, pipeline_version FROM documents")
    .all()
    .map((document) => [document.doc, document]),
);

const oldChunks = db.prepare("SELECT id, text FROM chunks WHERE doc = ?");
const deleteVec = db.prepare("DELETE FROM vec_chunks WHERE rowid = ?");
const deleteChunks = db.prepare("DELETE FROM chunks WHERE doc = ?");
const deleteDoc = db.prepare("DELETE FROM documents WHERE doc = ?");
const upsertDoc = db.prepare(`
  INSERT INTO documents (doc, hash, pipeline_version, chunk_count, ingested_at)
  VALUES (@doc, @hash, @version, @count, @at)
  ON CONFLICT(doc) DO UPDATE SET hash = @hash, pipeline_version = @version,
    chunk_count = @count, ingested_at = @at
`);
const insertChunk = db.prepare(`
  INSERT INTO chunks (doc, source, page, page_end, section, via, text)
  VALUES (@doc, @source, @page, @pageEnd, @section, @via, @text)
`);
const insertVec = db.prepare(
  "INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)",
);
// chunks is an external-content FTS table, so index entries are maintained by hand.
const ftsInsert = db.prepare(
  "INSERT INTO fts_chunks (rowid, text) VALUES (?, ?)",
);
const ftsDelete = db.prepare(
  "INSERT INTO fts_chunks (fts_chunks, rowid, text) VALUES ('delete', ?, ?)",
);

// Remove a document's chunks from all three indexes.
function removeChunks(doc) {
  for (const { id, text } of oldChunks.all(doc)) {
    ftsDelete.run(id, text);
    deleteVec.run(BigInt(id));
  }
  deleteChunks.run(doc);
}

// One transaction per document: a crash never leaves a half-replaced file,
// and documents finished before it stay indexed.
const replaceDocument = db.transaction((doc, hash, rows, vectors) => {
  removeChunks(doc);
  // The document row comes first: chunks reference it.
  upsertDoc.run({
    doc,
    hash,
    version: currentPipelineVersion(),
    count: rows.length,
    at: new Date().toISOString(),
  });
  rows.forEach((row, index) => {
    const { lastInsertRowid } = insertChunk.run({ ...row, doc });
    ftsInsert.run(lastInsertRowid, row.text);
    // vec_chunks requires integer rowids.
    insertVec.run(BigInt(lastInsertRowid), new Float32Array(vectors[index]));
  });
});

const removeDocument = db.transaction((doc) => {
  removeChunks(doc);
  deleteDoc.run(doc);
});

const counts = { added: 0, updated: 0, unchanged: 0, removed: 0, skipped: 0 };

for (const doc of known.keys()) {
  if (files.includes(doc)) continue;
  removeDocument(doc);
  counts.removed++;
  log.info("document.removed", { doc });
}

for (const file of files) {
  const hash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(DOCS_DIR, file)))
    .digest("hex");
  const previous = known.get(file);

  if (
    !FORCE &&
    previous?.hash === hash &&
    previous.pipeline_version === currentPipelineVersion()
  ) {
    counts.unchanged++;
    log.debug("document.unchanged", { doc: file });
    continue;
  }

  const documentStartedAt = performance.now();
  log.info("document.start", {
    doc: file,
    bytes: fs.statSync(path.join(DOCS_DIR, file)).size,
    reason: !previous ? "new" : previous.hash !== hash ? "content_changed" : FORCE ? "forced" : "pipeline_changed",
  });

  // Routing, parsing (text/OCR) and chunking happen in the ingestion graph.
  const { status, rows } = await ingestFile(path.join(DOCS_DIR, file));
  if (status !== "ok") {
    // Keep whatever is already indexed for this file.
    counts.skipped++;
    log.warn("document.skipped", { doc: file, status, duration_ms: elapsedMs(documentStartedAt) });
    continue;
  }

  const embedStartedAt = performance.now();
  const vectors = await embeddings.embedDocuments(rows.map((row) => row.text));
  const embedMs = elapsedMs(embedStartedAt);
  replaceDocument(file, hash, rows, vectors);
  previous ? counts.updated++ : counts.added++;
  log.info("document.indexed", {
    doc: file,
    outcome: previous ? "updated" : "added",
    chunks: rows.length,
    embed_ms: embedMs,
    duration_ms: elapsedMs(documentStartedAt),
  });
}

const total = db.prepare("SELECT COUNT(*) AS n FROM chunks").get().n;
log.info("run.done", { ...counts, chunks_indexed: total, embedding_dimensions: DIM, duration_ms: elapsedMs(runStartedAt) });
