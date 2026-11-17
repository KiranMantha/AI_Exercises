import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { openDb, search } from "./search.js";

const db = openDb();
const page = readFileSync("index.html");

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/search") {
    const q = url.searchParams.get("q");
    try {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(await search(db, q)));
    } catch (e) {
      res.writeHead(500).end(String(e.message));
    }
    return;
  }
  res.writeHead(200, { "content-type": "text/html" }).end(page);
}).listen(3000, () => console.log(`http://localhost:3000 (${db.prepare("select count(*) n from products").get().n} products)`));
