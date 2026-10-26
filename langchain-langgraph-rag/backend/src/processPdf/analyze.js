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
function multiply(matrix, other) {
  return [
    matrix[0] * other[0] + matrix[1] * other[2],
    matrix[0] * other[1] + matrix[1] * other[3],
    matrix[2] * other[0] + matrix[3] * other[2],
    matrix[2] * other[1] + matrix[3] * other[3],
    matrix[4] * other[0] + matrix[5] * other[2] + other[4],
    matrix[4] * other[1] + matrix[5] * other[3] + other[5],
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

  let currentMatrix = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let covered = 0;

  fnArray.forEach((opCode, index) => {
    if (opCode === OPS.save) stack.push(currentMatrix);
    else if (opCode === OPS.restore) currentMatrix = stack.pop() ?? currentMatrix;
    else if (opCode === OPS.transform) currentMatrix = multiply(argsArray[index], currentMatrix);
    else if (
      opCode === OPS.paintImageXObject ||
      opCode === OPS.paintInlineImageXObject ||
      opCode === OPS.paintImageMaskXObject
    ) {
      // Images are drawn into the unit square, so |det| is the area.
      covered += Math.abs(currentMatrix[0] * currentMatrix[3] - currentMatrix[1] * currentMatrix[2]);
    }
  });

  return Math.min(1, covered / pageArea);
}
