// The one diff concern this plugin still owns: the address key for a file row.
//
// The parsing that used to be tested here — name-status into per-file status, numstat into line
// counts, the merge of the two — belongs to the git domain, and it is now the contract's
// (soksak-git-spec@1 §7.3, scored by soksak-contract-git). A consumer that re-parses git's output
// has taken the domain back, and taken its bugs with it.
import test from "node:test";
import assert from "node:assert/strict";
import { nodeKey } from "../src/diff.js";

test("nodeKey — a file path becomes a stable, address-safe node segment", () => {
  // The path is the stable identifier (never a counter), but a node path segment must match
  // ^[a-z0-9][a-z0-9.-]*$ — so it is lowercased and the rest is folded to "-".
  assert.equal(nodeKey("src/main.ts"), "src-main.ts");
  assert.equal(nodeKey("SRC/Main.TS"), "src-main.ts");
  assert.equal(nodeKey("a b/c_d.js"), "a-b-c-d.js");
  assert.match(nodeKey("src/a.ts"), /^[a-z0-9][a-z0-9.-]*$/);
});

test("nodeKey — a path that cannot start a segment still yields a legal one", () => {
  // A leading separator is folded away rather than prefixed; only a key that would still be illegal
  // gets the "f-" prefix. Either way the result is addressable — a row is never left without a key.
  assert.equal(nodeKey("_hidden.ts"), "hidden.ts");
  assert.match(nodeKey("_hidden.ts"), /^[a-z0-9][a-z0-9.-]*$/);
  assert.match(nodeKey("///"), /^[a-z0-9][a-z0-9.-]*$/);
});

test("nodeKey — distinct paths keep distinct keys (a row is addressable)", () => {
  assert.notEqual(nodeKey("src/a.ts"), nodeKey("src/b.ts"));
});
