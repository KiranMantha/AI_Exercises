// Which retrieval mode suits a question. A comparison needs passages about
// several things, which one search cannot balance: the fixed pipeline tends to
// return mostly one side and then says the other has no data. The model-driven
// agent searches each side separately. Everything else is a lookup, where the
// cheaper fixed pipeline does as well (see README, "Model-driven retrieval").
const COMPARISON =
  /\b(compare|compared|comparison|versus|vs\.?|difference|differences|differ|differs|better\b|worse\b|which (?:one|is|car|has|are)|pros and cons|similar|alike)\b/i;

export const looksLikeComparison = (message) => COMPARISON.test(message ?? "");

// A question for something brochures and manuals do not state: a price, value
// for money, which is better, a recommendation. For these the answer is the
// closest documented comparison (see JUDGMENT_RULE in systemPrompts/chat.js). Decided
// from the wording alone, so no model call is spent on it.
const JUDGMENT =
  /(\bprices?\b|\bpricing\b|\bcosts?\b|\bcheap(?:er|est)?\b|\bexpensive\b|\baffordable\b|\bbudget\b|\blakhs?\b|\bcrores?\b|[₹$€£]|\bvalue for money\b|\bworth (?:it|buying|the)\b|\bbest (?:value|one|choice|option|buy)\b|\brecommend|\bshould i (?:buy|choose|pick|get)\b|\bbetter\b|\bworse\b)/i;

export const asksForJudgment = (message) => JUDGMENT.test(message ?? "");
