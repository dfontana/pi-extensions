// Loaded into a real `pi --mode rpc` child by the opt-in integration tests.
// Registers a local `probe/fake` model that never touches the network: each
// reply echoes the latest user message after a short delay.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const DELAY_MS = Number(process.env.FAKE_PROVIDER_DELAY_MS ?? 250);

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((part: any) => part?.text ?? "").join("") : "";
}

export default function (pi: any) {
  pi.registerProvider("probe", {
    name: "Local probe provider",
    api: "probe-api",
    apiKey: "not-used",
    models: [{
      id: "fake", name: "Fake", api: "probe-api", baseUrl: "http://127.0.0.1:1", input: ["text"],
      contextWindow: 4096, maxTokens: 256, reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model: any, context: any, options: any) {
      const stream = createAssistantMessageEventStream();
      const output: any = {
        role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now(),
      };
      void (async () => {
        await options?.onPayload?.({}, model);
        stream.push({ type: "start", partial: { ...output, content: [] } });
        const last = context.messages?.filter((message: any) => message.role === "user").at(-1);
        const text = `fake reply: ${last ? textOf(last.content) : ""}`;
        await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
        output.content = [{ type: "text", text }];
        stream.push({ type: "text_start", contentIndex: 0, partial: { ...output, content: [{ type: "text", text: "" }] } });
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
        stream.push({ type: "done", reason: "stop", message: output });
        stream.end(output);
      })();
      return stream;
    },
  });
}
