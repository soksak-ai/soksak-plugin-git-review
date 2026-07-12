// Pure diff parsing — name-status → per-file status, numstat → add/delete counts, merged into the
// file list the view and diff.files return. Plus a stable address-safe key for a file path.

const STATUS_MAP = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "typechange",
  U: "unmerged",
};

// `git diff --name-status` → [{status, path, oldPath?}]. Renames/copies carry the old path.
export function parseNameStatus(stdout) {
  const out = [];
  for (const line of String(stdout).split("\n")) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
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

// `git diff --numstat` → Map(path → {added, deleted, binary}). Binary files report "-"/"-".
export function parseNumstat(stdout) {
  const map = new Map();
  for (const line of String(stdout).split("\n")) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    if (cols.length < 3) continue;
    const added = cols[0] === "-" ? null : Number(cols[0]);
    const deleted = cols[1] === "-" ? null : Number(cols[1]);
    let path = cols.slice(2).join("\t");
    if (path.includes(" => ")) {
      // rename form: "{old => new}/x" or "old => new" — keep the new path
      path = path.replace(/\{[^}]*? => ([^}]*?)\}/g, "$1").replace(/^.* => /, "");
    }
    map.set(path, { added, deleted, binary: added === null && deleted === null });
  }
  return map;
}

// Merge name-status (status) with numstat (counts) into the file list.
export function mergeFileList(nameStatusArr, numstatMap) {
  return (nameStatusArr || []).map((f) => {
    const n = (numstatMap && numstatMap.get(f.path)) || {};
    return {
      path: f.path,
      status: f.status,
      ...(f.oldPath ? { oldPath: f.oldPath } : {}),
      added: n.added ?? null,
      deleted: n.deleted ?? null,
      binary: !!n.binary,
    };
  });
}

// A file path → a stable node-path segment (^[a-z0-9][a-z0-9.-]*$). The path is the stable key.
export function nodeKey(path) {
  const k = String(path)
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return /^[a-z0-9]/.test(k) ? k : "f-" + k;
}
