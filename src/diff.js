// The one diff concern this plugin still owns: a stable, address-safe key for a file path.
//
// The parsing that used to live here — name-status into per-file status, numstat into line counts,
// the merge of the two — is the git domain's, and it is now the contract's (soksak-git-spec@1
// §7.3): diff.files answers with the file list already merged. A consumer that re-parses git's
// output has taken the domain back, and taken its bugs with it.

// A file path → a stable node-path segment (^[a-z0-9][a-z0-9.-]*$). The path is the stable key.
export function nodeKey(path) {
  const k = String(path)
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return /^[a-z0-9]/.test(k) ? k : "f-" + k;
}
