// src/diff.js
var STATUS_MAP = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "typechange",
  U: "unmerged"
};
function parseNameStatus(stdout) {
  const out = [];
  for (const line of String(stdout).split("\n")) {
    if (!line.trim()) continue;
    const cols = line.split("	");
    const letter = (cols[0] || "")[0] || "";
    const status = STATUS_MAP[letter] || "modified";
    if ((letter === "R" || letter === "C") && cols.length >= 3) {
      out.push({ status, path: cols[2], oldPath: cols[1] });
    } else {
      out.push({ status, path: cols[cols.length - 1] });
    }
  }
  return out;
}
function parseNumstat(stdout) {
  const map = /* @__PURE__ */ new Map();
  for (const line of String(stdout).split("\n")) {
    if (!line.trim()) continue;
    const cols = line.split("	");
    if (cols.length < 3) continue;
    const added = cols[0] === "-" ? null : Number(cols[0]);
    const deleted = cols[1] === "-" ? null : Number(cols[1]);
    let path = cols.slice(2).join("	");
    if (path.includes(" => ")) {
      path = path.replace(/\{[^}]*? => ([^}]*?)\}/g, "$1").replace(/^.* => /, "");
    }
    map.set(path, { added, deleted, binary: added === null && deleted === null });
  }
  return map;
}
function mergeFileList(nameStatusArr, numstatMap) {
  return (nameStatusArr || []).map((f) => {
    const n = numstatMap && numstatMap.get(f.path) || {};
    return {
      path: f.path,
      status: f.status,
      ...f.oldPath ? { oldPath: f.oldPath } : {},
      added: n.added ?? null,
      deleted: n.deleted ?? null,
      binary: !!n.binary
    };
  });
}
function nodeKey(path) {
  const k = String(path).toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z0-9]/.test(k) ? k : "f-" + k;
}

// src/comment.js
var COMMENT_STATUS = Object.freeze(["open", "resolved"]);
function normalizeComment(input) {
  const i = input || {};
  const target = typeof i.target === "string" ? i.target.trim() : "";
  if (!target) return { ok: false, reason: "target required" };
  const body = typeof i.body === "string" ? i.body.trim() : "";
  if (!body) return { ok: false, reason: "body required" };
  const file = typeof i.file === "string" && i.file.trim() ? i.file.trim() : null;
  let line = null;
  if (i.line !== void 0 && i.line !== null && i.line !== "") {
    const n = Number(i.line);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, reason: "line must be a positive integer" };
    line = n;
  }
  if (line !== null && !file) return { ok: false, reason: "line requires file" };
  const author = typeof i.author === "string" && i.author.trim() ? i.author.trim() : "unknown";
  return { ok: true, comment: { target, file, line, body, status: "open", author } };
}
function targetKey(target) {
  const k = String(target).toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z0-9]/.test(k) ? k : "t-" + k;
}
function sortComments(comments) {
  return [...comments || []].sort((a, b) => {
    const fa = a.file || "\uFFFF";
    const fb = b.file || "\uFFFF";
    if (fa !== fb) return fa < fb ? -1 : 1;
    if ((a.line || 0) !== (b.line || 0)) return (a.line || 0) - (b.line || 0);
    if ((a.createdAt || 0) !== (b.createdAt || 0)) return (a.createdAt || 0) - (b.createdAt || 0);
    return String(a.id) < String(b.id) ? -1 : 1;
  });
}
function oneLine(body) {
  return String(body).replace(/[\r\n\t]+/g, " ").trim();
}
function formatCommentPayload(target, comments) {
  const open = (comments || []).filter((c) => c.status === "open");
  const header = `# review ${target}: ${open.length} open comment(s)`;
  const lines = sortComments(open).map((c) => {
    const loc = c.file ? `${c.file}${c.line ? ":" + c.line : ""}` : "(general)";
    return `# ${loc} \u2014 ${oneLine(c.body)}`;
  });
  return [header, ...lines].join("\r") + "\r";
}

// src/git.js
var READ_ENV = Object.freeze({ LC_ALL: "C", LANG: "C", GIT_OPTIONAL_LOCKS: "0" });
var WRITE_ENV = Object.freeze({ LC_ALL: "C", LANG: "C" });
var READ_TIMEOUT_MS = 3e4;
var WRITE_TIMEOUT_MS = 18e4;
var NOT_REPO_RE = /not a git repository/i;
function gitFail(r) {
  return { ok: false, code: "GIT_ERROR", message: r.stderr || `git exit ${r.code}` };
}
function validRef(ref) {
  if (typeof ref !== "string" || ref.length === 0) return false;
  if (ref.startsWith("-") || ref.includes("..") || ref.endsWith("/") || ref.endsWith(".lock")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || ref === "HEAD";
}
function makeGit(processApi) {
  function run({ cwd, args, write = false, timeoutMs }) {
    return new Promise((resolve, reject) => {
      const limit = timeoutMs ?? (write ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS);
      const dec = new TextDecoder();
      let out = "";
      let err = "";
      let done = false;
      let timer = null;
      processApi.spawn("git", args, { cwd, env: write ? { ...WRITE_ENV } : { ...READ_ENV } }).then((handle) => {
        const subs = [];
        const finish = (fn, v) => {
          if (done) return;
          done = true;
          if (timer) clearTimeout(timer);
          for (const s of subs) s.dispose();
          fn(v);
        };
        timer = setTimeout(() => {
          void processApi.kill(handle);
          finish(reject, new Error(`git ${args[0] ?? ""} timeout ${limit}ms`));
        }, limit);
        subs.push(
          processApi.onData(handle, (b) => out += dec.decode(b, { stream: true })),
          processApi.onStderr(handle, (b) => err += new TextDecoder().decode(b)),
          processApi.onExit(handle, (code) => finish(resolve, { code, stdout: out, stderr: err.trim() }))
        );
      }).catch((e) => {
        if (!done) {
          done = true;
          if (timer) clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    });
  }
  return {
    run,
    // Tri-state repository root discovery.
    async root(cwd) {
      try {
        const r = await run({ cwd, args: ["rev-parse", "--show-toplevel"] });
        if (r.code === 0) return { state: "repo", root: r.stdout.trim() };
        if (NOT_REPO_RE.test(r.stderr)) return { state: "not-repo" };
        return { state: "error", error: r.stderr };
      } catch (e) {
        return { state: "error", error: String(e?.message ?? e) };
      }
    },
    // name-status of base...target (changes on target since it diverged from base).
    async nameStatus({ repoRoot, base, target }) {
      const r = await run({ cwd: repoRoot, args: ["diff", "--name-status", `${base}...${target}`] });
      if (r.code !== 0) return gitFail(r);
      return { ok: true, stdout: r.stdout };
    },
    async numstat({ repoRoot, base, target }) {
      const r = await run({ cwd: repoRoot, args: ["diff", "--numstat", `${base}...${target}`] });
      if (r.code !== 0) return gitFail(r);
      return { ok: true, stdout: r.stdout };
    },
    // unified diff hunks of base...target, optionally narrowed to one file.
    async hunks({ repoRoot, base, target, file }) {
      const args = ["diff", `${base}...${target}`];
      if (typeof file === "string" && file) args.push("--", file);
      const r = await run({ cwd: repoRoot, args });
      if (r.code !== 0) return gitFail(r);
      return { ok: true, diff: r.stdout };
    },
    // Local merge of target into the branch checked out at repoRoot (the base). Returns the new HEAD.
    async merge({ repoRoot, target, noFf = true }) {
      const args = ["merge"];
      if (noFf) args.push("--no-ff");
      args.push("-m", `Merge ${target}`, "--", target);
      const r = await run({ cwd: repoRoot, args, write: true });
      if (r.code !== 0) return gitFail(r);
      const head = await run({ cwd: repoRoot, args: ["rev-parse", "HEAD"] });
      return { ok: true, oid: head.stdout.trim() };
    }
  };
}

// src/index.js
var COLL_COMMENT = "comment";
var COLL_APPROVAL = "approval";
var SCOPE = "index";
var DEFAULT_BASE = "main";
function h(tag, style, text) {
  const el = document.createElement(tag);
  if (style) el.style.cssText = style;
  if (text !== void 0) el.textContent = text;
  return el;
}
function lineStyle(line) {
  if (line.startsWith("@@")) return "color:var(--acc);opacity:.7";
  if (line.startsWith("+")) return "color:var(--ok)";
  if (line.startsWith("-")) return "color:var(--danger)";
  return "color:var(--fg2)";
}
var index_default = {
  activate(ctx) {
    const app = ctx.app;
    const err = (code, message) => ({ ok: false, code, message });
    const msg = (en, ko) => (typeof app.locale === "function" ? app.locale() : "en") === "ko" ? ko : en;
    const reg = (name, spec) => ctx.subscriptions.push(app.commands.register(name, spec));
    const git = makeGit(app.process);
    void app.data.define(COLL_COMMENT, { indexes: ["target", "status", "file", "createdAt"] });
    void app.data.define(COLL_APPROVAL, { indexes: ["target", "createdAt"] });
    const loadComments = async (target, status) => {
      const where = {};
      if (target) where.target = target;
      if (status) where.status = status;
      const rows = await app.data.query(COLL_COMMENT, {
        scope: SCOPE,
        ...Object.keys(where).length ? { where } : {},
        order: "createdAt"
      });
      return Array.isArray(rows) ? rows : [];
    };
    const approvalOf = async (target) => app.data.get(COLL_APPROVAL, targetKey(target), { scope: SCOPE });
    async function resolveRepoRoot(repoPath) {
      if (!repoPath) return { ok: false, out: err("NO_PATH", msg("no repository path \u2014 pass path or open a project", "\uC800\uC7A5\uC18C \uACBD\uB85C \uC5C6\uC74C \u2014 path \uB97C \uC8FC\uAC70\uB098 \uD504\uB85C\uC81D\uD2B8\uB97C \uC5EC\uC138\uC694")) };
      const st = await git.root(repoPath);
      if (st.state === "repo") return { ok: true, root: st.root };
      if (st.state === "not-repo") return { ok: false, out: err("NOT_REPO", msg("not a git repository", "git \uC800\uC7A5\uC18C\uAC00 \uC544\uB2D9\uB2C8\uB2E4")) };
      return { ok: false, out: err("GIT_ERROR", st.error || "git error") };
    }
    const repoPathParam = (p) => (typeof p.path === "string" && p.path ? p.path : void 0) ?? app.project?.current?.()?.root ?? void 0;
    const baseParam = (p) => typeof p.base === "string" && p.base ? p.base : DEFAULT_BASE;
    reg("diff.files", {
      description: "List the files a target (branch/ref) changes against its base (default 'main'): status (modified/added/deleted/renamed) and add/delete counts. The three-dot range base...target shows what the target introduced since it diverged. The same data the review view's file list shows.",
      triggers: { ko: "\uBCC0\uACBD \uD30C\uC77C \uBAA9\uB85D \uB9AC\uBDF0 \uB300\uC0C1 base" },
      params: {
        target: { type: "string", description: "Branch/ref under review", required: true },
        base: { type: "string", description: "Base ref to compare against (default main)" },
        path: { type: "string", description: "Repository directory (defaults to the active project root)" }
      },
      returns: "{ target, base, files: [{path, status, added, deleted, binary, oldPath?}] }",
      examples: [`sok plugin.soksak-plugin-git-review.diff.files '{"target":"feat/login"}'`],
      message: (d) => msg(`${(d.files ?? []).length} changed file(s)`, `\uBCC0\uACBD \uD30C\uC77C ${(d.files ?? []).length}\uAC1C`),
      handler: async (p) => {
        const target = String(p.target ?? "");
        const base = baseParam(p);
        if (!validRef(target) || !validRef(base)) return err("INVALID_REF", msg("invalid ref", "\uD5C8\uC6A9\uB418\uC9C0 \uC54A\uB294 ref"));
        const rr = await resolveRepoRoot(repoPathParam(p));
        if (!rr.ok) return rr.out;
        const ns = await git.nameStatus({ repoRoot: rr.root, base, target });
        if (!ns.ok) return err(ns.code, ns.message);
        const nm = await git.numstat({ repoRoot: rr.root, base, target });
        const files = mergeFileList(parseNameStatus(ns.stdout), nm.ok ? parseNumstat(nm.stdout) : /* @__PURE__ */ new Map());
        return { target, base, files };
      }
    });
    reg("diff.read", {
      description: "Return the unified diff of base...target \u2014 the whole target's changes, or one file when file is given. The same text the review view's diff pane shows.",
      triggers: { ko: "diff \uBCF8\uBB38 \uC870\uD68C hunk \uB9AC\uBDF0" },
      params: {
        target: { type: "string", description: "Branch/ref under review", required: true },
        base: { type: "string", description: "Base ref (default main)" },
        file: { type: "string", description: "Limit the diff to this repository-relative path" },
        path: { type: "string", description: "Repository directory (defaults to the active project root)" }
      },
      returns: "{ target, base, file?, diff: string }",
      examples: [`sok plugin.soksak-plugin-git-review.diff.read '{"target":"feat/login","file":"src/a.ts"}'`],
      message: (d) => String(d.diff ?? "").trim() ? msg("returned the diff", "diff \uB97C \uBC18\uD658\uD588\uC2B5\uB2C8\uB2E4") : msg("no changes", "\uBCC0\uACBD \uC5C6\uC74C"),
      handler: async (p) => {
        const target = String(p.target ?? "");
        const base = baseParam(p);
        if (!validRef(target) || !validRef(base)) return err("INVALID_REF", msg("invalid ref", "\uD5C8\uC6A9\uB418\uC9C0 \uC54A\uB294 ref"));
        const rr = await resolveRepoRoot(repoPathParam(p));
        if (!rr.ok) return rr.out;
        const file = typeof p.file === "string" && p.file ? p.file : void 0;
        const out = await git.hunks({ repoRoot: rr.root, base, target, file });
        if (!out.ok) return err(out.code, out.message);
        return { target, base, ...file ? { file } : {}, diff: out.diff };
      }
    });
    reg("comment.add", {
      description: "Add a review comment as a record { id, target, file?, line?, body, status:open, author, createdAt } \u2014 the schema is the contract downstream consumers read. line requires file; a comment with neither is a general comment on the target.",
      triggers: { ko: "\uB9AC\uBDF0 \uCF54\uBA58\uD2B8 \uCD94\uAC00 \uC791\uC131" },
      params: {
        target: { type: "string", description: "Branch/worktree under review", required: true },
        body: { type: "string", description: "Comment text", required: true },
        file: { type: "string", description: "Repository-relative file the comment anchors to" },
        line: { type: "number", description: "Line the comment anchors to (requires file)" },
        author: { type: "string", description: "Comment author (default 'unknown')" }
      },
      returns: "{ id, target, file, line, body, status, author, createdAt }",
      examples: [`sok plugin.soksak-plugin-git-review.comment.add '{"target":"feat/login","file":"src/a.ts","line":12,"body":"handle the null case"}'`],
      message: (d) => msg(`Added a comment on ${d.target}`, `${d.target} \uCF54\uBA58\uD2B8 \uCD94\uAC00`),
      handler: async (p) => {
        const norm = normalizeComment(p);
        if (!norm.ok) return err("INVALID_COMMENT", norm.reason);
        const rec = { ...norm.comment, createdAt: Date.now() };
        const id = await app.data.put(COLL_COMMENT, rec, { scope: SCOPE });
        return { id, ...rec };
      }
    });
    reg("comment.list", {
      description: "List review comments, optionally filtered by target and/or status (open/resolved). The same records the view shows.",
      triggers: { ko: "\uB9AC\uBDF0 \uCF54\uBA58\uD2B8 \uBAA9\uB85D \uC870\uD68C \uC0C1\uD0DC" },
      params: {
        target: { type: "string", description: "Filter to this target" },
        status: { type: "string", description: "Filter to open | resolved" }
      },
      returns: "{ comments: [record] }",
      examples: ["sok plugin.soksak-plugin-git-review.comment.list", `sok plugin.soksak-plugin-git-review.comment.list '{"target":"feat/login","status":"open"}'`],
      message: (d) => msg(`${(d.comments ?? []).length} comment(s)`, `\uCF54\uBA58\uD2B8 ${(d.comments ?? []).length}\uAC1C`),
      handler: async (p) => ({
        comments: await loadComments(
          typeof p.target === "string" && p.target ? p.target : void 0,
          p.status === "open" || p.status === "resolved" ? p.status : void 0
        )
      })
    });
    const setStatus = async (id, status) => {
      const rec = await app.data.get(COLL_COMMENT, String(id), { scope: SCOPE });
      if (!rec) return err("NOT_FOUND", msg(`no comment ${id}`, `\uCF54\uBA58\uD2B8 ${id} \uC5C6\uC74C`));
      await app.data.put(COLL_COMMENT, { ...rec, status }, { scope: SCOPE, id: String(id) });
      return { id: String(id), status };
    };
    reg("comment.resolve", {
      description: "Mark a comment resolved (status open \u2192 resolved). Idempotent.",
      triggers: { ko: "\uCF54\uBA58\uD2B8 \uD574\uC18C \uC644\uB8CC" },
      params: { id: { type: "string", description: "Comment id", required: true } },
      returns: "{ id, status }",
      examples: [`sok plugin.soksak-plugin-git-review.comment.resolve '{"id":"<id>"}'`],
      message: (d) => msg(`Resolved ${d.id}`, `\uCF54\uBA58\uD2B8 ${d.id} \uD574\uC18C`),
      handler: (p) => setStatus(p.id, "resolved")
    });
    reg("comment.reopen", {
      description: "Reopen a resolved comment (status resolved \u2192 open). Idempotent.",
      triggers: { ko: "\uCF54\uBA58\uD2B8 \uC7AC\uAC1C \uB2E4\uC2DC \uC5F4\uAE30" },
      params: { id: { type: "string", description: "Comment id", required: true } },
      returns: "{ id, status }",
      examples: [`sok plugin.soksak-plugin-git-review.comment.reopen '{"id":"<id>"}'`],
      message: (d) => msg(`Reopened ${d.id}`, `\uCF54\uBA58\uD2B8 ${d.id} \uC7AC\uAC1C`),
      handler: (p) => setStatus(p.id, "open")
    });
    reg("comment.send", {
      description: "Inject a target's open comments into a terminal pane as a deterministic payload (each line prefixed '# ', shell-safe). The pane is given explicitly \u2014 this is the review\u2192agent return path. Verified by the injected text appearing in that pane's buffer.",
      triggers: { ko: "\uCF54\uBA58\uD2B8 \uD130\uBBF8\uB110 \uC804\uC1A1 \uC8FC\uC785 \uD68C\uADC0 \uC5D0\uC774\uC804\uD2B8" },
      params: {
        target: { type: "string", description: "Branch/worktree whose open comments to send", required: true },
        pane: { type: "string", description: "Terminal pane id to inject into (explicit \u2014 no active-guess)", required: true }
      },
      returns: "{ sent, pane, count }",
      examples: [`sok plugin.soksak-plugin-git-review.comment.send '{"target":"feat/login","pane":"v5"}'`],
      message: (d) => msg(`Sent ${d.count} comment(s) to ${d.pane}`, `${d.pane} \uB85C \uCF54\uBA58\uD2B8 ${d.count}\uAC1C \uC804\uC1A1`),
      handler: async (p) => {
        const target = typeof p.target === "string" ? p.target.trim() : "";
        const pane = typeof p.pane === "string" ? p.pane.trim() : "";
        if (!target) return err("INVALID_PARAMS", msg("target required", "target \uD544\uC694"));
        if (!pane) return err("INVALID_PARAMS", msg("pane required (explicit)", "pane \uBA85\uC2DC \uD544\uC694"));
        const open = await loadComments(target, "open");
        const payload = formatCommentPayload(target, open);
        const ok = app.terminal?.sendText?.(pane, payload);
        if (ok === false) return err("TERMINAL_NOT_READY", msg(`pane ${pane} not ready`, `pane ${pane} \uC900\uBE44 \uC548 \uB428`));
        return { sent: true, pane, count: open.length };
      }
    });
    reg("approve", {
      description: "Record approval for a target's changes. Approval is a prerequisite for merge.",
      triggers: { ko: "\uB300\uC0C1 \uBCC0\uACBD \uC2B9\uC778 \uB9AC\uBDF0" },
      params: {
        target: { type: "string", description: "Branch/worktree to approve", required: true },
        author: { type: "string", description: "Approver (default 'unknown')" }
      },
      returns: "{ approved, target }",
      examples: [`sok plugin.soksak-plugin-git-review.approve '{"target":"feat/login"}'`],
      message: (d) => msg(`Approved ${d.target}`, `${d.target} \uC2B9\uC778`),
      handler: async (p) => {
        const target = typeof p.target === "string" ? p.target.trim() : "";
        if (!target) return err("INVALID_PARAMS", msg("target required", "target \uD544\uC694"));
        const author = typeof p.author === "string" && p.author.trim() ? p.author.trim() : "unknown";
        await app.data.put(COLL_APPROVAL, { target, author, createdAt: Date.now() }, { scope: SCOPE, id: targetKey(target) });
        return { approved: true, target };
      }
    });
    reg("merge", {
      danger: "destructive",
      description: "Merge a target branch into the branch checked out at the repository (local, --no-ff). Refuses without an approval record (NOT_APPROVED) and while the target has open comments (UNRESOLVED_COMMENTS). PR/remote is out of scope.",
      triggers: { ko: "\uC2B9\uC778\uB41C \uB300\uC0C1 \uBA38\uC9C0 \uBCD1\uD569" },
      params: {
        target: { type: "string", description: "Branch to merge", required: true },
        path: { type: "string", description: "Repository directory (defaults to the active project root)" },
        noFf: { type: "boolean", description: "Create a merge commit even for a fast-forward (default true)", default: true }
      },
      returns: "{ merged, oid, target }",
      examples: [`sok plugin.soksak-plugin-git-review.merge '{"target":"feat/login"}'`],
      message: (d) => msg(`Merged ${d.target} (${String(d.oid).slice(0, 7)})`, `${d.target} \uBA38\uC9C0 (${String(d.oid).slice(0, 7)})`),
      handler: async (p) => {
        const target = String(p.target ?? "");
        if (!validRef(target)) return err("INVALID_REF", msg("invalid ref", "\uD5C8\uC6A9\uB418\uC9C0 \uC54A\uB294 ref"));
        const rr = await resolveRepoRoot(repoPathParam(p));
        if (!rr.ok) return rr.out;
        if (!await approvalOf(target)) return err("NOT_APPROVED", msg(`${target} is not approved`, `${target} \uBBF8\uC2B9\uC778`));
        const open = await loadComments(target, "open");
        if (open.length > 0) return err("UNRESOLVED_COMMENTS", msg(`${open.length} open comment(s) must be resolved`, `open \uCF54\uBA58\uD2B8 ${open.length}\uAC1C \uD574\uC18C \uD544\uC694`));
        const out = await git.merge({ repoRoot: rr.root, target, noFf: p.noFf !== false });
        if (!out.ok) return err(out.code, out.message);
        return { merged: true, oid: out.oid, target };
      }
    });
    const cleanups = /* @__PURE__ */ new Map();
    ctx.subscriptions.push(app.ui.registerView("view", mkView(app, git, { loadComments, approvalOf, msg, DEFAULT_BASE }, cleanups)));
  },
  deactivate() {
  }
};
function mkView(app, git, deps, cleanups) {
  const { loadComments, approvalOf, msg, DEFAULT_BASE: DEFAULT_BASE2 } = deps;
  return {
    mount(container, vctx) {
      const report = (code, message) => vctx.setStatus?.(code ? { code, message } : null);
      container.replaceChildren();
      const wrap = h("div", "display:flex;flex-direction:column;height:100%;min-height:0;font-size:12px;color:var(--fg);background:var(--bg)");
      const bar = h("div", "display:flex;align-items:center;justify-content:space-between;gap:10px;padding:4px 10px;border-bottom:1px solid var(--bd);flex:0 0 auto;min-height:28px;box-sizing:border-box");
      const title = h("span", "color:var(--fg2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap", msg("Review", "\uB9AC\uBDF0"));
      const right = h("div", "display:flex;align-items:center;gap:6px;flex:0 0 auto");
      const approveBtn = h("button", "cursor:pointer;border:1px solid var(--bd);background:var(--inset);color:var(--fg2);border-radius:4px;padding:2px 8px;font-size:11px");
      approveBtn.textContent = msg("Approve", "\uC2B9\uC778");
      approveBtn.dataset.node = "approve";
      const refreshBtn = h("button", "display:inline-flex;align-items:center;justify-content:center;width:24px;height:22px;padding:0;cursor:pointer;border:1px solid var(--bd);background:var(--inset);color:var(--fg2);border-radius:4px");
      refreshBtn.textContent = "\u27F3";
      refreshBtn.title = msg("Refresh", "\uC0C8\uB85C\uACE0\uCE68");
      refreshBtn.dataset.node = "refresh";
      right.append(approveBtn, refreshBtn);
      bar.append(title, right);
      const errEl = h("div", "display:none;padding:8px 10px;color:var(--danger);font-size:11px;white-space:pre-wrap;word-break:break-all;flex:0 0 auto");
      const listEl = h("div", "flex:0 1 auto;max-height:35%;overflow:auto;padding:5px 0");
      const diffEl = h("div", "flex:1 1 auto;min-height:0;overflow:auto;padding:8px 10px;border-top:1px solid var(--bd);font-family:ui-monospace,Menlo,monospace;font-size:11px;line-height:1.5;white-space:pre");
      const commentsEl = h("div", "flex:0 1 auto;max-height:30%;overflow:auto;border-top:1px solid var(--bd);padding:5px 0");
      wrap.append(bar, errEl, listEl, diffEl, commentsEl);
      container.append(wrap);
      const root = vctx.root;
      let target = null;
      let selected = null;
      const showError = (t) => {
        errEl.textContent = String(t);
        errEl.style.display = "block";
        report("error", String(t));
      };
      async function loadDiff() {
        diffEl.replaceChildren();
        if (!selected || !target) return;
        const out = await git.hunks({ repoRoot: root, base: DEFAULT_BASE2, target, file: selected });
        if (!out.ok) return showError(`${out.code}: ${out.message}`);
        const frag = document.createDocumentFragment();
        for (const line of String(out.diff).split("\n")) frag.append(h("div", lineStyle(line), line === "" ? " " : line));
        diffEl.append(frag);
      }
      async function loadComments_() {
        commentsEl.replaceChildren();
        if (!target) return;
        const comments = sortComments(await loadComments(target));
        for (const c of comments) {
          const row = h("div", "display:flex;align-items:center;gap:7px;padding:3px 12px");
          row.dataset.node = `comment/${c.id}`;
          const badge = h("span", `flex:0 0 auto;font-size:10px;color:${c.status === "open" ? "var(--acc)" : "var(--fg3)"}`, c.status === "open" ? "\u25CF" : "\u25CB");
          const loc = h("span", "flex:0 0 auto;color:var(--fg3);font-size:10px", c.file ? `${c.file}${c.line ? ":" + c.line : ""}` : "(general)");
          const body = h("span", "flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg2)", c.body);
          const toggle = h("button", "flex:0 0 auto;cursor:pointer;border:1px solid var(--bd);background:transparent;color:var(--fg3);border-radius:4px;font-size:10px;padding:1px 5px");
          toggle.textContent = c.status === "open" ? msg("resolve", "\uD574\uC18C") : msg("reopen", "\uC7AC\uAC1C");
          toggle.dataset.node = `resolve/${c.id}`;
          toggle.onclick = () => void app.commands.execute(`plugin.soksak-plugin-git-review.comment.${c.status === "open" ? "resolve" : "reopen"}`, { id: c.id });
          row.append(badge, loc, body, toggle);
          commentsEl.append(row);
        }
      }
      async function render() {
        errEl.style.display = "none";
        report("loading", msg("Loading\u2026", "\uBD88\uB7EC\uC624\uB294 \uC911\u2026"));
        if (!root) return showError(msg("no project root", "\uD504\uB85C\uC81D\uD2B8 \uB8E8\uD2B8 \uC5C6\uC74C"));
        const br = await git.run({ cwd: root, args: ["rev-parse", "--abbrev-ref", "HEAD"] });
        target = br.code === 0 ? br.stdout.trim() : null;
        title.textContent = target ? `${msg("Review", "\uB9AC\uBDF0")}: ${target}` : msg("Review", "\uB9AC\uBDF0");
        listEl.replaceChildren();
        if (!target || target === DEFAULT_BASE2) {
          listEl.append(h("div", "padding:4px 12px;color:var(--fg3)", msg("Nothing to review (on base)", "\uB9AC\uBDF0 \uB300\uC0C1 \uC5C6\uC74C(base)")));
          report("clean", msg("Nothing to review", "\uB9AC\uBDF0 \uB300\uC0C1 \uC5C6\uC74C"));
          await loadComments_();
          return;
        }
        const ns = await git.nameStatus({ repoRoot: root, base: DEFAULT_BASE2, target });
        if (!ns.ok) return showError(`${ns.code}: ${ns.message}`);
        const files = parseNameStatus(ns.stdout);
        const approved = !!await approvalOf(target);
        if (files.length === 0) {
          listEl.append(h("div", "padding:4px 12px;color:var(--fg3)", msg("No changes", "\uBCC0\uACBD \uC5C6\uC74C")));
          report(approved ? "approved" : "clean", approved ? msg("Approved", "\uC2B9\uC778\uB428") : msg("No changes", "\uBCC0\uACBD \uC5C6\uC74C"));
        } else {
          report(approved ? "approved" : "changed", approved ? msg("Approved", "\uC2B9\uC778\uB428") : msg(`${files.length} changed`, `\uBCC0\uACBD ${files.length}\uAC1C`));
          const frag = document.createDocumentFragment();
          for (const f of files) {
            const row = h("div", "display:flex;align-items:center;gap:7px;padding:3px 12px;cursor:pointer");
            row.dataset.node = `file/${nodeKey(f.path)}`;
            row.title = f.path;
            row.append(h("span", "flex:0 0 12px;text-align:center;font-weight:600;color:var(--fg2)", (f.status[0] || "?").toUpperCase()));
            row.append(h("span", "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg2)", f.path));
            row.onclick = () => {
              selected = f.path;
              void loadDiff();
            };
            frag.append(row);
          }
          listEl.append(frag);
        }
        await loadComments_();
      }
      approveBtn.onclick = () => {
        if (target) void app.commands.execute("plugin.soksak-plugin-git-review.approve", { target });
      };
      refreshBtn.onclick = () => void render();
      void render();
      const subs = [
        app.data.watch(COLL_COMMENT, { scope: SCOPE }, () => void loadComments_()),
        app.data.watch(COLL_APPROVAL, { scope: SCOPE }, () => void render()),
        app.events.on("command.finished", (e) => {
          if (e.projectId && vctx.projectId && e.projectId !== vctx.projectId) return;
          void render();
        })
      ];
      cleanups.set(container, () => {
        for (const s of subs) s.dispose();
      });
    },
    unmount(container) {
      cleanups.get(container)?.();
      cleanups.delete(container);
      container.replaceChildren();
    }
  };
}
export {
  index_default as default
};
