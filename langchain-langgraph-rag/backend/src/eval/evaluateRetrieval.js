// Calibrate the relevance gate against a labelled question set:
//   pnpm eval:retrieval path/to/golden.json [--target 0.95] [--top-k 5]
//
// golden.json is an array of
//   { "query": "...", "answerable": true, "expectedPhrases": ["five business days"] }
//   { "query": "...", "answerable": false }
// expectedPhrases (recommended) are phrases the retrieved evidence must
// contain, so a hit means the chunk that answers the question was found.
// expectedDocs (optional) only checks the right document was found, which any
// chunk of that document satisfies.
// Write the questions your users actually ask, including ones the documents
// cannot answer, and keep some aside to check the chosen cutoff on.
import fs from "node:fs";
import { searchDocsDetailed } from "../rag.js";
import { RERANK_MARGIN, RERANK_MIN_SCORE } from "../relevanceGate.js";
import { evaluateAt, recommendCutoff } from "./metrics.js";

const MIN_QUESTIONS_PER_CLASS = 30;

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : Number(args[index + 1]);
};
const goldenPath = args.find((arg) => arg.endsWith(".json"));
if (!goldenPath) {
  console.error("Usage: pnpm eval:retrieval <golden.json> [--target 0.95] [--top-k 5]");
  process.exit(1);
}
const target = flag("--target", 0.95);
const topK = flag("--top-k", 5);

const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));
const records = [];
for (const { query, answerable, expectedDocs, expectedPhrases } of golden) {
  const { candidates } = await searchDocsDetailed(query, topK);
  records.push({
    query,
    answerable,
    expectedDocs,
    expectedPhrases,
    candidates: candidates.map((chunk) => ({ doc: chunk.doc, text: chunk.text, score: chunk.score })),
  });
}

const pct = (value) => (value === null ? "  n/a" : `${(value * 100).toFixed(0)}%`.padStart(5));
const row = (result, label = "") =>
  `${result.minScore.toFixed(2).padStart(8)}   ${pct(result.answerableRecall).padStart(18)}   ${pct(result.unanswerableRejection).padStart(21)}  ${label}`;

const current = evaluateAt(records, RERANK_MIN_SCORE, { margin: RERANK_MARGIN, topK });
const { table, recommended } = recommendCutoff(records, { target, margin: RERANK_MARGIN, topK });
const { answerable, unanswerable } = current.counts;

console.log(`${records.length} questions: ${answerable} answerable, ${unanswerable} unanswerable (margin ${RERANK_MARGIN}, top-${topK})`);
if (answerable < MIN_QUESTIONS_PER_CLASS || unanswerable < MIN_QUESTIONS_PER_CLASS)
  console.log(
    `WARNING: fewer than ${MIN_QUESTIONS_PER_CLASS} questions in a class. Treat the numbers below as a smoke test, not a calibration.`,
  );

console.log("\n  cutoff   answerable answered   unanswerable rejected");
for (const result of table.filter((entry) => Number.isInteger(entry.minScore)))
  console.log(row(result, result.minScore === RERANK_MIN_SCORE ? "<- current setting" : ""));
if (!Number.isInteger(RERANK_MIN_SCORE)) console.log(row(current, "<- current setting"));

console.log(`\nCurrent setting (RERANK_MIN_SCORE=${RERANK_MIN_SCORE}):`);
for (const record of current.missed) console.log(`  refused but answerable: ${record.query}`);
for (const record of current.leaked) console.log(`  answered but unanswerable: ${record.query}`);
if (!current.missed.length && !current.leaked.length) console.log("  every question handled correctly");

if (recommended) {
  console.log(
    `\nHighest cutoff answering >= ${pct(target).trim()} of answerable questions: ${recommended.minScore} ` +
      `(rejects ${pct(recommended.unanswerableRejection).trim()} of unanswerable)`,
  );
  console.log("Set RERANK_MIN_SCORE in .env, then re-run on questions you did not tune on.");
} else {
  console.log(`\nNo cutoff reaches ${pct(target).trim()} recall on answerable questions. Check the retrieval itself (chunking, embeddings), not the gate.`);
}
