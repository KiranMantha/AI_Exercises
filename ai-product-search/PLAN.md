# AI product search (shoes & footwear)

Goal: type "boots for rainy season" -> get fitting products. No keyword match needed.

## Data
HF `ashraq/fashion-product-images-small` via the public datasets-server (no key, ~44k items, real names + images).
Keep footwear only (subCategory Shoes / Sandal / Flip Flops). Rejected: DummyJSON (10 shoes), Platzi (12, no boots).

## Pipeline
1. `npm run index` - fetch rows, keep footwear, embed each product text with MiniLM (local, @huggingface/transformers) -> `data/products.db` (SQLite + sqlite-vec, committed so cloners skip the ~20 min build).
2. Query -> **small LLM** (any OpenAI-compatible endpoint, e.g. LM Studio/Ollama, 1-3B instruct model).
   Its only job: rewrite the query into a product description ("waterproof rubber ankle boots, sturdy sole")
   and extract optional filters (gender, article types from the real catalogue list).
3. Embed the rewrite, KNN in sqlite-vec (cosine), filters applied in the query (dropped if they leave nothing). Top 12.
4. If the LLM is down, search with the raw query (degrades, does not fail).

## UI
One static page: searchbox + product cards. Shows what the LLM understood.

## Deliberately skipped
Separate vector DB server (sqlite-vec KNN inside one file), reranker, auth, caching, streaming.
Dataset has no waterproof/material attribute, so "rainy" relies on names + embeddings; quality is bounded by that.

## Run
```
npm i && npm run index
SEARCH_LLM_BASE_URL=http://localhost:1234/v1 SEARCH_LLM_MODEL=<model> npm start   # http://localhost:3000
```
