import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { ApproveForMeSection } from './ApproveForMeSection.tsx'
import type { ApproveForMeSectionInjected } from './ApproveForMeSection.tsx'
import {
  APPROVE_FOR_ME_SETTINGS_NS,
  ApproveForMeSettingsController,
  refreshAllIfLoaded,
  refreshModelsIfLoaded,
  refreshSettingsIfLoaded,
} from './settings-controller.ts'
import { en, zh, type SettingsLocaleKey } from './settings-locale.ts'
import { ApproveForMeSettingsRpc } from './settings-rpc.ts'
import {
  legacyModelCatalogSource,
  sessionModelCatalogSource,
  type LegacyModelCatalogApi,
  type ModelCatalogSource,
  type SessionModelCatalogRemote,
} from './model-catalog.ts'

export type {
  ApproveForMeSectionInjected,
  ApproveForMeSectionProps,
} from './ApproveForMeSection.tsx'
export {
  APPROVE_FOR_ME_SETTINGS_NS,
  ApproveForMeSettingsController,
  refreshAllIfLoaded,
  refreshModelsIfLoaded,
  refreshSettingsIfLoaded,
  settingsMutationOps,
  settingsValueOf,
} from './settings-controller.ts'
export {
  buildSettingsMutation,
  createSettingsDraft,
  sameEditableSettings,
  validateSettingsDraft,
} from './settings-form.ts'
export type {
  ApproveForMeSettings,
  ApproveForMeSettingsState,
  ApprovalReviewMode,
  ReviewerModelOption,
  ReviewerProviderOption,
} from './settings-types.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.approve-for-me': SettingsLocaleKey
  }
}

const LOCALE_NS = 'settings.approve-for-me'

/** Required browser services. */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsSchema']

/** Register the settings section and keep its Host data current. */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register(LOCALE_NS, { zh, en }),
    'approve-for-me: settings dictionaries',
  )

  const connection = ctx.get('connection') as unknown as CompatibleConnection
  if (!connection.isLoopback) return

  if (connection.api !== undefined) {
    mountSettings(ctx, connection, legacyModelCatalogSource(connection.api.llm))
    return
  }

  ctx.inject(['remote.session'], (scope) => {
    const remote = (scope.remote as unknown as { session: SessionModelCatalogRemote }).session
    mountSettings(scope, connection, sessionModelCatalogSource(remote))
  })
}

type CompatibleConnection = Pick<ConnectionHandle, 'isLoopback' | 'rpc'> & {
  readonly api?: { readonly llm: LegacyModelCatalogApi }
}

interface CompatibleRemoteEvents {
  $on(
    event: 'settings/document-updated',
    listener: (namespace: string, revision?: number) => void,
  ): () => void
  $on(event: 'llm/adapters-updated', listener: () => void): () => void
}

function mountSettings(
  ctx: ClientContext,
  connection: CompatibleConnection,
  models: ModelCatalogSource,
): void {
  const slots = (ctx as unknown as { slots: any }).slots
  const remoteEvents = ctx.remote as unknown as CompatibleRemoteEvents
  const controller = new ApproveForMeSettingsController(
    new ApproveForMeSettingsRpc(connection.rpc),
    models,
    ctx.settingsSchema,
  )
  const injected = (): ApproveForMeSectionInjected => ({
    hooks: { approveForMe: controller.store },
    load: () => controller.load(),
    save: settings => controller.save(settings),
    reset: () => controller.reset(),
  })

  ctx.effect(() => {
    const disposers = [
      remoteEvents.$on('settings/document-updated', (namespace) => {
        if (namespace === APPROVE_FOR_ME_SETTINGS_NS) {
          refreshSettingsIfLoaded(controller)
        }
        refreshModelsIfLoaded(controller)
      }),
      remoteEvents.$on('llm/adapters-updated', () => {
        refreshModelsIfLoaded(controller)
      }),
      ctx.on('connection/reset', () => {
        refreshAllIfLoaded(controller)
      }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
      controller.dispose()
    }
  }, 'approve-for-me: settings invalidations')

  slots.inject('settings.plugin.item', () => slots.register({
    name: 'settings.plugin.item',
    key: APPROVE_FOR_ME_SETTINGS_NS,
    locale: LOCALE_NS,
    inject: injected,
  }, ApproveForMeSection))
}
