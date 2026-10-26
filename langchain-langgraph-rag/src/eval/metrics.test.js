import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAt, recommendCutoff } from "./metrics.js";

const chunk = (doc, score) => ({ doc, score });
const records = [
  { query: "a1", answerable: true, expectedDocs: ["a.md"], candidates: [chunk("a.md", 6), chunk("b.md", 1)] },
  { query: "a2", answerable: true, expectedDocs: ["b.md"], candidates: [chunk("b.md", -1), chunk("a.md", -4)] },
  { query: "a3", answerable: true, candidates: [chunk("a.md", 3)] },
  { query: "u1", answerable: false, candidates: [chunk("a.md", -8)] },
  { query: "u2", answerable: false, candidates: [chunk("b.md", -6)] },
  { query: "u3", answerable: false, candidates: [] },
];

test("a strict cutoff loses answerable questions, a loose one leaks unanswerable ones", () => {
  const strict = evaluateAt(records, 0, { margin: 100 });
  assert.equal(strict.answerableRecall, 2 / 3); // a2's best chunk scores -1
  assert.equal(strict.unanswerableRejection, 1);
  assert.deepEqual(strict.missed.map((record) => record.query), ["a2"]);

  const loose = evaluateAt(records, -7, { margin: 100 });
  assert.equal(loose.answerableRecall, 1);
  assert.deepEqual(loose.leaked.map((record) => record.query), ["u2"]); // -6 is above the -7 cutoff
});

test("expectedDocs must be among the kept chunks, not just any chunk", () => {
  const wrongDoc = [{ query: "q", answerable: true, expectedDocs: ["b.md"], candidates: [chunk("a.md", 5)] }];
  assert.equal(evaluateAt(wrongDoc, 0, { margin: 100 }).answerableRecall, 0);
});

test("the margin drops candidates far below the best one", () => {
  const rows = [{ query: "q", answerable: true, expectedDocs: ["b.md"], candidates: [chunk("a.md", 9), chunk("b.md", 2)] }];
  assert.equal(evaluateAt(rows, 0, { margin: 3 }).answerableRecall, 0);
  assert.equal(evaluateAt(rows, 0, { margin: 10 }).answerableRecall, 1);
});

test("the recommendation is the highest cutoff that meets the recall target", () => {
  const { recommended } = recommendCutoff(records, { target: 1, margin: 100 });
  // a2's only expected chunk scores -1, so -1 is the highest cutoff that keeps it.
  assert.equal(recommended.minScore, -1);
  assert.equal(recommended.answerableRecall, 1);
  assert.equal(recommended.unanswerableRejection, 1);
});

test("no answerable questions means no recommendation", () => {
  const onlyUnanswerable = records.filter((record) => !record.answerable);
  assert.equal(recommendCutoff(onlyUnanswerable).recommended, null);
});

test("expectedPhrases require the answer-bearing chunk, not just the right document", () => {
  const rows = [
    {
      query: "sunroof?",
      answerable: true,
      expectedDocs: ["car.pdf"],
      expectedPhrases: ["Panoramic Sunroof"],
      candidates: [
        { doc: "car.pdf", text: "Safety features and airbags", score: 2 },
        { doc: "car.pdf", text: "Dual Pane Panoramic Sunroof, leather seats", score: -5 },
      ],
    },
  ];
  // Right document, wrong chunk: a document-level label alone would call this a hit.
  assert.equal(evaluateAt(rows, 0, { margin: 100 }).answerableRecall, 0);
  // The answer-bearing chunk is kept once the cutoff admits it.
  assert.equal(evaluateAt(rows, -6, { margin: 100 }).answerableRecall, 1);
});

test("phrase matching ignores case", () => {
  const rows = [{ query: "q", answerable: true, expectedPhrases: ["FIVE business days"], candidates: [{ doc: "a", text: "within five Business Days", score: 1 }] }];
  assert.equal(evaluateAt(rows, 0, { margin: 100 }).answerableRecall, 1);
});
