import fs from "node:fs";
import { Annotation, Send, StateGraph, START, END } from "@langchain/langgraph";
import { extractText, getDocumentProxy, renderPageAsImage } from "unpdf";
import { imageCoverage, mathRatio } from "./analyze.js";
import { ocrImage } from "./ocr.js";

// A page goes to the OCR agent when its text layer can't be trusted.
const MIN_CHARS = Number(process.env.PDF_MIN_CHARS ?? 50); // scanned page
const MAX_IMAGE_COVERAGE = Number(process.env.PDF_MAX_IMAGE_COVERAGE ?? 0.2);
const MAX_MATH_RATIO = Number(process.env.PDF_MAX_MATH_RATIO ?? 0.02);
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

function routeFor({ chars, coverage, math }) {
  if (chars < MIN_CHARS) return { route: "ocr", reason: "no text layer" };
  if (coverage >= MAX_IMAGE_COVERAGE)
    return { route: "ocr", reason: `images cover ${(coverage * 100).toFixed(0)}%` };
  if (math >= MAX_MATH_RATIO)
    return { route: "ocr", reason: "formula glyphs in text layer" };
  return { route: "text", reason: "clean text layer" };
}

// Inspect every page and decide which agent handles it.
const classifyNode = async (state) => {
  const pdf = await openPdf(state.path);
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const layer = text[n - 1].trim();
    const coverage = await imageCoverage(await pdf.getPage(n));
    const math = mathRatio(layer);
    const decision = routeFor({ chars: layer.length, coverage, math });
    pages.push({ page: n, layer, coverage, math, ...decision });
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
    agent: "text",
    text: pageInfo.layer,
  })),
});

const ocrAgent = async (state) => {
  const targets = state.pages;

  if (!OCR_ENABLED) {
    console.error(`OCR disabled: using text layer for ${targets.length} page(s)`);
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
  for (const p of targets) {
    try {
      const png = await renderPageAsImage(pdf, p.page, {
        canvasImport: () => import("@napi-rs/canvas"),
        scale: RENDER_SCALE,
      });
      extracted.push({ page: p.page, agent: "ocr", text: await ocrImage(png) });
    } catch (err) {
      // Better a possibly incomplete text layer than a hole in the index.
      console.error(`OCR failed on page ${p.page}, using text layer: ${err.message}`);
      extracted.push({ page: p.page, agent: "text-fallback", text: p.layer });
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
  const out = await pdfGraph.invoke({ path });
  return { pages: out.result, routing: out.pages };
}
