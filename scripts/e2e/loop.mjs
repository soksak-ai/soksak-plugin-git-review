#!/usr/bin/env node
// End-to-end gate for soksak-plugin-git-review, driven only through registry commands (sok).
// Idempotent: a fixture repo under ~/.soksak-e2e with a `main` (tagged `base`) and a `review/target`
// branch; every run resets main to base and reclaims the worktree.
// Gates: ① diff view render + ui.tree node + click   ② comment CRUD (record contract)
//        ③ comment→terminal verified (readBuffer)     ④ approve→merge (merge commit)
//        ⑤ conformance (declared ≡ actual)             ⑥ window snapshot for eye verification
//
// Env: SOK = the sok binary (default: the pinned debug CLI). Requires the target app running.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import assert from "node:assert/strict";
import { join } from "node:path";

const SOK = process.env.SOK || "/Users/max/ai/cli/vsterm-tauri/src-tauri/target/debug/sok-debug";
const FIXTURE = join(homedir(), ".soksak-e2e", "git-review");
const REPO = join(FIXTURE, "repo");
const TARGET = "review/target";
const WT = `${REPO}-wt/review-target`;
const BASE = "main";
const SNAP = join(FIXTURE, "snapshot.png");
const PLUGIN = "plugin.soksak-plugin-git-review";

function sok(cmd, params, opts = {}) {
  const args = [];
  if (opts.window) args.push("--window", opts.window);
  args.push(cmd);
  if (params !== undefined) args.push(JSON.stringify(params));
  const r = spawnSync(SOK, args, { encoding: "utf8", timeout: 30000 });
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`sok ${cmd} — non-JSON output: ${r.stdout || r.stderr}`);
  }
}
const git = (args, cwd = REPO) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
const step = (n, s) => console.log(`\n[${n}] ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureFixture() {
  if (!existsSync(join(REPO, ".git"))) {
    mkdirSync(REPO, { recursive: true });
    for (const a of [["init", "-b", "main"], ["config", "user.email", "e2e@soksak.test"], ["config", "user.name", "e2e"]]) git(a);
    writeFileSync(join(REPO, "README.md"), "hello\n");
    git(["add", "README.md"]);
    git(["commit", "-q", "-m", "init"]);
    git(["tag", "base"]);
  }
  // defensive: the base tag must exist for the idempotent reset (a pre-existing repo may lack it).
  if (git(["rev-parse", "-q", "--verify", "refs/tags/base"]).status !== 0) {
    const rootCommit = git(["rev-list", "--max-parents=0", "HEAD"]).stdout.trim();
    if (rootCommit) git(["tag", "base", rootCommit]);
  }
  // ensure review/target exists with a change diverged from base
  if (git(["show-ref", "--verify", "--quiet", `refs/heads/${TARGET}`]).status !== 0) {
    git(["checkout", "-q", "-b", TARGET, "base"]);
    writeFileSync(join(REPO, "feature.txt"), "new feature\n");
    writeFileSync(join(REPO, "README.md"), "hello\nchanged on the feature branch\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "feature change"]);
    git(["checkout", "-q", "main"]);
  }
}

async function main() {
  step("setup", "app up + fixture repo with main(base) and review/target");
  assert.ok(sok("window.list").ok, `app not reachable via ${SOK}`);
  ensureFixture();
  // git pre-clean: main back to base, worktree reclaimed. Force-checkout tolerates a dirty main
  // left by an interrupted run; the worktree remove/prune pair reclaims a stale or crashed worktree.
  git(["checkout", "-q", "-f", "main"]);
  git(["reset", "--hard", "-q", "base"]);
  git(["worktree", "remove", "--force", WT]);
  git(["worktree", "prune"]);

  step("worktree", "check out review/target in its own worktree, open it as a window");
  assert.equal(git(["worktree", "add", "-q", WT, TARGET]).status, 0, "worktree add failed");
  const wo = sok("window.open", { root: WT });
  const win = wo.data.label || wo.data.existingWindow;
  assert.ok(win, "no worktree window");

  step("pre-clean", "resolve any leftover open comments for the target (idempotent)");
  for (const c of sok(`${PLUGIN}.comment.list`, { target: TARGET, status: "open" }, { window: win }).data.comments || []) {
    sok(`${PLUGIN}.comment.resolve`, { id: c.id }, { window: win });
  }

  step("view", "open the Review view in the worktree window");
  sok("plugin.view.open", { view: "soksak-plugin-git-review.view", placement: "content" }, { window: win });
  await sleep(1200);

  // ── GATE ① diff surface ─────────────────────────────────────────────────────
  step("①.diff", "diff.files/read return the target's changes; the view exposes file nodes");
  const files = sok(`${PLUGIN}.diff.files`, { target: TARGET, path: REPO }, { window: win });
  assert.ok(files.ok, `diff.files: ${files.message}`);
  const paths = files.data.files.map((f) => f.path);
  assert.ok(paths.includes("feature.txt") && paths.includes("README.md"), `unexpected files: ${paths}`);
  const read = sok(`${PLUGIN}.diff.read`, { target: TARGET, file: "feature.txt", path: REPO }, { window: win });
  assert.ok(read.data.diff.includes("new feature"), "diff.read missing hunk");

  const tree = sok("ui.tree", undefined, { window: win });
  const addrs = (tree.data.nodes || tree.data || []).map((n) => n.address || n);
  const refresh = addrs.find((a) => typeof a === "string" && a.endsWith("/node/refresh"));
  const fileNode = addrs.find((a) => typeof a === "string" && a.includes("/node/file/"));
  assert.ok(refresh, "no refresh node");
  assert.ok(fileNode, `no file node. git-review addrs:\n${addrs.filter((a) => String(a).includes("git-review")).join("\n")}`);
  assert.ok(sok("ui.input.click", { address: refresh }, { window: win }).ok, "refresh click failed");

  // ── GATE ② comment CRUD (record contract) ───────────────────────────────────
  step("②.comment", "comment add/list/resolve; the record carries the contract fields");
  const c1 = sok(`${PLUGIN}.comment.add`, { target: TARGET, file: "feature.txt", line: 1, body: "e2e: check this line" }, { window: win });
  assert.ok(c1.ok && c1.data.id, "comment.add failed");
  for (const f of ["id", "target", "file", "line", "body", "status", "author", "createdAt"]) assert.ok(f in c1.data, `record missing ${f}`);
  assert.equal(c1.data.status, "open");
  const listed = sok(`${PLUGIN}.comment.list`, { target: TARGET }, { window: win }).data.comments;
  assert.ok(listed.some((c) => c.id === c1.data.id), "comment not listed");
  assert.equal(sok(`${PLUGIN}.comment.resolve`, { id: c1.data.id }, { window: win }).data.status, "resolved");

  // ── GATE ③ comment→terminal (verified in the pane buffer) ────────────────────
  step("③.send", "inject an open comment into an explicit terminal pane, verify in its buffer");
  const c2body = "e2e: please handle the null case";
  sok(`${PLUGIN}.comment.add`, { target: TARGET, body: c2body }, { window: win });
  const vo = sok("view.open", { program: "terminal-xterm" }, { window: win });
  const pane = vo.data.viewId;
  assert.ok(pane, "no terminal pane");
  await sleep(2500);
  const sent = sok(`${PLUGIN}.comment.send`, { target: TARGET, pane }, { window: win });
  assert.ok(sent.ok, `comment.send: ${sent.code} ${sent.message}`);
  assert.ok(sent.data.count >= 1);
  await sleep(1500);
  const buf = sok("term.read", { pane, lines: 12 }, { window: win }).data.text;
  assert.ok(String(buf).includes("please handle the null case"), `payload not in pane buffer:\n${buf}`);

  // ── GATE ④ approve→merge (a real merge commit) ───────────────────────────────
  step("④.merge", "resolve comments, approve, then local-merge the target into main");
  for (const c of sok(`${PLUGIN}.comment.list`, { target: TARGET, status: "open" }, { window: win }).data.comments || []) {
    sok(`${PLUGIN}.comment.resolve`, { id: c.id }, { window: win });
  }
  // merge without approval must refuse
  assert.equal(sok(`${PLUGIN}.merge`, { target: TARGET, path: REPO }, { window: win }).code, "NOT_APPROVED", "merge should refuse unapproved");
  assert.ok(sok(`${PLUGIN}.approve`, { target: TARGET }, { window: win }).data.approved, "approve failed");
  const merged = sok(`${PLUGIN}.merge`, { target: TARGET, path: REPO }, { window: win });
  assert.ok(merged.ok && merged.data.merged, `merge: ${merged.code} ${merged.message}`);
  const parents = git(["show", "--no-patch", "--format=%P", "HEAD"]).stdout.trim().split(/\s+/);
  assert.equal(parents.length, 2, `HEAD is not a merge commit (parents: ${parents})`);
  assert.ok(existsSync(join(REPO, "feature.txt")), "merge did not bring the target's file into main");

  // ── GATE ⑤ conformance ───────────────────────────────────────────────────────
  step("⑤.conformance", "declared ≡ actual (runtime)");
  const conf = sok("plugin.conformance", { id: "soksak-plugin-git-review" }, { window: win });
  assert.ok(conf.ok, `conformance: ${conf.message}`);
  const viol = (conf.data.commands?.missing || []).concat(conf.data.commands?.messagesMissing || []);
  assert.equal(viol.length, 0, `conformance violations: ${JSON.stringify(viol)}`);

  // ── GATE ⑥ snapshot ──────────────────────────────────────────────────────────
  step("⑥.snapshot", `capture the review window → ${SNAP}`);
  assert.ok(sok("window.snapshot", { path: SNAP }, { window: win }).ok, "snapshot failed");

  console.log(`\nALL GATES PASSED. snapshot: ${SNAP}`);
}

main().catch((e) => {
  console.error(`\nE2E FAILED: ${e.message}`);
  process.exit(1);
});
