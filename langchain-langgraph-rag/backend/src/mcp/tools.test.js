import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDocsMcpServer } from "./tools.js";

const chunk = (id, score, text = `passage ${id}`) => ({ id, source: "car.pdf (p. 4)", section: null, page: 4, score, text });

async function connect({ results = [], candidates = results, store, rerankFloor } = {}) {
  const calls = { search: [] };
  const server = createDocsMcpServer({
    searchDetailed: async (query, maxResults) => (calls.search.push({ query, maxResults }), { results, candidates }),
    store: store ?? { listDocuments: () => [], readDocument: () => null },
    rerankFloor,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, calls };
}

test("the server exposes the three document tools", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["list_documents", "read_document", "search_docs"]);
  for (const tool of tools) assert.ok(tool.description.length > 30, `${tool.name} needs a real description`);
});

test("search_docs returns structured passages and marks which ones passed the gate", async () => {
  const strong = chunk(1, 4.2);
  const weak = chunk(2, -3.1);
  const { client, calls } = await connect({ results: [strong], candidates: [strong, weak] });
  const reply = await client.callTool({ name: "search_docs", arguments: { query: "sunroof", maxResults: 2 } });
  assert.deepEqual(reply.structuredContent.results.map((item) => [item.id, item.strong]), [[1, true], [2, false]]);
  assert.match(reply.content[0].text, /\(strong match\)/);
  assert.match(reply.content[0].text, /\(weak match\)/);
  assert.deepEqual(calls.search, [{ query: "sunroof", maxResults: 2 }]);
});

test("search_docs withholds candidates below the floor and says so when nothing is left", async () => {
  const { client } = await connect({ candidates: [chunk(1, -9), chunk(2, -11)], rerankFloor: -6 });
  const reply = await client.callTool({ name: "search_docs", arguments: { query: "who won?" } });
  assert.deepEqual(reply.structuredContent.results, []);
  assert.match(reply.content[0].text, /No relevant passages/);
});

test("search_docs rejects out-of-range input instead of searching", async () => {
  const { client, calls } = await connect();
  const outcome = await client
    .callTool({ name: "search_docs", arguments: { query: "x", maxResults: 99 } })
    .then((reply) => (reply.isError ? "error" : "ran"), () => "error");
  assert.equal(outcome, "error");
  assert.equal(calls.search.length, 0);
});

test("list_documents reports what is indexed", async () => {
  const { client } = await connect({
    store: { listDocuments: () => [{ doc: "car.pdf", chunks: 27, firstPage: 1, lastPage: 11 }, { doc: "a.md", chunks: 1, firstPage: null, lastPage: null }], readDocument: () => null },
  });
  const reply = await client.callTool({ name: "list_documents", arguments: {} });
  assert.equal(reply.structuredContent.documents.length, 2);
  assert.match(reply.content[0].text, /car\.pdf: 27 passages, pages 1-11/);
  assert.match(reply.content[0].text, /a\.md: 1 passages$/m);
});

test("read_document returns one page in order and refuses unknown documents", async () => {
  const seen = [];
  const store = {
    listDocuments: () => [],
    readDocument: (doc, page) => (seen.push([doc, page]), doc === "car.pdf" ? [chunk(1, 0, "first"), chunk(2, 0, "second")] : null),
  };
  const { client } = await connect({ store });

  const ok = await client.callTool({ name: "read_document", arguments: { doc: "car.pdf", page: 4 } });
  assert.deepEqual(ok.structuredContent.chunks.map((item) => item.text), ["first", "second"]);
  assert.deepEqual(seen[0], ["car.pdf", 4]);

  const missing = await client.callTool({ name: "read_document", arguments: { doc: "nope.pdf" } });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /list_documents/);
});

test("read_document caps how much it puts in the model's context", async () => {
  const big = Array.from({ length: 10 }, (_, index) => chunk(index + 1, 0, "x".repeat(1500)));
  const { client } = await connect({ store: { listDocuments: () => [], readDocument: () => big } });
  const reply = await client.callTool({ name: "read_document", arguments: { doc: "car.pdf" } });
  assert.equal(reply.structuredContent.truncated, true);
  assert.ok(reply.structuredContent.chunks.length < 10);
  assert.ok(reply.structuredContent.chunks.length >= 1);
});

test("search_docs pages through results with offset and says when there are more", async () => {
  const pool = Array.from({ length: 12 }, (_, index) => chunk(index + 1, 5 - index));
  const asked = [];
  const server = createDocsMcpServer({
    searchDetailed: async (query, depth) => (asked.push(depth), { results: pool.slice(0, 2), candidates: pool }),
    store: { listDocuments: () => [], readDocument: () => null },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const first = await client.callTool({ name: "search_docs", arguments: { query: "x", maxResults: 5 } });
  assert.deepEqual(first.structuredContent.results.map((item) => item.id), [1, 2, 3, 4, 5]);
  assert.equal(first.structuredContent.hasMore, true);
  assert.match(first.content[0].text, /use offset 5/);

  const second = await client.callTool({ name: "search_docs", arguments: { query: "x", maxResults: 5, offset: 5 } });
  assert.deepEqual(second.structuredContent.results.map((item) => item.id), [6, 7, 8, 9, 10]);
  assert.match(second.content[0].text, /^\[6\]/);
  assert.equal(asked[1], 10); // the pool grows with how deep the caller looks

  const last = await client.callTool({ name: "search_docs", arguments: { query: "x", maxResults: 5, offset: 10 } });
  assert.deepEqual(last.structuredContent.results.map((item) => item.id), [11, 12]);
  assert.equal(last.structuredContent.hasMore, false);
});
