import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { searchDocs } from "./rag.js";

const server = new McpServer({ name: "docs-rag", version: "1.0.0" });

server.registerTool(
  "search_docs",
  {
    description:
      "Semantic search over the project documentation. Use for conceptual questions " +
      "or when exact keywords are unknown. Returns the most relevant chunks with sources.",
    inputSchema: {
      query: z.string().describe("Natural-language question or topic"),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("Maximum number of results to return"),
    },
  },
  async ({ query, maxResults = 5 }) => {
    const results = await searchDocs(query, maxResults);

    if (results.length === 0) {
      return {
        content: [{ type: "text", text: "No relevant documentation found." }],
      };
    }

    const text = results
      .map(
        (r, i) =>
          `[${i + 1}] ${r.source}${r.section ? ` > ${r.section}` : ""} (score ${r.score.toFixed(2)})\n${r.text}`,
      )
      .join("\n\n---\n\n");

    return { content: [{ type: "text", text }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stdout is the MCP channel, so log only to stderr.
console.error("docs-rag MCP server running");
