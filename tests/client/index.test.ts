// @vitest-environment jsdom

import Schema from '@deepseek-ai/schemastery'
import { describe, expect, it, vi } from 'vitest'

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

type SlotEntry = {
  component: unknown
  options: { key?: string }
  locale?: string
  inject?: () => unknown
}

function bench(mode: 'rc2' | 'alpha' = 'rc2', isLoopback = true) {
  const remoteListeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const contextListeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const effects: Array<() => void> = []
  const entries: SlotEntry[] = []

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
  const rpcCall = vi.fn((channel: string, endpoint: string) => {
    if (channel === '/approve-for-me' && endpoint === 'describe') {
      return describeSettings()
    }
    throw new Error('unexpected test RPC')
  })
  const catalog = {
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-v4-flash', name: 'Flash' }],
    }],
    failures: [],
  }
  const models = vi.fn(() => Promise.resolve({
    rpcId: 'models',
    result: { ok: true as const, value: catalog },
  }))
  const modelCatalog = vi.fn(() => Promise.resolve({
    ok: true as const,
    value: catalog,
  }))
  const connection = {
    isLoopback,
    rpc: { call: rpcCall },
    ...(mode === 'rc2' ? { api: { llm: { models } } } : {}),
  }

  let deferredInject: ((scope: unknown) => void) | undefined
  const ctx = {
    locale: {
      register: vi.fn(() => () => {}),
    },
    remote: {
      $on(event: string, listener: (...args: unknown[]) => void) {
        const listeners = remoteListeners.get(event) ?? new Set()
        listeners.add(listener)
        remoteListeners.set(event, listeners)
        return () => { listeners.delete(listener) }
      },
    } as Record<string, unknown>,
    settingsSchema: {
      rehydrate(serialized: unknown) {
        return new Schema(serialized as Schema)
      },
      validate(schema: Schema, draft: unknown) {
        try {
          ;(schema as unknown as (value: unknown) => unknown)(draft)
          return undefined
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      },
    },
    get(service: string) {
      if (service !== 'connection') throw new Error('unexpected service: ' + service)
      return connection
    },
    effect(setup: () => void | (() => void)) {
      const dispose = setup()
      if (typeof dispose === 'function') effects.push(dispose)
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      const listeners = contextListeners.get(event) ?? new Set()
      listeners.add(listener)
      contextListeners.set(event, listeners)
      return () => { listeners.delete(listener) }
    },
    inject(deps: readonly string[], callback: (scope: unknown) => void) {
      expect(deps).toEqual(['remote.session'])
      deferredInject = callback
      return {} as never
    },
    slots: {
      inject(_name: string, register: () => (() => void)) {
        effects.push(register())
      },
      register(options: SlotEntry['options'] & { locale?: string }, component: unknown) {
        const entry: SlotEntry = {
          component,
          options,
          ...(options.locale === undefined ? {} : { locale: options.locale }),
          ...((options as SlotEntry).inject === undefined
            ? {}
            : { inject: (options as SlotEntry).inject }),
        }
        entries.push(entry)
        return () => {
          const index = entries.indexOf(entry)
          if (index >= 0) entries.splice(index, 1)
        }
      },
      entries() {
        return entries
      },
    },
  }

  apply(ctx as never)

  return {
    entries,
    describe: describeSettings,
    models,
    modelCatalog,
    rpcCall,
    activateAlpha() {
      ctx.remote.session = { modelCatalog }
      deferredInject?.(ctx)
    },
    dispatch(event: string, ...args: unknown[]) {
      for (const listener of remoteListeners.get(event) ?? []) listener(...args)
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of contextListeners.get(event) ?? []) listener(...args)
    },
    dispose() {
      for (const dispose of effects.reverse()) dispose()
    },
  }
}

describe('approve-for-me client apply', () => {
  it('mounts immediately through the rc.2 API proxy', async () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'remote', 'settingsSchema'])
    const b = bench('rc2')
    const entry = b.entries[0]!

    expect(entry.component).toBe(ApproveForMeSection)
    expect(entry.options).toMatchObject({ key: 'approve-for-me' })
    expect(entry.locale).toBe('settings.approve-for-me')

    const injected = entry.inject?.() as ApproveForMeSectionInjected
    await injected.load()
    expect(b.describe).toHaveBeenCalledOnce()
    expect(b.rpcCall).toHaveBeenCalledWith('/approve-for-me', 'describe', {})
    expect(b.models).toHaveBeenCalledOnce()
    expect(b.modelCatalog).not.toHaveBeenCalled()

    b.dispose()
    expect(b.entries).toHaveLength(0)
  })

  it('waits for alpha.1 remote.session and uses modelCatalog', async () => {
    const b = bench('alpha')
    expect(b.entries).toHaveLength(0)

    b.activateAlpha()
    const injected = b.entries[0]!.inject?.() as ApproveForMeSectionInjected
    await injected.load()

    expect(b.modelCatalog).toHaveBeenCalledOnce()
    expect(b.models).not.toHaveBeenCalled()
    expect(injected.hooks.approveForMe.getSnapshot()).toMatchObject({
      status: 'ready',
      modelsStatus: 'ready',
      modelGroups: [{ id: 'deepseek-official' }],
    })
  })

  it('routes settings, model, and reconnect invalidations to loaded data', async () => {
    const b = bench('rc2')
    const injected = b.entries[0]!.inject?.() as ApproveForMeSectionInjected
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
    b.emit('connection/reset')
    await vi.waitFor(() => {
      expect(b.describe).toHaveBeenCalledTimes(3)
      expect(b.models).toHaveBeenCalledTimes(5)
    })
  })

  it('does not expose durable settings to a non-loopback browser', () => {
    const rc2 = bench('rc2', false)
    const alpha = bench('alpha', false)

    expect(rc2.entries).toHaveLength(0)
    expect(alpha.entries).toHaveLength(0)
    expect(rc2.rpcCall).not.toHaveBeenCalled()
    expect(alpha.modelCatalog).not.toHaveBeenCalled()
  })
})
