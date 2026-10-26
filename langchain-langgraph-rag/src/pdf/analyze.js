import { getResolvedPDFJS } from "unpdf";

// Text-layer glyphs that signal formulas: math operators, Greek, private-use
// and replacement characters (what a broken math font decodes to).
const MATH_CHARS =
  /[Ͱ-Ͽ←-⇿∀-⋿⟀-⟯⦀-⫿-�]/gu;

export function mathRatio(text) {
  const visible = text.replace(/\s/g, "");
  if (!visible) return 0;
  return (visible.match(MATH_CHARS)?.length ?? 0) / visible.length;
}

// Multiply two PDF affine matrices (row-vector convention, as pdf.js uses).
function multiply(m, n) {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

// Fraction of the page covered by painted images, so logos and icons don't
// count but a full-page scan does. Overlapping images may double count; the
// result is capped at 1.
export async function imageCoverage(page) {
  const { OPS } = await getResolvedPDFJS();
  const { fnArray, argsArray } = await page.getOperatorList();
  const [x0, y0, x1, y1] = page.view;
  const pageArea = (x1 - x0) * (y1 - y0);
  if (pageArea <= 0) return 0;

  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let covered = 0;

  fnArray.forEach((opCode, index) => {
    if (opCode === OPS.save) stack.push(ctm);
    else if (opCode === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (opCode === OPS.transform) ctm = multiply(argsArray[index], ctm);
    else if (
      opCode === OPS.paintImageXObject ||
      opCode === OPS.paintInlineImageXObject ||
      opCode === OPS.paintImageMaskXObject
    ) {
      // Images are drawn into the unit square, so |det| is the area.
      covered += Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]);
    }
  });

  return Math.min(1, covered / pageArea);
}
