import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { layoutEngine, layoutSignature, parseLayout } from "./layoutParser.js";

// Stand-ins for the Python parser: tiny Node scripts run with the Node binary.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "layout-"));
const script = (name, body) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
};

function withParser(scriptPath, run, extra = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, {
    PDF_LAYOUT_ENGINE: "fake",
    PDF_LAYOUT_PYTHON: process.execPath,
    PDF_LAYOUT_SCRIPT: scriptPath,
    ...extra,
  });
  return Promise.resolve(run()).finally(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
}

test("pages come back in order as Markdown", async () => {
  const ok = script(
    "ok.js",
    `console.log(JSON.stringify({ engine: process.argv[3], pages: [{ page: 1, markdown: "| a | b |" }, { page: 2, markdown: "text" }] }))`,
  );
  const pages = await withParser(ok, () => parseLayout("any.pdf"));
  assert.deepEqual(pages, ["| a | b |", "text"]);
});

test("the PDF path is passed as one argument, never through a shell", async () => {
  const echo = script("echo.js", `console.log(JSON.stringify({ pages: [{ markdown: process.argv[4] }] }))`);
  const tricky = "a b; rm -rf $(whoami) 'quote'.pdf";
  assert.deepEqual(await withParser(echo, () => parseLayout(tricky)), [tricky]);
});

test("a parser that exits with an error rejects with its message", async () => {
  const bad = script("bad.js", `console.error("engine 'x' is not installed"); process.exit(2)`);
  await assert.rejects(withParser(bad, () => parseLayout("a.pdf")), /not installed/);
});

test("unreadable output rejects", async () => {
  const junk = script("junk.js", `console.log("not json")`);
  await assert.rejects(withParser(junk, () => parseLayout("a.pdf")), /unreadable output/);
  const wrong = script("wrong.js", `console.log(JSON.stringify({ nope: 1 }))`);
  await assert.rejects(withParser(wrong, () => parseLayout("a.pdf")), /unreadable output/);
});

test("a parser that hangs is stopped by the timeout", async () => {
  const slow = script("slow.js", `setTimeout(() => {}, 60000)`);
  await assert.rejects(withParser(slow, () => parseLayout("a.pdf"), { PDF_LAYOUT_TIMEOUT_MS: "300" }), /layout parser failed/);
});

test("without an engine configured nothing runs and the signature is empty", async () => {
  const saved = process.env.PDF_LAYOUT_ENGINE;
  delete process.env.PDF_LAYOUT_ENGINE;
  try {
    assert.equal(layoutEngine(), undefined);
    assert.equal(layoutSignature(), "");
    await assert.rejects(parseLayout("a.pdf"), /not set/);
  } finally {
    if (saved !== undefined) process.env.PDF_LAYOUT_ENGINE = saved;
  }
});

test("the engine is part of the signature so switching it re-reads documents", async () => {
  await withParser("unused", () => assert.equal(layoutSignature(), "+fake"));
});

test("noise printed before the JSON line is ignored", async () => {
  const noisy = script(
    "noisy.js",
    `console.log("Loading models..."); console.log("progress 50%"); console.log(JSON.stringify({ pages: [{ page: 1, markdown: "ok" }] }))`,
  );
  assert.deepEqual(await withParser(noisy, () => parseLayout("a.pdf")), ["ok"]);
});
