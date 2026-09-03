import { Service, type Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import {
  SettingsConflictError,
  type SettingsDescriptor,
  type SettingsPathOp,
} from '@deepseek-ai/dsh-settings'

import type {
  ApproveForMeSettingsDescriptor,
  ApproveForMeSettingsNamespaceView,
  ApproveForMeSettingsPathOp,
  ApproveForMeSettingsRpcResult,
} from './settings-remote-types.ts'
import {
  APPROVE_FOR_ME_SETTINGS_NAMESPACE,
  registerConnectionRpc,
} from './dsh-compat.ts'

const RPC_CHANNEL = '/approve-for-me'
const DESCRIBE_ENDPOINT = 'describe'
const MUTATE_ENDPOINT = 'mutate'

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function parseMutation(value: unknown): {
  ops: ApproveForMeSettingsPathOp[]
  expectedRevision?: number
} | undefined {
  if (!isPlainRecord(value)) return undefined
  if (!Object.hasOwn(value, 'ops')) return undefined
  if (Object.keys(value).some(key => key !== 'ops' && key !== 'expectedRevision')) return undefined
  if (!Array.isArray(value.ops)) return undefined

  const ops: ApproveForMeSettingsPathOp[] = []
  for (const candidate of value.ops) {
    if (!isPlainRecord(candidate)) return undefined
    if (candidate.op !== 'set' && candidate.op !== 'unset') return undefined
    if (!Array.isArray(candidate.path) || candidate.path.some(part => typeof part !== 'string')) {
      return undefined
    }
    if (candidate.op === 'set') {
      if (!hasExactKeys(candidate, ['op', 'path', 'value'])) return undefined
      ops.push({ op: 'set', path: [...candidate.path] as string[], value: candidate.value })
    } else {
      if (!hasExactKeys(candidate, ['op', 'path'])) return undefined
      ops.push({ op: 'unset', path: [...candidate.path] as string[] })
    }
  }

  const expectedRevision = value.expectedRevision
  if (expectedRevision !== undefined
    && (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0)) {
    return undefined
  }
  return expectedRevision === undefined
    ? { ops }
    : { ops, expectedRevision: expectedRevision as number }
}

function remoteView(descriptor: SettingsDescriptor): ApproveForMeSettingsNamespaceView {
  if (String(descriptor.ns) !== APPROVE_FOR_ME_SETTINGS_NAMESPACE) {
    throw new Error('approve-for-me settings descriptor has an unexpected namespace')
  }
  return {
    ns: 'approve-for-me',
    schema: descriptor.schema,
    value: descriptor.value,
    revision: descriptor.revision,
  }
}

function rejected(error: unknown): ApproveForMeSettingsRpcResult<never> {
  if (error instanceof SettingsConflictError) {
    return {
      ok: false,
      error: {
        code: 'settings-conflict',
        message: error.message,
        details: {
          ns: 'approve-for-me',
          expected: error.expected,
          actual: error.actual,
        },
      },
    }
  }
  return {
    ok: false,
    error: {
      code: 'settings-rejected',
      message: error instanceof Error ? error.message : String(error),
      details: { ns: 'approve-for-me' },
    },
  }
}

function badRequest(message: string): ApproveForMeSettingsRpcResult<never> {
  return {
    ok: false,
    error: { code: 'bad-request', message, details: { issues: [] } },
  }
}

/** Settings bridge on the authenticated Connection channel; the approval core remains independent of Web. */
export class ApproveForMeSettingsRemote extends Service {
  static inject = ['settings', 'connection']

  constructor(ctx: Context) {
    super(ctx, 'approveForMeSettings')
    registerConnectionRpc(ctx, RPC_CHANNEL, this.dispatch)
  }

  describe(): ApproveForMeSettingsDescriptor {
    const descriptor = this.ctx.settings.describe({ redactSecrets: true })
      .find(candidate => String(candidate.ns) === APPROVE_FOR_ME_SETTINGS_NAMESPACE)
    return {
      writable: this.ctx.settings.writable,
      ...(descriptor === undefined ? {} : { view: remoteView(descriptor) }),
    }
  }

  async mutate(
    ops: readonly ApproveForMeSettingsPathOp[],
    expectedRevision?: number,
  ): Promise<ApproveForMeSettingsDescriptor> {
    await (this.ctx.settings as unknown as {
      mutate(namespace: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<unknown>
    }).mutate(
      APPROVE_FOR_ME_SETTINGS_NAMESPACE,
      ops as readonly SettingsPathOp[],
      expectedRevision,
    )
    return this.describe()
  }

  private readonly dispatch: ConnectionRpcHandler = async (endpoint, payload) => {
    if (endpoint === DESCRIBE_ENDPOINT) {
      if (!isPlainRecord(payload) || Object.keys(payload).length !== 0) {
        return badRequest('approve-for-me describe payload must be an empty object')
      }
      try {
        return { ok: true, value: this.describe() }
      } catch (error) {
        return rejected(error)
      }
    }

    if (endpoint === MUTATE_ENDPOINT) {
      const request = parseMutation(payload)
      if (request === undefined) {
        return badRequest('approve-for-me mutate payload is invalid')
      }
      try {
        return {
          ok: true,
          value: await this.mutate(request.ops, request.expectedRevision),
        }
      } catch (error) {
        return rejected(error)
      }
    }

    return badRequest('unknown approve-for-me settings endpoint')
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    approveForMeSettings: ApproveForMeSettingsRemote
  }
}
