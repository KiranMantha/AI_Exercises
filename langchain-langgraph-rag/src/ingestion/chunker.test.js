import test from "node:test";
import assert from "node:assert/strict";
import { chunkDocument } from "./chunker.js";

const texts = (chunks) => chunks.map((chunk) => chunk.text);

test("heading path is attached and nested sections stay under their parent", async () => {
  const chunks = await chunkDocument([
    { text: "# Billing\n\nIntro text that is long enough to stand alone as its own paragraph, padding it out well past the minimum chunk size so the next heading starts a new chunk.\n\n## Refunds\n\nRefunds take five days." },
  ]);
  const refund = chunks.find((chunk) => chunk.text.includes("Refunds take"));
  assert.equal(refund.section, "Billing > Refunds");
  assert.match(refund.text, /^Billing\n\n## Refunds/);
});

test("a table is never split mid-way when it fits", async () => {
  const table = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |";
  const chunks = await chunkDocument([{ text: `Before.\n\n${table}\n\nAfter.` }]);
  assert.equal(chunks.filter((chunk) => chunk.text.includes(table)).length, 1);
});

test("an oversized table is split by rows and repeats its header", async () => {
  const rows = Array.from({ length: 80 }, (_unused, index) => `| row${index} | value${index} |`);
  const table = ["| name | value |", "|---|---|", ...rows].join("\n");
  const chunks = await chunkDocument([{ text: table }]);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.text.startsWith("| name | value |\n|---|---|"));
  const seen = chunks.flatMap((chunk) => chunk.text.match(/row\d+/g));
  assert.equal(seen.length, 80);
});

test("display math and code fences stay whole", async () => {
  const math = "$$\nE = mc^2 \\\\\n a^2 + b^2 = c^2\n$$";
  const code = "```js\nconst x = 1;\n\nconst y = 2;\n```";
  const chunks = await chunkDocument([{ text: `Intro.\n\n${math}\n\n${code}` }]);
  assert.ok(texts(chunks).some((text) => text.includes(math)));
  assert.ok(texts(chunks).some((text) => text.includes(code)));
});

test("a heading is never stranded at the end of a chunk", async () => {
  const filler = "x".repeat(700);
  const chunks = await chunkDocument([
    { text: `# A\n\n${filler}\n\n## B\n\n${"y".repeat(500)}` },
  ]);
  for (const chunk of chunks) assert.doesNotMatch(chunk.text.trimEnd(), /(^|\n)#{1,6} [^\n]+$/);
  assert.ok(chunks.some((chunk) => chunk.text.includes("## B") && chunk.text.includes("yyy")));
});

test("headings carry across pages and chunks record their page span", async () => {
  const chunks = await chunkDocument([
    { text: "# Report\n\nFirst page text.", page: 1, via: "text" },
    { text: "More text on the second page.", page: 2, via: "ocr" },
  ]);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].section, "Report");
  assert.equal(chunks[0].page, 1);
  assert.equal(chunks[0].pageEnd, 2);
  assert.equal(chunks[0].via, "text+ocr");
});

test("a paragraph split by a page break is chunked as one paragraph", async () => {
  const chunks = await chunkDocument([
    { text: "Sentence one continues", page: 1 },
    { text: "onto the next page.", page: 2 },
  ]);
  assert.equal(chunks.length, 1);
});

test("an oversized paragraph falls back to overlapping splits", async () => {
  const chunks = await chunkDocument([{ text: "word ".repeat(600) }]);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.text.length <= 800);
});

test("empty input yields no chunks", async () => {
  assert.deepEqual(await chunkDocument([{ text: "  \n\n " }]), []);
});
