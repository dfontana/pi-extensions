/**
 * scoped-tools — registers YAML-specified bash commands as first-class agent
 * tools. Each spec defines typed parameters (optionally checked by a
 * validationCmd), hidden parameters computed by shell commands at call time,
 * and a command template the values are substituted into. The agent only ever
 * sees the tool name, description, parameter schema, and the final command's
 * stdout/stderr — never the templates or hidden values.
 *
 * Call pipeline: validate each parameter -> evaluate hidden parameters in
 * declaration order (each may reference tool parameters and earlier hidden
 * parameters) -> substitute everything into commandTemplate -> run via
 * `bash -c` in the session cwd with the agent's environment.
 */

import { Type } from "@earendil-works/pi-ai";
import type { TSchema } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadScopedTools, type ToolSpec } from "./config.ts";

const DEFAULT_TIMEOUT_SECONDS = 120;

/**
 * Replace `$UPPER_SNAKE` references whose names are in `values`, raw (no
 * quoting). Unknown names are left untouched so templates can still use
 * environment variables like `$HOME`.
 */
export function substitute(template: string, values: Record<string, string>): string {
  return template.replace(/\$([A-Z][A-Z0-9_]*)/g, (match, name: string) => values[name] ?? match);
}

function registerScopedTool(pi: ExtensionAPI, spec: ToolSpec) {
  const properties: Record<string, TSchema> = {};
  for (const [name, param] of Object.entries(spec.parameters)) {
    properties[name] =
      param.type === "number"
        ? Type.Number({ description: param.description })
        : Type.String({ description: param.description });
  }

  pi.registerTool({
    name: spec.name,
    label: spec.name,
    description: spec.description,
    parameters: Type.Object(properties),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const run = (args: string[]) =>
        pi.exec("bash", args, {
          signal: signal ?? ctx.signal,
          timeout: (spec.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
          cwd: ctx.cwd,
        });

      const values: Record<string, string> = {};
      for (const [name, param] of Object.entries(spec.parameters)) {
        const raw = (params as Record<string, unknown>)[name];
        if (raw === undefined || raw === null) throw new Error(`Missing required parameter "${name}"`);
        const value = String(raw);
        if (param.validationCmd) {
          const check = await run(["-c", param.validationCmd, "scoped-tools", value]);
          if (check.code !== 0) {
            const detail = (check.stderr || check.stdout).trim();
            throw new Error(`Invalid value for parameter "${name}"${detail ? `: ${detail}` : ""}`);
          }
        }
        values[name.toUpperCase()] = value;
      }

      for (const [name, hidden] of Object.entries(spec.hiddenParameters)) {
        const result = await run(["-c", substitute(hidden.valueFromCmd, values)]);
        if (result.code !== 0) {
          const detail = (result.stderr || result.stdout).trim();
          throw new Error(`Failed to resolve parameter "${name}"${detail ? `: ${detail}` : ""}`);
        }
        values[name.toUpperCase()] = result.stdout.trimEnd();
      }

      const result = await run(["-c", substitute(spec.commandTemplate, values)]);
      if (result.code !== 0) {
        const detail = (result.stderr || result.stdout).trim();
        if (result.killed) throw new Error(`Command timed out or was aborted${detail ? `: ${detail}` : ""}`);
        throw new Error(`Command failed (exit ${result.code})${detail ? `: ${detail}` : ""}`);
      }
      let text = result.stdout.trimEnd();
      if (result.stderr.trim()) text += `${text ? "\n" : ""}[stderr]\n${result.stderr.trimEnd()}`;
      return { content: [{ type: "text" as const, text: text || "(no output)" }], details: undefined };
    },
  });
}

export default function (pi: ExtensionAPI) {
  // Config is read once per process: the tool set is fixed for the session,
  // so spec edits require a reload. Registration happens on the first
  // session_start because the project config path needs ctx.cwd.
  let registered = false;
  pi.on("session_start", (_event, ctx) => {
    if (registered) return;
    registered = true;
    const { tools, errors } = loadScopedTools(ctx.cwd);
    for (const spec of tools) registerScopedTool(pi, spec);
    for (const error of errors) ctx.ui.notify(`scoped-tools: ${error}`, "warning");
  });
}
