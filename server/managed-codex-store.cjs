'use strict';

// Uses the existing SQLite KV; no separate database or second writer is created.
const MANAGED_CODEX_KEY = 'managed-codex-v1';
function createManagedCodexStore(store) {
  if (!store || typeof store.getSetting !== 'function' || typeof store.setSetting !== 'function') {
    throw new Error('Codex 持久存储需要现有 SQLite 设置接口');
  }
  return {
    load: () => store.getSetting(MANAGED_CODEX_KEY, null),
    save: state => { store.setSetting(MANAGED_CODEX_KEY, state); },
  };
}
module.exports = { createManagedCodexStore, MANAGED_CODEX_KEY };
