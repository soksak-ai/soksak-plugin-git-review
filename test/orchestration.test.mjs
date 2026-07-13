// Handler orchestration — diff/comment/approve/merge.
//
// git is not run here and is not mocked at the process level: this plugin consumes
// soksak-spec-plugin-git and calls whoever implements it. The harness plays the implementer, and the id
// it plays is deliberately not the one that ships — an implementer named anywhere in this plugin
// would fail these tests.
//
// RED baseline: a diff that never asks the provider, a comment that skips validation, a merge that
// proceeds without approval or with open comments, a send that does not inject.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mockApp } from "./helpers/mock-app.mjs";

const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));
const plugin = (await import("../main.js")).default;

const CONTRACT = "soksak-spec-plugin-git";
const PROVIDER = "soksak-plugin-any-git";
const ok = (data) => ({ ok: true, code: "OK", message: "", data });
const fail = (code, message) => ({ ok: false, code, message });

// The implementer's answers, by contract command name.
function defaultGit() {
  return {
    root: () => ok({ state: "repo", root: "/repo" }),
    head: () => ok({ branch: "feat/x", oid: "a".repeat(40), detached: false }),
    "diff.files": (p) =>
      ok({
        base: p.base,
        target: p.target,
        files: [
          { path: "src/a.ts", status: "modified", added: 3, deleted: 1, binary: false },
          { path: "src/b.ts", status: "added", added: 5, deleted: 0, binary: false },
        ],
      }),
    "diff.range": () => ok({ diff: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n" }),
    merge: () => ok({ oid: "mergeoid123" }),
  };
}

// One router: the core's commands, and the contract's implementer (discovered, never named).
function router({ git = {}, implementers } = {}) {
  const calls = [];
  const gitCalls = [];
  const table = { ...defaultGit(), ...git };
  const enabled = implementers ?? [{ id: PROVIDER, version: "1.0.0", status: "enabled" }];
  const fn = async (name, params) => {
    calls.push({ name, params });
    if (name === "plugin.implementers") return ok({ contract: params?.contract, implementers: enabled });
    if (name.startsWith(`plugin.${PROVIDER}.`)) {
      const cmd = name.slice(`plugin.${PROVIDER}.`.length);
      gitCalls.push({ cmd, params });
      const h = table[cmd];
      return h ? h(params) : ok({});
    }
    return ok({});
  };
  return { fn, calls, gitCalls };
}

function boot({ git, implementers } = {}) {
  const r = router({ git, implementers });
  const terminalCalls = [];
  const terminal = { sendText: (pane, text) => (terminalCalls.push({ pane, text }), true), readBuffer: () => "" };
  const m = mockApp({ manifest, project: { id: "p1", root: "/repo" }, executeCommand: r.fn, terminal });
  plugin.activate(m.ctx);
  const cmd = (name) => m.registered.get(name).handler;
  return { m, r, terminalCalls, cmd };
}
const q = (m, coll) => m.app.data.query(coll, { scope: "index" });

test("diff.files — asks the provider for the branch's changes and returns its file list", async () => {
  const { r, cmd } = boot();
  const out = await cmd("diff.files")({ target: "feat/x" });
  assert.equal(out.target, "feat/x");
  assert.equal(out.base, "main");
  assert.deepEqual(out.files[0], { path: "src/a.ts", status: "modified", added: 3, deleted: 1, binary: false });
  assert.deepEqual(out.files[1], { path: "src/b.ts", status: "added", added: 5, deleted: 0, binary: false });

  // The range is the contract's (base...target, three dots) — this plugin passes the two refs and
  // does not assemble git syntax of its own.
  const call = r.gitCalls.find((c) => c.cmd === "diff.files");
  assert.deepEqual(call.params, { path: "/repo", base: "main", target: "feat/x" });
  assert.ok(
    r.calls.some((c) => c.name === "plugin.implementers" && c.params?.contract === CONTRACT),
    "the provider was never resolved by contract",
  );
  for (const c of r.calls) assert.ok(!c.name.includes("git-core"), `an implementer is named: ${c.name}`);
});

test("diff.files — a hostile ref is the contract's refusal, and it comes back untouched", async () => {
  // The whitelist lives in the contract (§3): the implementer refuses before anything runs. This
  // plugin keeps no second copy of that rule — a duplicated defense is the debt the contract ends.
  const { cmd } = boot({ git: { "diff.files": () => fail("INVALID_REF", "ref not allowed") } });
  const out = await cmd("diff.files")({ target: "--upload-pack=evil" });
  assert.equal(out.ok, false);
  assert.equal(out.code, "INVALID_REF");
});

test("diff.files — no enabled implementer is a loud refusal", async () => {
  const { r, cmd } = boot({ implementers: [] });
  const out = await cmd("diff.files")({ target: "feat/x" });
  assert.equal(out.ok, false);
  assert.equal(out.code, "NO_GIT_PROVIDER");
  assert.equal(r.gitCalls.length, 0);
});

test("diff.read — returns the unified diff of the range", async () => {
  const { r, cmd } = boot();
  const out = await cmd("diff.read")({ target: "feat/x", file: "src/a.ts" });
  assert.ok(out.diff.includes("@@ -1 +1 @@"));
  assert.equal(out.file, "src/a.ts");
  const call = r.gitCalls.find((c) => c.cmd === "diff.range");
  assert.deepEqual(call.params, { path: "/repo", base: "main", target: "feat/x", file: "src/a.ts" });
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
  const { m, r, cmd } = boot();
  await cmd("approve")({ target: "feat/x" });
  const out = await cmd("approve.revoke")({ target: "feat/x" });
  assert.equal(out.revoked, true);
  assert.equal((await q(m, "approval")).length, 0, "the approval record must be gone, not merely flagged");
  const merged = await cmd("merge")({ target: "feat/x" });
  assert.equal(merged.code, "NOT_APPROVED", "an approval taken back must stop being a key to merge");
  assert.equal(r.gitCalls.filter((c) => c.cmd === "merge").length, 0);
});

test("approve.revoke — revoking what was never approved is a no-op", async () => {
  const { cmd } = boot();
  assert.equal((await cmd("approve.revoke")({ target: "feat/x" })).revoked, false);
  assert.equal((await cmd("approve.revoke")({})).code, "INVALID_PARAMS");
});

test("merge — refuses without approval (the provider is never asked to merge)", async () => {
  const { r, cmd } = boot();
  const out = await cmd("merge")({ target: "feat/x" });
  assert.equal(out.code, "NOT_APPROVED");
  assert.equal(r.gitCalls.filter((c) => c.cmd === "merge").length, 0);
});

test("merge — refuses while open comments remain (the provider is never asked to merge)", async () => {
  const { r, cmd } = boot();
  await cmd("approve")({ target: "feat/x" });
  await cmd("comment.add")({ target: "feat/x", body: "unresolved" });
  const out = await cmd("merge")({ target: "feat/x" });
  assert.equal(out.code, "UNRESOLVED_COMMENTS");
  assert.equal(r.gitCalls.filter((c) => c.cmd === "merge").length, 0);
});

test("merge — approved + comments resolved → the provider merges, and the oid comes back", async () => {
  const { m, r, cmd } = boot();
  await cmd("approve")({ target: "feat/x" });
  const c = await cmd("comment.add")({ target: "feat/x", body: "nit" });
  await cmd("comment.resolve")({ id: c.id });
  const out = await cmd("merge")({ target: "feat/x" });
  assert.equal(out.merged, true);
  assert.equal(out.oid, "mergeoid123");
  const mergeCall = r.gitCalls.find((c2) => c2.cmd === "merge");
  // --no-ff is the contract's default and its reason: a review that approved a branch must not have
  // that branch fast-forwarded out of the history.
  assert.deepEqual(mergeCall.params, { path: "/repo", target: "feat/x", noFf: true });
  // the approval is consumed — a second merge without re-approval refuses
  assert.equal((await q(m, "approval")).length, 0, "approval not consumed by merge");
  assert.equal((await cmd("merge")({ target: "feat/x" })).code, "NOT_APPROVED", "re-merge must require fresh approval");
});
