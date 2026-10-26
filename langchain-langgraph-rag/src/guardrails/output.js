// Output guardrails: what is checked on the model's answer before a user sees it.
// The matching checks on what a user sends in are in input.js. The refusal
// texts shown when a check fails are in src/systemPrompts/refusals.js.

export const NOT_IN_DOCS = "NOT_IN_DOCS";

const REFUSAL_OPENER =
  /^(?:(?:unfortunately|sorry)[,.]?\s+)?i\s+(?:cannot|can't|can\s?not|am\s+unable\s+to|am\s+not\s+able\s+to|couldn't|could\s+not)\s+(?:answer|find|help|provide|say)\b/i;

// "The provided sources do not state how many ..." as the first sentence is a
// non-answer in prose. Only the first sentence is tested, so an answer that
// gives the covered part and then notes a gap still passes.
const NEGATIVE_FIRST_SENTENCE =
  /^[^.!?\n]{0,80}?\b(?:sources?|documents?|brochures?)\b[^.!?\n]{0,40}\b(?:do(?:es)?\s+not|don't|doesn't)\s+(?:state|specify|mention|say|contain|provide|include|list|cover)\b/i;

// A first sentence that says what the documents lack is the correct start of a
// fallback answer (only where allowGapOpening is set) ("The documents list no prices. On listed equipment: ... [1]").
// It only stays a refusal when nothing substantial follows it: the rest of the
// reply must carry its own citation.
function hasCitedFallback(text) {
  const rest = text.replace(/^[^.!?\n]*[.!?]?/, "").trim();
  return rest.length >= 60 && /\[\d+\]/.test(rest);
}

const URL_PATTERN = /https?:\/\/[^\s)>\]"']+/g;
const IMAGE_PATTERN = /!\[[^\]]*\]\(/;

// The model's answer must be grounded in what it was given: it must cite
// real sources, and must not introduce links or images (a data-exfiltration
// channel if a document contains an injected instruction).
// `allowGapOpening` is for questions that ask for something documents do not
// state (asksForJudgment): there, an answer may open by saying what is missing
// as long as a cited comparison follows.
export function checkOutput(answer, results, { allowGapOpening = false } = {}) {
  const text = (answer ?? "").trim();
  if (!text) return { ok: false, reason: "ungrounded", detail: "empty" };
  // The model declined: the marker anywhere in the reply (it sometimes
  // embeds it in a sentence), or a refusal written as prose instead of the
  // marker. Only an opener counts, so a partial answer that notes what the
  // sources do not cover still passes.
  const opening = text.replace(PREAMBLE, "");
  if (text.includes(NOT_IN_DOCS) || REFUSAL_OPENER.test(opening) || (NEGATIVE_FIRST_SENTENCE.test(opening) && !(allowGapOpening && hasCitedFallback(opening))))
    return { ok: false, reason: "no_context" };

  const cited = [...new Set([...text.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])))];
  if (cited.length === 0) return { ok: false, reason: "ungrounded", detail: "no_citation" };
  if (cited.some((id) => id < 1 || id > results.length))
    return { ok: false, reason: "ungrounded", detail: "bad_citation" };

  if (IMAGE_PATTERN.test(text)) return { ok: false, reason: "ungrounded", detail: "image" };
  const contextText = results.map((result) => result.text).join("\n");
  const invented = (text.match(URL_PATTERN) ?? []).filter((url) => !contextText.includes(url));
  if (invented.length) return { ok: false, reason: "ungrounded", detail: "invented_url" };

  return { ok: true, text, cited: cited.sort((first, second) => first - second) };
}

// Small models keep adding a "Based on the sources..." opener and a closing
// offer even when told not to. Prompts reduce it; this removes the rest
// deterministically, and only touches text that carries no information.
const PREAMBLE =
  /^(?:based on|according to|from)\s+(?:the\s+)?(?:provided\s+|given\s+|available\s+)?(?:sources?|documents?|brochures?|information|context)(?:\s+(?:provided|given|above))?\s*[,:\-–—]\s*/i;
const CLOSING_OFFER = /\n+\s*(?:let me know|feel free to ask|would you like me to|i can also help)[^\n]*$/i;

// Headings do not belong in a chat bubble: drop a leading title line and turn
// any other heading into a bold line.
const TITLE_LINE = /^#{1,6}[ \t]+[^\n]*\n+/;
const HEADING_LINE = /^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;

export function cleanAnswer(text) {
  const cleaned = text
    .trim()
    .replace(TITLE_LINE, "")
    .replace(HEADING_LINE, "**$1**")
    .replace(PREAMBLE, "")
    .replace(CLOSING_OFFER, "")
    .trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
