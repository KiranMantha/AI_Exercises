# Scaling and known limitations

What this project does today, where it stops working, and the planned enhancements. See [README.md](README.md) for the current flows.

Numbers below are estimates, not measurements. They assume about 20 chunks per document on average.

## Where it stands today

Built for a small corpus in one local directory:

- Incremental ingestion by content hash, one transaction per document.
- Agents discovered from `backend/src/ingestion/agents/`, routed by file extension, with a cached LLM fallback for ambiguous or unmatched files.
- Per-page PDF routing between text extraction and OCR.
- Structure-aware chunking with heading paths and page ranges.
- Hybrid search (vector + keyword, fused, then reranked) over SQLite.

## Limits at around a million documents

| Area | Today | At 1M documents |
| --- | --- | --- |
| Vector search | `sqlite-vec` scans every vector on each query; there is no approximate-nearest-neighbour index. | About 20M chunks x 384 dimensions is roughly 30 GB of vectors. A full scan per query takes seconds or more. SQLite allows a single writer. |
| Ingestion throughput | One process, one file at a time. Embeddings run on the local CPU. OCR runs page by page. | At about 5 documents a second, a full run takes around 55 hours. Scanned pages through a GPU model are slower. |
| Inputs | A flat local directory. | Confluence, S3 and similar sources have APIs, auth, rate limits and page trees. |
| Document identity | `doc` is the file's base name. | Names collide across folders and sources (see below). |
| Change detection | Hashes every file on every run. | Re-reads the whole corpus to find what changed. |
| Permissions | None. | Confluence spaces have access rules, and search has to filter on them. |
| Embedding model | MiniLM (384 dimensions, 256-token limit). | Likely too weak for a corpus this varied. |

## Known issues today

- **Document identity.** `ingest.js` reads only the top level of the docs directory, and the document ID is the base name. Two files with the same name in different folders would overwrite each other's chunks.
- **Durability.** No retries or backoff on OCR or router LLM calls, and no per-file timeout beyond the request timeout. A crash keeps finished documents but loses the one in progress.
- **Routing by extension only.** A mislabelled file (for example a `.docx` renamed `.pdf`) goes to the wrong agent. Routing should check the file's content type.
- **Password-protected PDFs** are skipped with a warning, with no way to supply a password.
- **No observability.** Logging is `console.error`. There is no per-file status report or metrics.
- **PDF routing is rule-based and partly unvalidated.** A page goes to OCR when its text layer is missing (under 50 characters) or garbled (formula-glyph ratio 0.02). Image coverage was removed as a default trigger after it sent 26 of 32 brochure pages with good text layers to OCR; it is now opt-in (`PDF_OCR_IMAGE_COVERAGE`). The 0.02 formula threshold has not been validated on a formula-heavy PDF. Text inside images is not read unless that rule is enabled.
- **OCR output untested.** The OCR agent has been run only against a mock server. The chunker's handling of real Unlimited-OCR output (tables, formulas) is unverified.
- **The relevance gate needs a golden question set per deployment.** "Nothing relevant" relies on the reranker cutoff `RERANK_MIN_SCORE` (default 0, deliberately strict), which wrongly refuses some answerable yes/no questions. `pnpm eval:retrieval` calibrates it, but needs a labelled set of real questions (30 or more of each kind), which does not exist yet.
- **Second-stage rerank cost and latency.** Uncertain questions (gate rejects, best candidate above `RERANK_REJECT_BELOW`) cost a second model call and add roughly 8 to 10 seconds with a local reasoning model. With no floor set, every off-topic question pays for that call too, so the floor should be calibrated before real traffic. Passage ids are the only model output used, but the model still influences which passages are shown.
- **Table and layout extraction depends on an optional Python parser.** With the plain text layer, spec tables come out scrambled and the chat cannot count variants. With Docling (`PDF_LAYOUT_ENGINE`) it reads the trims matrix correctly (11 trims, and which trims have a given engine). That adds a Python dependency and a per-PDF subprocess; Docling sometimes mislabels bold lines as headings (for example "Automatic only:" became a section name), and a table's first row can be a garbled merged header.
- **Table chunks rank poorly in search.** Even when a table is extracted perfectly, the reranker scores it as irrelevant for natural questions (rank 8 to 11 for "Seltos trims" or "variants"), and the embedding model only sees the first ~256 tokens of a long chunk. The second-stage model rerank and the rewrite retry are what surface it today. A reranker or embedding model that handles tables, or indexing a short generated description of each table beside it, would fix this properly.
- **Chat API limits.** No authentication, an in-memory per-IP rate limit (resets on restart, not shared across instances), no streaming (answers are verified before they are shown), and follow-ups only borrow the previous question for retrieval. The input guard is a pattern list and will not stop a determined prompt-injection attempt; the output check is the real defence. A faithfulness check by a second model call is not implemented.
- **No access control or PII handling.** Everything indexed is searchable by anyone who can query.

## What carries over

- The agent plugin contract. A Confluence agent would convert its HTML to markdown, and the chunker would work on that unchanged.
- Replacing a document in one transaction, so a retried job gives the same result.
- Structure-aware chunking and per-page OCR routing.
- The routing-decision cache.

## Lessons from a production assistant (planned)

Patterns worth adopting from a production, tool-calling airport assistant that serves real travellers:

- **Layered, external safety gates before the model:** a content-safety and prompt-injection service, a PII gate (matters most when the chat model is a cloud API), a language gate, and a multi-turn injection check, each failing open if its service is down, with the layer recorded on every response (done for the layers we have).
- **Document cards.** A short, generated digest of each document (what it covers, the words it uses for things) placed in the static system prompt, so the model knows what is in scope and can rewrite queries with the corpus's own vocabulary. This is also the cleanest form of "an LLM that knows the ingested documents".
- **Prompt caching discipline.** Keep the system prompt byte-stable, put volatile text in the user turn, log a prompt fingerprint and cached-token counts, and watch cache hit rate and cost per route (token usage is now logged; the dashboard and fingerprint are not).
- **Version prompts and keep the old ones** so a prompt change can be rolled back or A/B tested (a `PROMPT_VERSION` exists; old versions are not kept).
- **Tool-driven retrieval for live or structured data**, with per-tool timeouts and anomaly checks, if the assistant ever needs more than static documents.

## Planned enhancements, in order

1. **Stable document IDs and a source layer.**
   - A source interface (filesystem, S3, Confluence, ...) emits document references: a stable ID such as `confluence:SPACE/12345`, a version or etag, a content type and access rules.
   - Parsers take content, not a local path. Routing uses the content type, not the extension.
   - Change detection uses the source's etag or modified time, or webhooks, so unchanged documents are not downloaded.
   - Touches every later document, so do it first.
2. **Queue and workers.**
   - One job per document, run by a worker pool.
   - Retries with backoff, a dead-letter queue, rate limiting per source.
   - A separate autoscaled GPU pool for OCR.
3. **Embedding service.** Batched, GPU-backed embeddings behind a service. Store the embedding model ID on every chunk so a model change is a side-by-side re-index.
4. **Storage.**
   - A store with an approximate-nearest-neighbour index and hybrid search.
   - Postgres with pgvector is the simplest step. OpenSearch or Qdrant are the usual options past tens of millions of chunks.
   - Keep a separate state table for documents and versions.
5. **Query side.** Metadata filters (source, space, recency), permission filtering applied in the query, near-duplicate removal, and a retrieval evaluation set to tune ranking and the PDF routing thresholds.
6. **Operations.** Per-source and per-file metrics, ingestion status reports, content-type checks, and password handling for protected PDFs.
