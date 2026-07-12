// Pure diff parsing — name-status, numstat, merge, node key.
// RED baseline: mis-parsed status letters, dropped counts, a non-address-safe key.
import test from "node:test";
import assert from "node:assert/strict";
import { parseNameStatus, parseNumstat, mergeFileList, nodeKey } from "../src/diff.js";

test("parseNameStatus — status letters + rename old path", () => {
  const out = parseNameStatus("M\tsrc/a.ts\nA\tsrc/b.ts\nD\told.ts\nR100\tsrc/c.ts\tsrc/d.ts\n");
  assert.deepEqual(out[0], { status: "modified", path: "src/a.ts" });
  assert.deepEqual(out[1], { status: "added", path: "src/b.ts" });
  assert.deepEqual(out[2], { status: "deleted", path: "old.ts" });
  assert.deepEqual(out[3], { status: "renamed", path: "src/d.ts", oldPath: "src/c.ts" });
});

test("parseNumstat — counts, binary as null, rename new path", () => {
  const m = parseNumstat("3\t1\tsrc/a.ts\n-\t-\timg.png\n5\t0\tsrc/d.ts\n");
  assert.deepEqual(m.get("src/a.ts"), { added: 3, deleted: 1, binary: false });
  assert.deepEqual(m.get("img.png"), { added: null, deleted: null, binary: true });
  assert.deepEqual(m.get("src/d.ts"), { added: 5, deleted: 0, binary: false });
});

test("mergeFileList — status joined with counts", () => {
  const ns = parseNameStatus("M\tsrc/a.ts\nA\timg.png\n");
  const nm = parseNumstat("3\t1\tsrc/a.ts\n-\t-\timg.png\n");
  const merged = mergeFileList(ns, nm);
  assert.deepEqual(merged[0], { path: "src/a.ts", status: "modified", added: 3, deleted: 1, binary: false });
  assert.deepEqual(merged[1], { path: "img.png", status: "added", added: null, deleted: null, binary: true });
});

test("nodeKey — address-safe segment derived from path", () => {
  const re = /^[a-z0-9][a-z0-9.-]*$/;
  for (const p of ["src/a.ts", "DIR/Weird Name.tsx", "x/y/z.rs"]) assert.ok(re.test(nodeKey(p)), `${p} → ${nodeKey(p)}`);
  assert.equal(nodeKey("src/a.ts"), "src-a.ts");
});
