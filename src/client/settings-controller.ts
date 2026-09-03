import type Schema from '@deepseek-ai/schemastery'
import { parseApprovalSettings } from '../core/settings.ts'
import type {
  ApproveForMeSettingsDescriptor,
  ApproveForMeSettingsNamespaceView,
  ApproveForMeSettingsPathOp,
  ApproveForMeSettingsRpcResult,
} from '../settings-remote-types.ts'
import type {
  ApproveForMeSettings,
  ApproveForMeSettingsState,
  ReviewerProviderOption,
} from './settings-types.ts'
import type { ModelCatalogSource } from './model-catalog.ts'
import {
  createSnapshotStore,
  type MutableSnapshotStore,
} from './snapshot-store.ts'

export const APPROVE_FOR_ME_SETTINGS_NS = 'approve-for-me'

/** The schema surface needed by this controller from DSH rc.2/alpha.1. */
export type SettingsSchemaValidator = {
  rehydrate(serialized: unknown): Schema
  validate(schema: Schema, draft: unknown): string | undefined
}

const INITIAL: ApproveForMeSettingsState = {
  status: 'idle',
  error: null,
  writable: false,
  revision: undefined,
  value: undefined,
  modelsStatus: 'idle',
  modelsError: null,
  modelGroups: [],
  modelFailures: [],
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function responseError(error: { code: string; message: string }): string {
  return error.message + ' (' + error.code + ')'
}

/**
 * Validate both the serialized schema envelope and locked nested value.
 * DSH's shared settingsSchema service must be supplied by the client host.
 */
export function settingsValueOf(
  view: ApproveForMeSettingsNamespaceView,
  schemaValidator: SettingsSchemaValidator,
): ApproveForMeSettings {
  if (view.ns !== APPROVE_FOR_ME_SETTINGS_NS) {
    throw new Error('unexpected settings namespace: ' + view.ns)
  }
  let schemaFailure: string | undefined
  try {
    schemaFailure = schemaValidator.validate(
      schemaValidator.rehydrate(view.schema),
      view.value,
    )
  } catch (error) {
    throw new Error('invalid settings schema: ' + messageOf(error))
  }
  if (schemaFailure !== undefined) {
    throw new Error('settings value does not match its schema: ' + schemaFailure)
  }

  const parsed = parseApprovalSettings(view.value)
  if (!parsed.ok) {
    const detail = parsed.issues
      .map(issue => issue.path + ': ' + issue.message)
      .join('; ')
    throw new Error('invalid approve-for-me settings: ' + detail)
  }
  return parsed.settings
}

/**
 * Produce only path writes owned by the Web form. Hidden timeout/limits stay
 * untouched in the Host document.
 */
export function settingsMutationOps(
  current: ApproveForMeSettings,
  next: ApproveForMeSettings,
): ApproveForMeSettingsPathOp[] {
  const ops: ApproveForMeSettingsPathOp[] = [
    { op: 'set', path: ['mode'], value: next.mode },
    {
      op: 'set',
      path: ['rules', 'commandPrefixes'],
      value: next.rules.commandPrefixes.map(rule => ({ ...rule })),
    },
    {
      op: 'set',
      path: ['rules', 'reviewerInstructions'],
      value: next.rules.reviewerInstructions,
    },
  ]

  if (next.reviewer !== undefined) {
    if (current.reviewer === undefined) {
      ops.push({
        op: 'set',
        path: ['reviewer'],
        value: { ...next.reviewer },
      })
    } else if (
      next.reviewer.provider !== undefined
      && next.reviewer.model !== undefined
    ) {
      ops.push(
        {
          op: 'set',
          path: ['reviewer', 'provider'],
          value: next.reviewer.provider,
        },
        {
          op: 'set',
          path: ['reviewer', 'model'],
          value: next.reviewer.model,
        },
      )
    } else {
      if (current.reviewer.provider !== undefined) {
        ops.push({ op: 'unset', path: ['reviewer', 'provider'] })
      }
      if (current.reviewer.model !== undefined) {
        ops.push({ op: 'unset', path: ['reviewer', 'model'] })
      }
    }
  }
  return ops
}

/** Host-backed settings and model-catalog controller. */
export class ApproveForMeSettingsController {
  readonly store: MutableSnapshotStore<ApproveForMeSettingsState> =
    createSnapshotStore(INITIAL)

  private settingsTail: Promise<void> = Promise.resolve()
  private settingsReadGeneration = 0
  private modelsGeneration = 0
  private disposed = false

  constructor(
    private readonly settings: {
      describe(): Promise<ApproveForMeSettingsRpcResult<ApproveForMeSettingsDescriptor>>
      mutate(
        ops: readonly ApproveForMeSettingsPathOp[],
        expectedRevision?: number,
      ): Promise<ApproveForMeSettingsRpcResult<ApproveForMeSettingsDescriptor>>
    },
    private readonly models: ModelCatalogSource,
    private readonly schemaValidator: SettingsSchemaValidator,
  ) {}

  /** Load settings and the independent Host model catalog together. */
  async load(): Promise<void> {
    await Promise.all([this.loadSettings(), this.loadModels()])
  }

  /** Queue a settings refresh behind any active write. */
  async loadSettings(): Promise<void> {
    if (this.disposed) return
    const generation = ++this.settingsReadGeneration
    return this.enqueueSettings(() => this.readSettings(generation))
  }

  private async readSettings(generation: number): Promise<void> {
    if (this.disposed) return
    this.store.update((state) => {
      state.status = 'loading'
      state.error = null
    })

    try {
      const response = await this.settings.describe()
      if (this.disposed || generation !== this.settingsReadGeneration) return
      if (!response.ok) {
        throw new Error(responseError(response.error))
      }
      if (response.value.view === undefined) {
        this.store.update((state) => {
          state.status = 'unavailable'
          state.error = null
          state.writable = false
          state.revision = undefined
          state.value = undefined
        })
        return
      }
      this.acceptSettings(response.value.view, response.value.writable)
    } catch (error) {
      if (this.disposed || generation !== this.settingsReadGeneration) return
      this.failSettings(error)
    }
  }

  /** Refresh the session-independent reviewer model catalog. */
  async loadModels(): Promise<void> {
    if (this.disposed) return
    const generation = ++this.modelsGeneration
    this.store.update((state) => {
      state.modelsStatus = 'loading'
      state.modelsError = null
      state.modelGroups = []
      state.modelFailures = []
    })

    try {
      const result = await this.models.load()
      if (this.disposed || generation !== this.modelsGeneration) return
      if (!result.ok) {
        throw new Error(responseError(result.error))
      }
      const { groups, failures } = result.value
      const modelGroups: ReviewerProviderOption[] = groups.map(group => ({
        id: group.id,
        name: group.name,
        models: group.models.map(model => ({
          id: model.id,
          name: model.name,
          ...(model.description === undefined
            ? {}
            : { description: model.description }),
        })),
      }))
      this.store.update((state) => {
        state.modelsStatus = 'ready'
        state.modelsError = null
        state.modelGroups = modelGroups
        state.modelFailures = failures.map(failure =>
          failure.name + ' (' + failure.id + '): ' + failure.message)
      })
    } catch (error) {
      if (this.disposed || generation !== this.modelsGeneration) return
      this.store.update((state) => {
        state.modelsStatus = 'error'
        state.modelsError = messageOf(error)
        state.modelGroups = []
        state.modelFailures = []
      })
    }
  }

  /** Persist visible fields with optimistic concurrency. */
  async save(next: ApproveForMeSettings): Promise<void> {
    const parsed = parseApprovalSettings(next)
    if (!parsed.ok) {
      throw new Error(parsed.issues
        .map(issue => issue.path + ': ' + issue.message)
        .join('; '))
    }

    this.settingsReadGeneration += 1
    return this.enqueueSettings(async () => {
      const state = this.store.getSnapshot()
      if (state.value === undefined || state.revision === undefined) {
        throw new Error('approval settings are not loaded')
      }
      if (!state.writable) throw new Error('approval settings are read-only')

      this.store.update((draft) => {
        draft.status = 'saving'
        draft.error = null
      })

      try {
        const response = await this.settings.mutate(
          settingsMutationOps(state.value, parsed.settings),
          state.revision,
        )
        if (this.disposed) return
        if (!response.ok) {
          throw new Error(responseError(response.error))
        }
        if (response.value.view === undefined) {
          throw new Error('approval settings are unavailable after mutation')
        }
        this.acceptSettings(response.value.view, response.value.writable)
      } catch (error) {
        if (this.disposed) return
        this.failSettings(error, state.value, state.revision, state.writable)
        throw error
      }
    })
  }

  /** Remove the user section so Host defaults/base become effective again. */
  async reset(): Promise<void> {
    this.settingsReadGeneration += 1
    return this.enqueueSettings(async () => {
      const state = this.store.getSnapshot()
      if (state.value === undefined || state.revision === undefined) {
        throw new Error('approval settings are not loaded')
      }
      if (!state.writable) throw new Error('approval settings are read-only')

      this.store.update((draft) => {
        draft.status = 'resetting'
        draft.error = null
      })

      try {
        const response = await this.settings.mutate(
          [{ op: 'unset', path: [] }],
          state.revision,
        )
        if (this.disposed) return
        if (!response.ok) {
          throw new Error(responseError(response.error))
        }
        if (response.value.view === undefined) {
          throw new Error('approval settings are unavailable after mutation')
        }
        this.acceptSettings(response.value.view, response.value.writable)
      } catch (error) {
        if (this.disposed) return
        this.failSettings(error, state.value, state.revision, state.writable)
        throw error
      }
    })
  }

  dispose(): void {
    this.disposed = true
    this.settingsReadGeneration += 1
    this.modelsGeneration += 1
  }

  private enqueueSettings(operation: () => Promise<void>): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const task = this.settingsTail.then(async () => {
      if (this.disposed) return
      await operation()
    })
    this.settingsTail = task.catch(() => {})
    return task
  }

  private acceptSettings(view: ApproveForMeSettingsNamespaceView, writable: boolean): void {
    const value = settingsValueOf(view, this.schemaValidator)
    this.store.update((state) => {
      state.status = 'ready'
      state.error = null
      state.writable = writable
      state.revision = view.revision
      state.value = value
    })
  }

  private failSettings(
    error: unknown,
    value: ApproveForMeSettings | undefined = undefined,
    revision: number | undefined = undefined,
    writable = false,
  ): void {
    this.store.update((state) => {
      state.status = 'error'
      state.error = messageOf(error)
      state.writable = writable
      state.revision = revision
      state.value = value
    })
  }
}

export function refreshSettingsIfLoaded(
  controller: ApproveForMeSettingsController,
): void {
  if (controller.store.getSnapshot().status === 'idle') return
  void controller.loadSettings()
}

export function refreshModelsIfLoaded(
  controller: ApproveForMeSettingsController,
): void {
  if (controller.store.getSnapshot().modelsStatus === 'idle') return
  void controller.loadModels()
}

export function refreshAllIfLoaded(
  controller: ApproveForMeSettingsController,
): void {
  const state = controller.store.getSnapshot()
  if (state.status === 'idle' && state.modelsStatus === 'idle') return
  void controller.load()
}
