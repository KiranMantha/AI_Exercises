import { useEffect, useRef, useState } from "preact/hooks";
import { fetchHealth, sendChat } from "./lib/api.js";
import { Message } from "./components/Message.jsx";

const HISTORY_TURNS = 6;

export function App() {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState(null);
  const endRef = useRef(null);

  useEffect(() => {
    fetchHealth().then((health) => setMode(health.mode)).catch(() => setMode("offline"));
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, loading]);

  async function submit(event) {
    event.preventDefault();
    const question = draft.trim();
    if (!question || loading) return;

    // Only real answers go back as history; refusals and errors are noise.
    const history = messages
      .filter((message) => message.role === "user" || message.status === "answered")
      .slice(-HISTORY_TURNS)
      .map(({ role, content }) => ({ role, content }));

    setMessages((current) => [...current, { role: "user", content: question }]);
    setDraft("");
    setLoading(true);
    try {
      const result = await sendChat(question, history);
      setMessages((current) => [
        ...current,
        { role: "assistant", content: result.answer, status: result.status, sources: result.sources },
      ]);
    } catch (error) {
      setMessages((current) => [
        ...current,
        { role: "assistant", content: error.message, status: "error", sources: [] },
      ]);
    } finally {
      setLoading(false);
    }
  }

  const onKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) submit(event);
  };

  return (
    <div class="app">
      <header class="header">
        <h1>Docs Chat</h1>
        <p>Answers come only from the ingested documents, with sources.</p>
        {mode === "extractive" && (
          <p class="notice">Excerpt mode: no chat model is configured, so you'll see the matching passages.</p>
        )}
        {mode === "offline" && <p class="notice notice-error">The API is not reachable.</p>}
      </header>

      <main class="log" role="log" aria-live="polite" aria-label="Conversation">
        {messages.length === 0 && (
          <p class="empty">Ask a question about your documents to get started.</p>
        )}
        {messages.map((message, index) => (
          <Message key={index} message={message} id={`m${index}`} />
        ))}
        {loading && (
          <div class="row" aria-label="Thinking">
            <div class="bubble bubble-assistant typing"><span /><span /><span /></div>
          </div>
        )}
        <div ref={endRef} />
      </main>

      <form class="composer" onSubmit={submit}>
        <label class="visually-hidden" for="question">Your question</label>
        <textarea
          id="question"
          rows={2}
          maxLength={1000}
          value={draft}
          placeholder="Ask about the documents..."
          onInput={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        <button type="submit" disabled={loading || !draft.trim()}>Send</button>
      </form>
    </div>
  );
}
