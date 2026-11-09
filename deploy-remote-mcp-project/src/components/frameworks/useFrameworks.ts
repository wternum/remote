import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { frameworkLiveStore } from '@/vela/frameworkRuntime';
import {
  frameworkInputKey,
  normalizeFrameworkMarket,
  type FrameworkMarket,
} from '@/vela/frameworkKey';

export { frameworkInputKey, normalizeFrameworkMarket, type FrameworkMarket };

/** Reads the shared closed-bar framework analysis maintained by the Vela chart attachment. */
export function useFrameworks(open: boolean) {
  const snap = useSyncExternalStore(
    frameworkLiveStore.subscribe,
    frameworkLiveStore.getSnapshot,
    frameworkLiveStore.getSnapshot,
  );

  useEffect(() => {
    if (open) frameworkLiveStore.refresh();
  }, [open]);

  const follow = useCallback(() => frameworkLiveStore.refresh(), []);
  const refresh = useCallback(() => frameworkLiveStore.refresh(), []);

  return { ...snap, follow, refresh };
}
