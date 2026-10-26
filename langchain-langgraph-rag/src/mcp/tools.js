import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Read-only tools over the indexed documents. A model connected to this
// server decides what to search for, whether to search again with different
// words, and when to read around a hit. Every tool returns human-readable
// text and the same data as structuredContent, so clients (the chat agent)
// can track exactly which chunks they were given.

const MAX_READ_CHARS = 6000;

const chunkShape = {
  id: z.number(),
  source: z.string(),
  section: z.string().nullable(),
  page: z.number().nullable(),
  text: z.string(),
};

const label = (chunk) => [chunk.source, chunk.section].filter(Boolean).join(" > ");

const failure = (message) => ({ isError: true, content: [{ type: "text", text: message }] });

/**
 * searchDetailed(query, maxResults) -> { results, candidates } (see rag.js)
 * store.listDocuments() -> [{ doc, chunks, firstPage, lastPage }]
 * store.readDocument(doc, page) -> [{ id, source, section, page, text }] | null
 * rerankFloor: candidates scoring below it are not returned at all (a
 *   recall-oriented cut that keeps obvious junk out of the model's context).
 */
export function createDocsMcpServer({ searchDetailed, store, rerankFloor = -Infinity }) {
  const server = new McpServer({ name: "docs-rag", version: "2.0.0" });

  server.registerTool(
    "search_docs",
    {
      description:
        "Search the indexed documents. Returns the best matching passages, each marked strong " +
        "or weak. Documents may use different words than the question (for example 'trims' " +
        "for 'variants'), so if the results do not answer the question, search again with " +
        "other wording before concluding the documents do not cover it. Results come best first; " +
        "if the first ones do not answer the question, request the next ones with offset " +
        "before giving up.",
      inputSchema: {
        query: z.string().min(1).max(300).describe("What to look for: a short phrase or question"),
        maxResults: z.number().int().min(1).max(8).optional().describe("How many passages to return (default 5)"),
        offset: z.number().int().min(0).max(40).optional().describe("Skip this many best results, to see the next ones (default 0)"),
      },
      outputSchema: {
        results: z.array(
          z.object({ ...chunkShape, score: z.number(), strong: z.boolean() }),
        ),
        hasMore: z.boolean(),
      },
    },
    async ({ query, maxResults = 5, offset = 0 }) => {
      // The ranked pool grows with how deep the caller asks to look.
      const { results, candidates } = await searchDetailed(query, offset + maxResults);
      const strong = new Set(results.map((chunk) => chunk.id));
      const eligible = candidates.filter((chunk) => chunk.score >= rerankFloor);
      const hasMore = eligible.length > offset + maxResults;
      const found = eligible
        .slice(offset, offset + maxResults)
        .map((chunk) => ({
          id: chunk.id,
          source: chunk.source,
          section: chunk.section ?? null,
          page: chunk.page ?? null,
          score: Number(chunk.score.toFixed(2)),
          strong: strong.has(chunk.id),
          text: chunk.text,
        }));
      const text =
        (found.length
          ? found
              .map(
                (chunk, index) =>
                  `[${offset + index + 1}] ${label(chunk)} (${chunk.strong ? "strong" : "weak"} match)\n${chunk.text}`,
              )
              .join("\n\n---\n\n")
          : "No relevant passages found.") +
        (hasMore ? `\n\n(More results are available: use offset ${offset + maxResults}.)` : "");
      return { content: [{ type: "text", text }], structuredContent: { results: found, hasMore } };
    },
  );

  server.registerTool(
    "list_documents",
    {
      description:
        "List the documents that are indexed, with how many passages each has and the page range. " +
        "Use it to see what the collection covers before deciding what to search for.",
      inputSchema: {},
      outputSchema: {
        documents: z.array(
          z.object({
            doc: z.string(),
            chunks: z.number(),
            firstPage: z.number().nullable(),
            lastPage: z.number().nullable(),
          }),
        ),
      },
    },
    async () => {
      const documents = store.listDocuments();
      const text = documents.length
        ? documents
            .map(
              (item) =>
                `${item.doc}: ${item.chunks} passages` +
                (item.firstPage ? `, pages ${item.firstPage}-${item.lastPage}` : ""),
            )
            .join("\n")
        : "No documents are indexed.";
      return { content: [{ type: "text", text }], structuredContent: { documents } };
    },
  );

  server.registerTool(
    "read_document",
    {
      description:
        "Read the passages of one document in their original order, optionally only those on one " +
        "page. Use it after a search finds the right place but the answer needs the surrounding " +
        "text, such as a table or list that continues across passages.",
      inputSchema: {
        doc: z.string().min(1).max(300).describe("Document name exactly as shown by list_documents or a search result"),
        page: z.number().int().min(1).optional().describe("Only passages on this page"),
      },
      outputSchema: {
        doc: z.string(),
        truncated: z.boolean(),
        chunks: z.array(z.object(chunkShape)),
      },
    },
    async ({ doc, page }) => {
      const chunks = store.readDocument(doc, page);
      if (!chunks) return failure(`Unknown document "${doc}". Call list_documents to see the names.`);
      if (chunks.length === 0) return failure(`"${doc}" has no passages${page ? ` on page ${page}` : ""}.`);

      // Cap what one call can put in the model's context.
      const kept = [];
      let used = 0;
      for (const chunk of chunks) {
        if (kept.length > 0 && used + chunk.text.length > MAX_READ_CHARS) break;
        kept.push(chunk);
        used += chunk.text.length;
      }
      const truncated = kept.length < chunks.length;
      const text =
        kept.map((chunk) => `${label(chunk)}\n${chunk.text}`).join("\n\n") +
        (truncated ? `\n\n(Output cut: ${chunks.length - kept.length} more passages. Ask for a specific page.)` : "");
      return {
        content: [{ type: "text", text }],
        structuredContent: { doc, truncated, chunks: kept },
      };
    },
  );

  return server;
}
