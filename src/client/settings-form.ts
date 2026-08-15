import { parseCommandPrefixRules, serializeCommandPrefixRules } from './rules.ts'
import type { CommandPrefixRuleError } from './rules.ts'
import type {
  ApproveForMeSettings,
  ApprovalReviewMode,
  ReviewerProviderOption,
} from './settings-types.ts'

export const DEFAULT_REVIEWER_TIMEOUT_MS = 30_000

export interface SettingsDraft {
  readonly mode: ApprovalReviewMode
  readonly provider: string
  readonly model: string
  readonly shellRulesText: string
  readonly pwshRulesText: string
  readonly reviewerInstructions: string
}

export interface SettingsDraftErrors {
  readonly provider: 'provider-required' | undefined
  readonly model: 'model-required' | undefined
  readonly shellRules: readonly CommandPrefixRuleError[]
  readonly pwshRules: readonly CommandPrefixRuleError[]
}

export function createSettingsDraft(value: ApproveForMeSettings): SettingsDraft {
  return {
    mode: value.mode,
    provider: value.reviewer?.provider ?? '',
    model: value.reviewer?.model ?? '',
    shellRulesText: serializeCommandPrefixRules(
      value.rules.commandPrefixes
        .filter(rule => rule.tool === 'shell')
        .map(rule => rule.prefix),
    ),
    pwshRulesText: serializeCommandPrefixRules(
      value.rules.commandPrefixes
        .filter(rule => rule.tool === 'pwsh')
        .map(rule => rule.prefix),
    ),
    reviewerInstructions: value.rules.reviewerInstructions,
  }
}

export function validateSettingsDraft(
  draft: SettingsDraft,
  modelGroups: readonly ReviewerProviderOption[],
): SettingsDraftErrors {
  const inheritsRequestRoute = draft.provider === '' && draft.model === ''
  const provider = modelGroups.find(group => group.id === draft.provider)
  const model = provider?.models.find(option => option.id === draft.model)

  return {
    provider: draft.mode === 'rules-and-llm'
      && !inheritsRequestRoute
      && provider === undefined
      ? 'provider-required'
      : undefined,
    model: draft.mode === 'rules-and-llm'
      && !inheritsRequestRoute
      && model === undefined
      ? 'model-required'
      : undefined,
    shellRules: parseCommandPrefixRules(draft.shellRulesText, 'shell').errors,
    pwshRules: parseCommandPrefixRules(draft.pwshRulesText, 'pwsh').errors,
  }
}

/**
 * Build the visible form value while retaining hidden timeout and limits.
 */
export function buildSettingsMutation(
  draft: SettingsDraft,
  current: ApproveForMeSettings,
): ApproveForMeSettings {
  const existingReviewer = current.reviewer
  const shouldPersistReviewer = draft.mode === 'rules-and-llm'
    || existingReviewer !== undefined
  const hasExplicitRoute = draft.provider !== '' && draft.model !== ''

  return {
    version: 1,
    mode: draft.mode,
    rules: {
      commandPrefixes: [
        ...parseCommandPrefixRules(draft.shellRulesText, 'shell').prefixes.map(prefix => ({
          tool: 'shell' as const,
          prefix,
        })),
        ...parseCommandPrefixRules(draft.pwshRulesText, 'pwsh').prefixes.map(prefix => ({
          tool: 'pwsh' as const,
          prefix,
        })),
      ],
      reviewerInstructions: draft.reviewerInstructions.trim(),
    },
    ...(shouldPersistReviewer
      ? {
          reviewer: {
            ...(hasExplicitRoute
              ? { provider: draft.provider, model: draft.model }
              : {}),
            timeoutMs: existingReviewer?.timeoutMs
              ?? DEFAULT_REVIEWER_TIMEOUT_MS,
          },
        }
      : {}),
    limits: current.limits,
  }
}

export function sameEditableSettings(
  left: ApproveForMeSettings,
  right: ApproveForMeSettings,
): boolean {
  const leftReviewer = left.reviewer
  const rightReviewer = right.reviewer
  return left.mode === right.mode
    && left.rules.reviewerInstructions === right.rules.reviewerInstructions
    && left.rules.commandPrefixes.length === right.rules.commandPrefixes.length
    && left.rules.commandPrefixes.every((rule, index) => {
      const candidate = right.rules.commandPrefixes[index]
      return candidate?.tool === rule.tool && candidate.prefix === rule.prefix
    })
    && leftReviewer?.provider === rightReviewer?.provider
    && leftReviewer?.model === rightReviewer?.model
}
