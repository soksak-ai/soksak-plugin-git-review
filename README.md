# soksak-plugin-git-review

Local review for a branch or worktree's changes. A diff surface, comments stored as a
deterministic record contract, a command to send comments into the target's terminal, and an
approve-then-merge lifecycle.

It runs no git. Repository discovery, the branch's changes (the three-dot range `base...target`),
the unified diff, the checked-out HEAD, and the merge all come from **`soksak-spec-plugin-git`**, and the
plugin that implements it is found **by contract identity, never by name**: the manifest declares
`consumes: [{ id: "soksak-spec-plugin-git", range: "0.0.1" }]` and the implementer is resolved through
`plugin.implementers` called with the identity `{ id: "soksak-spec-plugin-git" }` — the version-free
contract id, no range in the discovery call. No plugin id appears in this plugin's code or manifest, and
no enabled implementer is a loud refusal (`NO_GIT_PROVIDER`).

Because it runs no git, it holds **no `process` permission** — it cannot spawn anything. The ref
whitelist that turns `--upload-pack=…` into a refusal instead of a command, and the diff parsing
that turns a rename into the right path, are the contract's and are scored there. Carrying a second
copy of a security rule is how the wrong copy ships.

## Commands

- `diff.files` / `diff.read` — the review data: changed files (with add/delete counts) and the
  unified diff hunks for a target (a branch or worktree) against its base. The same data the view
  renders.
- `comment.add` / `comment.list` / `comment.resolve` / `comment.reopen` — the comment lifecycle.
- `comment.send` — inject a target's open comments into a terminal pane as a deterministic payload
  (the pane is given explicitly). This is the review→agent return path.
- `approve` — record approval for a target.
- `merge` — local-merge an approved target once its comments are resolved.

## The comment contract

A comment is a record `{ id, target, file, line?, body, status, author, createdAt }` — the schema
is the contract that downstream consumers (redispatch) read. `status` is `open` or `resolved`.
`target` names what is under review (a branch or worktree). `file`/`line` may be null (a file-level
or general comment).

## View

A **Review** surface (content or sidebar) shows the changed files and the diff, with comments
anchored to files, and an approve control. It reports its state on the view status axis
(loading / clean / changed / approved / error).
