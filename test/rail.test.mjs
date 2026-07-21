// Rail bridge conformance — the DOM-reparenting channel of the sidebar projection.
// Runs with node --test alone (no DOM — fake containers implementing only appendChild).
// Axes: ① register → adopt + move into the container ② unregister → restore inline
// ③ unbind → restore inline ④ no viewId (older core / sidebar placement) = no-op
// ⑤ the two slots (files/comments) are independent.
import test from "node:test";
import assert from "node:assert/strict";
import { registerRailContainer, bindRailSlot } from "../src/railBridge.js";

const fakeContainer = () => ({
  children: [],
  appendChild(el) {
    this.children.push(el);
  },
});

function harness(viewId, slot) {
  const el = { slot };
  const log = [];
  const unbind = bindRailSlot(viewId, slot, el, {
    adopt: () => log.push("adopt"),
    restore: () => log.push("restore"),
  });
  return { el, log, unbind };
}

test("register → adopt + move, unregister → restore", () => {
  const { el, log, unbind } = harness("v1", "files");
  assert.deepEqual(log, []); // inline until a container registers (fallback)
  const c = fakeContainer();
  const off = registerRailContainer("v1", "files", c);
  assert.deepEqual(log, ["adopt"]);
  assert.deepEqual(c.children, [el]);
  off();
  assert.deepEqual(log, ["adopt", "restore"]);
  unbind();
  assert.deepEqual(log, ["adopt", "restore"]); // already inline — no double restore
});

test("unbind while railed → restore inline", () => {
  const { log, unbind } = harness("v2", "comments");
  const off = registerRailContainer("v2", "comments", fakeContainer());
  assert.deepEqual(log, ["adopt"]);
  unbind();
  assert.deepEqual(log, ["adopt", "restore"]);
  off(); // late unregister is a no-op after unbind
  assert.deepEqual(log, ["adopt", "restore"]);
});

test("no viewId (older core / sidebar placement) = no-op", () => {
  const { log, unbind } = harness(null, "files");
  registerRailContainer("v3", "files", fakeContainer());
  assert.deepEqual(log, []);
  unbind();
  assert.deepEqual(log, []);
});

test("slots are independent — files does not react to comments", () => {
  const files = harness("v4", "files");
  const comments = harness("v4", "comments");
  const off = registerRailContainer("v4", "comments", fakeContainer());
  assert.deepEqual(files.log, []);
  assert.deepEqual(comments.log, ["adopt"]);
  off();
  assert.deepEqual(comments.log, ["adopt", "restore"]);
});
