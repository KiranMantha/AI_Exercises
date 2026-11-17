// Cheap local checks that run BEFORE any LLM or embedding call. A failed check costs nothing.
export const MAX_QUERY_CHARS = 200;

// shortcut: a small deny-list, not a real injection detector; the LLM's `relevant` flag is the second line.
const INJECTION = /ignore (all |the )?(previous|above|prior)|disregard (the |all )?(previous|above|instructions)|system prompt|you are now|reveal your (instructions|prompt)/i;

export function checkInput(raw) {
  const q = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!q) return { ok: false, message: "Type what kind of footwear you are looking for." };
  if (q.length > MAX_QUERY_CHARS) return { ok: false, message: `Please keep it under ${MAX_QUERY_CHARS} characters.` };
  if ((q.match(/\p{L}/gu) ?? []).length < 2) return { ok: false, message: "Please describe the footwear in words." };
  if (INJECTION.test(q)) return { ok: false, message: 'I can only search footwear. Try e.g. "boots for rainy season".' };
  return { ok: true, query: q };
}
