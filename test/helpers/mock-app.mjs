// Test host app — runs activate() without the real app (a subset of the api, same shape).
// data is an in-memory store enforcing the core's index rule on order/where; process/terminal are
// injectable; commands.execute is stubbed; ui.registerView records the provider.
export function mockApp(opts = {}) {
  const registered = new Map();
  const views = new Map();
  const executed = [];
  const store = new Map(); // `${coll}\0${scope}\0${id}` → doc
  const indexes = new Map(); // coll → Set(indexed fields)
  const key = (coll, scope, id) => `${coll}\0${scope ?? "default"}\0${id}`;
  let seq = 0;

  const app = {
    appVersion: "test",
    pluginId: "soksak-plugin-git-review",
    locale: () => opts.locale ?? "en",
    windowLabel: () => opts.windowLabel ?? "w-test",
    project: { current: () => opts.project ?? null },
    commands: {
      register(name, spec) {
        registered.set(name, spec);
        return { dispose() {} };
      },
      async execute(name, params) {
        executed.push({ name, params });
        return opts.executeCommand ? opts.executeCommand(name, params) : { ok: true, code: "OK", message: "", data: {} };
      },
    },
    events: { on: () => ({ dispose() {} }), progress: () => {} },
    activity: { publish: () => {} },
    process: opts.process,
    terminal: opts.terminal,
    data: {
      async define(coll, o) {
        indexes.set(coll, new Set([...(o?.indexes ?? []), "created", "updated"]));
      },
      async put(coll, doc, o) {
        const id = o?.id ?? doc.id ?? `id${++seq}`;
        store.set(key(coll, o?.scope, id), { ...doc, id });
        return id;
      },
      async get(coll, id, o) {
        return store.get(key(coll, o?.scope, id)) ?? null;
      },
      async delete(coll, id, o) {
        return store.delete(key(coll, o?.scope, id));
      },
      async query(coll, o) {
        const idx = indexes.get(coll) ?? new Set(["created", "updated"]);
        if (o?.order && !idx.has(o.order)) throw new Error(`정렬 필드가 인덱스로 선언되지 않음: ${o.order}`);
        for (const f of Object.keys(o?.where ?? {})) if (!idx.has(f)) throw new Error(`where 필드가 인덱스 아님: ${f}`);
        const prefix = `${coll}\0${o?.scope ?? "default"}\0`;
        let rows = [];
        for (const [k, v] of store) if (k.startsWith(prefix)) rows.push(v);
        if (o?.where) rows = rows.filter((r) => Object.entries(o.where).every(([f, val]) => r[f] === val));
        rows.sort((a, b) => (a[o?.order ?? "created"] ?? 0) - (b[o?.order ?? "created"] ?? 0));
        return rows;
      },
      watch: () => ({ dispose() {} }),
    },
    ui: {
      registerView(viewId, provider) {
        views.set(viewId, provider);
        return { dispose() {} };
      },
    },
  };

  const ctx = { app, manifest: opts.manifest ?? {}, subscriptions: [] };
  return { app, ctx, registered, views, executed, store };
}
