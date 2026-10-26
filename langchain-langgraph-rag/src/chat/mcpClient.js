import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// The chat agent talks to the docs server over real MCP (listTools / callTool).
// In-memory transport keeps it in one process; the same client code works over
// stdio or HTTP against a separately deployed server.
export async function connectToMcp(server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "chat-agent", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const { tools } = await client.listTools();
  return {
    // Sorted so the tool list is byte-stable between requests (prompt caching).
    tools: tools
      .map((tool) => toOpenAiTool(tool))
      .sort((first, second) => first.function.name.localeCompare(second.function.name)),
    call: (name, args) => client.callTool({ name, arguments: args }),
    close: () => client.close(),
  };
}

// MCP describes tool inputs as JSON Schema; chat APIs take them as
// function-calling definitions.
function toOpenAiTool({ name, description, inputSchema }) {
  const { $schema: _ignored, ...parameters } = inputSchema;
  return { type: "function", function: { name, description, parameters } };
}
