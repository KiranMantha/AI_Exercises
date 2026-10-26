// Prompts used while ingesting documents.

// Sent to the OCR model with each page image. OCR_PROMPT overrides it for a
// model that expects different wording.
export const OCR_PROMPT = process.env.OCR_PROMPT ?? "document parsing.";

// Asks a model to pick the ingestion agent for a file no extension rule could
// place. It sees the agents' descriptions and the start of the file, nothing else.
export function buildRouterMessages({ agents, names, fileName, sizeBytes, sample }) {
  return [
    {
      role: "user",
      content: [
        "Pick the agent that should read this document, or \"none\" if no agent fits.",
        `Reply with JSON only: {"agent": <one of ${JSON.stringify(names)}>, "reason": <short>}.`,
        "",
        "Agents:",
        ...agents.map((agent) => `- ${agent.name}: ${agent.description}`),
        "",
        `File: ${fileName}`,
        `Size: ${sizeBytes} bytes`,
        `Start of file:\n${sample}`,
      ].join("\n"),
    },
  ];
}
