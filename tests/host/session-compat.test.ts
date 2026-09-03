import { Context } from '@deepseek-ai/cordis'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionStore, { SessionId, type Session, type UserMessage } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'

import {
  currentPermissionPreset,
  sessionEventAt,
} from '../../src/dsh-compat.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.provide('shell', {
    sandboxMode: 'workspace-write',
    resolve() {
      throw new Error('permission compatibility tests do not execute commands')
    },
    run() {
      throw new Error('permission compatibility tests do not execute commands')
    },
    start() {
      throw new Error('permission compatibility tests do not execute commands')
    },
  })
  await ctx.plugin(ApprovalService)
  await ctx.plugin(PermissionPresetService, {})
  return ctx
}

function current(ctx: Context, session: Session): string {
  return currentPermissionPreset(
    ctx,
    session as Parameters<typeof currentPermissionPreset>[1],
  )
}

describe('DSH session compatibility', () => {
  it('reads one real surface event through alpha.4 eventAt', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('event-at'))
    const message = {
      id: 'event-message',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Inspect repository state.' }],
    } as unknown as UserMessage
    const appended = session.append(
      'user/message',
      message,
      { surfaceOp: 'append' },
    )

    expect(sessionEventAt(
      session as Parameters<typeof sessionEventAt>[0],
      appended.seq,
    )).toBe(appended)
  })

  it('uses the real permission projection for new, switched, restored, and forked sessions', async () => {
    const ctx = await setup()
    const original = ctx.sessions.create(SessionId('permission-original'))
    expect(current(ctx, original)).toBe('workspace-write')

    ctx.permissionPresets.set(original, 'danger-full-access')
    expect(current(ctx, original)).toBe('danger-full-access')

    const restored = ctx.sessions.create(SessionId('permission-restored'), {
      seed: original.snapshotEvents(),
    })
    expect(current(ctx, restored)).toBe('danger-full-access')

    const forked = ctx.sessions.fork(original, undefined, SessionId('permission-forked'))
    expect(current(ctx, forked)).toBe('danger-full-access')
  })

  it('returns the framework custom preset for a non-target permission bundle', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('permission-custom'))
    session.append('sandbox/mode', { mode: 'read-only' })

    expect(current(ctx, session)).toBe('custom')
  })
})
