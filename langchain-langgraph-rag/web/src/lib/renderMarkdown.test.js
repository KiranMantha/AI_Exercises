import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// DOMPurify binds to the window that exists when it is first imported.
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const { renderMarkdown } = await import("./renderMarkdown.js");

const render = (text, ids = [1, 2]) => renderMarkdown(text, new Set(ids), "m0");

test("formatting survives: bold, code, lists", () => {
  const html = render("**key** and `code`\n\n- one\n- two");
  assert.match(html, /<strong>key<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<li>one<\/li>/);
});

test("citations link to known sources only", () => {
  const html = render("Five days [1]. Unknown [9].");
  assert.match(html, /<a class="cite" href="#m0-source-1">1<\/a>/);
  assert.match(html, /\[9\]/);
  assert.doesNotMatch(html, /source-9/);
});

test("scripts, event handlers, images and iframes are removed", () => {
  const html = render(
    '<script>alert(1)</script><img src=x onerror="alert(1)"><iframe src="//evil"></iframe>' +
      '<p onclick="alert(1)">hi</p>![pic](https://evil.example/p.png)',
  );
  assert.doesNotMatch(html, /<script|<img|<iframe|onerror|onclick/i);
  assert.match(html, /<p>hi<\/p>/);
});

test("javascript: and data: links are neutralised", () => {
  const html = render("[a](javascript:alert(1)) [b](data:text/html;base64,PHNjcmlwdD4=)");
  assert.doesNotMatch(html, /javascript:|data:/i);
});

test("external links open safely in a new tab", () => {
  const html = render("[docs](https://example.com/page)");
  assert.match(html, /href="https:\/\/example\.com\/page"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /target="_blank"/);
});

test("a citation index cannot be used to inject markup", () => {
  const html = render("[1]", [1]);
  assert.doesNotMatch(html, /<script/i);
});
