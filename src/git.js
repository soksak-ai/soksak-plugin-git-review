// Own the git execution — run the git CLI directly through the process capability. No dependency
// on another plugin (coupling 0; the git CLI is the stable contract). The thin runner this plugin
// needs: root discovery, diff (name-status + numstat + hunks), branch existence, local merge.

const READ_ENV = Object.freeze({ LC_ALL: "C", LANG: "C", GIT_OPTIONAL_LOCKS: "0" });
const WRITE_ENV = Object.freeze({ LC_ALL: "C", LANG: "C" });
const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 180_000;
const NOT_REPO_RE = /not a git repository/i;

// git failure → canonical envelope (MESSAGE-PROTOCOL); git's own stderr is the cause.
function gitFail(r) {
  return { ok: false, code: "GIT_ERROR", message: r.stderr || `git exit ${r.code}` };
}

// A ref/commit the diff and merge commands accept: a branch name, a short/long hash, or a HEAD
// form. Rejects option-looking or path-traversing input (no leading '-', no '..').
export function validRef(ref) {
  if (typeof ref !== "string" || ref.length === 0) return false;
  if (ref.startsWith("-") || ref.includes("..") || ref.endsWith("/") || ref.endsWith(".lock")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || ref === "HEAD";
}

// Bind the runner to a process capability (app.process). Each op resolves { ok, ... }; a failure
// is { ok:false, code, message }.
export function makeGit(processApi) {
  function run({ cwd, args, write = false, timeoutMs }) {
    return new Promise((resolve, reject) => {
      const limit = timeoutMs ?? (write ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS);
      const dec = new TextDecoder();
      let out = "";
      let err = "";
      let done = false;
      let timer = null;
      processApi
        .spawn("git", args, { cwd, env: write ? { ...WRITE_ENV } : { ...READ_ENV } })
        .then((handle) => {
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
            processApi.onData(handle, (b) => (out += dec.decode(b, { stream: true }))),
            processApi.onStderr(handle, (b) => (err += new TextDecoder().decode(b))),
            processApi.onExit(handle, (code) => finish(resolve, { code, stdout: out, stderr: err.trim() })),
          );
        })
        .catch((e) => {
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
    },
  };
}
