import { execFile } from "node:child_process";

const quote = (value: string) => `"${value.replace(/["\\]/g, "\\$&")}"`;

async function security(command: string, account: string, options: string[] = [], allowMissing = false): Promise<string | undefined> {
  if (process.platform !== "darwin") throw new Error("Keychain requires macOS");
  if (!account || /[\r\n\0]/.test(account)) throw new Error("Keychain account must be nonempty and contain no NUL or newlines");
  const input = [command, "-s", "pi-extensions", "-a", account, ...options].map(quote).join(" ") + "\n";
  // security -i has a 4096-byte buffer; never let it truncate a command.
  if (Buffer.byteLength(input) >= 4096) throw new Error("Keychain command exceeds the macOS security stdin limit");
  return new Promise((resolve, reject) => {
    // Only fixed flags enter argv; credentials go directly through the pipe, never a shell.
    const child = execFile("/usr/bin/security", ["-i", "-q"], { encoding: "utf8" }, (error, _stdout, stderr) => {
      if (error) {
        if (allowMissing && error.code === 44) resolve(undefined); // errSecItemNotFound
        // Do not forward stderr or the original error: either could contain a secret.
        else reject(new Error(`Keychain command failed (${error.code ?? error.signal ?? "unknown"})`));
      } else resolve(stderr);
    });
    child.stdin!.on("error", () => reject(new Error("Keychain stdin failed")));
    child.stdin!.end(input);
  });
}

/** Insert or update a generic password in the default keychain, under service pi-extensions. */
export async function setPassword(account: string, password: string): Promise<void> {
  // Hex handles embedded line breaks/NUL without injecting another interactive command.
  const secret = /[\r\n\0]/.test(password) ? ["-X", Buffer.from(password).toString("hex")] : ["-w", password];
  await security("add-generic-password", account, ["-U", ...secret]);
}

/** Read a password, or undefined if the account is absent. */
export async function getPassword(account: string): Promise<string | undefined> {
  // -g's stderr format distinguishes hex from literal text, unlike -w's ambiguous stdout.
  const output = await security("find-generic-password", account, ["-g"], true);
  if (output === undefined) return undefined;
  const match = /^password: (?:0x([\da-fA-F]+)[^\n]*|"(.*)"|)$/m.exec(output);
  if (!match) throw new Error("Unexpected keychain password output");
  return match[1] ? Buffer.from(match[1], "hex").toString("utf8") : match[2] ?? "";
}

/** Delete a password; an absent account is already deleted. */
export async function deletePassword(account: string): Promise<void> {
  await security("delete-generic-password", account, [], true);
}
