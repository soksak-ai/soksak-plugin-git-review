// git runner pure part — ref validation guard.
// RED baseline: an option-looking or traversing ref slipping through to a git command.
import test from "node:test";
import assert from "node:assert/strict";
import { validRef } from "../src/git.js";

test("validRef — accepts branches/hashes/HEAD, rejects option/traversal", () => {
  for (const r of ["main", "feat/login", "HEAD", "a1b2c3d", "release-1.2.0"]) assert.ok(validRef(r), r);
  for (const r of ["", "-x", "--upload-pack=evil", "a..b", "trail/", "x.lock", 42, null]) assert.ok(!validRef(r), String(r));
});
