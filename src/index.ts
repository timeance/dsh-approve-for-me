import { AsyncLocalStorage } from 'node:async_hooks'

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { WIDER_MODES, type SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { ObjectJsonSchema, ToolDispatchExecution } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'

import { APPROVE_FOR_ME_DEFAULTS } from './core/defaults.ts'
import {
  buildReviewerPrompt,
  detectFixedHighRisk,
  evaluateCommandRules,
  parseApprovalSettings,
  type ApprovalSettings,
  type CommandPrefixRule,
  type ShellToolName,
  type TrustedTranscriptEntry,
} from './core/index.ts'
import {
  APPROVE_FOR_ME_SETTINGS_NAMESPACE,
  currentPermissionPreset,
  installSettingsSectionCompat,
  sessionEventAt,
} from './dsh-compat.ts'
import { ApproveForMeSettingsRemote } from './settings-remote-host.ts'

export { ApproveForMeSettingsRemote } from './settings-remote-host.ts'
export type {
  ApproveForMeSettingsDescriptor,
  ApproveForMeSettingsNamespaceView,
  ApproveForMeSettingsPathOp,
} from './settings-remote-types.ts'

declare module '@deepseek-ai/dsh-agent' {
  interface AgentOptions {
    approveForMeReviewer?: true
  }
}

export const name = 'approve-for-me'
export const inject = [
  'approval',
  'permissionPresets',
  'sandboxPolicy',
  'subagents',
  'systemPrompt',
  'tools',
] as const

const MAX_JUSTIFICATION_CHARS = 4_000
const REVIEWER_MAX_TOKENS = 1_024

interface ApprovalSettingsDocument extends Omit<ApprovalSettings, 'rules'> {
  rules: {
    commandPrefixes: CommandPrefixRule[]
    reviewerInstructions: string
  }
}

export const Config: z<ApprovalSettingsDocument> = z.object({
  version: z.union([1] as const).default(1),
  mode: z.union(['rules-only', 'rules-and-llm'] as const).default(APPROVE_FOR_ME_DEFAULTS.mode),
  rules: z.object({
    commandPrefixes: z.array(z.object({
      tool: z.union(['shell', 'pwsh'] as const).required(),
      prefix: z.string().min(1).required(),
    })).default([]),
    reviewerInstructions: z.string().default(APPROVE_FOR_ME_DEFAULTS.rules.reviewerInstructions),
  }).default({ commandPrefixes: [], reviewerInstructions: '' }),
  reviewer: z.object({
    provider: z.string().min(1).required(false),
    model: z.string().min(1).required(false),
    timeoutMs: z.number().step(1).min(1_000).max(120_000)
      .default(APPROVE_FOR_ME_DEFAULTS.reviewer.timeoutMs),
  }).default({ timeoutMs: APPROVE_FOR_ME_DEFAULTS.reviewer.timeoutMs } as unknown as {
    provider: string
    model: string
    timeoutMs: number
  }),
  limits: z.object({
    trustedTranscriptChars: z.number().step(1).min(256).max(100_000)
      .default(APPROVE_FOR_ME_DEFAULTS.limits.trustedTranscriptChars),
    untrustedToolDataChars: z.number().step(1).min(256).max(100_000)
      .default(APPROVE_FOR_ME_DEFAULTS.limits.untrustedToolDataChars),
    reviewerOutputChars: z.number().step(1).min(256).max(100_000)
      .default(APPROVE_FOR_ME_DEFAULTS.limits.reviewerOutputChars),
  }).default({ ...APPROVE_FOR_ME_DEFAULTS.limits }),
})

const REVIEWER_OUTPUT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    decision: { type: 'string', enum: ['allow', 'deny', 'escalate'] },
    rationale: { type: 'string' },
  },
  required: ['decision'],
}

interface AssociatedEscalation {
  execution: ToolDispatchExecution
  tool: ShellToolName
  command: string
  justification: string
  requested: SandboxMode
}

interface ReviewerStructuredOutput {
  decision: 'allow' | 'deny' | 'escalate'
  rationale?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const item of Object.values(value)) deepFreeze(item)
  return Object.freeze(value)
}

function validatedBase(config: ApprovalSettings): ApprovalSettings {
  const parsed = parseApprovalSettings(config)
  if (!parsed.ok) {
    throw new Error(`approve-for-me: invalid configuration: ${parsed.issues
      .map(issue => `${issue.path} ${issue.message}`)
      .join('; ')}`)
  }
  return deepFreeze(parsed.settings)
}

function toSettingsDocument(settings: ApprovalSettings): ApprovalSettingsDocument {
  return {
    ...settings,
    rules: {
      ...settings.rules,
      commandPrefixes: [...settings.rules.commandPrefixes],
    },
  }
}

function validateSettingsDocument(settings: ApprovalSettingsDocument): void {
  const parsed = parseApprovalSettings(settings)
  if (parsed.ok) return
  throw new Error(`approve-for-me: invalid settings document: ${parsed.issues
    .map(issue => `${issue.path} ${issue.message}`)
    .join('; ')}`)
}

function shellTool(name: string): ShellToolName | undefined {
  if (name === 'bash') return 'shell'
  if (name === 'pwsh') return 'pwsh'
  return undefined
}

function escalationTarget(value: unknown): SandboxMode | undefined {
  return value === 'workspace-write' || value === 'danger-full-access' ? value : undefined
}

function associateEscalation(
  ctx: Context,
  execution: ToolDispatchExecution | undefined,
  request: ApprovalRequest,
): AssociatedEscalation | undefined {
  if (execution === undefined || execution.agent === undefined) return undefined
  if (execution.agent !== request.agent) return undefined
  if (request.callId === undefined || execution.callId !== request.callId) return undefined
  if (execution.name !== request.toolName) return undefined

  const tool = shellTool(execution.name)
  if (tool === undefined || !isRecord(execution.arguments)) return undefined
  const requested = escalationTarget(execution.arguments.sandbox_permissions)
  const command = execution.arguments.command
  const justification = execution.arguments.justification
  if (requested === undefined || typeof command !== 'string' || command.trim().length === 0) return undefined
  if (typeof justification !== 'string'
    || justification.trim().length === 0
    || justification.length > MAX_JUSTIFICATION_CHARS) return undefined
  if (request.reason !== `escalate sandbox to ${requested}: ${justification}`) return undefined

  const current = ctx.sandboxPolicy.resolve({ session: request.agent.session }).mode
  if (!(WIDER_MODES[current] ?? []).includes(requested)) return undefined
  return { execution, tool, command, justification, requested }
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value
    .filter((block): block is { type: 'text'; text: string } => (
      isRecord(block) && block.type === 'text' && typeof block.text === 'string'
    ))
    .map(block => block.text)
    .join('\n')
}

function trustedTranscript(agent: Agent): TrustedTranscriptEntry[] {
  const result: TrustedTranscriptEntry[] = []
  for (const seq of agent.session.surface.nodes) {
    const event = sessionEventAt(agent.session, seq)
    if (!isRecord(event)) continue
    const type = event.type
    const data = event.data
    if (type !== 'user/message' || !isRecord(data)) continue
    const rawSource = data.source
    const source = isRecord(rawSource) ? rawSource : undefined
    const content = contentText(data.content)
    if (source === undefined || content.length === 0) continue
    if (source.kind === 'user') {
      result.push({ role: 'user', content })
    } else if (source.kind === 'agent-instructions' && source.form === 'instructions') {
      result.push({ role: 'developer', content })
    }
  }
  return result
}

function reviewerOutput(value: unknown, maxChars: number): ReviewerStructuredOutput | undefined {
  if (!isRecord(value)) return undefined
  const keys = Object.keys(value)
  if (keys.some(key => key !== 'decision' && key !== 'rationale')) return undefined
  if (value.decision !== 'allow' && value.decision !== 'deny' && value.decision !== 'escalate') return undefined
  if (value.rationale !== undefined && typeof value.rationale !== 'string') return undefined
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    return undefined
  }
  if (serialized.length > maxChars) return undefined
  return value.rationale === undefined
    ? { decision: value.decision }
    : { decision: value.decision, rationale: value.rationale }
}

function fusedSignal(
  execution: ToolDispatchExecution,
  request: ApprovalRequest,
  lifetime: AbortSignal,
  timeout: AbortSignal,
): AbortSignal {
  return AbortSignal.any([
    execution.signal,
    ...request.signal === undefined ? [] : [request.signal],
    lifetime,
    timeout,
  ])
}

async function reviewWithModel(
  ctx: Context,
  request: ApprovalRequest,
  escalation: AssociatedEscalation,
  settings: ApprovalSettings,
  lifetime: AbortSignal,
): Promise<boolean> {
  const reviewer = settings.reviewer
  const requestConfig = request.agent.session.requestHeader()?.config
  const provider = reviewer?.provider ?? requestConfig?.provider
  const model = reviewer?.model ?? requestConfig?.model
  if (provider === undefined || model === undefined) return false
  const reviewerTimeoutMs = reviewer?.timeoutMs
    ?? APPROVE_FOR_ME_DEFAULTS.reviewer.timeoutMs
  const prompt = buildReviewerPrompt({
    reviewerInstructions: settings.rules.reviewerInstructions,
    trustedTranscript: trustedTranscript(request.agent),
    untrustedRequest: {
      toolName: escalation.execution.name,
      command: escalation.command,
      justification: escalation.justification,
      reason: request.reason ?? '',
    },
    limits: settings.limits,
  })
  if (!prompt.ok || prompt.messages.length !== 2) return false
  const persona = prompt.messages[0]
  const userPrompt = prompt.messages[1]
  if (persona?.role !== 'system' || userPrompt?.role !== 'user') return false

  const timeout = new AbortController()
  const timer = setTimeout(() => {
    timeout.abort(new Error('approve-for-me reviewer timed out'))
  }, reviewerTimeoutMs)
  const signal = fusedSignal(escalation.execution, request, lifetime, timeout.signal)
  let run: SubagentRun | undefined
  let allowCandidate = false
  let disposed = false
  try {
    if (signal.aborted) return false
    run = await ctx.subagents.start('spawn', {
      parent: request.agent,
      label: 'approve-for-me reviewer',
      signal,
      persona: persona.content,
      prompt: [{ type: 'text', text: userPrompt.content }],
      agentOptions: {
        provider,
        model,
        maxTokens: REVIEWER_MAX_TOKENS,
        approveForMeReviewer: true,
      },
      toolFilter: { allow: [] },
      outputSchema: REVIEWER_OUTPUT_SCHEMA,
    })
    const result = await run.result
    if (result.stopReason !== 'completed') return false
    allowCandidate = reviewerOutput(result.structured, settings.limits.reviewerOutputChars)?.decision === 'allow'
  } catch {
    return false
  } finally {
    if (run !== undefined) {
      try {
        await run.dispose()
        disposed = true
      } catch {
        disposed = false
      }
    }
    clearTimeout(timer)
  }
  return allowCandidate && disposed && !signal.aborted
}

export function apply(ctx: Context, config: ApprovalSettings = APPROVE_FOR_ME_DEFAULTS): void {
  const base = deepFreeze(toSettingsDocument(validatedBase(config)))
  let settingsSource: () => ApprovalSettings = () => base
  installSettingsSectionCompat(ctx, Config, base, {
    setSource: (current) => {
      settingsSource = current
    },
    onChange: () => {},
    validate: validateSettingsDocument,
  })

  // A pending child fiber never blocks the approval plugin when settings is absent.
  ctx.plugin(ApproveForMeSettingsRemote)

  const executions = new AsyncLocalStorage<ToolDispatchExecution>()
  const lifetime = new AbortController()
  const activeReviews = new Set<Promise<unknown>>()

  ctx.on('tools/execute', (execution, next) => (
    executions.run(execution, () => next())
  ), { prepend: true })

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    if (context.agent?.options.approveForMeReviewer !== true) return assembled
    return { ...assembled, contexts: [] }
  }, { global: true, prepend: true })

  const disposeApproval = ctx.on('approval/request', async (request, next): Promise<ApprovalOutcome> => {
    if (lifetime.signal.aborted) return next()
    let capturedSettings: ApprovalSettings
    let activePreset: boolean
    try {
      capturedSettings = settingsSource()
      activePreset = currentPermissionPreset(ctx, request.agent.session) === 'approve-for-me'
    } catch {
      return next()
    }
    if (!activePreset) return next()
    if (request.signal?.aborted === true) return next()

    let escalation: AssociatedEscalation | undefined
    let settings: ApprovalSettings | undefined
    try {
      escalation = associateEscalation(ctx, executions.getStore(), request)
      const parsed = parseApprovalSettings(capturedSettings)
      if (parsed.ok) settings = parsed.settings
    } catch {
      return next()
    }
    if (escalation === undefined || settings === undefined) return next()

    const risk = detectFixedHighRisk(escalation.command, escalation.tool)
    if (risk.status !== 'safe') return next()
    const rules = evaluateCommandRules(escalation.command, escalation.tool, settings.rules.commandPrefixes)
    if (rules.status !== 'matched') return next()
    if (settings.mode === 'rules-only') return 'allowed-once'

    const review = reviewWithModel(ctx, request, escalation, settings, lifetime.signal)
    activeReviews.add(review)
    let allowed = false
    try {
      allowed = await review
    } catch {
      allowed = false
    } finally {
      activeReviews.delete(review)
    }
    return allowed ? 'allowed-once' : next()
  }, { prepend: true })

  ctx.effect(() => async () => {
    let disposerError: unknown
    try {
      disposeApproval()
    } catch (error: unknown) {
      disposerError = error
    }
    lifetime.abort(new Error('approve-for-me plugin disposed'))
    await Promise.allSettled([...activeReviews])
    if (disposerError !== undefined) throw disposerError
  }, 'approve-for-me review lifecycle')
}
