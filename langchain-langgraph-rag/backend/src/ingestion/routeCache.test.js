import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

// rag.js opens its database on import, so point it at a throwaway file first.
process.env.DB_PATH = path.join(os.tmpdir(), `route-cache-${process.pid}.db`);
const { routeCache, routeKey } = await import("./routeCache.js");

const pdf = { name: "pdf", description: "Reads PDFs." };
const md = { name: "markdown", description: "Reads markdown." };

test("a stored decision is returned, and unknown keys are not", () => {
  const key = routeKey(".log", [pdf, md]);
  assert.equal(routeCache.get(key), undefined);
  routeCache.set(key, ".log", "markdown");
  assert.equal(routeCache.get(key), "markdown");
  routeCache.set(key, ".log", "none");
  assert.equal(routeCache.get(key), "none");
});

test("the key changes with extension, agent set and descriptions", () => {
  const base = routeKey(".log", [pdf, md]);
  assert.notEqual(base, routeKey(".txt", [pdf, md]));
  assert.notEqual(base, routeKey(".log", [pdf]));
  assert.notEqual(base, routeKey(".log", [{ ...pdf, description: "Changed." }, md]));
  assert.equal(base, routeKey(".log", [pdf, md]));
});
