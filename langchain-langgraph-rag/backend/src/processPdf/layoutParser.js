import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

// Layout-aware PDF extraction: an external parser turns each page into
// Markdown that keeps tables as tables and columns in reading order, which the
// raw text layer cannot do. The parsers are Python, so they run as a
// subprocess (no shell) that prints JSON. Unset PDF_LAYOUT_ENGINE and none of
// this runs.
const DEFAULT_SCRIPT = fileURLToPath(new URL("../../scripts/pdf_to_markdown.py", import.meta.url));
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

export const layoutEngine = () => process.env.PDF_LAYOUT_ENGINE || undefined;

// Part of what makes an indexed document stale: switching the engine changes
// every PDF's text, so documents must be read again.
export const layoutSignature = () => (layoutEngine() ? `+${layoutEngine()}` : "");

/** Returns the Markdown of each page, in page order. Rejects on any failure. */
export function parseLayout(pdfPath) {
  const engine = layoutEngine();
  if (!engine) return Promise.reject(new Error("PDF_LAYOUT_ENGINE is not set"));
  return new Promise((resolve, reject) => {
    execFile(
      process.env.PDF_LAYOUT_PYTHON || "python3",
      [process.env.PDF_LAYOUT_SCRIPT ?? DEFAULT_SCRIPT, "--engine", engine, pdfPath],
      {
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: Number(process.env.PDF_LAYOUT_TIMEOUT_MS ?? 600_000),
      },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(`layout parser failed: ${(stderr || error.message).trim().slice(-300)}`));
        try {
          // The JSON is the last line; anything a library printed before it is noise.
          const { pages } = JSON.parse(stdout.trim().split("\n").at(-1));
          if (!Array.isArray(pages)) throw new Error("no pages array");
          resolve(pages.map((page) => page.markdown ?? ""));
        } catch (parseError) {
          reject(new Error(`layout parser returned unreadable output: ${parseError.message}`));
        }
      },
    );
  });
}
