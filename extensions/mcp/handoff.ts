import type { McpEnabledSnapshot } from "./manager.ts";

/** Child-only environment value carrying the parent's enabled-server snapshot. */
export const MCP_ENABLED_SNAPSHOT_ENV = "PI_EXTENSIONS_MCP_ENABLED_SNAPSHOT";

// Keep well below typical process environment limits. A snapshot contains only
// server names and short identity hashes, never credentials or server config.
const MAX_SNAPSHOT_BYTES = 16 * 1024;
const MAX_SNAPSHOT_SERVERS = 256;

type MutableEnvironment = Record<string, string | undefined>;

function validSnapshot(value: unknown): value is McpEnabledSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { version?: unknown; servers?: unknown };
  if (candidate.version !== 1 || !Array.isArray(candidate.servers)) return false;
  if (candidate.servers.length > MAX_SNAPSHOT_SERVERS) return false;
  return candidate.servers.every(
    (entry) =>
      !!entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      typeof (entry as { name?: unknown }).name === "string" &&
      typeof (entry as { identity?: unknown }).identity === "string",
  );
}

/** Serialize a snapshot for one child process, or omit an unexpectedly large value. */
export function serializeEnabledSnapshot(snapshot: McpEnabledSnapshot): string | undefined {
  const serialized = JSON.stringify(snapshot);
  return Buffer.byteLength(serialized, "utf8") <= MAX_SNAPSHOT_BYTES ? serialized : undefined;
}

/**
 * Remove and decode the child snapshot from an environment object. Removal is
 * unconditional so the handoff cannot flow into processes launched later by
 * the child session.
 */
export function consumeEnabledSnapshot(
  environment: MutableEnvironment = process.env,
): McpEnabledSnapshot | undefined {
  const serialized = environment[MCP_ENABLED_SNAPSHOT_ENV];
  delete environment[MCP_ENABLED_SNAPSHOT_ENV];
  if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) return undefined;

  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!validSnapshot(parsed)) return undefined;
    return {
      version: 1,
      servers: parsed.servers.map(({ name, identity }) => ({ name, identity })),
    };
  } catch {
    return undefined;
  }
}
