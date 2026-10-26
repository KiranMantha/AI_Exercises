import test from "node:test";
import assert from "node:assert/strict";
import { judgeScenario } from "./chatJudge.js";

const answered = {
  status: "answered",
  reason: null,
  enforcementLayer: null,
  answer: "The Duster has **544L** of boot space [1].",
  sources: [{ cited: true, excerpt: "offers a best-in-class 544L* boot space" }, { cited: false, excerpt: "airbags" }],
};
const refused = { status: "refused", reason: "no_context", enforcementLayer: "relevance_gate", answer: "I couldn't find anything.", sources: [] };

test("a response meeting every expectation passes", () => {
  const verdict = judgeScenario(
    { expect: { status: "answered", answerMatches: ["544"], answerExcludes: ["^based on"], sourcesContain: ["boot space"] } },
    answered,
    1000,
  );
  assert.deepEqual(verdict, { status: "PASS", problems: [] });
});

test("each unmet expectation is reported", () => {
  const verdict = judgeScenario(
    { expect: { status: "refused", reason: "no_context", layer: "input_guard", answerMatches: ["sunroof"], answerExcludes: ["544"], sourcesContain: ["airbags"], maxMs: 10 } },
    answered,
    5000,
  );
  assert.equal(verdict.status, "FAIL");
  assert.equal(verdict.problems.length, 7);
});

test("sources count only when cited", () => {
  const verdict = judgeScenario({ expect: { sourcesContain: ["airbags"] } }, answered, 1);
  assert.equal(verdict.status, "FAIL");
});

test("refusal expectations check reason and layer", () => {
  assert.equal(judgeScenario({ expect: { status: "refused", reason: "no_context", layer: "relevance_gate" } }, refused, 1).status, "PASS");
  assert.equal(judgeScenario({ expect: { status: "refused", layer: "input_guard" } }, refused, 1).status, "FAIL");
});

test("a scenario without expectations is MANUAL", () => {
  assert.equal(judgeScenario({ question: "hmm" }, answered, 1).status, "MANUAL");
});
