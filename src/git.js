// The git this plugin needs, taken from the contract — not run here.
//
// A git runner is a spawn wrapper, an env pin, timeouts, a ref whitelist and a diff parser. Every
// plugin that ran git kept its own copy, and a duplicated defense is a security debt: the copy
// written slightly wrong is the one that ships, and it does not announce itself. Those rules — the
// ref whitelist that made `--upload-pack=…` a refusal instead of a command, the three-dot range that
// makes "what did this branch do" the right question — are stated and scored once, in
// soksak-spec-plugin-git. This plugin asks whoever implements it.
//
// The implementer is resolved by contract, never named (C3 L2 contract-pin). The manifest declares
// `consumes: ["soksak-spec-plugin-git"]` and the host's call gate reads that declaration, so no plugin id
// appears here or in the manifest.

export const GIT_CONTRACT = "soksak-spec-plugin-git";

// No enabled implementer is a loud refusal. A review with no git is not a review of nothing.
export function noProvider(msg) {
  return {
    ok: false,
    code: "NO_GIT_PROVIDER",
    message: msg(
      `no enabled plugin implements ${GIT_CONTRACT}`,
      `${GIT_CONTRACT} 을 구현한 활성 플러그인이 없습니다`,
    ),
  };
}

export function makeGit(app, msg) {
  // Resolved on every call: an implementer is enabled and disabled at runtime, so a cached id is a
  // claim about a fact that may already have changed.
  async function provider() {
    const out = await app.commands.execute("plugin.implementers", { id: GIT_CONTRACT });
    if (!out?.ok) return null;
    const found = (out.data?.implementers ?? []).find((i) => i.status === "enabled");
    return found?.id ?? null;
  }

  async function call(cmd, params) {
    const id = await provider();
    if (!id) return noProvider(msg);
    return app.commands.execute(`plugin.${id}.${cmd}`, params);
  }

  return {
    call,

    // Tri-state root discovery, and the refusal's code travels with it: "git failed" and "there is
    // no git" are different facts.
    async root(cwd) {
      const out = await call("root", { path: cwd });
      if (!out.ok) return { state: "error", error: out.message, code: out.code };
      return out.data ?? { state: "error", error: "empty answer", code: "GIT_ERROR" };
    },

    // What the branch changed since it diverged (the three-dot range base...target). The contract
    // returns the file list already merged with its line counts — the name-status and numstat
    // parsers this plugin used to carry are the implementer's business now.
    async files({ repoRoot, base, target }) {
      const out = await call("diff.files", { path: repoRoot, base, target });
      return out.ok ? { ok: true, files: out.data?.files ?? [] } : out;
    },

    // The unified diff of the same range, optionally narrowed to one file.
    async hunks({ repoRoot, base, target, file }) {
      const out = await call("diff.range", { path: repoRoot, base, target, ...(file ? { file } : {}) });
      return out.ok ? { ok: true, diff: out.data?.diff ?? "" } : out;
    },

    // What is checked out at the repository root — the base a review merges into.
    async head(repoRoot) {
      const out = await call("head", { path: repoRoot });
      return out.ok ? { ok: true, ...(out.data ?? {}) } : out;
    },

    // Merge the approved target into what is checked out. A conflict comes back as the contract's
    // GIT_ERROR carrying git's own text — this plugin does not resolve, abort, or commit its way out.
    async merge({ repoRoot, target, noFf = true }) {
      const out = await call("merge", { path: repoRoot, target, noFf });
      return out.ok ? { ok: true, oid: out.data?.oid } : out;
    },
  };
}
