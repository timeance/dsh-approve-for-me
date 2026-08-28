import { describe, expect, it, vi } from 'vitest'

import { createSnapshotStore } from '../../src/client/snapshot-store.ts'

describe('version-neutral snapshot store', () => {
  it('replaces snapshots and notifies active subscribers once', () => {
    const store = createSnapshotStore({ status: 'idle', nested: { value: 1 } })
    const initial = store.getSnapshot()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.update((draft) => { draft.status = 'ready' })

    expect(store.getSnapshot()).not.toBe(initial)
    expect(store.getSnapshot()).toEqual({ status: 'ready', nested: initial.nested })
    expect(listener).toHaveBeenCalledOnce()

    unsubscribe()
    store.update((draft) => { draft.status = 'done' })
    expect(listener).toHaveBeenCalledOnce()
  })
})
