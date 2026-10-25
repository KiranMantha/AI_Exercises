import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const queries = process.argv.slice(2);
if (queries.length === 0) {
  queries.push(
    "why do users get logged out", // semantic: should hit vectors
    "ERR_AUTH_417", // exact term: should hit keywords
    "session expiry policy", // mixed
  );
}

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["server.js"],
    env: { ...process.env },
    stderr: "inherit", // show the server's startup log
  });

  const client = new Client({ name: "test-client", version: "1.0.0" });
  console.log("Connecting to server...");
  await client.connect(transport);
  console.log("Connected.");

  const { tools } = await client.listTools();
  console.log("Tools:", tools.map((t) => t.name).join(", "));

  for (const query of queries) {
    console.log(`\n=== ${query} ===`);
    const result = await client.callTool({
      name: "search_docs",
      arguments: { query, maxResults: 3 },
    });
    console.log(result.content[0].text);
  }

  await client.close();
}

main().catch((err) => {
  console.error("test-client failed:", err);
  process.exit(1);
});
