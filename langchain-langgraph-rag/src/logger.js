import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Structured logging in the shape CNCF tooling expects: one JSON object per
// line, with the field names of the OpenTelemetry log data model (timestamp,
// severity_text, severity_number, body, attributes, resource, trace_id,
// span_id). Lines go to stderr (stdout belongs to the MCP protocol) and to a
// timestamped file in the root `logs/` folder. A collector such as
// OpenTelemetry's filelog receiver or Fluent Bit can ship either one as is.
//
// `body` is a stable event name ("retrieval.search"), never a sentence, so
// logs can be filtered by event. Details go in `attributes`. Question and
// answer text is never logged: only lengths, counts, scores and timings,
// unless LOG_QUERIES=true opts in to the search query.

const SEVERITY = { debug: 5, info: 9, warn: 13, error: 17 };
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// `node --test` should not write log files or flood the test report.
const underTest = Boolean(process.env.NODE_TEST_CONTEXT);

const settings = {
  service: process.env.OTEL_SERVICE_NAME ?? "docs-rag",
  level: process.env.LOG_LEVEL ?? (underTest ? "silent" : "info"),
  // An empty LOG_DIR turns the file off; stderr stays on unless LOG_STDERR=false.
  dir: process.env.LOG_DIR ?? path.join(PROJECT_ROOT, "logs"),
  stderr: process.env.LOG_STDERR !== "false",
  format: process.env.LOG_FORMAT ?? "json",
  includeQueries: process.env.LOG_QUERIES === "true",
};

let logFile = null;

// Called once by each entry point. The service name picks the file name and
// the `service.name` resource attribute; OTEL_SERVICE_NAME overrides it.
export function configureLogging(overrides = {}) {
  const { service, ...rest } = overrides;
  if (service && !process.env.OTEL_SERVICE_NAME) settings.service = service;
  Object.assign(settings, rest);
  logFile = null;
}

// One file per process start: logs/<service>-2026-10-26T10-30-00-123Z.log
function currentLogFile() {
  if (!settings.dir) return null;
  if (!logFile) {
    fs.mkdirSync(settings.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    logFile = path.join(settings.dir, `${settings.service}-${stamp}.log`);
  }
  return logFile;
}

// Request correlation. Everything logged while a request runs carries its
// trace_id, so one question can be followed through retrieval, the model
// calls and the response. A W3C `traceparent` header is honoured, so the
// id continues a trace started by a caller.
const traceStorage = new AsyncLocalStorage();
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

export function withTrace(run, { traceparent } = {}) {
  const parent = traceparent?.match(TRACEPARENT);
  const context = {
    traceId: parent?.[1] ?? crypto.randomBytes(16).toString("hex"),
    spanId: crypto.randomBytes(8).toString("hex"),
  };
  return traceStorage.run(context, run);
}

// For scripts with no request to wrap (the ingestion run): everything the
// process logs from here on shares one trace_id.
export function startTrace() {
  traceStorage.enterWith({
    traceId: crypto.randomBytes(16).toString("hex"),
    spanId: crypto.randomBytes(8).toString("hex"),
  });
}

export const currentTraceId = () => traceStorage.getStore()?.traceId;

// OpenTelemetry semantic conventions for exceptions.
function expandErrors(attributes) {
  const expanded = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value instanceof Error) {
      expanded["exception.type"] = value.name;
      expanded["exception.message"] = value.message;
      expanded["exception.stacktrace"] = value.stack;
    } else if (value !== undefined) {
      expanded[key] = value;
    }
  }
  return expanded;
}

function render(record) {
  if (settings.format !== "pretty") return JSON.stringify(record);
  const details = Object.entries(record.attributes)
    .filter(([key]) => key !== "exception.stacktrace")
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
  const trace = record.trace_id ? ` trace=${record.trace_id.slice(0, 8)}` : "";
  return `${record.timestamp} ${record.severity_text.padEnd(5)} [${record.scope}] ${record.body} ${details}${trace}`.trimEnd();
}

function write(level, scope, event, attributes) {
  if (settings.level === "silent" || SEVERITY[level] < (SEVERITY[settings.level] ?? SEVERITY.info)) return;
  const trace = traceStorage.getStore();
  const record = {
    timestamp: new Date().toISOString(),
    severity_text: level.toUpperCase(),
    severity_number: SEVERITY[level],
    body: event,
    attributes: expandErrors(attributes),
    resource: { "service.name": settings.service, "process.pid": process.pid },
    scope,
    trace_id: trace?.traceId,
    span_id: trace?.spanId,
  };
  const line = render(record);
  if (settings.stderr) process.stderr.write(`${line}\n`);
  try {
    const file = currentLogFile();
    // The file always gets JSON, whatever the console format is.
    if (file) fs.appendFileSync(file, `${settings.format === "pretty" ? JSON.stringify(record) : line}\n`);
  } catch (error) {
    // Logging must never take the application down. Give up on the file.
    settings.dir = "";
    process.stderr.write(`logging to file disabled: ${error.message}\n`);
  }
}

// `scope` names the part of the system logging (OpenTelemetry's
// instrumentation scope): "ingestion", "retrieval", "chat", "api".
export function createLogger(scope) {
  return {
    debug: (event, attributes = {}) => write("debug", scope, event, attributes),
    info: (event, attributes = {}) => write("info", scope, event, attributes),
    warn: (event, attributes = {}) => write("warn", scope, event, attributes),
    error: (event, attributes = {}) => write("error", scope, event, attributes),
  };
}

// The text of a user's question is not logged unless LOG_QUERIES=true.
export const queryAttributes = (query) => ({
  query_chars: query.length,
  ...(settings.includeQueries && { query }),
});

export const elapsedMs = (startedAt) => Math.round(performance.now() - startedAt);

// Wrap a graph node so every run logs its name, duration and a summary of
// what it decided. `summarize(update, state)` returns the attributes.
export const loggedNode =
  (log, stage, node, summarize = () => ({})) =>
  async (state, ...rest) => {
    const startedAt = performance.now();
    try {
      const update = await node(state, ...rest);
      log.info("stage.done", { stage, duration_ms: elapsedMs(startedAt), ...summarize(update ?? {}, state) });
      return update;
    } catch (error) {
      log.error("stage.failed", { stage, duration_ms: elapsedMs(startedAt), error });
      throw error;
    }
  };
