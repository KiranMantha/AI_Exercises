// Guards on what we show: no weak matches, no duplicate products.
export const MIN_SCORE = Number(process.env.SEARCH_MIN_SCORE ?? 0.3); // cosine; below this a hit is noise

export const NOT_FOOTWEAR = 'I can only search footwear. Try e.g. "boots for rainy season".';
export const NO_MATCH = "No close matches. Try describing the shoe differently.";

export const cleanHits = (hits, k) =>
  hits.filter((p, i) => p.score >= MIN_SCORE && hits.findIndex((o) => o.name === p.name) === i).slice(0, k);
