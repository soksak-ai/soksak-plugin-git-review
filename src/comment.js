// The comment contract (pure). A comment record is
//   { id, target, file, line?, body, status, author, createdAt }
// where the schema is the contract downstream consumers read. This module validates the mutable
// fields, keys a target for indexing, and formats a target's open comments into the deterministic
// payload injected into the review target's terminal. id/createdAt are assigned at the store/handler
// boundary (kept out of here so the logic stays pure and testable).

export const COMMENT_STATUS = Object.freeze(["open", "resolved"]);

// Validate + normalize the caller's fields into the record body (minus id/createdAt).
// target and body are required; line requires a file; author defaults to "unknown".
export function normalizeComment(input) {
  const i = input || {};
  const target = typeof i.target === "string" ? i.target.trim() : "";
  if (!target) return { ok: false, reason: "target required" };
  const body = typeof i.body === "string" ? i.body.trim() : "";
  if (!body) return { ok: false, reason: "body required" };
  const file = typeof i.file === "string" && i.file.trim() ? i.file.trim() : null;
  let line = null;
  if (i.line !== undefined && i.line !== null && i.line !== "") {
    const n = Number(i.line);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, reason: "line must be a positive integer" };
    line = n;
  }
  if (line !== null && !file) return { ok: false, reason: "line requires file" };
  const author = typeof i.author === "string" && i.author.trim() ? i.author.trim() : "unknown";
  return { ok: true, comment: { target, file, line, body, status: "open", author } };
}

// A target (branch/worktree id) → a stable address-safe key for indexing (approval id, node key).
export function targetKey(target) {
  const k = String(target)
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return /^[a-z0-9]/.test(k) ? k : "t-" + k;
}

// Deterministic order: by file (general last), then line, then createdAt, then id.
export function sortComments(comments) {
  return [...(comments || [])].sort((a, b) => {
    const fa = a.file || "￿"; // null file sorts last
    const fb = b.file || "￿";
    if (fa !== fb) return fa < fb ? -1 : 1;
    if ((a.line || 0) !== (b.line || 0)) return (a.line || 0) - (b.line || 0);
    if ((a.createdAt || 0) !== (b.createdAt || 0)) return (a.createdAt || 0) - (b.createdAt || 0);
    return String(a.id) < String(b.id) ? -1 : 1;
  });
}

// One-line-safe body (injection is line-oriented; collapse newlines/tabs to spaces).
function oneLine(body) {
  return String(body).replace(/[\r\n\t]+/g, " ").trim();
}

// The deterministic payload injected into the target's terminal. Every line is prefixed "# " so a
// shell treats it as a no-op comment (safe injection) and an agent reads it as review context.
// Lines are joined with "\r" (Enter) and terminated with "\r" so the buffer commits them.
export function formatCommentPayload(target, comments) {
  const open = (comments || []).filter((c) => c.status === "open");
  const header = `# review ${target}: ${open.length} open comment(s)`;
  const lines = sortComments(open).map((c) => {
    const loc = c.file ? `${c.file}${c.line ? ":" + c.line : ""}` : "(general)";
    return `# ${loc} — ${oneLine(c.body)}`;
  });
  return [header, ...lines].join("\r") + "\r";
}
