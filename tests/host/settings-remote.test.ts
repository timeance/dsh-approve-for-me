import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService, type ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import {
  SettingsConflictError,
} from '@deepseek-ai/dsh-settings'
import { describe, expect, it, vi } from 'vitest'

import {
  APPROVE_FOR_ME_SETTINGS_NAMESPACE,
} from '../../src/dsh-compat.ts'
import { ApproveForMeSettingsRemote } from '../../src/settings-remote-host.ts'

const NS = APPROVE_FOR_ME_SETTINGS_NAMESPACE

async function bench(options: {
  present?: boolean
  rpcApi?: 'legacy' | 'modern'
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

  const ctx = new Context()
  ctx.provide('settings', {
    describe: describeSettings,
    mutate: mutateSettings,
    writable: options.writable ?? true,
  } as never)
  const register = (candidate: ConnectionRpcHandler) => {
    handler = candidate
    return vi.fn(() => Promise.resolve())
  }
  const handle = options.rpcApi === 'legacy'
    ? vi.fn(function legacyHandle(
      _channel: string,
      candidate: ConnectionRpcHandler,
      _policy: { authority: string },
    ) {
      return register(candidate)
    })
    : vi.fn(function modernHandle(
      _channel: string,
      candidate: ConnectionRpcHandler,
      _ignored?: unknown,
    ) {
      return register(candidate)
    })
  ctx.provide('connection', options.rpcApi === 'legacy'
    ? { rpc: { handle } }
    : { rpc: { handle }, fetch: {} } as never)

  const fiber = ctx.plugin(ApproveForMeSettingsRemote)
  await fiber.await()
  const remote = ctx.get('approveForMeSettings') as ApproveForMeSettingsRemote
  if (handler === undefined) throw new Error('settings RPC handler was not registered')
  return { describeSettings, fiber, handle, handler, mutateSettings, remote }
}

describe('approve-for-me settings Remote', () => {
  it('registers an alpha.4 Connection channel without the removed authority option', async () => {
    const b = await bench()
    expect(b.handle).toHaveBeenCalledWith(
      '/approve-for-me',
      expect.any(Function),
    )
    expect(b.handle.mock.calls[0]).toHaveLength(2)

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

  it('keeps the legacy loopback registration for rc.2 and alpha.1', async () => {
    const b = await bench({ rpcApi: 'legacy' })
    expect(b.handle).toHaveBeenCalledWith(
      '/approve-for-me',
      expect.any(Function),
      { authority: 'loopback' },
    )
    expect(b.handle.mock.calls[0]).toHaveLength(3)
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

// Use the published Connection implementation without webServer injection, as in 0.1.5.
it('loads Settings on the real shared carrier, validates requests and disposes routes', async () => {
  const ctx = new Context()
  const mutate = vi.fn(async () => {})
  ctx.provide('settings', {
    describe: () => [{ ns: NS, schema: { type: 'object' }, value: { version: 1 }, revision: 4 }],
    mutate,
    writable: true,
  } as never)
  let connection!: HostConnectionService
  const owner = ctx.plugin({
    name: 'test-connection',
    apply(scope) {
      // This test enters after HTTP authentication; no auth methods are called.
      connection = new HostConnectionService(scope, [], {} as never)
    },
  })
  await owner.await()
  const remote = ctx.plugin(ApproveForMeSettingsRemote)
  try {
    await remote.await()
    expect(ctx.get('approveForMeSettings')).toBeDefined()
    const carrier = connection.createSharedFetchHandler('/api')
    const request = (endpoint: string, payload: unknown = {}, method = `approve-for-me/${endpoint}`) =>
      new Request(`http://localhost/api/approve-for-me/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'settings-test', method, payload }),
      })
    const response = await carrier.fetch(request('describe'))
    expect(await response.json()).toMatchObject({
      type: 'server-response', rpcId: 'settings-test',
      result: { ok: true, value: { writable: true, view: { ns: NS, revision: 4 } } },
    })
    const ops = [{ op: 'unset', path: [] }]
    const saved = await carrier.fetch(request('mutate', { ops, expectedRevision: 4 }))
    expect((await saved.json()).result.ok).toBe(true)
    expect(mutate).toHaveBeenCalledExactlyOnceWith(NS, ops, 4)
    expect((await carrier.fetch(request('describe', { ops }, 'approve-for-me/mutate'))).status).toBe(400)
    const malformed = await carrier.fetch(request('mutate', { ops: 'invalid' }))
    expect((await malformed.json()).result.error.code).toBe('bad-request')
    expect(mutate).toHaveBeenCalledTimes(1)
    await remote.dispose()
    expect((await carrier.fetch(request('describe'))).status).toBe(404)
    expect((await carrier.fetch(request('mutate'))).status).toBe(404)
  } finally {
    await remote.dispose()
    await owner.dispose()
  }
})
