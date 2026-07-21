// Rail bridge — the binding channel of the sidebar projection (rail placement). A rail view
// mount registers its container under the bound content view id (ctx.boundViewId); the content
// mount with the same id (ctx.viewId — per-view instances, 1:1) moves its list element into the
// registered container. A DOM move (appendChild) preserves rows, listeners, and scroll state.
// When the container goes away the element returns to its inline slot. Hosts that never register
// a container (older cores) keep the inline layout unchanged.

const containers = new Map(); // viewId → Map(slot → container element)
const subs = new Map(); // viewId → Set<() => void>

function notify(viewId) {
  for (const fn of subs.get(viewId) ?? []) fn();
}

// A rail view mount registers its container. Returns the release (call on unmount).
export function registerRailContainer(viewId, slot, el) {
  let entry = containers.get(viewId);
  if (!entry) containers.set(viewId, (entry = new Map()));
  entry.set(slot, el);
  notify(viewId);
  return () => {
    const cur = containers.get(viewId);
    if (!cur || cur.get(slot) !== el) return;
    cur.delete(slot);
    if (cur.size === 0) containers.delete(viewId);
    notify(viewId);
  };
}

// A content mount binds one element to a slot — adopt + move when a registered container
// appears, restore inline when it goes away. Returns the unbind (call on unmount).
export function bindRailSlot(viewId, slot, el, { adopt, restore }) {
  if (!viewId) return () => {}; // sidebar placement / older core — no binding key, stay inline
  let placed = null;
  const sync = () => {
    const target = containers.get(viewId)?.get(slot) ?? null;
    if (target === placed) return;
    if (target) {
      adopt(el);
      target.appendChild(el);
    } else {
      restore(el);
    }
    placed = target;
  };
  let set = subs.get(viewId);
  if (!set) subs.set(viewId, (set = new Set()));
  set.add(sync);
  sync();
  return () => {
    const s = subs.get(viewId);
    if (s) {
      s.delete(sync);
      if (s.size === 0) subs.delete(viewId);
    }
    if (placed) {
      restore(el);
      placed = null;
    }
  };
}
