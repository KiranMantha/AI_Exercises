import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runAgent, MAX_STEPS } from "../src/agent.js";
import { stripThink } from "../src/llm.js";

const fixture = readFileSync(new URL("./fixture-ddg.html", import.meta.url), "utf8");
const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

test("agent loop: tool call, tool result, final answer", async () => {
  globalThis.fetch = async () => new Response(fixture);
  const snapshots = [];
  const replies = [
    { content: "", toolCalls: [{ id: "call_1", name: "web_search", arguments: { query: "node lts" } }], finishReason: "tool_calls" },
    { content: "Node 22 is LTS. https://nodejs.org", toolCalls: [], finishReason: "stop" },
  ];
  const chat = async ({ messages, tools }) => {
    assert.ok(tools.length === 2, "tools are sent on every call");
    snapshots.push(messages.map((m) => ({ ...m })));
    return replies.shift();
  };
  const steps = [];
  const answer = await runAgent("q", { chat, onStep: (s) => steps.push(s) });

  assert.equal(answer, "Node 22 is LTS. https://nodejs.org");
  assert.deepEqual(steps.map((s) => s.name), ["web_search"]);

  const second = snapshots[1];
  assert.deepEqual(second.map((m) => m.role), ["system", "user", "assistant", "tool"]);
  assert.equal(second[2].tool_calls[0].id, "call_1");
  assert.equal(second[2].tool_calls[0].function.arguments, '{"query":"node lts"}');
  assert.equal(second[3].tool_call_id, "call_1");
  assert.match(second[3].content, /nodejs\.org/);
});

test("unknown tool is returned to the model, not thrown", async () => {
  let seen;
  const replies = [
    { content: "", toolCalls: [{ id: "c1", name: "nope", arguments: {} }], finishReason: "tool_calls" },
    { content: "done", toolCalls: [], finishReason: "stop" },
  ];
  const chat = async ({ messages }) => {
    seen = messages;
    return replies.shift();
  };
  assert.equal(await runAgent("q", { chat }), "done");
  assert.match(seen.at(-1).content, /unknown tool "nope"/);
});

test("invalid tool arguments become an error tool result", async () => {
  let seen;
  const replies = [
    { content: "", toolCalls: [{ id: "c1", name: "web_search", arguments: {} }], finishReason: "tool_calls" },
    { content: "ok", toolCalls: [], finishReason: "stop" },
  ];
  const chat = async ({ messages }) => {
    seen = messages;
    return replies.shift();
  };
  await runAgent("q", { chat });
  assert.match(seen.at(-1).content, /^Error: web_search requires/);
});

test("stops after MAX_STEPS", async () => {
  const chat = async () => ({
    content: "",
    toolCalls: [{ id: "c", name: "nope", arguments: {} }],
    finishReason: "tool_calls",
  });
  await assert.rejects(() => runAgent("q", { chat }), new RegExp(`${MAX_STEPS} steps`));
});

test("stripThink removes think blocks", () => {
  assert.equal(stripThink("<think>hmm\nmore</think>\nAnswer"), "Answer");
  assert.equal(stripThink("A<think>unclosed"), "A");
  assert.equal(stripThink(null), "");
});
