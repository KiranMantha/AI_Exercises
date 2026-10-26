import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { searchDocsDetailed } from "./rag.js";
import { createDocsMcpServer } from "./mcp/tools.js";
import { docsStore } from "./mcp/docsStore.js";
import { configureLogging, createLogger } from "./logger.js";

configureLogging({ service: "docs-rag-mcp" });

const server = createDocsMcpServer({
  searchDetailed: searchDocsDetailed,
  store: docsStore,
  rerankFloor: Number(process.env.RERANK_REJECT_BELOW ?? -Infinity),
});

const transport = new StdioServerTransport();
await server.connect(transport);
// stdout is the MCP channel; the logger writes to stderr and the logs folder.
createLogger("mcp").info("mcp.started", { transport: "stdio" });
