import path from "node:path";
import { parsePdf } from "../../processPdf/graph.js";
import { createLogger } from "../../logger.js";

const log = createLogger("ingestion");

export default {
  name: "pdf",
  description:
    "Reads PDF documents page by page. Pages with a clean text layer are extracted directly; scanned pages, pages with large images, and formula-heavy pages are OCR'd with Unlimited-OCR.",
  accepts: [".pdf"],
  async process(filePath) {
    const file = path.basename(filePath);
    const { pages, routing } = await parsePdf(filePath);
    for (const pageRouting of routing)
      log.debug("pdf.page_routed", { doc: file, page: pageRouting.page, route: pageRouting.route, reason: pageRouting.reason });
    const routes = {};
    for (const pageRouting of routing) routes[pageRouting.route] = (routes[pageRouting.route] ?? 0) + 1;
    log.info("pdf.parsed", { doc: file, pages: pages.length, routes });
    return pages.map((parsedPage) => ({
      text: parsedPage.text,
      page: parsedPage.page,
      via: parsedPage.agent,
    }));
  },
};
