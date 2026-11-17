import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { unwrapDdgUrl, parseDdgHtml, webSearch, fetchPage } from "../src/tools.js";

const fixture = readFileSync(new URL("./fixture-ddg.html", import.meta.url), "utf8");

function mockFetch(body, init = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return new Response(body, { status: 200, ...init });
  };
  return calls;
}

const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

test("unwrapDdgUrl extracts the uddg target", () => {
  assert.equal(
    unwrapDdgUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen&amp;rut=x"),
    "https://nodejs.org/en",
  );
  assert.equal(unwrapDdgUrl("https://example.com/a"), "https://example.com/a");
});

test("parseDdgHtml returns title, url, snippet", () => {
  const r = parseDdgHtml(fixture);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], {
    title: "Node.js & Releases",
    url: "https://nodejs.org/en/about/releases",
    snippet: 'Node.js LTS schedule and "current" releases.',
  });
  assert.equal(r[1].url, "https://example.com/direct");
});

test("webSearch formats numbered results and sends a User-Agent", async () => {
  const calls = mockFetch(fixture);
  const out = await webSearch({ query: "node lts" });
  assert.match(calls[0].url, /^https:\/\/html\.duckduckgo\.com\/html\/\?q=node%20lts$/);
  assert.ok(calls[0].opts.headers["User-Agent"]);
  assert.match(out, /^1\. Node\.js & Releases\n   https:\/\/nodejs\.org\/en\/about\/releases\n   /);
  assert.match(out, /\n2\. Direct link/);
});

test("fetchPage rejects non-http(s) URLs", async () => {
  await assert.rejects(() => fetchPage({ url: "file:///etc/passwd" }), /http and https/);
});

test("fetchPage strips script/style and truncates to 4000 chars", async () => {
  mockFetch(`<style>p{}</style><script>alert(1)</script><p>${"x".repeat(5000)}</p>`);
  const out = await fetchPage({ url: "https://example.com" });
  assert.equal(out.length, 4000);
  assert.ok(!out.includes("alert"));
  assert.ok(!out.includes("p{}"));
});
