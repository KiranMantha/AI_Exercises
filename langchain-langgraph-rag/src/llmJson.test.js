import test from "node:test";
import assert from "node:assert/strict";
import { extractJson, structuredOutputText } from "./llmJson.js";

test("plain, fenced and think-wrapped JSON are all parsed", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('<think>maybe {"a":2}?</think>\n{"a":1}'), { a: 1 });
});

test("no JSON is an error", () => {
  assert.throws(() => extractJson("nothing here"), /no JSON/);
  assert.throws(() => extractJson(undefined), /no JSON/);
});

test("structured output falls back to reasoning_content when content is empty", () => {
  assert.equal(structuredOutputText({ content: "", reasoning_content: "{}" }), "{}");
  assert.equal(structuredOutputText({ content: "{\"a\":1}", reasoning_content: "x" }), "{\"a\":1}");
});
