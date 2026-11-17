import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { queryParserPrompt } from "./systemPrompts/queryParser.js";
import { GENDERS, intentSchema, parseIntent } from "./guardRails/intent.js";
import { checkInput } from "./guardRails/input.js";
import { cleanHits, NOT_FOOTWEAR, NO_MATCH } from "./guardRails/results.js";
import { pipeline } from "@huggingface/transformers";

const BASE_URL = process.env.SEARCH_LLM_BASE_URL ?? "http://localhost:1234/v1";
const MODEL = process.env.SEARCH_LLM_MODEL ?? "local";
const DIM = 384;

export const productText = (p) =>
  `${p.name}. ${p.type} for ${p.gender}. Colour ${p.colour}. ${p.usage} use. ${p.season} season.`;

let extractor;
export async function embed(texts) {
  extractor ??= await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  return (await extractor(texts, { pooling: "mean", normalize: true })).data; // flat Float32Array
}

export const SCHEMA = `create virtual table if not exists products using vec0(
  id integer primary key, gender text, type text,
  +name text, +colour text, +usage text, +season text, +image text,
  embedding float[${DIM}] distance_metric=cosine)`;

export function openDb(path = "data/products.db", readonly = true) {
  const db = new Database(path, { readonly });
  sqliteVec.load(db);
  return db;
}

export const catalogueTypes = (db) => db.prepare("select distinct type from products").all().map((r) => r.type);

async function callLlm(q, types, structured) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(process.env.SEARCH_LLM_API_KEY && { authorization: `Bearer ${process.env.SEARCH_LLM_API_KEY}` }) },
    body: JSON.stringify({
      model: MODEL, temperature: 0, max_tokens: 300,
      messages: [{ role: "system", content: queryParserPrompt(types, GENDERS) }, { role: "user", content: q }],
      ...(structured && { response_format: { type: "json_schema", json_schema: { name: "footwear_query", strict: true, schema: intentSchema(types) } } }),
    }),
    signal: AbortSignal.timeout(Number(process.env.SEARCH_LLM_TIMEOUT_MS ?? 30_000)),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}`);
  return (await res.json()).choices[0].message.content.replace(/<think>[\s\S]*?<\/think>/g, "");
}

// Small LLM: query -> {relevant, query, gender, types}. Any failure => raw query, no filters.
export async function understand(q, types) {
  try {
    let text;
    try { text = await callLlm(q, types, true); }
    catch (e) { if (!String(e.message).startsWith("LLM 4")) throw e; text = await callLlm(q, types, false); } // endpoint without json_schema support
    return parseIntent(text, q, types);
  } catch (err) {
    return { relevant: true, query: q, gender: null, types: [], llm: false, error: String(err.message ?? err) };
  }
}

export function rank(db, qvec, intent, k = 12) {
  const knn = (where, params) =>
    db.prepare(`select id, name, type, gender, colour, image, distance from products
                where embedding match ? and k = ? ${where} order by distance`)
      .all(Buffer.from(new Float32Array(qvec).buffer), k * 3, ...params) // over-fetch: the dataset has duplicate products
      .map(({ distance, ...p }) => ({ ...p, score: +(1 - distance).toFixed(3) }));
  const clean = (hits) => cleanHits(hits, k);
  const where = [], params = [];
  if (intent.gender) { where.push("and gender in (?, 'Unisex')"); params.push(intent.gender); }
  if (intent.types.length) { where.push(`and type in (${intent.types.map(() => "?").join(",")})`); params.push(...intent.types); }
  const hits = where.length ? clean(knn(where.join(" "), params)) : [];
  return hits.length ? hits : clean(knn("", [])); // shortcut: filters are all-or-nothing, relax per-field if this feels too coarse
}

export async function search(db, raw) {
  const input = checkInput(raw); // local guard: on failure no LLM or embedding call is made
  if (!input.ok) return { intent: null, results: [], message: input.message };
  const q = input.query;
  const intent = await understand(q, catalogueTypes(db));
  if (!intent.relevant) return { intent, results: [], message: NOT_FOOTWEAR };
  // Embed the shopper's own words with the rewrite so a wandering rewrite cannot pull results off-topic.
  const qvec = await embed([intent.llm ? `${q}. ${intent.query}` : q]);
  const results = rank(db, qvec, intent);
  return { intent, results, ...(!results.length && { message: NO_MATCH }) };
}
