import { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import {
  SettingsConflictError,
  settingsNamespace,
} from '@deepseek-ai/dsh-settings'
import { describe, expect, it, vi } from 'vitest'

import { ApproveForMeSettingsRemote } from '../../src/settings-remote-host.ts'

const NS = settingsNamespace('approve-for-me')

async function bench(options: {
  present?: boolean
  writable?: boolean
  mutate?: ReturnType<typeof vi.fn>
} = {}) {
  const descriptor = {
    ns: NS,
    schema: { type: 'object' },
    value: { version: 1 },
    applies: 'live' as const,
    revision: 4,
  }
  const describeSettings = vi.fn(() => options.present === false ? [] : [descriptor])
  const mutateSettings = options.mutate ?? vi.fn(() => Promise.resolve())
  let handler: ConnectionRpcHandler | undefined
  const handle = vi.fn((
    _channel: string,
    candidate: ConnectionRpcHandler,
    _policy: { authority: string },
  ) => {
    handler = candidate
    return vi.fn(() => Promise.resolve())
  })

  const ctx = new Context()
  ctx.provide('settings', {
    describe: describeSettings,
    mutate: mutateSettings,
    writable: options.writable ?? true,
  } as never)
  ctx.provide('connection', { rpc: { handle } } as never)

  const fiber = ctx.plugin(ApproveForMeSettingsRemote)
  await fiber.await()
  const remote = ctx.get('approveForMeSettings') as ApproveForMeSettingsRemote
  if (handler === undefined) throw new Error('settings RPC handler was not registered')
  return { describeSettings, fiber, handle, handler, mutateSettings, remote }
}

describe('approve-for-me settings Remote', () => {
  it('registers a loopback-only Cordis Connection channel', async () => {
    const b = await bench()
    expect(b.handle).toHaveBeenCalledWith(
      '/approve-for-me',
      expect.any(Function),
      { authority: 'loopback' },
    )

    await expect(b.handler('describe', {}, new AbortController().signal)).resolves.toEqual({
      ok: true,
      value: {
        writable: true,
        view: {
          ns: 'approve-for-me',
          schema: { type: 'object' },
          value: { version: 1 },
          revision: 4,
        },
      },
    })
    expect(b.describeSettings).toHaveBeenCalledWith({ redactSecrets: true })
  })

  it('mutates only the fixed namespace and returns a fresh descriptor', async () => {
    const b = await bench()
    const ops = [{ op: 'set' as const, path: ['mode'], value: 'rules-only' }]

    await expect(b.handler(
      'mutate',
      { ops, expectedRevision: 4 },
      new AbortController().signal,
    )).resolves.toMatchObject({
      ok: true,
      value: { writable: true, view: { ns: 'approve-for-me', revision: 4 } },
    })
    expect(b.mutateSettings).toHaveBeenCalledWith(NS, ops, 4)
    expect(b.describeSettings).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed payloads before settings and preserves conflict details', async () => {
    const mutate = vi.fn(() => Promise.reject(new SettingsConflictError(NS, 4, 5)))
    const b = await bench({ mutate })

    await expect(b.handler(
      'mutate',
      { ops: [{ op: 'unset', path: [], extra: true }], expectedRevision: 4 },
      new AbortController().signal,
    )).resolves.toMatchObject({
      ok: false,
      error: { code: 'bad-request' },
    })
    expect(mutate).not.toHaveBeenCalled()

    await expect(b.handler(
      'mutate',
      { ops: [{ op: 'unset', path: [] }], expectedRevision: 4 },
      new AbortController().signal,
    )).resolves.toEqual({
      ok: false,
      error: {
        code: 'settings-conflict',
        message: 'settings namespace "approve-for-me" changed since it was read (expected revision 4, now 5)',
        details: { ns: 'approve-for-me', expected: 4, actual: 5 },
      },
    })
  })

  it('reports an unavailable or read-only settings surface without affecting the service', async () => {
    const absent = await bench({ present: false, writable: false })
    expect(absent.remote.describe()).toEqual({ writable: false })

    const readonly = await bench({ writable: false })
    expect(readonly.remote.describe()).toMatchObject({
      writable: false,
      view: { ns: 'approve-for-me' },
    })
  })
})