/**
 * No Git for JJ Extension
 *
 * Blocks git commands when a .jj/ directory exists in the project root.
 * Forces the agent to use jj instead of git for all VCS operations.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { existsSync } from "fs";
import { join } from "path";

const GIT_COMMANDS = [
  "git add",
  "git branch",
  "git checkout",
  "git commit",
  "git diff",
  "git fetch",
  "git init",
  "git log",
  "git merge",
  "git pull",
  "git push",
  "git rebase",
  "git reset",
  "git restore",
  "git revert",
  "git status",
  "git stash",
  "git switch",
  "git tag",
];

const JJ_ALTERNATIVES: Record<string, string> = {
  "git status": "jj status",
  "git diff": "jj diff",
  "git log": "jj log",
  "git add": "jj commit (all changes are auto-staged in jj)",
  "git commit": "jj commit -m",
  "git push": "jj git push",
  "git pull": "jj git fetch",
  "git branch": "jj bookmark list",
  "git checkout": "jj new",
  "git merge": "jj squash",
  "git rebase": "jj rebase",
  "git stash": "jj commit (jj automatically tracks all changes)",
  "git reset": "jj undo",
  "git switch": "jj new",
  "git tag": "jj bookmark",
  "git restore": "jj diffedit / jj restore",
  "git revert": "jj backout / jj undo",
  "git fetch": "jj git fetch",
  "git init": "jj git init",
};

function findJjRoot(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, ".jj"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

function isGitCommand(command: string): string | null {
  for (const gitCmd of GIT_COMMANDS) {
    const idx = command.indexOf(gitCmd);
    if (idx === -1) continue;
    // Ensure 'git' is a standalone word: the preceding character must not be alphanumeric.
    if (idx > 0 && /[a-zA-Z0-9_]/.test(command[idx - 1])) continue;
    return gitCmd;
  }
  return null;
}

function getJjAlternative(gitCmd: string): string {
  return JJ_ALTERNATIVES[gitCmd] || "Use jj instead of git in this repository";
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    const command = event.input.command ?? "";

    // Allow jj git subcommands (e.g. `jj git push`, `jj git fetch`)
    if (/\bjj\s+git\b/.test(command)) return;

    const gitCmd = isGitCommand(command);
    if (!gitCmd) return;

    const jjRoot = findJjRoot(ctx.cwd);
    if (!jjRoot) return;

    const alt = getJjAlternative(gitCmd);
    return {
      block: true,
      reason: `Git commands are blocked in jj repositories (.jj found at ${jjRoot}). Use jj instead:\n  ${command} → ${alt}`,
    };
  });
}