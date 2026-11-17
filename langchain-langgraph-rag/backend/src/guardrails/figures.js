// Number check: every figure in an answer must appear in the sources that
// sentence cites (or in what the user asked). Deterministic, no model call.
// It proves the figure is in the source, not that the sentence means the same
// thing as the source; it catches the common failure, a wrong or invented
// number sitting next to a real citation.
//
// Known limits: bare integers 1-10 (counts like "3 variants", list numbers)
// are not checked, and names are only covered when they contain a digit
// (i20, 1.6L, E-Tech 140).

const NUMBER = /\d[\d,.]*\d|\d/g;
const CITATION = /\[\d+\]/g;
const URL = /https?:\/\/[^\s)>\]"']+/g;
const SENTENCE_BREAK = /(?<=[.!?])\s+(?=[A-Z*_\[(])/;

const WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
};
const WORD_PATTERN = new RegExp(`\\b(${Object.keys(WORDS).join("|")})\\b`, "gi");

// "1,499", "1,50,000", "12.5", "12,5" and "26.10.2026" all become plain numbers.
function parse(token) {
  if ((token.match(/\./g) ?? []).length > 1) return token.split(".").flatMap(parse);
  let text = token;
  if (/^\d+,\d{1,2}$/.test(text)) text = text.replace(",", ".");
  else text = text.replace(/,/g, "");
  const value = Number(text);
  return Number.isFinite(value) ? [value] : [];
}

function figuresIn(text) {
  return [...text.matchAll(NUMBER)].flatMap(({ 0: token, index }) =>
    parse(token).map((value) => ({ token, value, attached: /^[A-Za-z%°]/.test(text.slice(index + token.length)) })),
  );
}

// Everything a source states: numerals, number words, and a compact form
// (digits only) so "12 99 000" in a table still supports "1299000".
function supportOf(texts) {
  const values = new Set();
  let compact = "";
  for (const text of texts) {
    for (const { value } of figuresIn(text)) values.add(value);
    for (const [word] of text.matchAll(WORD_PATTERN)) values.add(WORDS[word.toLowerCase()]);
    compact += `${text.replace(/(?<=\d)[\s,. ](?=\d)/g, "")}\n`;
  }
  return { values, compact };
}

function segmentsOf(text) {
  return text
    .split("\n")
    .flatMap((line) => line.split(SENTENCE_BREAK))
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/**
 * Figures in `answer` that none of the sources it cites state.
 * `results` are the numbered sources (cited as [1]..[n]); `askedText` is the
 * user's question and history, whose figures the answer may repeat.
 */
export function unsupportedFigures(answer, results, askedText = "") {
  const asked = supportOf([askedText]);
  const all = new Set(results.map((_result, index) => index + 1));
  const citedAnywhere = [...answer.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])).filter((id) => all.has(id));
  const unsupported = new Set();

  for (const segment of segmentsOf(answer)) {
    const ids = [...segment.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])).filter((id) => all.has(id));
    const scope = ids.length ? ids : citedAnywhere;
    const support = supportOf(scope.map((id) => results[id - 1].text));
    const prose = segment.replace(URL, " ").replace(CITATION, " ").replace(/^\s*(?:[-*]\s+|\d+[.)]\s+)/, "");
    for (const { token, value, attached } of figuresIn(prose)) {
      if (Number.isInteger(value) && value >= 0 && value <= 10 && !attached) continue;
      if (support.values.has(value) || asked.values.has(value)) continue;
      const digits = token.replace(/\D/g, "");
      if (digits.length >= 4 && support.compact.includes(digits)) continue;
      unsupported.add(token);
    }
  }
  return [...unsupported];
}
