import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "echo", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{
  name: "echo",
  description: "Echo text back unchanged",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
}] }));
server.setRequestHandler(CallToolRequestSchema, ({ params }) => ({
  content: [{ type: "text", text: String(params.arguments?.text ?? "") }],
}));
await server.connect(new StdioServerTransport());
