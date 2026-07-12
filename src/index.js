// soksak-plugin-git-review — review a branch/worktree's changes locally. Owns its git execution
// (process capability — coupling 0, no other-plugin calls). Comments are records whose schema is
// the contract downstream consumers read; comment.send injects a target's open comments into a
// terminal pane; approve+merge run git directly. External data (paths/diffs) is textContent only.
import { parseNameStatus, parseNumstat, mergeFileList, nodeKey } from "./diff.js";
import { normalizeComment, targetKey, sortComments, formatCommentPayload } from "./comment.js";
import { makeGit, validRef } from "./git.js";

const COLL_COMMENT = "comment";
const COLL_APPROVAL = "approval";
const SCOPE = "index"; // one partition — a global registry of comments/approvals
const DEFAULT_BASE = "main";

function h(tag, style, text) {
  const el = document.createElement(tag);
  if (style) el.style.cssText = style;
  if (text !== undefined) el.textContent = text;
  return el;
}
function lineStyle(line) {
  if (line.startsWith("@@")) return "color:var(--acc);opacity:.7";
  if (line.startsWith("+")) return "color:var(--ok)";
  if (line.startsWith("-")) return "color:var(--danger)";
  return "color:var(--fg2)";
}

const index_default = {
  activate(ctx) {
    const app = ctx.app;
    const err = (code, message) => ({ ok: false, code, message });
    const msg = (en, ko) => ((typeof app.locale === "function" ? app.locale() : "en") === "ko" ? ko : en);
    const reg = (name, spec) => ctx.subscriptions.push(app.commands.register(name, spec));
    const git = makeGit(app.process); // git CLI, run directly (coupling 0)

    void app.data.define(COLL_COMMENT, { indexes: ["target", "status", "file", "createdAt"] });
    void app.data.define(COLL_APPROVAL, { indexes: ["target", "createdAt"] });

    const loadComments = async (target, status) => {
      const where = {};
      if (target) where.target = target;
      if (status) where.status = status;
      const rows = await app.data.query(COLL_COMMENT, {
        scope: SCOPE,
        ...(Object.keys(where).length ? { where } : {}),
        order: "createdAt",
      });
      return Array.isArray(rows) ? rows : [];
    };
    const approvalOf = async (target) => app.data.get(COLL_APPROVAL, targetKey(target), { scope: SCOPE });

    async function resolveRepoRoot(repoPath) {
      if (!repoPath) return { ok: false, out: err("NO_PATH", msg("no repository path — pass path or open a project", "저장소 경로 없음 — path 를 주거나 프로젝트를 여세요")) };
      const st = await git.root(repoPath);
      if (st.state === "repo") return { ok: true, root: st.root };
      if (st.state === "not-repo") return { ok: false, out: err("NOT_REPO", msg("not a git repository", "git 저장소가 아닙니다")) };
      return { ok: false, out: err("GIT_ERROR", st.error || "git error") };
    }
    const repoPathParam = (p) => (typeof p.path === "string" && p.path ? p.path : undefined) ?? app.project?.current?.()?.root ?? undefined;
    const baseParam = (p) => (typeof p.base === "string" && p.base ? p.base : DEFAULT_BASE);

    // ── diff.files — changed files (the view's file list, headless) ─────────────
    reg("diff.files", {
      description:
        "List the files a target (branch/ref) changes against its base (default 'main'): status (modified/added/deleted/renamed) and add/delete counts. The three-dot range base...target shows what the target introduced since it diverged. The same data the review view's file list shows.",
      triggers: { ko: "변경 파일 목록 리뷰 대상 base" },
      params: {
        target: { type: "string", description: "Branch/ref under review", required: true },
        base: { type: "string", description: "Base ref to compare against (default main)" },
        path: { type: "string", description: "Repository directory (defaults to the active project root)" },
      },
      returns: "{ target, base, files: [{path, status, added, deleted, binary, oldPath?}] }",
      examples: ['sok plugin.soksak-plugin-git-review.diff.files \'{"target":"feat/login"}\''],
      message: (d) => msg(`${(d.files ?? []).length} changed file(s)`, `변경 파일 ${(d.files ?? []).length}개`),
      handler: async (p) => {
        const target = String(p.target ?? "");
        const base = baseParam(p);
        if (!validRef(target) || !validRef(base)) return err("INVALID_REF", msg("invalid ref", "허용되지 않는 ref"));
        const rr = await resolveRepoRoot(repoPathParam(p));
        if (!rr.ok) return rr.out;
        const ns = await git.nameStatus({ repoRoot: rr.root, base, target });
        if (!ns.ok) return err(ns.code, ns.message);
        const nm = await git.numstat({ repoRoot: rr.root, base, target });
        const files = mergeFileList(parseNameStatus(ns.stdout), nm.ok ? parseNumstat(nm.stdout) : new Map());
        return { target, base, files };
      },
    });

    // ── diff.read — the unified diff hunks ──────────────────────────────────────
    reg("diff.read", {
      description:
        "Return the unified diff of base...target — the whole target's changes, or one file when file is given. The same text the review view's diff pane shows.",
      triggers: { ko: "diff 본문 조회 hunk 리뷰" },
      params: {
        target: { type: "string", description: "Branch/ref under review", required: true },
        base: { type: "string", description: "Base ref (default main)" },
        file: { type: "string", description: "Limit the diff to this repository-relative path" },
        path: { type: "string", description: "Repository directory (defaults to the active project root)" },
      },
      returns: "{ target, base, file?, diff: string }",
      examples: ['sok plugin.soksak-plugin-git-review.diff.read \'{"target":"feat/login","file":"src/a.ts"}\''],
      message: (d) => (String(d.diff ?? "").trim() ? msg("returned the diff", "diff 를 반환했습니다") : msg("no changes", "변경 없음")),
      handler: async (p) => {
        const target = String(p.target ?? "");
        const base = baseParam(p);
        if (!validRef(target) || !validRef(base)) return err("INVALID_REF", msg("invalid ref", "허용되지 않는 ref"));
        const rr = await resolveRepoRoot(repoPathParam(p));
        if (!rr.ok) return rr.out;
        const file = typeof p.file === "string" && p.file ? p.file : undefined;
        const out = await git.hunks({ repoRoot: rr.root, base, target, file });
        if (!out.ok) return err(out.code, out.message);
        return { target, base, ...(file ? { file } : {}), diff: out.diff };
      },
    });

    // ── comment.add / list / resolve / reopen — the comment record contract ─────
    reg("comment.add", {
      description:
        "Add a review comment as a record { id, target, file?, line?, body, status:open, author, createdAt } — the schema is the contract downstream consumers read. line requires file; a comment with neither is a general comment on the target.",
      triggers: { ko: "리뷰 코멘트 추가 작성" },
      params: {
        target: { type: "string", description: "Branch/worktree under review", required: true },
        body: { type: "string", description: "Comment text", required: true },
        file: { type: "string", description: "Repository-relative file the comment anchors to" },
        line: { type: "number", description: "Line the comment anchors to (requires file)" },
        author: { type: "string", description: "Comment author (default 'unknown')" },
      },
      returns: "{ id, target, file, line, body, status, author, createdAt }",
      examples: ['sok plugin.soksak-plugin-git-review.comment.add \'{"target":"feat/login","file":"src/a.ts","line":12,"body":"handle the null case"}\''],
      message: (d) => msg(`Added a comment on ${d.target}`, `${d.target} 코멘트 추가`),
      handler: async (p) => {
        const norm = normalizeComment(p);
        if (!norm.ok) return err("INVALID_COMMENT", norm.reason);
        const rec = { ...norm.comment, createdAt: Date.now() };
        const id = await app.data.put(COLL_COMMENT, rec, { scope: SCOPE });
        return { id, ...rec };
      },
    });

    reg("comment.list", {
      description: "List review comments, optionally filtered by target and/or status (open/resolved). The same records the view shows.",
      triggers: { ko: "리뷰 코멘트 목록 조회 상태" },
      params: {
        target: { type: "string", description: "Filter to this target" },
        status: { type: "string", description: "Filter to open | resolved" },
      },
      returns: "{ comments: [record] }",
      examples: ["sok plugin.soksak-plugin-git-review.comment.list", 'sok plugin.soksak-plugin-git-review.comment.list \'{"target":"feat/login","status":"open"}\''],
      message: (d) => msg(`${(d.comments ?? []).length} comment(s)`, `코멘트 ${(d.comments ?? []).length}개`),
      handler: async (p) => ({
        comments: await loadComments(
          typeof p.target === "string" && p.target ? p.target : undefined,
          p.status === "open" || p.status === "resolved" ? p.status : undefined,
        ),
      }),
    });

    const setStatus = async (id, status) => {
      const rec = await app.data.get(COLL_COMMENT, String(id), { scope: SCOPE });
      if (!rec) return err("NOT_FOUND", msg(`no comment ${id}`, `코멘트 ${id} 없음`));
      await app.data.put(COLL_COMMENT, { ...rec, status }, { scope: SCOPE, id: String(id) });
      return { id: String(id), status };
    };
    reg("comment.resolve", {
      description: "Mark a comment resolved (status open → resolved). Idempotent.",
      triggers: { ko: "코멘트 해소 완료" },
      params: { id: { type: "string", description: "Comment id", required: true } },
      returns: "{ id, status }",
      examples: ['sok plugin.soksak-plugin-git-review.comment.resolve \'{"id":"<id>"}\''],
      message: (d) => msg(`Resolved ${d.id}`, `코멘트 ${d.id} 해소`),
      handler: (p) => setStatus(p.id, "resolved"),
    });
    reg("comment.reopen", {
      description: "Reopen a resolved comment (status resolved → open). Idempotent.",
      triggers: { ko: "코멘트 재개 다시 열기" },
      params: { id: { type: "string", description: "Comment id", required: true } },
      returns: "{ id, status }",
      examples: ['sok plugin.soksak-plugin-git-review.comment.reopen \'{"id":"<id>"}\''],
      message: (d) => msg(`Reopened ${d.id}`, `코멘트 ${d.id} 재개`),
      handler: (p) => setStatus(p.id, "open"),
    });
    reg("comment.remove", {
      danger: "destructive",
      description: "Permanently delete a comment record. Idempotent — removing an absent comment reports removed:false.",
      triggers: { ko: "코멘트 삭제 제거 영구" },
      params: { id: { type: "string", description: "Comment id", required: true } },
      returns: "{ id, removed }",
      examples: ['sok plugin.soksak-plugin-git-review.comment.remove \'{"id":"<id>"}\''],
      message: (d) => (d.removed ? msg(`Removed ${d.id}`, `코멘트 ${d.id} 삭제`) : msg(`No comment ${d.id}`, `코멘트 ${d.id} 없음`)),
      handler: async (p) => ({ id: String(p.id), removed: await app.data.delete(COLL_COMMENT, String(p.id), { scope: SCOPE }) }),
    });

    // ── comment.send — inject a target's open comments into a terminal pane ──────
    reg("comment.send", {
      description:
        "Inject a target's open comments into a terminal pane as a deterministic payload (each line prefixed '# ', shell-safe). The pane is given explicitly — this is the review→agent return path. Verified by the injected text appearing in that pane's buffer.",
      triggers: { ko: "코멘트 터미널 전송 주입 회귀 에이전트" },
      params: {
        target: { type: "string", description: "Branch/worktree whose open comments to send", required: true },
        pane: { type: "string", description: "Terminal pane id to inject into (explicit — no active-guess)", required: true },
      },
      returns: "{ sent, pane, count }",
      examples: ['sok plugin.soksak-plugin-git-review.comment.send \'{"target":"feat/login","pane":"v5"}\''],
      message: (d) => msg(`Sent ${d.count} comment(s) to ${d.pane}`, `${d.pane} 로 코멘트 ${d.count}개 전송`),
      handler: async (p) => {
        const target = typeof p.target === "string" ? p.target.trim() : "";
        const pane = typeof p.pane === "string" ? p.pane.trim() : "";
        if (!target) return err("INVALID_PARAMS", msg("target required", "target 필요"));
        if (!pane) return err("INVALID_PARAMS", msg("pane required (explicit)", "pane 명시 필요"));
        const open = await loadComments(target, "open");
        const payload = formatCommentPayload(target, open);
        const ok = app.terminal?.sendText?.(pane, payload);
        if (ok === false) return err("TERMINAL_NOT_READY", msg(`pane ${pane} not ready`, `pane ${pane} 준비 안 됨`));
        return { sent: true, pane, count: open.length };
      },
    });

    // ── approve — record approval for a target ──────────────────────────────────
    reg("approve", {
      description: "Record approval for a target's changes. Approval is a prerequisite for merge.",
      triggers: { ko: "대상 변경 승인 리뷰" },
      params: {
        target: { type: "string", description: "Branch/worktree to approve", required: true },
        author: { type: "string", description: "Approver (default 'unknown')" },
      },
      returns: "{ approved, target }",
      examples: ['sok plugin.soksak-plugin-git-review.approve \'{"target":"feat/login"}\''],
      message: (d) => msg(`Approved ${d.target}`, `${d.target} 승인`),
      handler: async (p) => {
        const target = typeof p.target === "string" ? p.target.trim() : "";
        if (!target) return err("INVALID_PARAMS", msg("target required", "target 필요"));
        const author = typeof p.author === "string" && p.author.trim() ? p.author.trim() : "unknown";
        await app.data.put(COLL_APPROVAL, { target, author, createdAt: Date.now() }, { scope: SCOPE, id: targetKey(target) });
        return { approved: true, target };
      },
    });

    reg("approve.revoke", {
      description:
        "Withdraw an approval. A reviewer who has changed their mind must be able to take it back, and a merge that was never re-approved must go back to refusing NOT_APPROVED. Idempotent — revoking an approval that was never given (or that a merge already consumed) is a no-op.",
      triggers: { ko: "승인 철회 취소" },
      params: {
        target: { type: "string", description: "Branch/worktree whose approval to withdraw", required: true },
      },
      returns: "{ revoked, target }",
      examples: ['sok plugin.soksak-plugin-git-review.approve.revoke \'{"target":"feat/login"}\''],
      message: (d) => msg(`Approval withdrawn for ${d.target}`, `${d.target} 승인 철회`),
      handler: async (p) => {
        const target = typeof p.target === "string" ? p.target.trim() : "";
        if (!target) return err("INVALID_PARAMS", msg("target required", "target 필요"));
        const had = await approvalOf(target);
        if (!had) return { revoked: false, target };
        await app.data.delete(COLL_APPROVAL, targetKey(target), { scope: SCOPE });
        return { revoked: true, target };
      },
    });

    // ── merge — local-merge an approved target once comments are resolved ────────
    reg("merge", {
      danger: "destructive",
      description:
        "Merge a target branch into the branch checked out at the repository (local, --no-ff). Refuses without an approval record (NOT_APPROVED) and while the target has open comments (UNRESOLVED_COMMENTS). The approval is consumed on a successful merge — re-merging requires a fresh approval. PR/remote is out of scope.",
      triggers: { ko: "승인된 대상 머지 병합" },
      params: {
        target: { type: "string", description: "Branch to merge", required: true },
        path: { type: "string", description: "Repository directory (defaults to the active project root)" },
        noFf: { type: "boolean", description: "Create a merge commit even for a fast-forward (default true)", default: true },
      },
      returns: "{ merged, oid, target }",
      examples: ['sok plugin.soksak-plugin-git-review.merge \'{"target":"feat/login"}\''],
      message: (d) => msg(`Merged ${d.target} (${String(d.oid).slice(0, 7)})`, `${d.target} 머지 (${String(d.oid).slice(0, 7)})`),
      handler: async (p) => {
        const target = String(p.target ?? "");
        if (!validRef(target)) return err("INVALID_REF", msg("invalid ref", "허용되지 않는 ref"));
        const rr = await resolveRepoRoot(repoPathParam(p));
        if (!rr.ok) return rr.out;
        if (!(await approvalOf(target))) return err("NOT_APPROVED", msg(`${target} is not approved`, `${target} 미승인`));
        const open = await loadComments(target, "open");
        if (open.length > 0) return err("UNRESOLVED_COMMENTS", msg(`${open.length} open comment(s) must be resolved`, `open 코멘트 ${open.length}개 해소 필요`));
        const out = await git.merge({ repoRoot: rr.root, target, noFf: p.noFf !== false });
        if (!out.ok) return err(out.code, out.message);
        await app.data.delete(COLL_APPROVAL, targetKey(target), { scope: SCOPE }); // approval is consumed by the merge
        return { merged: true, oid: out.oid, target };
      },
    });

    // ── The review view (DOM trio) ──────────────────────────────────────────────
    const cleanups = new Map();
    ctx.subscriptions.push(app.ui.registerView("view", mkView(app, git, { loadComments, approvalOf, msg, DEFAULT_BASE }, cleanups)));
  },

  deactivate() {},
};

// The review view — target = current branch of the mounted project's root, base = main. Renders the
// changed-file list, the selected file's diff, the target's comments, and an approve control.
function mkView(app, git, deps, cleanups) {
  const { loadComments, approvalOf, msg, DEFAULT_BASE } = deps;
  return {
    mount(container, vctx) {
      const report = (code, message) => vctx.setStatus?.(code ? { code, message } : null);
      container.replaceChildren();
      const wrap = h("div", "display:flex;flex-direction:column;height:100%;min-height:0;font-size:12px;color:var(--fg);background:var(--bg)");
      const bar = h("div", "display:flex;align-items:center;justify-content:space-between;gap:10px;padding:4px 10px;border-bottom:1px solid var(--bd);flex:0 0 auto;min-height:28px;box-sizing:border-box");
      const title = h("span", "color:var(--fg2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap", msg("Review", "리뷰"));
      const right = h("div", "display:flex;align-items:center;gap:6px;flex:0 0 auto");
      const approveBtn = h("button", "cursor:pointer;border:1px solid var(--bd);background:var(--inset);color:var(--fg2);border-radius:4px;padding:2px 8px;font-size:11px");
      approveBtn.textContent = msg("Approve", "승인");
      approveBtn.dataset.node = "approve";
      const refreshBtn = h("button", "display:inline-flex;align-items:center;justify-content:center;width:24px;height:22px;padding:0;cursor:pointer;border:1px solid var(--bd);background:var(--inset);color:var(--fg2);border-radius:4px");
      refreshBtn.textContent = "⟳";
      refreshBtn.title = msg("Refresh", "새로고침");
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
        const out = await git.hunks({ repoRoot: root, base: DEFAULT_BASE, target, file: selected });
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
          const badge = h("span", `flex:0 0 auto;font-size:10px;color:${c.status === "open" ? "var(--acc)" : "var(--fg3)"}`, c.status === "open" ? "●" : "○");
          const loc = h("span", "flex:0 0 auto;color:var(--fg3);font-size:10px", c.file ? `${c.file}${c.line ? ":" + c.line : ""}` : "(general)");
          const body = h("span", "flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg2)", c.body);
          const toggle = h("button", "flex:0 0 auto;cursor:pointer;border:1px solid var(--bd);background:transparent;color:var(--fg3);border-radius:4px;font-size:10px;padding:1px 5px");
          toggle.textContent = c.status === "open" ? msg("resolve", "해소") : msg("reopen", "재개");
          toggle.dataset.node = `resolve/${c.id}`;
          toggle.onclick = () => void app.commands.execute(`plugin.soksak-plugin-git-review.comment.${c.status === "open" ? "resolve" : "reopen"}`, { id: c.id });
          row.append(badge, loc, body, toggle);
          commentsEl.append(row);
        }
      }

      async function render() {
        errEl.style.display = "none";
        report("loading", msg("Loading…", "불러오는 중…"));
        if (!root) return showError(msg("no project root", "프로젝트 루트 없음"));
        const br = await git.run({ cwd: root, args: ["rev-parse", "--abbrev-ref", "HEAD"] });
        target = br.code === 0 ? br.stdout.trim() : null;
        title.textContent = target ? `${msg("Review", "리뷰")}: ${target}` : msg("Review", "리뷰");
        listEl.replaceChildren();
        if (!target || target === DEFAULT_BASE) {
          listEl.append(h("div", "padding:4px 12px;color:var(--fg3)", msg("Nothing to review (on base)", "리뷰 대상 없음(base)")));
          report("clean", msg("Nothing to review", "리뷰 대상 없음"));
          await loadComments_();
          return;
        }
        const ns = await git.nameStatus({ repoRoot: root, base: DEFAULT_BASE, target });
        if (!ns.ok) return showError(`${ns.code}: ${ns.message}`);
        const files = parseNameStatus(ns.stdout);
        const approved = !!(await approvalOf(target));
        if (files.length === 0) {
          listEl.append(h("div", "padding:4px 12px;color:var(--fg3)", msg("No changes", "변경 없음")));
          report(approved ? "approved" : "clean", approved ? msg("Approved", "승인됨") : msg("No changes", "변경 없음"));
        } else {
          report(approved ? "approved" : "changed", approved ? msg("Approved", "승인됨") : msg(`${files.length} changed`, `변경 ${files.length}개`));
          const frag = document.createDocumentFragment();
          for (const f of files) {
            const row = h("div", "display:flex;align-items:center;gap:7px;padding:3px 12px;cursor:pointer");
            row.dataset.node = `file/${nodeKey(f.path)}`;
            row.title = f.path;
            row.append(h("span", "flex:0 0 12px;text-align:center;font-weight:600;color:var(--fg2)", (f.status[0] || "?").toUpperCase()));
            row.append(h("span", "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg2)", f.path));
            row.onclick = () => { selected = f.path; void loadDiff(); };
            frag.append(row);
          }
          listEl.append(frag);
        }
        await loadComments_();
      }

      approveBtn.onclick = () => { if (target) void app.commands.execute("plugin.soksak-plugin-git-review.approve", { target }); };
      refreshBtn.onclick = () => void render();
      void render();

      // Event-driven refresh (no polling): comment/approval changes across windows, and command
      // completions in this project's terminals (a commit changes the diff).
      const subs = [
        app.data.watch(COLL_COMMENT, { scope: SCOPE }, () => void loadComments_()),
        app.data.watch(COLL_APPROVAL, { scope: SCOPE }, () => void render()),
        app.events.on("command.finished", (e) => {
          if (e.projectId && vctx.projectId && e.projectId !== vctx.projectId) return;
          void render();
        }),
      ];
      cleanups.set(container, () => { for (const s of subs) s.dispose(); });
    },
    unmount(container) {
      cleanups.get(container)?.();
      cleanups.delete(container);
      container.replaceChildren();
    },
  };
}

export { index_default as default };
