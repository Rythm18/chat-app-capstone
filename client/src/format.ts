/** Small display formatters shared across components. */

/** `nowMs` is the live-ticking clock from useNow; pass it for running spans
 *  so the label counts up between stream events. */
export function elapsed(startIso: string | null, endIso: string | null, nowMs?: number): string {
  if (!startIso) return "";
  const end = endIso ? Date.parse(endIso) : (nowMs ?? Date.now());
  const s = Math.max(0, Math.round((end - Date.parse(startIso)) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** One-line human summary of a tool input for collapsed step rows. */
export function toolInputSummary(tool: string, input: Record<string, unknown>): string {
  if (typeof input.query === "string") return `“${truncate(input.query, 64)}”`;
  if (typeof input.file_path === "string") {
    const name = input.file_path.split("/").pop() ?? input.file_path;
    return typeof input.content === "string" ? `${name} (${bytes(input.content.length)})` : name;
  }
  if (typeof input.pattern === "string") return `pattern ${input.pattern}`;
  const keys = Object.keys(input);
  return keys.length ? truncate(JSON.stringify(input), 64) : "";
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
