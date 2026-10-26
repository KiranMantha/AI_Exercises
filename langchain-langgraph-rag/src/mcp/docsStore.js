import { db } from "../rag.js";

// SQLite-backed store for the list/read tools.
const listStmt = db.prepare(`
  SELECT doc, COUNT(*) AS chunks, MIN(page) AS firstPage, MAX(page_end) AS lastPage
  FROM chunks GROUP BY doc ORDER BY doc
`);
const hasDocStmt = db.prepare("SELECT 1 FROM documents WHERE doc = ?");
const readStmt = db.prepare(`
  SELECT id, source, section, page, text FROM chunks
  WHERE doc = ? AND (? IS NULL OR (page IS NOT NULL AND ? BETWEEN page AND COALESCE(page_end, page)))
  ORDER BY id
`);

export const docsStore = {
  listDocuments: () => listStmt.all(),
  readDocument: (doc, page) =>
    hasDocStmt.get(doc) ? readStmt.all(doc, page ?? null, page ?? null) : null,
};
