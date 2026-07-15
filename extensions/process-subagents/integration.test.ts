import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";

const cliPath = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));
const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));

const fauxProvider = `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function(pi) {
  pi.registerProvider("process-subagents-faux", {
    baseUrl: "https://example.invalid", apiKey: "test", api: "process-subagents-faux-api",
    models: [{ id: "faux", name: "Faux", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
        const base = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now() };
        const child = process.env.PI_PROCESS_SUBAGENT_CHILD === "1";
        let lastUser = -1;
        for (let index = 0; index < context.messages.length; index++) if (context.messages[index].role === "user") lastUser = index;
        const userContent = lastUser >= 0 ? context.messages[lastUser].content : "";
        const userText = typeof userContent === "string" ? userContent : userContent.map((part) => part.text ?? "").join("");
        const hasCurrentResult = context.messages.slice(lastUser + 1).some((message) => message.role === "toolResult");
        const resumeTurn = userText.includes("Resume the integration");
        let content;
        if (child) {
          content = [{ type: "text", text: userText.includes("resumed") ? "child resumed complete" : "child integration complete" }];
        } else if (hasCurrentResult) {
          content = [{ type: "text", text: resumeTurn ? "parent resume complete" : "parent integration complete" }];
        } else if (resumeTurn) {
          const prior = context.messages.filter((message) => message.role === "toolResult")
            .map((message) => message.content?.find?.((part) => part.type === "text")?.text ?? "").join("\\n");
          const agentId = prior.match(/\"agentId\"\\s*:\\s*\"([^\"]+)/)?.[1];
          content = [{ type: "toolCall", id: "integration-resume-call", name: "resume_subagent", arguments: {
            agent_id: agentId, prompt: "Reply with child resumed complete", run_in_background: false } }];
        } else {
          content = [{ type: "toolCall", id: "integration-agent-call", name: "Agent", arguments: {
            prompt: "Reply with child integration complete", description: "Integration child",
            subagent_type: "general-purpose", model: "process-subagents-faux/faux", thinking: "off",
            run_in_background: false } }];
        }
        const message = { ...base, content, stopReason: child || hasCurrentResult ? "stop" : "toolUse" };
        stream.push({ type: "start", partial: { ...base, content: [], stopReason: "stop" } });
        if (content[0].type === "toolCall") stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: content[0], partial: message });
        else stream.push({ type: "text_end", contentIndex: 0, content: content[0].text, partial: message });
        stream.push({ type: "done", reason: message.stopReason, message });
      });
      return stream;
    },
  });
}
`;

describe("process-subagents integration", () => {
  test("runs a foreground child through real Pi RPC and persists its terminal result", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "process-subagents-integration-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(path.join(cwd, ".pi", "extensions"), { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi", "extensions", "faux.ts"), fauxProvider);
    const client = new RpcClient({
      cliPath,
      cwd,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      provider: "process-subagents-faux",
      model: "faux",
      args: ["--approve", "--thinking", "off", "--extension", extensionPath],
    });
    try {
      await client.start();
      await client.prompt("Run the integration delegation");
      await client.waitForIdle(30_000);
      assert.equal(await client.getLastAssistantText(), "parent integration complete");
      const entries = await client.getEntries();
      assert.match(JSON.stringify(entries), /child integration complete/);
      assert.match(JSON.stringify(entries), /\"status\":\"completed\"/);

      await client.prompt("Resume the integration agent");
      await client.waitForIdle(30_000);
      assert.equal(await client.getLastAssistantText(), "parent resume complete");
      const resumedEntries = await client.getEntries();
      const serialized = JSON.stringify(resumedEntries);
      assert.match(serialized, /child resumed complete/);
      assert.match(serialized, /\"runNumber\":2/);
    } finally {
      await client.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
