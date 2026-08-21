import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
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

  const connection = ctx.get('connection') as unknown as ConnectionHandle
  if (!connection.isLoopback) return
  const controller = new ApproveForMeSettingsController(
    new ApproveForMeSettingsRpc(connection.rpc),
    connection.api.llm,
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
      ctx.remote.$on('settings/document-updated', (namespace) => {
        if (namespace === APPROVE_FOR_ME_SETTINGS_NS) {
          refreshSettingsIfLoaded(controller)
        }
        refreshModelsIfLoaded(controller)
      }),
      ctx.remote.$on('llm/adapters-updated', () => {
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

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: APPROVE_FOR_ME_SETTINGS_NS,
    locale: LOCALE_NS,
    inject: injected,
  }, ApproveForMeSection))
}
