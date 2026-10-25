import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { db, embeddings, DIM } from "./rag.js";

const DOCS_DIR =
  process.env.DOCS_DIR ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), "docs");

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 800,
  chunkOverlap: 100,
});

const files = fs.readdirSync(DOCS_DIR).filter((f) => f.endsWith(".md"));

const rows = [];
for (const file of files) {
  const text = fs.readFileSync(path.join(DOCS_DIR, file), "utf8");
  const pieces = await splitter.splitText(text);
  for (const piece of pieces) rows.push({ source: file, text: piece });
}

if (rows.length === 0) throw new Error("No .md files found in " + DOCS_DIR);

// Rebuild from scratch so the index always matches the files.
db.exec(`
  DELETE FROM chunks;
  DELETE FROM vec_chunks;
  INSERT INTO fts_chunks(fts_chunks) VALUES('delete-all');
`);

const insertChunk = db.prepare(
  "INSERT INTO chunks (source, text) VALUES (?, ?)",
);
const insertVec = db.prepare(
  "INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)",
);

console.error(`Embedding ${rows.length} chunks from ${files.length} files...`);
const vectors = await embeddings.embedDocuments(rows.map((r) => r.text));

const write = db.transaction(() => {
  rows.forEach((row, i) => {
    const { lastInsertRowid } = insertChunk.run(row.source, row.text);
    // vec_chunks requires integer rowids.
    insertVec.run(BigInt(lastInsertRowid), new Float32Array(vectors[i]));
  });
  db.exec(`INSERT INTO fts_chunks(fts_chunks) VALUES('rebuild');`);
});

write();

console.error(`Indexed ${rows.length} chunks. Dimension check: ${DIM}`);
