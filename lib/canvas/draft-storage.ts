import type { PersistStorage, StateStorage, StorageValue } from "zustand/middleware";

/** Coalesce object snapshots BEFORE serialization. Compatible with Zustand's JSON envelope. */
export function createDraftStorage<S extends object>(
  getStorage: () => StateStorage,
  onError: (error: unknown) => void,
  delay = 500,
  maxWait = 2000,
) {
  let pending: { name: string; value: StorageValue<S> } | undefined;
  let previous: S | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const interactions = new Set<string>();
  const clearTimers = () => {
    clearTimeout(timer);
    clearTimeout(deadline);
    timer = deadline = undefined;
  };
  const flush = () => {
    clearTimers();
    if (!pending) return;
    try {
      getStorage().setItem(pending.name, JSON.stringify(pending.value));
      pending = undefined;
    } catch (error) {
      // Keep the latest snapshot for explicit retry or the next edit.
      onError(error);
    }
  };
  const schedule = () => {
    if (!pending || interactions.size) return;
    clearTimeout(timer);
    timer = setTimeout(flush, delay);
    deadline ??= setTimeout(flush, maxWait);
  };
  const storage: PersistStorage<S> = {
    getItem(name) {
      try {
        const raw = getStorage().getItem(name);
        if (typeof raw !== "string") return null;
        const value = JSON.parse(raw) as StorageValue<S>;
        previous = value.state;
        return value;
      } catch (error) {
        onError(error);
        return null;
      }
    },
    setItem(name, value) {
      if (previous && Object.keys(value.state).every(
        (key) => Object.is(value.state[key as keyof S], previous![key as keyof S]),
      )) return;
      previous = value.state;
      pending = { name, value };
      schedule();
    },
    removeItem(name) {
      clearTimers();
      pending = undefined;
      previous = undefined;
      getStorage().removeItem(name);
    },
  };
  return {
    storage,
    flush,
    beginInteraction(key: string) {
      interactions.add(key);
      clearTimers();
    },
    endInteraction(key: string) {
      interactions.delete(key);
      schedule();
    },
  };
}
