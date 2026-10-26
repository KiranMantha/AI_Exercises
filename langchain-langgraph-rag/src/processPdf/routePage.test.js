import test from "node:test";
import assert from "node:assert/strict";
import { routePage } from "./routePage.js";

const thresholds = { minChars: 50, maxMathRatio: 0.02, imageCoverage: undefined };
const page = (overrides) => ({ chars: 800, coverage: 0, math: 0, ...overrides });

test("a clean text page is read from its text layer", () => {
  assert.equal(routePage(page(), thresholds).route, "text");
});

test("a page with no text layer is OCR'd", () => {
  assert.deepEqual(routePage(page({ chars: 0 }), thresholds), { route: "ocr", reason: "no text layer" });
});

test("a garbled text layer (broken math font) is OCR'd", () => {
  assert.equal(routePage(page({ math: 0.1 }), thresholds).route, "ocr");
});

test("large images alone do not send a page with real text to OCR", () => {
  // Marketing PDFs: full-bleed photos behind real text.
  assert.equal(routePage(page({ coverage: 0.95 }), thresholds).route, "text");
});

test("a scan with a searchable text layer is read from the text layer", () => {
  assert.equal(routePage(page({ coverage: 1, chars: 3000 }), thresholds).route, "text");
});

test("the image rule applies only when explicitly enabled", () => {
  const optIn = { ...thresholds, imageCoverage: 0.5 };
  assert.equal(routePage(page({ coverage: 0.6 }), optIn).route, "ocr");
  assert.equal(routePage(page({ coverage: 0.4 }), optIn).route, "text");
});
