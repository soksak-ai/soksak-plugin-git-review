// The git seam — this plugin runs no git. It asks whoever implements soksak-spec-plugin-git, and it
// finds that plugin by contract, never by name.
//
// The provider id the tests hand it is deliberately NOT the one that ships: if an implementer's name
// were written anywhere in this plugin, these tests could not pass.
import test from "node:test";
import assert from "node:assert/strict";
import { GIT_CONTRACT, makeGit } from "../src/git.js";

const PROVIDER = "soksak-plugin-any-git";
const ENABLED = [{ id: PROVIDER, version: "1.0.0", status: "enabled" }];
const msg = (en) => en;

function hostApp({ implementers = ENABLED, answers = {}, calls = [], discovery = [] } = {}) {
  return {
    commands: {
      async execute(name, params) {
        if (name === "plugin.implementers") {
          discovery.push(params);
          return { ok: true, code: "OK", message: "", data: { implementers } };
        }
        calls.push([name, params]);
        const cmd = name.startsWith(`plugin.${PROVIDER}.`) ? name.slice(`plugin.${PROVIDER}.`.length) : null;
        const answer = cmd && answers[cmd];
        if (typeof answer === "function") return answer(params);
        if (answer) return answer;
        return { ok: true, code: "OK", message: "", data: {} };
      },
    },
  };
}

test("the provider is resolved by contract id, and never named", async () => {
  const calls = [];
  const discovery = [];
  const git = makeGit(hostApp({ calls, discovery }), msg);
  await git.files({ repoRoot: "/repo", base: "main", target: "feat/x" });
  assert.deepEqual(discovery, [{ contract: GIT_CONTRACT }]);
  assert.equal(calls[0][0], `plugin.${PROVIDER}.diff.files`);
  for (const [name] of calls) assert.ok(!name.includes("git-core"), `an implementer is named: ${name}`);
});

test("no enabled implementer → loud refusal, never an empty review", async () => {
  const git = makeGit(hostApp({ implementers: [] }), msg);
  for (const out of [
    await git.files({ repoRoot: "/repo", base: "main", target: "feat/x" }),
    await git.hunks({ repoRoot: "/repo", base: "main", target: "feat/x" }),
    await git.merge({ repoRoot: "/repo", target: "feat/x" }),
    await git.head("/repo"),
  ]) {
    assert.equal(out.ok, false);
    assert.equal(out.code, "NO_GIT_PROVIDER");
    assert.ok(out.message.includes(GIT_CONTRACT));
  }
});

test("diff.files — the contract answers with the file list already merged with its counts", async () => {
  const calls = [];
  const git = makeGit(
    hostApp({
      calls,
      answers: {
        "diff.files": () => ({
          ok: true,
          data: { files: [{ path: "src/a.ts", status: "modified", added: 3, deleted: 1, binary: false }] },
        }),
      },
    }),
    msg,
  );
  const out = await git.files({ repoRoot: "/repo", base: "main", target: "feat/x" });
  assert.equal(out.ok, true);
  assert.deepEqual(out.files[0], { path: "src/a.ts", status: "modified", added: 3, deleted: 1, binary: false });
  // Two refs go out; no git range syntax is assembled here (the three-dot range is the contract's).
  assert.deepEqual(calls[0][1], { path: "/repo", base: "main", target: "feat/x" });
});

test("a hostile ref is the contract's refusal, and it comes back untouched", async () => {
  const git = makeGit(
    hostApp({ answers: { "diff.files": { ok: false, code: "INVALID_REF", message: "ref not allowed" } } }),
    msg,
  );
  const out = await git.files({ repoRoot: "/repo", base: "main", target: "--upload-pack=evil" });
  assert.equal(out.ok, false);
  assert.equal(out.code, "INVALID_REF");
  assert.equal(out.message, "ref not allowed");
});

test("merge — --no-ff by default, and a conflict comes back as the contract's error", async () => {
  const calls = [];
  const ok = makeGit(hostApp({ calls, answers: { merge: () => ({ ok: true, data: { oid: "abc" } }) } }), msg);
  const merged = await ok.merge({ repoRoot: "/repo", target: "feat/x" });
  assert.equal(merged.oid, "abc");
  assert.deepEqual(calls[0][1], { path: "/repo", target: "feat/x", noFf: true });

  const conflicted = makeGit(
    hostApp({ answers: { merge: { ok: false, code: "GIT_ERROR", message: "CONFLICT (content)" } } }),
    msg,
  );
  const out = await conflicted.merge({ repoRoot: "/repo", target: "feat/x" });
  assert.equal(out.ok, false);
  assert.equal(out.code, "GIT_ERROR");
  assert.ok(out.message.includes("CONFLICT"), "git's own conflict text must survive");
});

test("head — the checked-out branch, and a detached HEAD is a fact, not an error", async () => {
  const onBranch = makeGit(hostApp({ answers: { head: { ok: true, data: { branch: "main", detached: false } } } }), msg);
  assert.equal((await onBranch.head("/repo")).branch, "main");
  const detached = makeGit(hostApp({ answers: { head: { ok: true, data: { branch: null, detached: true } } } }), msg);
  const out = await detached.head("/repo");
  assert.equal(out.ok, true);
  assert.equal(out.branch, null);
  assert.equal(out.detached, true);
});
