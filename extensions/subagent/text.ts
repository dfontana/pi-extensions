/** Cut to at most `maxBytes` of UTF-8 on a character boundary, appending `suffix` when cut. */
export function truncateUtf8(value: string, maxBytes: number, suffix = "\n[truncated]"): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8") + suffix;
}

/** Keep the last `maxBytes` of UTF-8 on a character boundary. */
export function utf8Tail(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString("utf8");
}

/** Text parts of message content, joined. */
export function textOf(content: unknown, separator = ""): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text").map((part) => part.text).join(separator);
}
