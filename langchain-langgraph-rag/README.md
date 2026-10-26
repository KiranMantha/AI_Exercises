Referece Docs:
----

- [ai-langchain-langgraph-rag.md](https://gist.github.com/KiranMantha/aea0f556af1de0adb0ce0e594e4f586e)

# Flow

Two flows share one SQLite database (`src/docs.db`): **ingestion** writes it, **search** reads it.

## Ingestion (`pnpm ingest`)

```mermaid
flowchart TD
    A[src/docs/*] --> B{Changed?<br/>SHA-256 + pipeline version}
    B -- unchanged --> Z[Skip]
    B -- new or changed --> R

    subgraph G[Ingestion graph · src/ingestion/graph.js]
        R{Router<br/>match file extension<br/>against agent.accepts}
        R -- one match --> AG
        R -- several or none --> C{Decision cached<br/>for this extension?}
        C -- yes --> AG
        C -- no --> L[LLM fallback<br/>picks from agent descriptions<br/>result stored in routing_cache]
        L -- chosen agent --> AG
        L -- none fits --> S
        L -- unavailable --> F{any match?}
        F -- yes: first match --> AG
        F -- no --> S[Skip: unsupported]

        subgraph AG[Agents · drop a file into src/ingestion/agents]
            MD[markdown agent<br/>.md]
            PDF[pdf agent<br/>.pdf]
        end

        PDF --> PR
        subgraph PR[Per-page router · src/pdf/graph.js]
            P1{Per page:<br/>text layer under 50 chars?<br/>images cover 0.2 of page or more?<br/>formula glyph ratio 0.02 or more?}
            P1 -- no --> TX[Text agent<br/>unpdf text layer]
            P1 -- yes --> OC[OCR agent<br/>render page, call Unlimited-OCR<br/>falls back to text layer on error]
        end

        MD --> SEC[Sections: text, page, via]
        TX --> SEC
        OC --> SEC
        SEC --> CH[Structure-aware chunker<br/>tables, code, formulas kept whole<br/>heading path + page range per chunk]
    end

    CH --> E[Embed chunks<br/>all-MiniLM-L6-v2, 384 dims]
    E --> DB[(SQLite, one transaction per document<br/>documents · chunks · vec_chunks · fts_chunks)]
    S --> Z
    A -. file removed .-> RM[Delete its chunks from all indexes]
    RM --> DB
```

A file that fails to parse (for example a password-protected PDF) is skipped and its existing chunks are kept.

The router's LLM is called only for files with several or no matching agents. Its decision is cached per extension in the `routing_cache` table (keyed on the candidate agents' names and descriptions, so editing an agent invalidates it), so an unrecognised extension costs one call, not one per file. Extensionless files are decided on content and never cached.

## Search (`search_docs` MCP tool)

```mermaid
flowchart TD
    Q[Query] --> V[Vector branch<br/>embed query, nearest neighbours<br/>sqlite-vec]
    Q --> K[Keyword branch<br/>stopwords removed, OR query<br/>FTS5 bm25]
    V --> FU[Fuse<br/>Reciprocal Rank Fusion, k=60]
    K --> FU
    FU --> RR[Rerank<br/>ms-marco-MiniLM cross-encoder<br/>drop below floor or far from best]
    RR --> OUT[Top results<br/>source, section, text, score]
```

The vector and keyword branches run in parallel (LangGraph, `src/rag.js`).

## Adding a format

Add a file to `src/ingestion/agents/` that default-exports `{ name, description, accepts, process(filePath) }`. It is discovered on the next run; nothing else needs editing. The contract is documented at the top of `agents/markdown.js`.

## Configuration

Settings live in `.env`, which is git-ignored. Create it with `cp .env.example .env`. The `start`, `ingest`, `ingest:full` and `test` scripts load it through `env-cmd`, and a variable already set in your shell takes precedence over the file. The scripts fail if `.env` is missing. `test:unit` doesn't use it.

| Variable | Used by | Default |
| --- | --- | --- |
| `DOCS_DIR`, `DB_PATH` | ingest, server | `src/docs`, `src/docs.db` |
| `OCR_BASE_URL`, `OCR_MODEL`, `OCR_PROMPT`, `OCR_API_KEY` | OCR agent | `http://localhost:8000/v1`, `baidu/Unlimited-OCR`, `document parsing.`, unset |
| `OCR_ENABLED` | OCR agent. `false` uses the text layer for every page | `true` |
| `OCR_TIMEOUT_MS` | OCR agent, per page | `300000` |
| `PDF_MIN_CHARS`, `PDF_MAX_IMAGE_COVERAGE`, `PDF_MAX_MATH_RATIO` | PDF router: a page goes to OCR when any threshold trips | `50`, `0.2`, `0.02` |
| `PDF_RENDER_SCALE` | OCR agent, page render scale | `2` |
| `ROUTER_BASE_URL`, `ROUTER_MODEL`, `ROUTER_API_KEY` | LLM fallback router (any OpenAI-compatible endpoint) | unset: fallback disabled |
| `ROUTER_TIMEOUT_MS` | LLM fallback router | `60000` |

## Commands

- `pnpm ingest` indexes new and changed files only. `pnpm ingest:full` rebuilds everything.
- `pnpm test:unit` runs the chunker and routing-cache tests. `pnpm test` runs the MCP client against the server.
