// @vitest-environment jsdom

import Schema from '@deepseek-ai/schemastery'
import { describe, expect, it, vi } from 'vitest'
import type {
  ApproveForMeSettingsDescriptor,
  ApproveForMeSettingsNamespaceView,
} from '../../src/settings-remote-types.ts'
import {
  ApproveForMeSettingsController,
  refreshModelsIfLoaded,
  refreshSettingsIfLoaded,
  settingsMutationOps,
  settingsValueOf,
} from '../../src/client/settings-controller.ts'
import type { ApproveForMeSettings } from '../../src/client/settings-types.ts'
import { legacyModelCatalogSource } from '../../src/client/model-catalog.ts'

const SETTINGS_SCHEMA = Schema.object({
  version: Schema.const(1).required(),
  mode: Schema.union(['rules-only', 'rules-and-llm'] as const).required(),
  rules: Schema.object({
    commandPrefixes: Schema.array(Schema.object({
      tool: Schema.union(['shell', 'pwsh'] as const).required(),
      prefix: Schema.string().required(),
    })).required(),
    reviewerInstructions: Schema.string().required(),
  }).required(),
  reviewer: Schema.object({
    provider: Schema.string().required(false),
    model: Schema.string().required(false),
    timeoutMs: Schema.number().required(),
  }),
  limits: Schema.object({
    trustedTranscriptChars: Schema.number().required(),
    untrustedToolDataChars: Schema.number().required(),
    reviewerOutputChars: Schema.number().required(),
  }).required(),
}).toJSON()

const VALUE: ApproveForMeSettings = {
  version: 1,
  mode: 'rules-and-llm',
  rules: {
    commandPrefixes: [{ tool: 'shell', prefix: 'git status' }],
    reviewerInstructions: '',
  },
  reviewer: {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    timeoutMs: 45_000,
  },
  limits: {
    trustedTranscriptChars: 12_000,
    untrustedToolDataChars: 8_000,
    reviewerOutputChars: 2_000,
  },
}

function view(
  value: ApproveForMeSettings = VALUE,
  revision = 4,
): ApproveForMeSettingsNamespaceView {
  return {
    ns: 'approve-for-me',
    schema: SETTINGS_SCHEMA,
    value,
    revision,
  }
}

function rpcOk<T>(value: T) {
  return { rpcId: 'test', result: { ok: true as const, value } }
}

function remoteOk<T>(value: T) {
  return { ok: true as const, value }
}

function described(
  namespaces: ApproveForMeSettingsNamespaceView[] = [view()],
  writable = true,
) {
  const current = namespaces[0]
  return remoteOk({
    writable,
    ...(current === undefined ? {} : { view: current }),
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function api(options: {
  writable?: boolean
  namespaces?: ApproveForMeSettingsNamespaceView[]
  describe?: ReturnType<typeof vi.fn>
  mutate?: ReturnType<typeof vi.fn>
  models?: ReturnType<typeof vi.fn>
} = {}) {
  return {
    settings: {
      describe: options.describe ?? vi.fn(() => Promise.resolve(described(
        options.namespaces ?? [view()],
        options.writable ?? true,
      ))),
      mutate: options.mutate ?? vi.fn(() => Promise.resolve(described([view(VALUE, 5)]))),
    },
    llm: {
      models: options.models ?? vi.fn(() => Promise.resolve(rpcOk({
        groups: [{
          id: 'deepseek-official',
          name: 'DeepSeek',
          models: [{ id: 'deepseek-v4-flash', name: 'Flash' }],
        }],
        failures: [],
      }))),
    },
  }
}

function controllerFor(wire: ReturnType<typeof api>) {
  return new ApproveForMeSettingsController(
    wire.settings as never,
    legacyModelCatalogSource(wire.llm as never),
  )
}

describe('approve-for-me settings controller', () => {
  it('rejects invalid schemas and values at the descriptor boundary', () => {
    expect(settingsValueOf(view())).toEqual(VALUE)
    expect(() => settingsValueOf({ ...view(), schema: { nope: true } }))
      .toThrow(/invalid settings schema|does not match/)
    expect(() => settingsValueOf({
      ...view(),
      value: { ...VALUE, version: 2 },
    })).toThrow(/invalid approve-for-me settings|does not match/)
  })

  it('loads describe and llm.models without importing model-selection state', async () => {
    const wire = api()
    const controller = controllerFor(wire)
    await controller.load()
    expect(wire.settings.describe).toHaveBeenCalledWith()
    expect(wire.llm.models).toHaveBeenCalledWith({})
    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready',
      writable: true,
      revision: 4,
      value: VALUE,
      modelsStatus: 'ready',
      modelGroups: [{
        id: 'deepseek-official',
        models: [{ id: 'deepseek-v4-flash' }],
      }],
    })
  })

  it('clears stale model options while the catalog refreshes', async () => {
    const refresh = deferred<ReturnType<typeof rpcOk<{
      groups: { id: string; name: string; models: { id: string; name: string }[] }[]
      failures: never[]
    }>>>()
    const models = vi.fn()
      .mockResolvedValueOnce(rpcOk({
        groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'Flash' }] }],
        failures: [],
      }))
      .mockReturnValueOnce(refresh.promise)
    const controller = controllerFor(api({ models }))
    await controller.load()

    const loading = controller.loadModels()
    expect(controller.store.getSnapshot()).toMatchObject({
      modelsStatus: 'loading',
      modelGroups: [],
      modelFailures: [],
    })
    refresh.resolve(rpcOk({ groups: [], failures: [] }))
    await loading
  })

  it('writes visible nested paths with expectedRevision and preserves hidden fields', async () => {
    const next: ApproveForMeSettings = {
      ...VALUE,
      rules: {
        commandPrefixes: [{ tool: 'pwsh', prefix: 'Get-Content' }],
        reviewerInstructions: 'Ask on installs.',
      },
      reviewer: {
        provider: 'openai',
        model: 'gpt-5',
        timeoutMs: 99_000,
      },
      limits: {
        trustedTranscriptChars: 999,
        untrustedToolDataChars: 999,
        reviewerOutputChars: 999,
      },
    }
    const returned = {
      ...next,
      reviewer: { ...next.reviewer!, timeoutMs: VALUE.reviewer!.timeoutMs },
      limits: VALUE.limits,
    }
    const mutate = vi.fn((_request: unknown) => Promise.resolve(described([view(returned, 5)])))
    const wire = api({ mutate })
    const controller = controllerFor(wire)
    await controller.load()
    await controller.save(next)

    expect(mutate).toHaveBeenCalledWith(
      settingsMutationOps(VALUE, next),
      4,
    )
    const ops = mutate.mock.calls[0]?.[0] as unknown[] | undefined
    expect(ops).toEqual([
      { op: 'set', path: ['mode'], value: 'rules-and-llm' },
      {
        op: 'set',
        path: ['rules', 'commandPrefixes'],
        value: [{ tool: 'pwsh', prefix: 'Get-Content' }],
      },
      {
        op: 'set',
        path: ['rules', 'reviewerInstructions'],
        value: 'Ask on installs.',
      },
      { op: 'set', path: ['reviewer', 'provider'], value: 'openai' },
      { op: 'set', path: ['reviewer', 'model'], value: 'gpt-5' },
    ])
    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready',
      revision: 5,
      value: returned,
    })
  })

  it('commits a save response before converging to a queued document refresh', async () => {
    const saved: ApproveForMeSettings = {
      ...VALUE,
      rules: {
        ...VALUE.rules,
        reviewerInstructions: 'saved locally',
      },
    }
    const refreshed: ApproveForMeSettings = {
      ...saved,
      rules: {
        ...saved.rules,
        reviewerInstructions: 'updated remotely',
      },
    }
    const mutation = deferred<ReturnType<typeof described>>()
    const refresh = deferred<ReturnType<typeof described>>()
    const describe = vi.fn()
      .mockResolvedValueOnce(described())
      .mockReturnValueOnce(refresh.promise)
    const mutate = vi.fn(() => mutation.promise)
    const wire = api({ describe, mutate })
    const controller = controllerFor(wire)
    await controller.load()

    const saving = controller.save(saved)
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledOnce())
    refreshSettingsIfLoaded(controller)
    mutation.resolve(described([view(saved, 5)]))
    await saving
    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'loading',
      revision: 5,
      value: saved,
    })

    await vi.waitFor(() => expect(describe).toHaveBeenCalledTimes(2))
    refresh.resolve(described([view(refreshed, 6)]))
    await vi.waitFor(() => {
      expect(controller.store.getSnapshot()).toMatchObject({
        status: 'ready',
        revision: 6,
        value: refreshed,
      })
    })
  })
  it('materializes a complete reviewer only when none existed', () => {
    const { reviewer: _reviewer, ...base } = VALUE
    const current = { ...base, mode: 'rules-only' as const }
    expect(settingsMutationOps(current, VALUE).at(-1)).toEqual({
      op: 'set',
      path: ['reviewer'],
      value: VALUE.reviewer,
    })
  })

  it('unsets both explicit route fields when switching to session inheritance', () => {
    const inherited: ApproveForMeSettings = {
      ...VALUE,
      reviewer: { timeoutMs: VALUE.reviewer!.timeoutMs },
    }
    expect(settingsValueOf(view(inherited))).toEqual(inherited)
    expect(settingsMutationOps(VALUE, inherited).slice(-2)).toEqual([
      { op: 'unset', path: ['reviewer', 'provider'] },
      { op: 'unset', path: ['reviewer', 'model'] },
    ])
  })

  it('surfaces conflict, missing namespace, model failures, and read-only state', async () => {
    const conflict = api({
      mutate: vi.fn(() => Promise.resolve({
        ok: false as const,
        error: {
          code: 'settings-conflict',
          message: 'stale revision',
          details: {},
        },
      })),
    })
    const failing = controllerFor(conflict)
    await failing.load()
    await expect(failing.save(VALUE)).rejects.toThrow(/stale revision/)
    expect(failing.store.getSnapshot()).toMatchObject({
      status: 'error',
      error: 'stale revision (settings-conflict)',
      value: VALUE,
    })

    const absent = controllerFor(api({ namespaces: [] }))
    await absent.load()
    expect(absent.store.getSnapshot()).toMatchObject({
      status: 'unavailable',
      value: undefined,
      writable: false,
    })

    const readonly = controllerFor(api({ writable: false }))
    await readonly.load()
    await expect(readonly.save(VALUE)).rejects.toThrow(/read-only/)

    const modelFailure = controllerFor(api({
      models: vi.fn(() => Promise.resolve({
        rpcId: 'test',
        result: {
          ok: false as const,
          error: { code: 'internal', message: 'catalog offline', details: {} },
        },
      })),
    }))
    await modelFailure.load()
    expect(modelFailure.store.getSnapshot()).toMatchObject({
      status: 'ready',
      modelsStatus: 'error',
      modelsError: 'catalog offline (internal)',
      modelGroups: [],
    })
  })

  it('resets through mutate and refreshes only after first load', async () => {
    const mutate = vi.fn(() => Promise.resolve(described([view(VALUE, 5)])))
    const wire = api({ mutate })
    const controller = controllerFor(wire)
    refreshSettingsIfLoaded(controller)
    refreshModelsIfLoaded(controller)
    expect(wire.settings.describe).not.toHaveBeenCalled()
    expect(wire.llm.models).not.toHaveBeenCalled()

    await controller.load()
    await controller.reset()
    expect(mutate).toHaveBeenLastCalledWith(
      [{ op: 'unset', path: [] }],
      4,
    )
    refreshSettingsIfLoaded(controller)
    refreshModelsIfLoaded(controller)
    await vi.waitFor(() => {
      expect(wire.settings.describe).toHaveBeenCalledTimes(2)
      expect(wire.llm.models).toHaveBeenCalledTimes(2)
    })
  })
})
