const VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/;

export function healthVersion(value) {
  if (!value || value.ok !== true || value.service !== 'personal-workboard' || value.host !== '127.0.0.1' || typeof value.version !== 'string' || value.version.length > 80 || !VERSION.test(value.version)) return null;
  return value.version;
}

// This probe never fetches business data and never refreshes the document.
export function createVersionMonitor({ fetchImpl = fetch, onState, timeoutMs = 5000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let pending = null;
  let controller = null;
  let stopped = false;
  let version = '';
  const check = () => {
    if (stopped) return Promise.resolve(null);
    if (pending) return pending;
    controller = new AbortController();
    const activeController = controller;
    let timer;
    const aborted = new Promise((_, reject) => activeController.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    timer = setTimer(() => activeController.abort(), timeoutMs);
    pending = Promise.race([
      Promise.resolve().then(async () => {
        const response = await fetchImpl('/health', { method: 'GET', cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: activeController.signal });
        if (!response.ok) throw new Error('unavailable');
        const body = await response.text();
        if (body.length > 16384) throw new Error('invalid');
        const next = healthVersion(JSON.parse(body));
        if (!next) throw new Error('invalid');
        return next;
      }),
      aborted,
    ]).then(next => {
      if (stopped || activeController.signal.aborted) return null;
      version = next;
      onState?.({ version, connected: true });
      return next;
    }).catch(() => {
      if (!stopped) onState?.({ version, connected: false });
      return null;
    }).finally(() => {
      clearTimer(timer);
      if (controller === activeController) controller = null;
      pending = null;
    });
    return pending;
  };
  return { check, stop() { stopped = true; controller?.abort(); } };
}

// Only labels and dirty flags live here. Form values and credentials stay in
// the component that owns them and are never copied to browser storage.
export function createDraftRegistry() {
  const drafts = new Map();
  const listeners = new Set();
  let snapshot = Object.freeze([]);
  const emit = () => { snapshot = Object.freeze([...new Set(drafts.values())]); for (const listener of listeners) listener(); };
  return {
    set(key, label, dirty) {
      if (dirty) { if (drafts.get(key) === label) return; drafts.set(key, label); }
      else if (!drafts.delete(key)) return;
      emit();
    },
    clearAll() { if (!drafts.size) return; drafts.clear(); emit(); },
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

export function createRefreshGuard({ registry, confirmDiscard, reload }) {
  let confirming = false;
  return () => {
    if (confirming) return 'pending';
    const labels = registry.getSnapshot();
    if (!labels.length) { reload(); return 'refreshed'; }
    confirming = true;
    let decided = false;
    confirmDiscard({ labels, cancel() { if (decided) return; decided = true; confirming = false; }, proceed() { if (decided) return; decided = true; confirming = false; registry.clearAll(); reload(); } });
    return 'confirmation-required';
  };
}
