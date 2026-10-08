import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const server = new McpServer({ name: "echo", version: "1" });
server.registerTool(
  "echo",
  {
    description: "Echo text back unchanged",
    inputSchema: z.object({ text: z.string() }),
  },
  async ({ text }) => ({ content: [{ type: "text", text }] }),
);
await server.connect(new StdioServerTransport());
