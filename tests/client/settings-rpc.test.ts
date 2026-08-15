// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'

import { ApproveForMeSettingsRpc } from '../../src/client/settings-rpc.ts'

describe('approve-for-me settings RPC client', () => {
  it('uses the plugin-owned channel and exact endpoint payloads', async () => {
    const call = vi.fn(() => Promise.resolve({
      ok: true as const,
      value: { writable: false },
    }))
    const settings = new ApproveForMeSettingsRpc({ call } as never)
    const ops = [{ op: 'unset' as const, path: [] }]

    await settings.describe()
    await settings.mutate(ops, 7)
    await settings.mutate(ops)

    expect(call.mock.calls).toEqual([
      ['/approve-for-me', 'describe', {}],
      ['/approve-for-me', 'mutate', { ops, expectedRevision: 7 }],
      ['/approve-for-me', 'mutate', { ops }],
    ])
  })
})