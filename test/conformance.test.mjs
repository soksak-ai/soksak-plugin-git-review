// Command-surface conformance — C2 transparency (command axis) + declared ≡ actual (both ways).
// ① manifest contributes.commands ≡ activate registrations ② danger declared ≡ registered spec
// ③ mandatory spec fields (T1) ④ the declared view is registered. Runs with node --test (mocked host).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mockApp } from "./helpers/mock-app.mjs";

const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));
const plugin = (await import("../main.js")).default;

function activated() {
  const m = mockApp({ manifest });
  plugin.activate(m.ctx);
  return m;
}

test("declared ≡ registered — bidirectional", () => {
  const { registered } = activated();
  assert.deepEqual([...registered.keys()].sort(), manifest.contributes.commands.map((c) => c.name).sort());
});

test("danger declared ≡ registered spec danger", () => {
  const { registered } = activated();
  for (const c of manifest.contributes.commands) assert.equal(registered.get(c.name).danger, c.danger, c.name);
});

test("T1 mandatory fields — description · ko triggers · examples · message · returns", () => {
  const { registered } = activated();
  for (const [name, spec] of registered) {
    assert.ok(spec.description?.length > 10, `${name}: description`);
    assert.ok(spec.triggers?.ko?.length > 0, `${name}: triggers.ko`);
    assert.ok(Array.isArray(spec.examples) && spec.examples.length >= 1, `${name}: examples`);
    assert.equal(typeof spec.message, "function", `${name}: message`);
    assert.ok(spec.returns?.length > 0, `${name}: returns`);
  }
});

test("the declared view is registered", () => {
  const { views } = activated();
  for (const v of manifest.contributes.views) assert.ok(views.has(v.id), `view ${v.id}`);
});

test("deactivate roundtrip — subscriptions dispose", () => {
  const m = mockApp({ manifest });
  plugin.activate(m.ctx);
  for (const d of m.ctx.subscriptions) d.dispose();
  if (plugin.deactivate) plugin.deactivate();
});
