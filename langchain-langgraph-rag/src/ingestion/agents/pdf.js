import path from "node:path";
import { parsePdf } from "../../pdf/graph.js";

export default {
  name: "pdf",
  description:
    "Reads PDF documents page by page. Pages with a clean text layer are extracted directly; scanned pages, pages with large images, and formula-heavy pages are OCR'd with Unlimited-OCR.",
  accepts: [".pdf"],
  async process(filePath) {
    const file = path.basename(filePath);
    const { pages, routing } = await parsePdf(filePath);
    for (const r of routing)
      console.error(`${file} p${r.page}: ${r.route} (${r.reason})`);
    return pages.map((p) => ({ text: p.text, page: p.page, via: p.agent }));
  },
};
