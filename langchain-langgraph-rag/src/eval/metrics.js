import { applyRelevanceGate } from "../relevanceGate.js";

/**
 * record: { query, answerable, expectedDocs?, expectedPhrases?,
 *           candidates: [{ doc, text, score }] }
 * `candidates` are the reranked chunks before the relevance gate, best first.
 *
 * At a given cutoff, an answerable question is a hit when the gate keeps
 * something and, for each label that is set, the kept chunks satisfy it:
 *   expectedDocs    some kept chunk comes from one of these documents
 *   expectedPhrases some kept chunk contains one of these phrases
 * Prefer expectedPhrases: a document-level label is satisfied by any chunk of
 * the right document, including ones that do not contain the answer.
 * An unanswerable question is correctly rejected when the gate keeps nothing.
 */
export function isHit(record, kept) {
  if (kept.length === 0) return false;
  const docsOk =
    !record.expectedDocs?.length || kept.some((chunk) => record.expectedDocs.includes(chunk.doc));
  const phrasesOk =
    !record.expectedPhrases?.length ||
    kept.some((chunk) =>
      record.expectedPhrases.some((phrase) =>
        (chunk.text ?? "").toLowerCase().includes(phrase.toLowerCase()),
      ),
    );
  return docsOk && phrasesOk;
}

export function evaluateAt(records, minScore, { margin, topK = 5 } = {}) {
  const gated = (record) =>
    applyRelevanceGate(record.candidates, { minScore, margin, maxResults: topK });

  const answerable = records.filter((record) => record.answerable);
  const unanswerable = records.filter((record) => !record.answerable);

  const hits = answerable.filter((record) => isHit(record, gated(record)));
  const rejected = unanswerable.filter((record) => gated(record).length === 0);

  return {
    minScore,
    answerableRecall: answerable.length ? hits.length / answerable.length : null,
    unanswerableRejection: unanswerable.length ? rejected.length / unanswerable.length : null,
    missed: answerable.filter((record) => !hits.includes(record)),
    leaked: unanswerable.filter((record) => !rejected.includes(record)),
    counts: { answerable: answerable.length, unanswerable: unanswerable.length },
  };
}

/**
 * Sweep cutoffs and recommend the highest one that still answers at least
 * `target` of the answerable questions, which maximises rejection of
 * unanswerable ones subject to that recall.
 */
export function recommendCutoff(records, { target = 0.95, margin, topK = 5, step = 0.25 } = {}) {
  const scores = records.flatMap((record) => record.candidates.map((chunk) => chunk.score));
  if (scores.length === 0) return { table: [], recommended: null };

  const low = Math.floor(Math.min(...scores));
  const high = Math.ceil(Math.max(...scores));
  const table = [];
  for (let cutoff = low; cutoff <= high; cutoff += step) {
    table.push(evaluateAt(records, cutoff, { margin, topK }));
  }
  const meetsTarget = table.filter(
    (row) => row.answerableRecall !== null && row.answerableRecall >= target,
  );
  return { table, recommended: meetsTarget.at(-1) ?? null };
}
