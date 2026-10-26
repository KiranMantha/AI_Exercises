import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

const MAX_CHARS = 800;
const MIN_CHARS = 150; // a section smaller than this is merged with the next
const OVERLAP = 100; // only used inside a single oversized paragraph

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const TABLE_ROW = /^\s*\|/;
const MATH_OPEN = /^\s*(\$\$|\\\[)/;

// Split text into blocks. Code, math and tables are atomic: chunking never
// cuts through them unless one is bigger than a whole chunk.
function parseBlocks(text, meta) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let para = [];
  const flushPara = () => {
    if (para.length) blocks.push({ ...meta, type: "paragraph", text: para.join("\n") });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(FENCE);
    const math = line.match(MATH_OPEN);
    const heading = line.match(HEADING);

    if (fence) {
      flushPara();
      const body = [line];
      while (++i < lines.length) {
        body.push(lines[i]);
        if (lines[i].trim().startsWith(fence[1])) break;
      }
      blocks.push({ ...meta, type: "code", text: body.join("\n") });
    } else if (math) {
      flushPara();
      const close = math[1] === "$$" ? "$$" : "\\]";
      const body = [line];
      const closedOnSameLine = line.trim().length > 2 && line.trim().endsWith(close);
      while (!closedOnSameLine && ++i < lines.length) {
        body.push(lines[i]);
        if (lines[i].includes(close)) break;
      }
      blocks.push({ ...meta, type: "math", text: body.join("\n") });
    } else if (/^\s*<table/i.test(line)) {
      flushPara();
      const body = [line];
      while (!/<\/table>/i.test(lines[i]) && ++i < lines.length) body.push(lines[i]);
      blocks.push({ ...meta, type: "table", text: body.join("\n") });
    } else if (TABLE_ROW.test(line)) {
      flushPara();
      const body = [line];
      while (i + 1 < lines.length && TABLE_ROW.test(lines[i + 1])) body.push(lines[++i]);
      blocks.push({ ...meta, type: "table", text: body.join("\n") });
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
      para.push(line);
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
    for (const l of lines.slice(1, -1)) {
      if (current.length && current.join("\n").length + l.length > MAX_CHARS) {
        pieces.push([open, ...current, close].join("\n"));
        current = [];
      }
      current.push(l);
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
  const blocks = sections.flatMap((s) =>
    parseBlocks(s.text, { page: s.page ?? null, via: s.via ?? null }),
  );

  const chunks = [];
  const headingPath = []; // [{ level, title }]
  let parts = []; // blocks in the chunk being built
  let size = 0;
  let startPath = []; // heading path when the chunk started

  const pathTitles = () => headingPath.map((h) => h.title);

  const emit = (bodyBlocks, body, path) => {
    const startsWithHeading = bodyBlocks[0]?.type === "heading";
    const ancestors = startsWithHeading ? path.slice(0, -1) : path;
    const prefix = ancestors.length ? `${ancestors.join(" > ")}\n\n` : "";
    const pages = bodyBlocks.map((b) => b.page).filter((p) => p != null);
    chunks.push({
      text: prefix + body,
      section: path.join(" > ") || null,
      page: pages[0] ?? null,
      pageEnd: pages.at(-1) ?? null,
      via: [...new Set(bodyBlocks.map((b) => b.via).filter(Boolean))].join("+") || null,
    });
  };

  // A heading is never left stranded at the end of a chunk: it moves to the
  // start of the next one. Only the final flush emits a trailing heading.
  const flush = ({ final = false } = {}) => {
    if (!parts.length) return;
    const carry = !final && parts.at(-1).type === "heading" ? parts.pop() : null;
    if (parts.length) emit(parts, parts.map((b) => b.text).join("\n\n"), startPath);
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
        block.type === "paragraph" ? await splitter.splitText(block.text) : splitOversized(block);
      pieces.forEach((piece, i) => {
        const withLead = i === 0 && lead.length;
        emit(
          withLead ? [...lead, block] : [block],
          withLead ? `${lead.map((b) => b.text).join("\n\n")}\n\n${piece}` : piece,
          pathTitles(),
        );
      });
      continue;
    }

    if (parts.length && size + block.text.length + 2 > MAX_CHARS) flush();
    add(block);
  }
  flush({ final: true });
  return chunks.filter((c) => c.text.trim());
}
