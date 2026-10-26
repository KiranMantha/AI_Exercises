import fs from "node:fs";

// Agent contract (every file in this folder default-exports one):
//   name         unique id, becomes the graph node
//   description  what it can read; the LLM router chooses from this text
//   accepts      file extensions it handles; the deterministic router matches these
//   process(filePath) -> [{ text, page?, via? }]  readable units in reading
//                        order (a whole file, or one PDF page); `via` names the
//                        parser that produced the text
export default {
  name: "markdown",
  description:
    "Reads Markdown and plain-text notes whose content is already text. Use for .md files.",
  accepts: [".md"],
  async process(filePath) {
    return [{ text: fs.readFileSync(filePath, "utf8") }];
  },
};
