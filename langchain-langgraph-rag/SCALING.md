# Scaling and known limitations

What this project does today, where it stops working, and the planned enhancements. See [README.md](README.md) for the current flows.

Numbers below are estimates, not measurements. They assume about 20 chunks per document on average.

## Where it stands today

Built for a small corpus in one local directory:

- Incremental ingestion by content hash, one transaction per document.
- Agents discovered from `src/ingestion/agents/`, routed by file extension, with a cached LLM fallback for ambiguous or unmatched files.
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
- **Untuned routing thresholds.** The PDF router's 50 characters / 0.2 image coverage / 0.02 formula ratio are starting guesses, with no evaluation set. On an image-heavy slide deck, 28 of 39 pages went to OCR.
- **OCR output untested.** The OCR agent has been run only against a mock server. The chunker's handling of real Unlimited-OCR output (tables, formulas) is unverified.
- **No access control or PII handling.** Everything indexed is searchable by anyone who can query.

## What carries over

- The agent plugin contract. A Confluence agent would convert its HTML to markdown, and the chunker would work on that unchanged.
- Replacing a document in one transaction, so a retried job gives the same result.
- Structure-aware chunking and per-page OCR routing.
- The routing-decision cache.

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
