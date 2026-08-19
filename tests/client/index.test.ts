// @vitest-environment jsdom

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import {
  SlotRegistry,
} from '@deepseek-ai/dsh-client-runtime/client'
import Schema from '@deepseek-ai/schemastery'
import { ApproveForMeSection } from '../../src/client/ApproveForMeSection.tsx'
import type { ApproveForMeSectionInjected } from '../../src/client/ApproveForMeSection.tsx'
import { apply, inject } from '../../src/client/index.ts'

const VALUE = {
  version: 1 as const,
  mode: 'rules-and-llm' as const,
  rules: { commandPrefixes: [], reviewerInstructions: '' },
  reviewer: {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    timeoutMs: 30_000,
  },
  limits: {
    trustedTranscriptChars: 12_000,
    untrustedToolDataChars: 8_000,
    reviewerOutputChars: 2_000,
  },
}

async function bench(isLoopback = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)

  const remoteListeners = new Map<
    string,
    Set<(...args: unknown[]) => void>
  >()
  ctx.provide('remote', {
    $on(event: string, listener: (...args: unknown[]) => void) {
      const listeners = remoteListeners.get(event) ?? new Set()
      listeners.add(listener)
      remoteListeners.set(event, listeners)
      return () => { listeners.delete(listener) }
    },
  } as never)

  const describeSettings = vi.fn(() => Promise.resolve({
    ok: true as const,
    value: {
      writable: true,
      view: {
        ns: 'approve-for-me' as const,
        schema: Schema.object({}).toJSON(),
        value: VALUE,
        revision: 1,
      },
    },
  }))
  const rpcCall = vi.fn((
    channel: string,
    endpoint: string,
    _payload: unknown,
  ) => {
    if (channel === '/approve-for-me' && endpoint === 'describe') {
      return describeSettings()
    }
    throw new Error('unexpected test RPC')
  })
  const models = vi.fn(() => Promise.resolve({
    rpcId: 'models',
    result: {
      ok: true as const,
      value: {
        groups: [{
          id: 'deepseek-official',
          name: 'DeepSeek',
          models: [{ id: 'deepseek-v4-flash', name: 'Flash' }],
        }],
        failures: [],
      },
    },
  }))
  ctx.provide('connection', {
    isLoopback,
    rpc: { call: rpcCall },
    api: { llm: { models } },
  } as never)

  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: {
      'settings.plugin.item': { kind: 'keyed', scope: 'root' },
    },
  } as never, () => null)

  const dispatch = (event: string, ...args: unknown[]): void => {
    for (const listener of remoteListeners.get(event) ?? []) listener(...args)
  }

  return { ctx, locale, slots, describe: describeSettings, models, rpcCall, dispatch }
}
describe('approve-for-me client apply', () => {
  it('declares services and registers a keyed localized settings section', async () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'remote'])
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const entry = b.slots.entries('settings.plugin.item')[0]!
    expect(entry.component).toBe(ApproveForMeSection)
    expect(entry.options).toMatchObject({
      key: 'approve-for-me',
    })
    expect(entry.locale).toBe('settings.approve-for-me')

    const injected = entry.inject?.() as unknown as ApproveForMeSectionInjected
    expect(injected.hooks.approveForMe).toBeDefined()
    await injected.load()
    expect(b.describe).toHaveBeenCalledOnce()
    expect(b.rpcCall).toHaveBeenCalledWith('/approve-for-me', 'describe', {})
    expect(b.models).toHaveBeenCalledOnce()

    await fiber.dispose()
    expect(b.slots.entries('settings.plugin.item')).toHaveLength(0)
  })

  it('routes settings, model, and reconnect invalidations to loaded data', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('settings.plugin.item')[0]!
    const injected = entry.inject?.() as unknown as ApproveForMeSectionInjected
    await injected.load()

    b.dispatch('settings/document-updated', 'another', 2)
    expect(b.describe).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => { expect(b.models).toHaveBeenCalledTimes(2) })
    b.dispatch('settings/document-updated', 'approve-for-me', 2)
    await vi.waitFor(() => {
      expect(b.describe).toHaveBeenCalledTimes(2)
      expect(b.models).toHaveBeenCalledTimes(3)
    })

    b.dispatch('llm/adapters-updated')
    await vi.waitFor(() => { expect(b.models).toHaveBeenCalledTimes(4) })

    b.ctx.emit('connection/reset')
    await vi.waitFor(() => {
      expect(b.describe).toHaveBeenCalledTimes(3)
      expect(b.models).toHaveBeenCalledTimes(5)
    })
  })

  it('does not expose durable settings to a non-loopback browser', async () => {
    const b = await bench(false)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    expect(b.slots.entries('settings.plugin.item')).toHaveLength(0)
    expect(b.rpcCall).not.toHaveBeenCalled()
    expect(b.models).not.toHaveBeenCalled()
  })})
