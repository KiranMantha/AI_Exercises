import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

const MAX_CHARS = 800;
// A table is one unit of meaning: split across chunks, the rows lose the
// column headers that say what each cell is. So a table stays whole up to this
// size (an embedding model sees only the start of it, but keyword search, the
// reranker and the chat model read all of it) and only larger ones are split.
const MAX_TABLE_CHARS = Number(process.env.CHUNK_MAX_TABLE_CHARS ?? 3000);
const MIN_CHARS = 150; // a section smaller than this is merged with the next
const OVERLAP = 100; // only used inside a single oversized paragraph

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const TABLE_ROW = /^\s*\|/;
const MATH_OPEN = /^\s*(\$\$|\\\[)/;

const MARKED = /^(•|●|✓|✔|✅|x|yes|y)$/i;
const UNMARKED = /^(-|–|—|✗|✘|no|n\/a)?$/i;

const tableCells = (row) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());

// A matrix table (rows x columns, cells just marked or unmarked) is nearly
// all symbols, so neither embeddings nor keyword search can match it to a
// question. A plain-language digest, stated once per table and generated
// from its own cells, makes it findable: how many columns there are, and
// for each row which columns are marked.
export function describeMatrix(table) {
  const [headerRow, , ...bodyRows] = table.split("\n").filter((line) => TABLE_ROW.test(line));
  if (!headerRow || !bodyRows.length) return "";
  const columns = tableCells(headerRow).slice(1);
  const sentences = [];
  for (const row of bodyRows) {
    const [label, ...cells] = tableCells(row);
    if (!label || cells.length !== columns.length) continue;
    if (!cells.every((cell) => MARKED.test(cell) || UNMARKED.test(cell))) continue;
    const marked = columns.filter((_, index) => MARKED.test(cells[index]));
    sentences.push(`${label}: ${marked.length ? marked.join(", ") : "none"}.`);
  }
  if (!sentences.length) return "";
  return [`Summary of the table above, ${columns.length} columns: ${columns.join(", ")}.`, ...sentences.map((sentence) => `Marked columns for ${sentence}`)].join("\n");
}

// The digest goes after the table (measured: putting it first ranked worse), only while the whole thing still fits as one
// chunk; a table that will be split by rows is left as it is.
function withDigest(table) {
  const digest = describeMatrix(table);
  const combined = digest ? `${table}\n\n${digest}` : table;
  return combined.length <= MAX_TABLE_CHARS ? combined : table;
}

// Split text into blocks. Code, math and tables are atomic: chunking never
// cuts through them unless one is bigger than a whole chunk.
function parseBlocks(text, meta) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let paragraphLines = [];
  const flushPara = () => {
    if (paragraphLines.length) blocks.push({ ...meta, type: "paragraph", text: paragraphLines.join("\n") });
    paragraphLines = [];
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const fence = line.match(FENCE);
    const math = line.match(MATH_OPEN);
    const heading = line.match(HEADING);

    if (fence) {
      flushPara();
      const body = [line];
      while (++lineIndex < lines.length) {
        body.push(lines[lineIndex]);
        if (lines[lineIndex].trim().startsWith(fence[1])) break;
      }
      blocks.push({ ...meta, type: "code", text: body.join("\n") });
    } else if (math) {
      flushPara();
      const close = math[1] === "$$" ? "$$" : "\\]";
      const body = [line];
      const closedOnSameLine = line.trim().length > 2 && line.trim().endsWith(close);
      while (!closedOnSameLine && ++lineIndex < lines.length) {
        body.push(lines[lineIndex]);
        if (lines[lineIndex].includes(close)) break;
      }
      blocks.push({ ...meta, type: "math", text: body.join("\n") });
    } else if (/^\s*<table/i.test(line)) {
      flushPara();
      const body = [line];
      while (!/<\/table>/i.test(lines[lineIndex]) && ++lineIndex < lines.length) body.push(lines[lineIndex]);
      blocks.push({ ...meta, type: "table", text: body.join("\n") });
    } else if (TABLE_ROW.test(line)) {
      flushPara();
      const body = [line];
      while (lineIndex + 1 < lines.length && TABLE_ROW.test(lines[lineIndex + 1])) body.push(lines[++lineIndex]);
      blocks.push({ ...meta, type: "table", text: withDigest(body.join("\n")) });
    } else if (heading) {
      flushPara();
      blocks.push({
        ...meta,
        type: "heading",
        level: heading[1].length,
        title: heading[2],
        text: line.trim(),
      });
    } else if (!line.trim()) {
      flushPara();
    } else {
      paragraphLines.push(line);
    }
  }
  flushPara();
  return blocks;
}

// Split an oversized atomic block without losing its context: a table keeps
// its header on every piece, code keeps its fences. Math is never split.
function splitOversized(block) {
  const lines = block.text.split("\n");
  if (block.type === "table" && TABLE_ROW.test(lines[0])) {
    const header = lines.slice(0, 2).join("\n");
    const pieces = [];
    let current = [];
    for (const row of lines.slice(2)) {
      const size = header.length + current.join("\n").length + row.length + 2;
      if (current.length && size > MAX_CHARS) {
        pieces.push(`${header}\n${current.join("\n")}`);
        current = [];
      }
      current.push(row);
    }
    if (current.length) pieces.push(`${header}\n${current.join("\n")}`);
    return pieces;
  }
  if (block.type === "code" && lines.length > 2) {
    const open = lines[0];
    const close = lines.at(-1);
    const pieces = [];
    let current = [];
    for (const codeLine of lines.slice(1, -1)) {
      if (current.length && current.join("\n").length + codeLine.length > MAX_CHARS) {
        pieces.push([open, ...current, close].join("\n"));
        current = [];
      }
      current.push(codeLine);
    }
    if (current.length) pieces.push([open, ...current, close].join("\n"));
    return pieces;
  }
  return [block.text];
}

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: MAX_CHARS,
  chunkOverlap: OVERLAP,
});

/**
 * Structure-aware chunking over a whole document.
 * sections: [{ text, page?, via? }] in reading order. Headings carry across
 * sections, so page 3 still knows it sits under "Billing > Refunds".
 * Returns [{ text, section, page, pageEnd, via }].
 */
export async function chunkDocument(sections) {
  const blocks = sections.flatMap((section) =>
    parseBlocks(section.text, { page: section.page ?? null, via: section.via ?? null }),
  );

  const chunks = [];
  const headingPath = []; // [{ level, title }]
  let parts = []; // blocks in the chunk being built
  let size = 0;
  let startPath = []; // heading path when the chunk started

  const pathTitles = () => headingPath.map((heading) => heading.title);

  const emit = (bodyBlocks, body, path) => {
    const startsWithHeading = bodyBlocks[0]?.type === "heading";
    const ancestors = startsWithHeading ? path.slice(0, -1) : path;
    const prefix = ancestors.length ? `${ancestors.join(" > ")}\n\n` : "";
    const pages = bodyBlocks.map((block) => block.page).filter((page) => page != null);
    chunks.push({
      text: prefix + body,
      section: path.join(" > ") || null,
      page: pages[0] ?? null,
      pageEnd: pages.at(-1) ?? null,
      via: [...new Set(bodyBlocks.map((block) => block.via).filter(Boolean))].join("+") || null,
    });
  };

  // A heading is never left stranded at the end of a chunk: it moves to the
  // start of the next one. Only the final flush emits a trailing heading.
  const flush = ({ final = false } = {}) => {
    if (!parts.length) return;
    const carry = !final && parts.at(-1).type === "heading" ? parts.pop() : null;
    if (parts.length) emit(parts, parts.map((block) => block.text).join("\n\n"), startPath);
    parts = carry ? [carry] : [];
    size = carry ? carry.text.length : 0;
    startPath = pathTitles();
  };

  const add = (block) => {
    if (!parts.length) startPath = pathTitles();
    parts.push(block);
    size += block.text.length + 2;
  };

  for (const block of blocks) {
    if (block.type === "heading") {
      while (headingPath.length && headingPath.at(-1).level >= block.level) headingPath.pop();
      headingPath.push({ level: block.level, title: block.title });
      if (size >= MIN_CHARS) flush();
      if (!parts.length) startPath = pathTitles();
      add(block);
      continue;
    }

    if (block.text.length > MAX_CHARS) {
      flush();
      // A carried heading leads the first piece of the oversized block.
      const lead = parts;
      parts = [];
      size = 0;
      const pieces =
        block.type === "paragraph"
          ? await splitter.splitText(block.text)
          : block.type === "table" && block.text.length <= MAX_TABLE_CHARS
            ? [block.text]
            : splitOversized(block);
      pieces.forEach((piece, index) => {
        const withLead = index === 0 && lead.length;
        emit(
          withLead ? [...lead, block] : [block],
          withLead ? `${lead.map((block) => block.text).join("\n\n")}\n\n${piece}` : piece,
          pathTitles(),
        );
      });
      continue;
    }

    if (parts.length && size + block.text.length + 2 > MAX_CHARS) flush();
    add(block);
  }
  flush({ final: true });
  return chunks.filter((chunk) => chunk.text.trim());
}
