import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

export const DraftRegistryContext = createContext(null);

export function useUnsavedDraft(key, label) {
  const registry = useContext(DraftRegistryContext);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const setDraft = useCallback(value => {
    const next = value === true;
    dirtyRef.current = next;
    registry?.set(key, label, next);
    setDirty(next);
  }, [registry, key, label]);
  const markDirty = useCallback(() => setDraft(true), [setDraft]);
  const resetDraft = useCallback(() => setDraft(false), [setDraft]);
  useEffect(() => () => registry?.set(key, label, false), [registry, key, label]);
  return { dirty, dirtyRef, setDraft, markDirty, resetDraft };
}
