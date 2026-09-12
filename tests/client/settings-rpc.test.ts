// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'

import { ApproveForMeSettingsRpc } from '../../src/client/settings-rpc.ts'

describe('approve-for-me settings RPC client', () => {
  it.each([false, true])('uses exact endpoint payloads (shared API: %s)', async (sharedApi) => {
    const call = vi.fn(() => Promise.resolve({
      ok: true as const,
      value: { writable: false },
    }))
    const settings = new ApproveForMeSettingsRpc({ call } as never, sharedApi)
    const ops = [{ op: 'unset' as const, path: [] }]

    await settings.describe()
    await settings.mutate(ops, 7)
    await settings.mutate(ops)

    const channel = sharedApi ? '/api' : '/approve-for-me'
    const prefix = sharedApi ? 'approve-for-me/' : ''
    expect(call.mock.calls).toEqual([
      [channel, `${prefix}describe`, {}],
      [channel, `${prefix}mutate`, { ops, expectedRevision: 7 }],
      [channel, `${prefix}mutate`, { ops }],
    ])
  })
})