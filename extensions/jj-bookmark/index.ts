/**
 * Jujutsu (jj) Bookmark Extension
 * 
 * Shows the current jj bookmark in the footer (line 3).
 * Falls back to git branch if not in a jj repo.
 * Format: jj:{bookmark} or git:{branch} or "No VCS"
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

const EXTENSION_KEY = "jj-bookmark";

function exec(cmd: string, cwd: string): string | null {
  try {
    return execSync(cmd, { cwd, encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

function getVcsInfo(cwd: string): string | null {
  // Check for jj repo (.jj directory exists)
  const jjDir = join(cwd, ".jj");

  if (existsSync(jjDir)) {
    const result = exec("jj branch", cwd);
    if (result) {
      const bookmark = result.trim().split("\n")[0];
      if (bookmark) return `jj:${bookmark}`;
    }
    return "jj:??";
  }

  // Fall back to git
  if (existsSync(join(cwd, ".git"))) {
    const branch = exec("git rev-parse --abbrev-ref HEAD", cwd);
    if (branch && branch !== "HEAD") {
      return `git:${branch}`;
    }
  }

  return null;
}

export default function (pi: ExtensionAPI) {
  function updateStatus(ctx: { ui: { setStatus: (key: string, status: string | undefined) => void } }) {
    const vcsInfo = getVcsInfo(process.cwd());
    ctx.ui.setStatus(EXTENSION_KEY, vcsInfo ?? "No VCS");
  }

  pi.on("session_start", async (_event, ctx) => {
    updateStatus(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus(EXTENSION_KEY, undefined);
  });
}