// The server rebuilds and validates history itself; send only role and content.
export async function sendChat(message, history, signal) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, history }),
    signal,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

export async function fetchHealth() {
  const response = await fetch("/api/health");
  if (!response.ok) throw new Error("API unreachable");
  return response.json();
}
