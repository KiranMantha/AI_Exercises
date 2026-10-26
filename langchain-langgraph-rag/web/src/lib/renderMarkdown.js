import { marked } from "marked";
import DOMPurify from "dompurify";

// Model output and the documents behind it are untrusted, so the HTML is
// sanitised with a short allow-list: no images, scripts, styles or event
// handlers, and links limited to http(s) and in-page anchors.
const ALLOWED_TAGS = [
  "p", "br", "ul", "ol", "li", "strong", "em", "code", "pre", "blockquote",
  "a", "table", "thead", "tbody", "tr", "th", "td", "hr",
];

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.getAttribute("href")?.startsWith("http")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

// [n] becomes a link to that source, but only when the source exists.
export function renderMarkdown(text, sourceIds, messageId) {
  const withCitations = text.replace(/\[(\d+)\]/g, (match, id) =>
    sourceIds.has(Number(id))
      ? `<a class="cite" href="#${messageId}-source-${id}">${id}</a>`
      : match,
  );
  const html = marked.parse(withCitations, { async: false, breaks: true });
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ["href", "class", "target", "rel"],
    ALLOWED_URI_REGEXP: /^(?:https?:|#)/i,
  });
}
