import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIntent } from "./intent.js";

const types = ["Casual Shoes", "Heels"];
test("parseIntent keeps valid fields, drops invented ones", () => {
  const i = parseIntent('ok {"query":"rubber boots","gender":"Men","types":["Heels","Wellies"]}', "x", types);
  assert.deepEqual(i, { relevant: true, query: "rubber boots", gender: "Men", types: ["Heels"], llm: true });
});
test("parseIntent flags off-topic requests", () => {
  assert.equal(parseIntent('{"relevant":false,"query":"","gender":"none","types":[]}', "write a poem", types).relevant, false);
});
test("parseIntent falls back on garbage", () => {
  assert.equal(parseIntent("nope", "raw", types).query, "raw");
});
