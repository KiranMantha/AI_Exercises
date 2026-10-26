// The reranker returns logits. Keep results within `margin` of the best score
// for the query, and drop anything below `minScore`. Both are deployment
// settings, not constants: the right values depend on the corpus and the
// questions people ask. Calibrate them with `pnpm eval:retrieval` against a
// labelled question set. The defaults are deliberately strict (0 is where the
// model itself says "more likely relevant than not"), so an uncalibrated
// system errs towards "nothing found" over weak matches.
export const RERANK_MARGIN = Number(process.env.RERANK_MARGIN ?? 3);
export const RERANK_MIN_SCORE = Number(process.env.RERANK_MIN_SCORE ?? 0);

// Which reranked candidates are good enough to use. `scored` is sorted best
// first.
export function applyRelevanceGate(
  scored,
  { minScore = RERANK_MIN_SCORE, margin = RERANK_MARGIN, maxResults = 5 } = {},
) {
  if (scored.length === 0) return [];
  const best = scored[0].score;
  return scored
    .filter((row) => row.score >= minScore && best - row.score <= margin)
    .slice(0, maxResults);
}
