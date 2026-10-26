import { createLogger, elapsedMs } from "../logger.js";
import fs from "node:fs";
import { Annotation, Send, StateGraph, START, END } from "@langchain/langgraph";
import { extractText, getDocumentProxy, renderPageAsImage } from "unpdf";
import { imageCoverage, mathRatio } from "./analyze.js";
import { ocrImage } from "./ocr.js";
import { routePage } from "./routePage.js";
import { layoutEngine, parseLayout } from "./layoutParser.js";

const log = createLogger("ingestion");

// A page goes to the OCR agent when its text layer can't be trusted (see
// routePage.js). PDF_OCR_IMAGE_COVERAGE is opt-in: unset, images never trigger
// OCR on their own.
const THRESHOLDS = {
  minChars: Number(process.env.PDF_MIN_CHARS ?? 50),
  maxMathRatio: Number(process.env.PDF_MAX_MATH_RATIO ?? 0.02),
  imageCoverage: process.env.PDF_OCR_IMAGE_COVERAGE
    ? Number(process.env.PDF_OCR_IMAGE_COVERAGE)
    : undefined,
};
const RENDER_SCALE = Number(process.env.PDF_RENDER_SCALE ?? 2);
const OCR_ENABLED = process.env.OCR_ENABLED !== "false";

const PdfState = Annotation.Root({
  path: Annotation({ reducer: (_previous, next) => next, default: () => "" }),
  pages: Annotation({ reducer: (_previous, next) => next, default: () => [] }),
  extracted: Annotation({ reducer: (existing, incoming) => existing.concat(incoming), default: () => [] }),
  result: Annotation({ reducer: (_previous, next) => next, default: () => [] }),
});

const openPdf = (path) =>
  getDocumentProxy(new Uint8Array(fs.readFileSync(path)));

// Page text from the layout-aware parser when one is configured (tables stay
// tables, columns stay in order), else null so the raw text layer is used.
async function layoutPages(path, pageCount) {
  if (!layoutEngine()) return null;
  const startedAt = performance.now();
  try {
    const pages = await parseLayout(path);
    if (pages.length === pageCount) {
      log.info("pdf.layout_parsed", { engine: layoutEngine(), pages: pages.length, duration_ms: elapsedMs(startedAt) });
      return pages;
    }
    log.warn("pdf.layout_fallback", { reason: "page_count_mismatch", layout_pages: pages.length, pdf_pages: pageCount });
  } catch (error) {
    log.warn("pdf.layout_fallback", { reason: "parser_failed", engine: layoutEngine(), error });
  }
  return null;
}

// Inspect every page and decide which agent handles it.
const classifyNode = async (state) => {
  const pdf = await openPdf(state.path);
  const { text } = await extractText(pdf, { mergePages: false });
  const layout = await layoutPages(state.path, pdf.numPages);
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const layer = (layout?.[pageNumber - 1] ?? text[pageNumber - 1]).trim();
    // Image coverage costs a pass over the page's drawing operations, so only
    // measure it when a rule uses it.
    const coverage =
      THRESHOLDS.imageCoverage === undefined
        ? 0
        : await imageCoverage(await pdf.getPage(pageNumber));
    const math = mathRatio(layer);
    const decision = routePage({ chars: layer.length, coverage, math }, THRESHOLDS);
    pages.push({ page: pageNumber, layer, coverage, math, from: layout ? "layout" : "text", ...decision });
  }
  return { pages };
};

// The router: a conditional edge that dispatches each agent only the pages
// routed to it. An agent with no pages is never invoked.
const routePages = (state) => {
  const sends = ["text", "ocr"]
    .map((agent) => [
      agent,
      state.pages.filter((pageInfo) => pageInfo.route === agent),
    ])
    .filter(([, pages]) => pages.length > 0)
    .map(([agent, pages]) => new Send(agent, { path: state.path, pages }));
  return sends.length ? sends : "merge";
};

// Both agents receive only their own pages as `state.pages`.
const textAgent = (state) => ({
  extracted: state.pages.map((pageInfo) => ({
    page: pageInfo.page,
    agent: pageInfo.from === "layout" ? "layout" : "text",
    text: pageInfo.layer,
  })),
});

const ocrAgent = async (state) => {
  const targets = state.pages;

  if (!OCR_ENABLED) {
    log.warn("pdf.ocr_disabled", { pages: targets.length });
    return {
      extracted: targets.map((pageInfo) => ({
        page: pageInfo.page,
        agent: "text-fallback",
        text: pageInfo.layer,
      })),
    };
  }

  const pdf = await openPdf(state.path);
  const extracted = [];
  // Sequential: the OCR model is the bottleneck and usually single-GPU.
  for (const pageInfo of targets) {
    try {
      const pageImage = await renderPageAsImage(pdf, pageInfo.page, {
        canvasImport: () => import("@napi-rs/canvas"),
        scale: RENDER_SCALE,
      });
      extracted.push({ page: pageInfo.page, agent: "ocr", text: await ocrImage(pageImage) });
    } catch (err) {
      // Better a possibly incomplete text layer than a hole in the index.
      log.warn("pdf.ocr_failed", { page: pageInfo.page, error: err });
      extracted.push({ page: pageInfo.page, agent: "text-fallback", text: pageInfo.layer });
    }
  }
  return { extracted };
};

const mergeNode = (state) => ({
  result: [...state.extracted].sort((first, second) => first.page - second.page),
});

const pdfGraph = new StateGraph(PdfState)
  .addNode("classify", classifyNode)
  .addNode("text", textAgent)
  .addNode("ocr", ocrAgent)
  .addNode("merge", mergeNode)
  .addEdge(START, "classify")
  .addConditionalEdges("classify", routePages, ["text", "ocr", "merge"])
  .addEdge("text", "merge")
  .addEdge("ocr", "merge")
  .addEdge("merge", END)
  .compile();

// Returns [{ page, agent, text }] in page order, plus the routing decisions.
export async function parsePdf(path) {
  const output = await pdfGraph.invoke({ path });
  return { pages: output.result, routing: output.pages };
}
