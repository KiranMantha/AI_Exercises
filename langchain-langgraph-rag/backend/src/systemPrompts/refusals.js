// What a user is told when a guardrail or the retrieval step stops an answer.
// Fixed text on purpose: a refusal never depends on the model.
export const REFUSALS = {
  invalid_input: "I couldn't read that message. Please ask a question in plain text.",
  blocked_input:
    "I can only answer questions about the ingested documents, and I can't act on instructions to change how I work.",
  no_context:
    "I couldn't find anything about that in the ingested documents. Try rephrasing, or ask about a topic the documents cover.",
  ungrounded:
    "I couldn't produce an answer I could back up with the documents, so I'd rather not guess. Try rephrasing your question.",
  llm_error: "The answer service is unavailable right now. Please try again shortly.",
};
