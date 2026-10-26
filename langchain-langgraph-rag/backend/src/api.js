import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { searchDocsDetailed } from "./rag.js";
import { chatLlm } from "./chat/llm.js";
import { createChatGraph, runChat } from "./chat/graph.js";
import { createAgentGraph, runAgentChat } from "./chat/agent.js";
import { looksLikeComparison } from "./chat/route.js";
import { connectToMcp } from "./chat/mcpClient.js";
import { createDocsMcpServer } from "./mcp/tools.js";
import { docsStore } from "./mcp/docsStore.js";
import { configureLogging, createLogger, currentTraceId, elapsedMs, withTrace } from "./logger.js";

configureLogging({ service: "docs-rag-api" });
const log = createLogger("api");

const PORT = Number(process.env.API_PORT ?? 3001);
const MAX_BODY_BYTES = 16 * 1024;
const RATE_LIMIT_PER_MINUTE = Number(process.env.CHAT_RATE_LIMIT_PER_MIN ?? 30);
const WEB_DIST = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "web",
  "dist",
);

// How a question is answered:
//   auto      (default) comparisons go to the agent, everything else to the
//             cheaper fixed pipeline
//   agent     the chat model is an MCP client: it calls the document tools
//             itself, can search again with other wording, then answers
//   pipeline  fixed retrieve, rerank, answer steps
//   extractive no chat model configured: cited excerpts only
// Chosen with CHAT_RETRIEVAL.
const pipelineGraph = createChatGraph({ search: searchDocsDetailed, llm: chatLlm });
let runChatTurn = (body) => runChat(pipelineGraph, body);
let chatMode = chatLlm.isConfigured() ? "pipeline" : "extractive";

const retrieval = process.env.CHAT_RETRIEVAL ?? "auto";
if (chatLlm.isConfigured() && retrieval !== "pipeline") {
  const mcp = await connectToMcp(
    createDocsMcpServer({
      searchDetailed: searchDocsDetailed,
      store: docsStore,
      rerankFloor: Number(process.env.RERANK_REJECT_BELOW ?? -Infinity),
    }),
  );
  const agentGraph = createAgentGraph({ mcp, llm: chatLlm });
  const agentTurn = (body) => runAgentChat(agentGraph, body);
  if (retrieval === "agent") {
    runChatTurn = agentTurn;
    chatMode = "agent";
  } else {
    runChatTurn = (body) => (looksLikeComparison(body.message) ? agentTurn(body) : runChat(pipelineGraph, body));
    chatMode = "auto";
  }
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
};

const requestTimes = new Map(); // ip -> timestamps within the last minute

function rateLimited(ip) {
  const now = Date.now();
  const recent = (requestTimes.get(ip) ?? []).filter((time) => now - time < 60_000);
  recent.push(now);
  requestTimes.set(ip, recent);
  return recent.length > RATE_LIMIT_PER_MINUTE;
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json", ...SECURITY_HEADERS });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("too large"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid JSON"), { status: 400 });
  }
}

async function handleChat(request, response) {
  if (rateLimited(request.socket.remoteAddress)) {
    log.warn("chat.rate_limited", { limit_per_minute: RATE_LIMIT_PER_MINUTE });
    return sendJson(response, 429, { error: "Too many requests. Please slow down." });
  }
  if (!request.headers["content-type"]?.startsWith("application/json")) {
    return sendJson(response, 415, { error: "Send application/json." });
  }
  const { message, history } = await readJsonBody(request);
  const startedAt = performance.now();
  log.info("chat.request", {
    message_chars: typeof message === "string" ? message.length : null,
    history_turns: Array.isArray(history) ? history.length : 0,
    mode: chatMode,
  });
  const result = await runChatTurn({ message, history });
  // Outcomes only, never the question or the answer.
  log.info("chat.response", {
    status: result.status,
    reason: result.reason ?? undefined,
    enforcement_layer: result.enforcementLayer ?? undefined,
    mode: result.mode,
    reranked_by: result.rerankedBy,
    rewritten: result.rewritten,
    tools: result.toolCalls?.map((call) => call.name),
    sources: result.sources.map((source) => source.source),
    answer_chars: result.answer?.length ?? 0,
    prompt_version: result.promptVersion,
    llm_calls: result.usage.calls,
    prompt_tokens: result.usage.promptTokens,
    completion_tokens: result.usage.completionTokens,
    cached_tokens: result.usage.cachedTokens,
    duration_ms: elapsedMs(startedAt),
  });
  response.setHeader("x-trace-id", currentTraceId());
  sendJson(response, 200, result);
}

function serveStatic(request, response) {
  const requested = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  let filePath = path.join(WEB_DIST, requested);
  // Stay inside the build folder; unknown paths fall back to the app shell.
  if (!filePath.startsWith(WEB_DIST) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory())
    filePath = path.join(WEB_DIST, "index.html");
  if (!fs.existsSync(filePath)) {
    return sendJson(response, 404, { error: "Frontend not built. Run pnpm web:build." });
  }
  response.writeHead(200, {
    "content-type": MIME_TYPES[path.extname(filePath)] ?? "application/octet-stream",
    ...SECURITY_HEADERS,
  });
  fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer((request, response) =>
  withTrace(() => handleRequest(request, response), { traceparent: request.headers.traceparent }),
);

async function handleRequest(request, response) {
  try {
    const { pathname } = new URL(request.url, "http://localhost");
    if (pathname === "/api/health" && request.method === "GET") {
      return sendJson(response, 200, {
        ok: true,
        mode: chatMode,
      });
    }
    if (pathname === "/api/chat") {
      return request.method === "POST"
        ? await handleChat(request, response)
        : sendJson(response, 405, { error: "Use POST." });
    }
    if (pathname.startsWith("/api/")) return sendJson(response, 404, { error: "Not found." });
    if (request.method !== "GET") return sendJson(response, 405, { error: "Use GET." });
    serveStatic(request, response);
  } catch (error) {
    if (error.status) {
      log.warn("request.rejected", { path: request.url, status: error.status, reason: error.message });
      return sendJson(response, error.status, { error: error.message });
    }
    log.error("request.failed", { path: request.url, error });
    sendJson(response, 500, { error: "Something went wrong." });
  }
}

server.listen(PORT, () => {
  log.info("api.started", {
    port: PORT,
    mode: chatMode,
    chat_model: chatLlm.isConfigured() ? process.env.CHAT_MODEL : null,
    rerank_model: process.env.RERANK_MODEL ?? "default",
  });
});
