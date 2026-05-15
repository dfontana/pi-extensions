import { execFile } from "child_process";

interface ClipboardCommand {
  command: string;
  args: string[];
}

const CLIPBOARD_TIMEOUT_MS = 2000;

function isWslEnvironment(): boolean {
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

function clipboardCandidates(): ClipboardCommand[] {
  const candidates: ClipboardCommand[] = [];

  if (process.platform === "darwin") {
    candidates.push({ command: "pbcopy", args: [] });
  } else if (process.platform === "win32") {
    candidates.push({ command: "clip.exe", args: [] });
  } else if (process.platform === "linux") {
    if (process.env.WAYLAND_DISPLAY) {
      candidates.push({ command: "wl-copy", args: [] });
    }
    if (process.env.DISPLAY) {
      candidates.push(
        { command: "xclip", args: ["-selection", "clipboard"] },
        { command: "xsel", args: ["--clipboard", "--input"] },
      );
    }
    if (isWslEnvironment()) {
      candidates.push({ command: "clip.exe", args: [] });
    }
  }

  return candidates;
}

function writeWithCommand(text: string, candidate: ClipboardCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      candidate.command,
      candidate.args,
      {
        timeout: CLIPBOARD_TIMEOUT_MS,
        windowsHide: true,
      },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );

    child.stdin?.on("error", reject);
    child.stdin?.end(text);
  });
}

export async function writeSystemClipboard(text: string): Promise<void> {
  const candidates = clipboardCandidates();
  if (candidates.length === 0) {
    throw new Error("No supported clipboard command found for this environment");
  }

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      await writeWithCommand(text, candidate);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  const cause = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(
    `Failed to write to system clipboard with: ${candidates
      .map(({ command, args }) => [command, ...args].join(" "))
      .join(", ")}.${cause}`,
  );
}
