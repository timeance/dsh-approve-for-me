import { Context, resolveConfig } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { usesProfileSettings, type SettingsConfig } from '../../src/dsh-compat.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDispatchExecution } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it, vi } from 'vitest'

import { APPROVE_FOR_ME_DEFAULTS } from '../../src/core/defaults.ts'
import type { ApprovalSettings } from '../../src/core/settings.ts'
import * as hostPlugin from '../../src/index.ts'
import { apply } from '../../src/index.ts'

type WaterfallListener = (...args: any[]) => unknown

interface FakeHost {
  approval: WaterfallListener
  cleanup: () => Promise<void>
  ctx: Context
  disposalOrder: string[]
  prompt: WaterfallListener
  start: ReturnType<typeof vi.fn>
  tools: WaterfallListener
}

function settings(
  mode: ApprovalSettings['mode'],
  commandPrefixes: ApprovalSettings['rules']['commandPrefixes'],
): ApprovalSettings {
  return {
    ...APPROVE_FOR_ME_DEFAULTS,
    mode,
    rules: {
      commandPrefixes,
      reviewerInstructions: 'Approve only the exact requested read operation.',
    },
    reviewer: { provider: 'review-provider', model: 'review-model', timeoutMs: 5_000 },
  }
}

function agentWithVisibleInputs(options: {
  agentOptions?: Record<string, unknown>
  requestConfig?: { provider?: string; model?: string } | undefined
  presetOrigin?: 'default' | 'selection' | 'inferred'
  sessionApi?: 'legacy' | 'modern'
} = {}): Agent {
  const events: unknown[] = [
    {
      type: 'user/message',
      data: {
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Inspect repository state.' }],
      },
    },
    {
      type: 'user/message',
      data: {
        source: { kind: 'agent-instructions', form: 'instructions' },
        content: [{ type: 'text', text: 'Do not mutate files.' }],
      },
    },
  ]
  const requestConfig = Object.hasOwn(options, 'requestConfig')
    ? options.requestConfig
    : { provider: 'session-provider', model: 'session-model' }
  if (options.presetOrigin !== undefined) {
    events.push({
      type: 'permission/preset',
      data: { preset: 'approve-for-me', origin: options.presetOrigin },
    })
  }
  const session: Record<string, unknown> = {
    surface: { nodes: [0, 1] },
    requestHeader: () => requestConfig === undefined
      ? undefined
      : { config: requestConfig },
  }
  if (options.sessionApi === 'legacy') {
    session.events = events
  } else {
    session.eventAt = (seq: number) => events[seq]
  }
  return {
    options: options.agentOptions ?? {},
    session,
  } as unknown as Agent
}

function execution(
  agent: Agent,
  callId: string,
  command: string,
  options: { name?: string; requested?: string; signal?: AbortSignal } = {},
): ToolDispatchExecution {
  const requested = options.requested ?? 'danger-full-access'
  return Object.freeze({
    agent,
    callId,
    name: options.name ?? 'bash',
    arguments: Object.freeze({
      command,
      sandbox_permissions: requested,
      justification: `Run ${command} outside the workspace sandbox.`,
    }),
    signal: options.signal ?? new AbortController().signal,
  }) as unknown as ToolDispatchExecution
}

function approvalRequest(exec: ToolDispatchExecution, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const args = exec.arguments as Record<string, unknown>
  const requested = String(args.sandbox_permissions)
  const justification = String(args.justification)
  return {
    agent: exec.agent as Agent,
    callId: exec.callId,
    toolName: exec.name,
    reason: `escalate sandbox to ${requested}: ${justification}`,
    signal: exec.signal,
    ...overrides,
  }
}

function fakeHost(
  config: SettingsConfig<ApprovalSettings>,
  options: {
    currentMode?: string
    preset?: string
    presetApi?: 'legacy' | 'modern'
    settingsPresent?: boolean
    start?: ReturnType<typeof vi.fn>
    stream?: ReturnType<typeof vi.fn>
  } = {},
): FakeHost {
  const listeners = new Map<string, WaterfallListener>()
  const cleanups: Array<() => Promise<void> | void> = []
  const disposalOrder: string[] = []
  const start = options.start ?? vi.fn()
  const ctx = {
    inject: vi.fn((_deps: readonly string[], callback: (context: Context) => void) => {
      if (options.settingsPresent !== false) callback(ctx as unknown as Context)
    }),
    plugin: vi.fn(),
    get: (name: string) => (ctx as unknown as Record<string, unknown>)[name],
    on: vi.fn((event: string, listener: WaterfallListener) => {
      listeners.set(event, listener)
      return vi.fn(() => {
        if (event === 'approval/request') disposalOrder.push('approval-listener')
      })
    }),
    effect: vi.fn((factory: () => (() => Promise<void> | void)) => {
      cleanups.push(factory())
      return vi.fn()
    }),
    settings: options.settingsPresent === false ? undefined : {
      configure: vi.fn(),
      register: (_namespace: string, _schema: unknown, options: { base: ApprovalSettings }) => ({
        get: () => options.base,
        watch: () => () => {},
      }),
      installSection: (
        _owner: unknown,
        _namespace: string,
        _schema: unknown,
        entry: ApprovalSettings,
        hooks: {
          setSource: (current: () => ApprovalSettings) => void
          onChange: () => void
        },
      ) => {
        hooks.setSource(() => entry)
        hooks.onChange()
      },
    },
    permissionPresets: {
      current: vi.fn((input: unknown) => {
        if (options.presetApi === 'legacy') {
          if (!Array.isArray(input)) throw new Error('expected legacy session events')
        } else if (
          typeof input !== 'object'
          || input === null
          || typeof (input as { eventAt?: unknown }).eventAt !== 'function'
        ) {
          throw new Error('expected alpha.4 session')
        }
        return options.preset ?? 'approve-for-me'
      }),
    },
    sandboxPolicy: {
      resolve: vi.fn(() => ({ mode: options.currentMode ?? 'workspace-write' })),
    },
    subagents: options.stream ? {} : { start },
    llm: { stream: options.stream },
  } as unknown as Context
  apply(ctx, config)
  return {
    approval: listeners.get('approval/request')!,
    cleanup: async () => {
      await cleanups.at(-1)?.()
      disposalOrder.push('drained')
    },
    ctx,
    disposalOrder,
    prompt: listeners.get('system-prompt/assemble')!,
    start,
    tools: listeners.get('tools/execute')!,
  }
}

async function decide(
  host: FakeHost,
  exec: ToolDispatchExecution,
  request: ApprovalRequest = approvalRequest(exec),
  native = vi.fn<() => Promise<ApprovalOutcome>>().mockResolvedValue('rejected'),
): Promise<ApprovalOutcome> {
  return await host.tools(exec, async () => host.approval(request, native)) as ApprovalOutcome
}

describe('approve-for-me Host integration', () => {
  it('keeps Loader metadata on the namespace export', () => {
    expect('default' in hostPlugin).toBe(false)
    expect(hostPlugin).toMatchObject({
      name: 'approve-for-me',
      Config: expect.any(Function),
      apply: expect.any(Function),
    })
    expect(hostPlugin.inject).toContain('approval')
    expect(hostPlugin.inject).not.toContain('settings')
    expect(hostPlugin.inject).not.toContain('connection')
  })

  it('starts the optional settings Remote as a child without widening core injects', () => {
    const host = fakeHost(settings('rules-only', []))
    expect(host.ctx.plugin).toHaveBeenCalledWith(hostPlugin.ApproveForMeSettingsRemote)
  })

  it('keeps static settings active when the optional Settings service is absent', async () => {
    const host = fakeHost(
      settings('rules-only', [{ tool: 'shell', prefix: 'git status' }]),
      { settingsPresent: false },
    )
    const agent = agentWithVisibleInputs()

    await expect(decide(host, execution(agent, 'call-static-settings', 'git status')))
      .resolves.toBe('allowed-once')
    expect(host.ctx.inject).toHaveBeenCalledWith(['settings'], expect.any(Function))
  })

  it('allows a fully matched low-risk rules-only bash request without a reviewer call', async () => {
    const host = fakeHost(settings('rules-only', [{ tool: 'shell', prefix: 'git status' }]))
    const agent = agentWithVisibleInputs()
    const native = vi.fn<() => Promise<ApprovalOutcome>>().mockResolvedValue('rejected')

    await expect(decide(host, execution(agent, 'call-1', 'git status --short'), undefined, native))
      .resolves.toBe('allowed-once')
    expect(host.ctx.permissionPresets.current).toHaveBeenCalledWith(agent.session)
    expect(native).not.toHaveBeenCalled()
    expect(host.start).not.toHaveBeenCalled()
  })

  it.each(['default', 'selection', 'inferred'] as const)(
    'keeps legacy permission/preset origin %s transparent to preset lookup',
    async origin => {
      const host = fakeHost(
        settings('rules-only', [{ tool: 'shell', prefix: 'git status' }]),
        { presetApi: 'legacy' },
      )
      const agent = agentWithVisibleInputs({ presetOrigin: origin, sessionApi: 'legacy' })

      await expect(decide(host, execution(agent, `call-origin-${origin}`, 'git status')))
        .resolves.toBe('allowed-once')
      expect(host.ctx.permissionPresets.current).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'permission/preset',
            data: { preset: 'approve-for-me', origin },
          }),
        ]),
      )
    },
  )

  it('does not auto-approve persistent pwsh calls without one-shot escalation fields', async () => {
    const host = fakeHost(settings('rules-only', [{ tool: 'pwsh', prefix: 'Get-Content' }]))
    const agent = agentWithVisibleInputs()
    const signal = new AbortController().signal
    const persistent = Object.freeze({
      agent,
      callId: 'persistent-pwsh-call',
      name: 'pwsh',
      arguments: Object.freeze({
        command: 'Get-Content README.md',
        description: 'Read the README file',
      }),
      signal,
    }) as unknown as ToolDispatchExecution
    const request: ApprovalRequest = {
      agent,
      callId: persistent.callId,
      toolName: persistent.name,
      signal,
    }
    const native = vi.fn<() => Promise<ApprovalOutcome>>().mockResolvedValue('rejected')

    await expect(decide(host, persistent, request, native)).resolves.toBe('rejected')
    expect(native).toHaveBeenCalledOnce()
    expect(host.start).not.toHaveBeenCalled()
  })

  it('delegates when the preset or exact execution association does not match', async () => {
    const config = settings('rules-only', [{ tool: 'shell', prefix: 'git status' }])
    const wrongPreset = fakeHost(config, { preset: 'workspace-write' })
    const agent = agentWithVisibleInputs()
    const exec = execution(agent, 'call-1', 'git status')
    await expect(decide(wrongPreset, exec)).resolves.toBe('rejected')

    const host = fakeHost(config)
    await expect(host.approval(approvalRequest(exec), async () => 'rejected'))
      .resolves.toBe('rejected')
    await expect(decide(host, exec, approvalRequest(exec, { callId: 'another-call' as never })))
      .resolves.toBe('rejected')
  })

  it('runs fixed high-risk detection before an otherwise matching allow rule', async () => {
    const host = fakeHost(settings('rules-only', [{ tool: 'shell', prefix: 'git push' }]))
    const agent = agentWithVisibleInputs()

    await expect(decide(host, execution(agent, 'call-risk', 'git push origin main')))
      .resolves.toBe('rejected')
    expect(host.start).not.toHaveBeenCalled()
  })

  it.each([
    {
      tool: 'shell', prefix: 'find .', command: 'find . -delete', name: 'bash',
    },
    {
      tool: 'shell', prefix: 'pnpm', command: 'pnpm test', name: 'bash',
    },
    {
      tool: 'pwsh', prefix: 'Get-Content', command: 'Get-Content -Path:Env:DEEPSEEK_API_KEY', name: 'pwsh',
    },
    {
      tool: 'shell', prefix: 'apt', command: 'apt purge package', name: 'bash',
    },
    {
      tool: 'shell', prefix: 'npm audit', command: 'npm audit', name: 'bash',
    },
    {
      tool: 'pwsh', prefix: 'Stop-Process', command: 'Stop-Process -Name dsh', name: 'pwsh',
    },
    {
      tool: 'pwsh', prefix: 'md', command: 'md newdir', name: 'pwsh',
    },
  ] as const)('delegates a matching $command fixed-risk request', async ({ tool, prefix, command, name }) => {
    const host = fakeHost(settings('rules-only', [{ tool, prefix }]))
    const agent = agentWithVisibleInputs()
    const native = vi.fn<() => Promise<ApprovalOutcome>>().mockResolvedValue('rejected')

    await expect(decide(
      host,
      execution(agent, 'call-risk-regression', command, { name }),
      undefined,
      native,
    )).resolves.toBe('rejected')
    expect(native).toHaveBeenCalledOnce()
    expect(host.start).not.toHaveBeenCalled()
  })

  it('uses an explicit reviewer route over the session header and agent options without tools', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined)
    const start = vi.fn().mockResolvedValue({
      id: 'review-run',
      localAgent: undefined,
      result: Promise.resolve({
        output: [],
        stopReason: 'completed',
        structured: { decision: 'allow', rationale: 'Read-only inspection.' },
      }),
      dispose,
    })
    const host = fakeHost(
      settings('rules-and-llm', [{ tool: 'shell', prefix: 'git status' }]),
      { start },
    )
    const agent = agentWithVisibleInputs({
      agentOptions: { provider: 'options-provider', model: 'options-model' },
    })

    await expect(decide(host, execution(agent, 'call-review', 'git status --short')))
      .resolves.toBe('allowed-once')
    expect(dispose).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledOnce()
    const [provider, request] = start.mock.calls[0]!
    expect(provider).toBe('spawn')
    expect(request.agentOptions).toEqual({
      provider: 'review-provider',
      model: 'review-model',
      maxTokens: 1_024,
      approveForMeReviewer: true,
    })
    expect(request.toolFilter).toEqual({ allow: [] })
    expect(request.outputSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        decision: { type: 'string', enum: ['allow', 'deny', 'escalate'] },
        rationale: { type: 'string' },
      },
      required: ['decision'],
    })
    expect(request.persona).toContain('sandbox-widening request')
    expect(request.prompt[0].text).toContain('Inspect repository state.')
    expect(request.prompt[0].text).toContain('Do not mutate files.')
  })

  it('inherits the reviewer route from the request header instead of agent options', async () => {
    const start = vi.fn().mockResolvedValue({
      id: 'review-run',
      localAgent: undefined,
      result: Promise.resolve({
        output: [],
        stopReason: 'completed',
        structured: { decision: 'allow' },
      }),
      dispose: vi.fn().mockResolvedValue(undefined),
    })
    const config = settings('rules-and-llm', [{ tool: 'shell', prefix: 'git status' }])
    config.reviewer = { timeoutMs: 5_000 }
    const host = fakeHost(config, { start })
    const agent = agentWithVisibleInputs({
      agentOptions: { provider: 'options-provider', model: 'options-model' },
      requestConfig: { provider: 'header-provider', model: 'header-model' },
    })

    await expect(decide(host, execution(agent, 'call-inherit', 'git status --short')))
      .resolves.toBe('allowed-once')
    expect(start).toHaveBeenCalledOnce()
    expect(start.mock.calls[0]?.[1]).toMatchObject({
      agentOptions: {
        provider: 'header-provider',
        model: 'header-model',
        maxTokens: 1_024,
        approveForMeReviewer: true,
      },
      toolFilter: { allow: [] },
    })
  })

  it.each([
    ['missing', undefined],
    ['provider-only', { provider: 'header-provider' }],
    ['model-only', { model: 'header-model' }],
  ] as const)('delegates to native approval when the request header route is %s', async (_case, requestConfig) => {
    const start = vi.fn()
    const config = settings('rules-and-llm', [{ tool: 'shell', prefix: 'git status' }])
    config.reviewer = { timeoutMs: 5_000 }
    const host = fakeHost(config, { start })
    const agent = agentWithVisibleInputs({
      agentOptions: { provider: 'options-provider', model: 'options-model' },
      requestConfig,
    })
    const native = vi.fn<() => Promise<ApprovalOutcome>>().mockResolvedValue('rejected')

    await expect(decide(
      host,
      execution(agent, 'call-no-route', 'git status'),
      undefined,
      native,
    )).resolves.toBe('rejected')
    expect(start).not.toHaveBeenCalled()
    expect(native).toHaveBeenCalledOnce()
  })

  it.each([
    [{ decision: 'deny', rationale: 'Needs a human.' }, false],
    [{ decision: 'allow', extra: true }, false],
    [undefined, false],
  ])('delegates malformed or non-allow reviewer output %#', async (structured, _expected) => {
    const start = vi.fn().mockResolvedValue({
      id: 'review-run',
      localAgent: undefined,
      result: Promise.resolve({ output: [], stopReason: 'completed', structured }),
      dispose: vi.fn().mockResolvedValue(undefined),
    })
    const host = fakeHost(
      settings('rules-and-llm', [{ tool: 'shell', prefix: 'git status' }]),
      { start },
    )
    await expect(decide(host, execution(agentWithVisibleInputs(), 'call-review', 'git status')))
      .resolves.toBe('rejected')
  })

  it('delegates an allow verdict when reviewer disposal fails', async () => {
    const start = vi.fn().mockResolvedValue({
      id: 'review-run',
      localAgent: undefined,
      result: Promise.resolve({
        output: [],
        stopReason: 'completed',
        structured: { decision: 'allow' },
      }),
      dispose: vi.fn().mockRejectedValue(new Error('cleanup failed')),
    })
    const host = fakeHost(
      settings('rules-and-llm', [{ tool: 'shell', prefix: 'git status' }]),
      { start },
    )
    await expect(decide(host, execution(agentWithVisibleInputs(), 'call-review', 'git status')))
      .resolves.toBe('rejected')
  })

  it('keeps concurrent approval requests correlated to their own tool dispatch', async () => {
    const host = fakeHost(settings('rules-only', [
      { tool: 'shell', prefix: 'git status' },
      { tool: 'shell', prefix: 'git diff' },
    ]))
    const agent = agentWithVisibleInputs()
    const first = execution(agent, 'call-a', 'git status')
    const second = execution(agent, 'call-b', 'git diff --stat')
    const releaseFirst = Promise.withResolvers<void>()

    const firstDecision = host.tools(first, async () => {
      await releaseFirst.promise
      return host.approval(approvalRequest(first), async () => 'rejected')
    })
    const secondDecision = host.tools(second, async () => {
      const result = await host.approval(approvalRequest(second), async () => 'rejected')
      releaseFirst.resolve()
      return result
    })

    await expect(Promise.all([firstDecision, secondDecision]))
      .resolves.toEqual(['allowed-once', 'allowed-once'])
  })

  it('removes runtime contexts only from marked reviewer prompt assemblies', async () => {
    const host = fakeHost(settings('rules-only', []))
    const assembly = {
      sections: [{ name: 'persona', text: 'reviewer' }],
      contexts: [{ name: 'workspace', text: 'secret runtime context' }],
      tools: [],
      variables: {},
    }
    const reviewer = { options: { approveForMeReviewer: true } }
    const ordinary = { options: {} }

    await expect(host.prompt(assembly, { agent: reviewer }, async () => assembly))
      .resolves.toEqual({ ...assembly, contexts: [] })
    await expect(host.prompt(assembly, { agent: ordinary }, async () => assembly))
      .resolves.toBe(assembly)
  })

  it('disposes the approval listener, aborts active review, and drains it before cleanup settles', async () => {
    const disposeStarted = Promise.withResolvers<void>()
    const releaseDispose = Promise.withResolvers<void>()
    const start = vi.fn().mockImplementation(async (_provider: string, request: { signal: AbortSignal }) => ({
      id: 'review-run',
      localAgent: undefined,
      result: new Promise(resolve => {
        request.signal.addEventListener('abort', () => {
          resolve({ output: [], stopReason: 'aborted' })
        }, { once: true })
      }),
      dispose: vi.fn(async () => {
        disposeStarted.resolve()
        await releaseDispose.promise
      }),
    }))
    const host = fakeHost(
      settings('rules-and-llm', [{ tool: 'shell', prefix: 'git status' }]),
      { start },
    )
    const exec = execution(agentWithVisibleInputs(), 'call-review', 'git status')
    const pendingDecision = decide(host, exec)
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())

    let cleanupSettled = false
    const cleanup = host.cleanup().then(() => { cleanupSettled = true })
    await disposeStarted.promise
    expect(cleanupSettled).toBe(false)
    expect(host.disposalOrder[0]).toBe('approval-listener')
    releaseDispose.resolve()
    await cleanup
    await expect(pendingDecision).resolves.toBe('rejected')

    const stale = host.approval(approvalRequest(exec), async () => 'rejected')
    await expect(stale).resolves.toBe('rejected')
    expect(start).toHaveBeenCalledOnce()
  })
})


describe('modern reviewer stream', () => {
  const text = { type: 'text-delta', index: 0, text: '{"decision":"allow"}' }
  const finish = { type: 'finish', reason: { kind: 'stop' } }
  function streamOf(chunks: unknown[]) {
    return vi.fn(async function* (_options: unknown) { yield* chunks })
  }
  it('completes through the published LlmRuntime with a local tool-free adapter', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime).await()
    const received = vi.fn()
    class ReviewerAdapter extends LlmAdapter {
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        received(options)
        yield { type: 'text-delta', index: 0, text: '{"decision":"allow"}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const owner = ctx.plugin({
      inject: ['llm'],
      apply(scope) { scope.llm.registerAdapter(['review-provider'], new ReviewerAdapter()) },
    })
    try {
      await owner.await()
      const stream = vi.fn((options: GenerateOptions) => ctx.get('llm')!.stream(options))
      const host = fakeHost(settings('rules-and-llm', [{ tool: 'shell', prefix: 'git status' }]), { stream })
      await expect(decide(host, execution(agentWithVisibleInputs(), 'real-llm', 'git status'))).resolves.toBe('allowed-once')
      expect(received).toHaveBeenCalledOnce()
      expect(received.mock.calls[0]?.[0]).toMatchObject({ tools: [], maxTokens: 1024 })
      await host.cleanup()
    } finally {
      await ctx.fiber.dispose()
    }
  })
  it('uses a single isolated call with no tools and explicit model routing', async () => {
    const stream = streamOf([text, finish])
    const host = fakeHost(settings('rules-and-llm', [{ tool: 'shell', prefix: 'git status' }]), { stream })
    await expect(decide(host, execution(agentWithVisibleInputs(), 'modern-allow', 'git status'))).resolves.toBe('allowed-once')
    expect(stream).toHaveBeenCalledOnce()
    expect(stream.mock.calls[0]?.[0]).toMatchObject({
      provider: 'review-provider', model: 'review-model', tools: [], maxTokens: 1024,
      system: expect.stringContaining('sandbox-widening request'),
      messages: [{ role: 'user', content: [{ type: 'text', text: expect.stringContaining('Inspect repository state.') }] }],
    })
    expect(host.start).not.toHaveBeenCalled()
  })
  it.each([
    ['missing terminal', [text]],
    ['truncated', [text, { type: 'finish', reason: { kind: 'max-tokens' } }]],
    ['after terminal', [text, finish, text]],
    ['invalid JSON', [{ ...text, text: 'allow' }, finish]],
    ['extra fields', [{ ...text, text: '{"decision":"allow","extra":true}' }, finish]],
    ['oversized output', [{ ...text, text: ' '.repeat(100001) }, finish]],
    ['tool request', [{ type: 'block-start', index: 1, blockType: 'tool-call' }, text, finish]],
    ['multiple text blocks', [text, { ...text, index: 1 }, finish]],
    ['deny', [{ ...text, text: '{"decision":"deny"}' }, finish]],
  ])('falls back to human approval for %s', async (_label, chunks) => {
    const host = fakeHost(settings('rules-and-llm', [{ tool: 'shell', prefix: 'git status' }]), { stream: streamOf(chunks) })
    await expect(decide(host, execution(agentWithVisibleInputs(), 'modern-invalid', 'git status'))).resolves.toBe('rejected')
  })
  it('aborts pending streams on plugin disposal and drains the review', async () => {
    let begin!: () => void
    const started = new Promise<void>(resolve => { begin = resolve })
    const stream = vi.fn(async function* (options: { signal: AbortSignal }) {
      begin()
      await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true }))
      yield text
      yield finish
    })
    const host = fakeHost(settings('rules-and-llm', [{ tool: 'shell', prefix: 'git status' }]), { stream })
    const review = decide(host, execution(agentWithVisibleInputs(), 'modern-dispose', 'git status'))
    await started
    await host.cleanup()
    await expect(review).resolves.toBe('rejected')
  })
})

it.runIf(usesProfileSettings)('keeps the real Loader volatile Config live without restarting the approval consumer', async () => {
  const ctx = new Context()
  await ctx.plugin(Loader).await()
  let host!: FakeHost
  const mount = vi.fn(function (_scope: Context, config: SettingsConfig<ApprovalSettings>) {
    host = fakeHost(config)
  })
  ctx.loader.builtins['approval-test'] = { name: 'approve-for-me', Config: hostPlugin.Config, apply: mount }
  const initial = settings('rules-only', [{ tool: 'shell', prefix: 'git status' }])
  const options = { id: 'approve-for-me', name: 'cordis:approval-test', config: initial }
  const id = await ctx.loader.create(options)
  const entry = ctx.loader.resolve(id)
  try {
    await entry.fiber!.await()
    const exec = () => execution(agentWithVisibleInputs(), 'volatile-settings', 'git status')
    await expect(decide(host, exec())).resolves.toBe('allowed-once')
    const next = settings('rules-only', [])
    // Same resolve/update sequence used by profile reconciliation in DSH.
    resolveConfig(entry.fiber!.runtime!, next)
    await entry.update({ config: next })
    await entry.fiber!.await()
    expect(mount).toHaveBeenCalledOnce()
    await expect(decide(host, exec())).resolves.toBe('rejected')
    expect(initial.rules.commandPrefixes).toHaveLength(1)
  } finally {
    await entry.fiber!.dispose()
    await ctx.fiber.dispose()
  }
})
