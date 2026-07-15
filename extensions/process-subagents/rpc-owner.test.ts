import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { RpcOwner } from "./rpc-owner.ts";

function injected(script: string): typeof spawn {
  return ((_command: string, _args: readonly string[], options: object) =>
    spawn(process.execPath, ["-e", script], options as any)) as typeof spawn;
}

describe("process-subagents rpc-owner", () => {
  test("correlates responses and cancels blocking extension UI requests", async () => {
    const script = String.raw`
      let buffer = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => {
        buffer += chunk;
        let i;
        while ((i = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
          const value = JSON.parse(line);
          if (value.type === "get_state") {
            process.stdout.write(JSON.stringify({type:"extension_ui_request",id:"ui-1",method:"confirm",title:"x",message:"y"}) + "\n");
            process.stdout.write(JSON.stringify({type:"response",id:value.id,command:"get_state",success:true,data:{sessionId:"s",thinkingLevel:"off"}}) + "\n");
          } else if (value.type === "extension_ui_response") {
            process.stdout.write(JSON.stringify({type:"ui_cancelled",cancelled:value.cancelled}) + "\n");
          } else if (value.type === "abort") {
            process.stdout.write(JSON.stringify({type:"response",id:value.id,command:"abort",success:true}) + "\n");
          }
        }
      });
    `;
    const owner = new RpcOwner({ args: [], cwd: process.cwd(), env: process.env, spawnProcess: injected(script) });
    const cancelled = new Promise<boolean>((resolve) => owner.onEvent((event) => {
      if (event.type === "ui_cancelled") resolve(event.cancelled === true);
    }));
    const response = await owner.request({ type: "get_state" });
    assert.equal(response.success, true);
    assert.equal(await cancelled, true);
    await owner.stop();
  });

  test("rejects malformed JSONL instead of silently ignoring it", async () => {
    const owner = new RpcOwner({
      args: [], cwd: process.cwd(), env: process.env,
      spawnProcess: injected(`process.stdout.write("not-json\\n"); setTimeout(() => process.exit(0), 20);`),
    });
    await assert.rejects(owner.request({ type: "get_state" }), /invalid JSON/);
    await owner.exit;
  });

  test("requires an LF-terminated final RPC record", async () => {
    const owner = new RpcOwner({
      args: [], cwd: process.cwd(), env: process.env,
      spawnProcess: injected(`process.stdout.write(JSON.stringify({type:"event"})); setTimeout(() => process.exit(0), 20);`),
    });
    await assert.rejects(owner.request({ type: "get_state" }), /LF-terminated/);
    await owner.exit;
  });
});
