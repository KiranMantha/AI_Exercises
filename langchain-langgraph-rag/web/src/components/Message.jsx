import { useState } from "preact/hooks";
import { renderMarkdown } from "../lib/renderMarkdown.js";
import { Sources } from "./Sources.jsx";

export function Message({ message, id }) {
  const [sourcesOpen, setSourcesOpen] = useState(false);

  if (message.role === "user") {
    return (
      <div class="row row-user">
        <div class="bubble bubble-user">{message.content}</div>
      </div>
    );
  }

  const citedSources = message.sources?.filter((source) => source.cited) ?? [];
  const html = renderMarkdown(
    message.content,
    new Set(citedSources.map((source) => source.id)),
    id,
  );

  // Clicking a citation opens the sources and jumps to the one it points at.
  const onContentClick = (event) => {
    const link = event.target.closest?.("a.cite");
    if (!link) return;
    event.preventDefault();
    setSourcesOpen(true);
    requestAnimationFrame(() =>
      document.getElementById(link.getAttribute("href").slice(1))?.scrollIntoView({ block: "nearest" }),
    );
  };

  return (
    <div class="row">
      <div class={`bubble bubble-assistant${message.status !== "answered" ? ` bubble-${message.status}` : ""}`}>
        {/* eslint-disable-next-line react/no-danger -- sanitised in renderMarkdown */}
        <div class="prose" onClick={onContentClick} dangerouslySetInnerHTML={{ __html: html }} />
        {message.status === "answered" && (
          <Sources sources={citedSources} messageId={id} open={sourcesOpen} onToggle={setSourcesOpen} />
        )}
      </div>
    </div>
  );
}
