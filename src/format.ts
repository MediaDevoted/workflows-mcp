export function jsonText(value: unknown, maxBytes: number): string {
  const raw = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(raw, "utf8") <= maxBytes) return raw;
  const buffer = Buffer.from(raw, "utf8");
  return `${buffer.subarray(0, maxBytes).toString("utf8")}\n...[truncated at ${maxBytes} bytes]`;
}

export function splitCsv(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).map((v) => v.trim()).filter(Boolean);
  return String(value).split(",").map((v) => v.trim()).filter(Boolean);
}
