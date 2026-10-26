import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The client reads its endpoint at import time, so configure it first.
process.env.ROUTER_BASE_URL = "http://router.test/v1";
process.env.ROUTER_MODEL = "test-model";
const { parseChoice, chooseAgentWithLLM } = await import("./llm-router.js");

const names = ["markdown", "pdf", "none"];

test("plain JSON is parsed", () => {
  assert.deepEqual(parseChoice('{"agent":"markdown","reason":"text notes"}', names), {
    agent: "markdown",
    reason: "text notes",
  });
});

test("a reasoning model's <think> block is ignored, even if it contains braces", () => {
  const content =
    '<think>The file looks like {plain text}. Maybe "pdf"? No.</think>\n{"agent":"markdown","reason":"notes"}';
  assert.equal(parseChoice(content, names).agent, "markdown");
});

test("JSON inside a code fence is parsed", () => {
  const content = '```json\n{"agent":"pdf","reason":"pdf header"}\n```';
  assert.equal(parseChoice(content, names).agent, "pdf");
});

test("an agent that was not offered is rejected", () => {
  assert.throws(() => parseChoice('{"agent":"docx","reason":"x"}', names), /unknown agent/);
});

test("output with no JSON is rejected", () => {
  assert.throws(() => parseChoice("I think markdown.", names), /no JSON/);
  assert.throws(() => parseChoice(undefined, names), /no JSON/);
});

const agents = [
  { name: "markdown", description: "Reads markdown." },
  { name: "pdf", description: "Reads PDFs." },
];

async function chooseWithReply(message) {
  const sample = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "router-")), "notes.txt");
  fs.writeFileSync(sample, "some notes");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ choices: [{ message }] });
  try {
    return await chooseAgentWithLLM(sample, agents);
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("answer in content is used", async () => {
  assert.equal(await chooseWithReply({ content: '{"agent":"pdf","reason":"x"}' }), "pdf");
});

test("LM Studio with a reasoning model: JSON in reasoning_content, content empty", async () => {
  const message = { content: "", reasoning_content: '{ "agent": "markdown", "reason": "notes" }' };
  assert.equal(await chooseWithReply(message), "markdown");
});
