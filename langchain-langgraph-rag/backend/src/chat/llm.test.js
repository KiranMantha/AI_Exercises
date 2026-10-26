import test from "node:test";
import assert from "node:assert/strict";
import { stripThinking } from "./llm.js";

test("plain answers pass through", () => {
  assert.equal(stripThinking("  Refunds take five days [1].  "), "Refunds take five days [1].");
});

test("inline thinking is removed, including multi-line and brace-heavy thoughts", () => {
  const raw = "<think>\nLet me check {source 1}.\nIt says five days.\n</think>\n\nRefunds take **five days** [1].";
  assert.equal(stripThinking(raw), "Refunds take **five days** [1].");
});

test("an unfinished thought yields no answer instead of leaking the thinking", () => {
  assert.equal(stripThinking("<think>Let me think about the refund policy..."), "");
});

test("empty or missing content yields an empty answer", () => {
  assert.equal(stripThinking(""), "");
  assert.equal(stripThinking(undefined), "");
});
