import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { embed, productText, openDb, SCHEMA } from "./search.js";

const API = "https://datasets-server.huggingface.co/rows?dataset=ashraq/fashion-product-images-small&config=default&split=train";
const FOOTWEAR = new Set(["Shoes", "Sandal", "Flip Flops"]);
const PAGE = 100, CONCURRENCY = 3;

// Pages are cached in .cache/ so a rerun after a throttling failure resumes where it stopped.
mkdirSync(".cache", { recursive: true });
async function page(offset) {
  const file = `.cache/${offset}.json`;
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  for (let attempt = 0; attempt < 15; attempt++) {
    const res = await fetch(`${API}&offset=${offset}&length=${PAGE}`);
    if (res.ok) {
      const data = await res.json();
      writeFileSync(file, JSON.stringify(data));
      return data;
    }
    await new Promise((r) => setTimeout(r, Math.min(30_000, 2000 * (attempt + 1))));
  }
  throw new Error(`rows at offset ${offset} kept failing`);
}

const first = await page(0);
const total = first.num_rows_total;
const maxPages = Number(process.env.MAX_PAGES ?? Infinity);
const offsets = Array.from({ length: Math.min(maxPages, Math.ceil(total / PAGE)) }, (_, i) => i * PAGE);
const products = [];
let next = 0, done = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < offsets.length) {
    const off = offsets[next++];
    const { rows } = await page(off);
    for (const { row: r } of rows) {
      if (!FOOTWEAR.has(r.subCategory)) continue;
      products.push({ id: r.id, name: r.productDisplayName, gender: r.gender, type: r.articleType, colour: r.baseColour, season: r.season, usage: r.usage, image: r.image?.src });
    }
    if (++done % 40 === 0) console.log(`fetched ${done}/${offsets.length} pages, ${products.length} footwear`);
  }
}));

products.sort((a, b) => a.id - b.id);
console.log(`embedding ${products.length} products...`);
mkdirSync("data", { recursive: true });
rmSync("data/products.db", { force: true });
const db = openDb("data/products.db", false);
db.exec(SCHEMA);
const insert = db.prepare("insert into products(id, gender, type, name, colour, usage, season, image, embedding) values (?,?,?,?,?,?,?,?,?)");
for (let i = 0; i < products.length; i += 64) {
  const batch = products.slice(i, i + 64);
  const vecs = await embed(batch.map(productText));
  db.transaction(() => batch.forEach((p, j) =>
    insert.run(BigInt(p.id), p.gender, p.type, p.name, p.colour, p.usage, p.season, p.image,
      Buffer.from(vecs.slice(j * 384, (j + 1) * 384).buffer))))();
}
db.exec("vacuum");
console.log("done", products.length);
