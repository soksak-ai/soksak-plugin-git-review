// The comment contract (pure) — normalize/validate, target key, deterministic payload.
// RED baseline: a comment missing target/body slipping through, a line without a file, a payload
// that is non-deterministic or leaks resolved comments.
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeComment, targetKey, sortComments, formatCommentPayload, COMMENT_STATUS } from "../src/comment.js";

test("normalizeComment — valid record body (no id/createdAt), defaults", () => {
  const r = normalizeComment({ target: "feat/x", file: "src/a.ts", line: 12, body: "  fix this  " });
  assert.equal(r.ok, true);
  assert.deepEqual(r.comment, { target: "feat/x", file: "src/a.ts", line: 12, body: "fix this", status: "open", author: "unknown" });
  assert.ok(!("id" in r.comment) && !("createdAt" in r.comment)); // assigned at store/handler boundary
});

test("normalizeComment — required + shape rules", () => {
  assert.equal(normalizeComment({ body: "x" }).ok, false); // no target
  assert.equal(normalizeComment({ target: "t" }).ok, false); // no body
  assert.equal(normalizeComment({ target: "t", body: "b", line: 3 }).ok, false); // line without file
  assert.equal(normalizeComment({ target: "t", body: "b", file: "a", line: 0 }).ok, false); // line must be positive int
  assert.equal(normalizeComment({ target: "t", body: "b", file: "a", line: 1.5 }).ok, false);
  const gen = normalizeComment({ target: "t", body: "b", author: "max" });
  assert.deepEqual(gen.comment, { target: "t", file: null, line: null, body: "b", status: "open", author: "max" });
});

test("COMMENT_STATUS — the contract's two states", () => {
  assert.deepEqual([...COMMENT_STATUS], ["open", "resolved"]);
});

test("targetKey — address-safe", () => {
  const re = /^[a-z0-9][a-z0-9.-]*$/;
  assert.ok(re.test(targetKey("feat/login")));
  assert.equal(targetKey("feat/login"), "feat-login");
});

test("sortComments — deterministic by file, line, createdAt", () => {
  const c = [
    { id: "3", file: "b.ts", line: 2, createdAt: 5 },
    { id: "1", file: "a.ts", line: 9, createdAt: 1 },
    { id: "2", file: "a.ts", line: 2, createdAt: 1 },
    { id: "4", file: null, line: null, createdAt: 1 },
  ];
  assert.deepEqual(sortComments(c).map((x) => x.id), ["2", "1", "3", "4"]);
});

test("formatCommentPayload — only open, # prefix, deterministic, CR-joined", () => {
  const comments = [
    { file: "src/a.ts", line: 12, body: "line\nwrap", status: "open", createdAt: 1 },
    { file: null, line: null, body: "general note", status: "open", createdAt: 2 },
    { file: "src/z.ts", line: 3, body: "resolved one", status: "resolved", createdAt: 3 },
  ];
  const payload = formatCommentPayload("feat/x", comments);
  const lines = payload.split("\r").filter(Boolean);
  assert.equal(lines[0], "# review feat/x: 2 open comment(s)"); // resolved excluded from count
  assert.equal(lines[1], "# src/a.ts:12 — line wrap"); // newline collapsed
  assert.equal(lines[2], "# (general) — general note");
  assert.ok(!payload.includes("resolved one")); // resolved not injected
  assert.ok(payload.endsWith("\r"));
});
