import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configureLogging, createLogger, currentTraceId, queryAttributes, withTrace } from "./logger.js";

function withTempLogs(overrides, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docs-rag-logs-"));
  configureLogging({ service: "test-service", level: "debug", dir, stderr: false, format: "json", includeQueries: false, ...overrides });
  try {
    run(dir);
  } finally {
    configureLogging({ level: "silent", dir: "" });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const readRecords = (dir) => {
  const [file] = fs.readdirSync(dir);
  return {
    file,
    records: fs.readFileSync(path.join(dir, file), "utf8").trim().split("\n").map((line) => JSON.parse(line)),
  };
};

test("writes OpenTelemetry-shaped JSON lines to a timestamped file", () => {
  withTempLogs({}, (dir) => {
    createLogger("retrieval").info("retrieval.search", { kept: 3 });
    const { file, records } = readRecords(dir);
    assert.match(file, /^test-service-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.log$/);
    const [record] = records;
    assert.equal(record.body, "retrieval.search");
    assert.equal(record.severity_text, "INFO");
    assert.equal(record.severity_number, 9);
    assert.equal(record.scope, "retrieval");
    assert.equal(record.attributes.kept, 3);
    assert.equal(record.resource["service.name"], "test-service");
    assert.ok(!Number.isNaN(Date.parse(record.timestamp)));
  });
});

test("levels below the threshold are dropped", () => {
  withTempLogs({ level: "warn" }, (dir) => {
    const log = createLogger("chat");
    log.info("ignored");
    log.warn("kept");
    assert.deepEqual(readRecords(dir).records.map((record) => record.body), ["kept"]);
  });
});

test("everything logged inside withTrace shares one trace_id, and a traceparent is continued", () => {
  withTempLogs({}, (dir) => {
    const log = createLogger("chat");
    withTrace(() => {
      log.info("first");
      log.info("second");
    });
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    withTrace(() => log.info("continued"), { traceparent });
    log.info("outside");
    const [first, second, continued, outside] = readRecords(dir).records;
    assert.equal(first.trace_id, second.trace_id);
    assert.match(first.trace_id, /^[0-9a-f]{32}$/);
    assert.equal(continued.trace_id, "0af7651916cd43dd8448eb211c80319c");
    assert.equal(outside.trace_id, undefined);
  });
  assert.equal(currentTraceId(), undefined);
});

test("errors use the OpenTelemetry exception attributes", () => {
  withTempLogs({}, (dir) => {
    createLogger("api").error("request.failed", { error: new TypeError("boom") });
    const [record] = readRecords(dir).records;
    assert.equal(record.attributes["exception.type"], "TypeError");
    assert.equal(record.attributes["exception.message"], "boom");
    assert.match(record.attributes["exception.stacktrace"], /boom/);
  });
});

test("the query text is logged only when opted in", () => {
  withTempLogs({}, () => assert.deepEqual(queryAttributes("secret question"), { query_chars: 15 }));
  withTempLogs({ includeQueries: true }, () =>
    assert.deepEqual(queryAttributes("secret question"), { query_chars: 15, query: "secret question" }),
  );
});

test("an empty log directory disables the file sink", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docs-rag-logs-"));
  configureLogging({ service: "test-service", level: "info", dir: "", stderr: false });
  createLogger("api").info("no.file");
  configureLogging({ level: "silent" });
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
