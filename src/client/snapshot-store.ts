/** Read-only observable contract consumed by DSH slot hooks. */
export interface SnapshotStore<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** Mutable owner face kept private to the settings controller. */
export interface MutableSnapshotStore<T> extends SnapshotStore<T> {
  update(mutator: (draft: T) => void): void
}

/**
 * Small framework-independent store shared by DSH rc.2 and alpha.1.
 * Controller mutations replace only top-level state fields, so a shallow
 * draft preserves immutable nested settings and model values.
 */
export function createSnapshotStore<T extends object>(initial: T): MutableSnapshotStore<T> {
  let snapshot = initial
  const listeners = new Set<() => void>()

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    update(mutator) {
      const draft = { ...snapshot }
      mutator(draft)
      snapshot = draft
      for (const listener of [...listeners]) listener()
    },
  }
}
