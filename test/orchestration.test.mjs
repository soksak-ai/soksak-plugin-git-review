// Handler orchestration — diff/comment/approve/merge, driven by mocked process (git), data, and
// terminal. RED baseline: a diff that does not run git, a comment that skips validation, a merge
// that proceeds without approval or with open comments, a send that does not inject.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mockApp } from "./helpers/mock-app.mjs";
import { mockProcess } from "./helpers/mock-process.mjs";

const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));
const plugin = (await import("../main.js")).default;

// git process handler by argv.
function defaultGit(_cmd, args) {
  if (args[0] === "rev-parse" && args.includes("--show-toplevel")) return { stdout: "/repo\n", code: 0 };
  if (args[0] === "rev-parse" && args.includes("HEAD")) return { stdout: "mergeoid123\n", code: 0 };
  if (args[0] === "diff" && args.includes("--name-status")) return { stdout: "M\tsrc/a.ts\nA\tsrc/b.ts\n", code: 0 };
  if (args[0] === "diff" && args.includes("--numstat")) return { stdout: "3\t1\tsrc/a.ts\n5\t0\tsrc/b.ts\n", code: 0 };
  if (args[0] === "diff") return { stdout: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n", code: 0 };
  if (args[0] === "merge") return { code: 0 };
  return { stdout: "", code: 0 };
}

function boot({ git } = {}) {
  const proc = mockProcess(git ?? defaultGit);
  const terminalCalls = [];
  const terminal = { sendText: (pane, text) => (terminalCalls.push({ pane, text }), true), readBuffer: () => "" };
  const m = mockApp({ manifest, project: { id: "p1", root: "/repo" }, process: proc.api, terminal });
  plugin.activate(m.ctx);
  const cmd = (name) => m.registered.get(name).handler;
  return { m, proc, terminalCalls, cmd };
}
const q = (m, coll) => m.app.data.query(coll, { scope: "index" });

test("diff.files — runs git name-status + numstat, returns the merged file list", async () => {
  const { proc, cmd } = boot();
  const out = await cmd("diff.files")({ target: "feat/x" });
  assert.equal(out.target, "feat/x");
  assert.equal(out.base, "main");
  assert.deepEqual(out.files[0], { path: "src/a.ts", status: "modified", added: 3, deleted: 1, binary: false });
  assert.deepEqual(out.files[1], { path: "src/b.ts", status: "added", added: 5, deleted: 0, binary: false });
  const ns = proc.calls.find((c) => c.args.includes("--name-status"));
  assert.ok(ns.args.includes("main...feat/x")); // three-dot range
});

test("diff.files — an invalid ref is rejected before git runs", async () => {
  const { proc, cmd } = boot();
  const out = await cmd("diff.files")({ target: "--upload-pack=evil" });
  assert.equal(out.code, "INVALID_REF");
  assert.equal(proc.calls.filter((c) => c.args.includes("--name-status")).length, 0);
});

test("diff.read — returns the unified diff", async () => {
  const { cmd } = boot();
  const out = await cmd("diff.read")({ target: "feat/x", file: "src/a.ts" });
  assert.ok(out.diff.includes("@@ -1 +1 @@"));
  assert.equal(out.file, "src/a.ts");
});

test("comment.add — validates then persists a record carrying the contract fields", async () => {
  const { m, cmd } = boot();
  const out = await cmd("comment.add")({ target: "feat/x", file: "src/a.ts", line: 12, body: "handle null" });
  assert.ok(out.id, "no id assigned");
  assert.equal(out.target, "feat/x");
  assert.equal(out.status, "open");
  assert.ok(out.createdAt > 0);
  const rows = await q(m, "comment");
  assert.equal(rows.length, 1);
  // the record has every contract field
  for (const f of ["id", "target", "file", "line", "body", "status", "author", "createdAt"]) assert.ok(f in rows[0], `missing ${f}`);
});

test("comment.add — invalid input is INVALID_COMMENT, nothing persisted", async () => {
  const { m, cmd } = boot();
  assert.equal((await cmd("comment.add")({ target: "t" })).code, "INVALID_COMMENT"); // no body
  assert.equal((await cmd("comment.add")({ target: "t", body: "b", line: 3 })).code, "INVALID_COMMENT"); // line without file
  assert.equal((await q(m, "comment")).length, 0);
});

test("comment.list — filters by target and status", async () => {
  const { cmd } = boot();
  await cmd("comment.add")({ target: "a", body: "one" });
  await cmd("comment.add")({ target: "a", body: "two" });
  await cmd("comment.add")({ target: "b", body: "three" });
  assert.equal((await cmd("comment.list")({ target: "a" })).comments.length, 2);
  assert.equal((await cmd("comment.list")({ target: "a", status: "open" })).comments.length, 2);
  assert.equal((await cmd("comment.list")({})).comments.length, 3);
});

test("comment.resolve / reopen — status transitions, NOT_FOUND for a stranger", async () => {
  const { cmd } = boot();
  const added = await cmd("comment.add")({ target: "a", body: "x" });
  assert.equal((await cmd("comment.resolve")({ id: added.id })).status, "resolved");
  assert.equal((await cmd("comment.reopen")({ id: added.id })).status, "open");
  assert.equal((await cmd("comment.resolve")({ id: "nope" })).code, "NOT_FOUND");
});

test("comment.remove — permanently deletes the record, idempotent", async () => {
  const { m, cmd } = boot();
  const added = await cmd("comment.add")({ target: "a", body: "x" });
  assert.equal((await q(m, "comment")).length, 1);
  assert.equal((await cmd("comment.remove")({ id: added.id })).removed, true);
  assert.equal((await q(m, "comment")).length, 0);
  assert.equal((await cmd("comment.remove")({ id: added.id })).removed, false); // idempotent no-op
});

test("comment.send — injects the deterministic payload into the explicit pane", async () => {
  const { terminalCalls, cmd } = boot();
  await cmd("comment.add")({ target: "feat/x", file: "src/a.ts", line: 12, body: "fix this" });
  await cmd("comment.add")({ target: "feat/x", body: "and this" });
  const out = await cmd("comment.send")({ target: "feat/x", pane: "v5" });
  assert.equal(out.sent, true);
  assert.equal(out.count, 2);
  assert.equal(terminalCalls.length, 1);
  assert.equal(terminalCalls[0].pane, "v5");
  assert.ok(terminalCalls[0].text.includes("fix this") && terminalCalls[0].text.includes("and this"));
  assert.ok(terminalCalls[0].text.startsWith("# review feat/x"));
});

test("comment.send — requires an explicit pane", async () => {
  const { terminalCalls, cmd } = boot();
  assert.equal((await cmd("comment.send")({ target: "feat/x" })).code, "INVALID_PARAMS");
  assert.equal(terminalCalls.length, 0);
});

test("approve — records approval keyed by target", async () => {
  const { m, cmd } = boot();
  const out = await cmd("approve")({ target: "feat/x", author: "max" });
  assert.equal(out.approved, true);
  const rows = await q(m, "approval");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].target, "feat/x");
});

test("approve.revoke — a withdrawn approval sends merge back to refusing", async () => {
  const { m, proc, cmd } = boot();
  await cmd("approve")({ target: "feat/x" });
  const out = await cmd("approve.revoke")({ target: "feat/x" });
  assert.equal(out.revoked, true);
  assert.equal((await q(m, "approval")).length, 0, "the approval record must be gone, not merely flagged");
  const merged = await cmd("merge")({ target: "feat/x" });
  assert.equal(merged.code, "NOT_APPROVED", "an approval taken back must stop being a key to merge");
  assert.equal(proc.calls.filter((c) => c.args[0] === "merge").length, 0);
});

test("approve.revoke — revoking what was never approved is a no-op", async () => {
  const { cmd } = boot();
  assert.equal((await cmd("approve.revoke")({ target: "feat/x" })).revoked, false);
  assert.equal((await cmd("approve.revoke")({})).code, "INVALID_PARAMS");
});

test("merge — refuses without approval (no git merge)", async () => {
  const { proc, cmd } = boot();
  const out = await cmd("merge")({ target: "feat/x" });
  assert.equal(out.code, "NOT_APPROVED");
  assert.equal(proc.calls.filter((c) => c.args[0] === "merge").length, 0);
});

test("merge — refuses while open comments remain (no git merge)", async () => {
  const { proc, cmd } = boot();
  await cmd("approve")({ target: "feat/x" });
  await cmd("comment.add")({ target: "feat/x", body: "unresolved" });
  const out = await cmd("merge")({ target: "feat/x" });
  assert.equal(out.code, "UNRESOLVED_COMMENTS");
  assert.equal(proc.calls.filter((c) => c.args[0] === "merge").length, 0);
});

test("merge — approved + comments resolved → git merge, returns the oid", async () => {
  const { m, proc, cmd } = boot();
  await cmd("approve")({ target: "feat/x" });
  const c = await cmd("comment.add")({ target: "feat/x", body: "nit" });
  await cmd("comment.resolve")({ id: c.id });
  const out = await cmd("merge")({ target: "feat/x" });
  assert.equal(out.merged, true);
  assert.equal(out.oid, "mergeoid123");
  const mergeCall = proc.calls.find((c2) => c2.args[0] === "merge");
  assert.ok(mergeCall.args.includes("--no-ff") && mergeCall.args.includes("feat/x"));
  // the approval is consumed — a second merge without re-approval refuses
  assert.equal((await q(m, "approval")).length, 0, "approval not consumed by merge");
  assert.equal((await cmd("merge")({ target: "feat/x" })).code, "NOT_APPROVED", "re-merge must require fresh approval");
});
