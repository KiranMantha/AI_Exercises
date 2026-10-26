/**
 * Decide whether a PDF page is read from its text layer or OCR'd.
 *
 * The question is "can this page's text layer be trusted?", which is checkable
 * on any PDF:
 *   - no real text layer (a scan without a text layer)    -> OCR
 *   - text layer garbled by a broken math/symbol font     -> OCR
 *   - otherwise                                           -> text layer
 *
 * Images are not evidence against the text layer: a page with a photo
 * background and real text is read from the text. Text *inside* images is a
 * separate need (infographics, screenshots), so it is opt-in: set
 * `imageCoverage` to OCR pages where images cover at least that fraction of
 * the page. Leave it unset unless the corpus actually has image-only content.
 */
export function routePage({ chars, coverage, math }, { minChars, maxMathRatio, imageCoverage }) {
  if (chars < minChars) return { route: "ocr", reason: "no text layer" };
  if (math >= maxMathRatio) return { route: "ocr", reason: "formula glyphs in text layer" };
  if (imageCoverage !== undefined && coverage >= imageCoverage)
    return { route: "ocr", reason: `images cover ${(coverage * 100).toFixed(0)}% (opt-in rule)` };
  return { route: "text", reason: "usable text layer" };
}
