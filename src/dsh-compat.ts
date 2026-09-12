import * as settingsApi from '@deepseek-ai/dsh-settings'
import * as connectionApi from '@deepseek-ai/dsh-client-connection'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import type {
  SettingsNamespace,
  SettingsSectionHooks,
} from '@deepseek-ai/dsh-settings'
import type z from '@deepseek-ai/schemastery'

/** Shared namespace literal accepted by both the legacy and alpha.4 APIs. */
export const APPROVE_FOR_ME_SETTINGS_NAMESPACE = 'approve-for-me' as SettingsNamespace

type LegacyInstallSettingsSection = <T>(
  ctx: Context,
  ns: SettingsNamespace,
  schema: z<T>,
  entry: T,
  hooks: SettingsSectionHooks<T>,
) => void

interface ModernSettingsProvider {
  installSection<T>(
    owner: Context,
    ns: string,
    schema: z<T>,
    entry: T,
    hooks: SettingsSectionHooks<T>,
  ): void
}

/**
 * Select the Settings install path by capability. The legacy export is read
 * from the module namespace so alpha.4 can load without a deleted named
 * import, while older DSH releases retain their original fallback semantics.
 */
export function installSettingsSectionCompat<T>(
  ctx: Context,
  schema: z<T>,
  entry: T,
  hooks: SettingsSectionHooks<T>,
): void {
  const legacy = (settingsApi as unknown as {
    installSettingsSection?: LegacyInstallSettingsSection
  }).installSettingsSection
  if (typeof legacy === 'function') {
    legacy(ctx, APPROVE_FOR_ME_SETTINGS_NAMESPACE, schema, entry, hooks)
    return
  }

  // The Settings service is optional. Injecting here preserves the service's
  // attach/detach lifecycle and leaves the composition entry authoritative
  // while no provider is mounted.
  ctx.inject(['settings'], settingsContext => {
    // Read the injected service through the public store API. The alpha.4
    // property proxy is topology-sensitive while this optional child fiber is
    // loading; `get` retains the same service lifetime without that coupling.
    const settings = (typeof (settingsContext as unknown as { get?: unknown }).get === 'function'
      ? settingsContext.get('settings')
      : (settingsContext as unknown as { settings?: unknown }).settings) as Partial<ModernSettingsProvider> | undefined
    if (typeof settings?.installSection !== 'function') {
      throw new Error('approve-for-me: DSH Settings install API is unavailable')
    }
    settings.installSection(
      ctx,
      APPROVE_FOR_ME_SETTINGS_NAMESPACE,
      schema,
      entry,
      hooks,
    )
  })
}

type SessionSeq = Agent['session']['surface']['nodes'][number]

interface LegacySessionEvents {
  events?: readonly unknown[]
}

interface IndexedSession {
  eventAt(seq: SessionSeq): unknown
}

function indexedSession(session: Agent['session']): session is Agent['session'] & IndexedSession {
  return typeof (session as unknown as { eventAt?: unknown }).eventAt === 'function'
}

function legacySessionEvents(session: Agent['session']): readonly unknown[] {
  const events = (session as unknown as LegacySessionEvents).events
  if (!Array.isArray(events)) {
    throw new Error('approve-for-me: DSH Session event reader is unavailable')
  }
  return events
}

/** Read one surface event without materializing the full alpha.4 log. */
export function sessionEventAt(session: Agent['session'], seq: SessionSeq): unknown {
  if (indexedSession(session)) return session.eventAt(seq)
  return legacySessionEvents(session)[seq as number]
}

/**
 * Call the permission preset service with the argument shape of the active
 * Session API. This avoids using a failed call as version detection.
 */
export function currentPermissionPreset(ctx: Context, session: Agent['session']): string {
  const service = ctx.permissionPresets as unknown as {
    current(input: Agent['session'] | readonly unknown[]): string
  }
  const input = indexedSession(session) ? session : legacySessionEvents(session)
  return service.current(input)
}

interface LegacyRpc {
  handle(
    channel: string,
    handler: ConnectionRpcHandler,
    options: { authority: 'loopback' },
  ): () => Promise<void>
}

interface ModernRpc {
  handle(channel: string, handler: ConnectionRpcHandler): () => Promise<void>
}

interface ConnectionHandle {
  rpc: {
    handle: (...args: unknown[]) => unknown
  }
  /** Public on alpha.1 and later; rc.2 only exposes the RPC registry. */
  fetch?: unknown
}

/** Register a channel using the explicit RPC signature exposed by each DSH line. */
export function registerConnectionRpc(
  ctx: Context,
  channel: string,
  handler: ConnectionRpcHandler,
): () => Promise<void> {
  const connection = ctx.connection as unknown as ConnectionHandle
  // alpha.1+ uses the remote-backed client. Register its two Settings endpoints
  // on the authenticated shared carrier; custom HTTP channels fail on 0.1.5.
  const fetch = connection.fetch as {
    register?: (route: {
      path: string
      methods: string[]
      requestBody: 'buffered'
      fetch(request: Request): Promise<Response>
    }) => () => Promise<void>
  } | undefined
  if (typeof fetch?.register === 'function') {
    const schema = (connectionApi as unknown as {
      clientRequestSchema: { safeParse(value: unknown):
        | { success: false }
        | { success: true; data: { rpcId: string; method: string; payload: unknown } } }
    }).clientRequestSchema
    const disposers = ['describe', 'mutate'].map(endpoint => fetch.register!({
      path: `/api${channel}/${endpoint}`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
          return new Response('content type must be application/json', { status: 415 })
        }
        let body: unknown
        try { body = await request.json() } catch {
          return new Response('body is not JSON', { status: 400 })
        }
        const parsed = schema.safeParse(body)
        if (!parsed.success || parsed.data.method !== `${channel.slice(1)}/${endpoint}`) {
          return new Response('invalid Settings RPC envelope', { status: 400 })
        }
        const result = await handler(endpoint, parsed.data.payload, request.signal)
        return Response.json({ type: 'server-response', rpcId: parsed.data.rpcId, result })
      },
    }))
    return async () => { await Promise.all(disposers.map(dispose => dispose())) }
  }
  const rpc = connection.rpc
  if (typeof rpc.handle !== 'function') {
    throw new Error('approve-for-me: DSH Connection RPC registry is unavailable')
  }

  if (connection.fetch === undefined) {
    return (rpc as unknown as LegacyRpc).handle(channel, handler, { authority: 'loopback' })
  }
  return (rpc as unknown as ModernRpc).handle(channel, handler)
}
