export function Sources({ sources, messageId, open, onToggle }) {
  if (sources.length === 0) return null;
  return (
    <details class="sources" open={open} onToggle={(event) => onToggle(event.currentTarget.open)}>
      <summary>
        {sources.length} {sources.length === 1 ? "source" : "sources"}
      </summary>
      <ol class="source-list">
        {sources.map((source) => (
          <li key={source.id} id={`${messageId}-source-${source.id}`} value={source.id}>
            <div class="source-title">
              {source.source}
              {source.section ? <span class="source-section"> &rsaquo; {source.section}</span> : null}
            </div>
            <p class="source-excerpt">{source.excerpt}</p>
          </li>
        ))}
      </ol>
    </details>
  );
}
