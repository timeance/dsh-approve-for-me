import { describe, expect, it } from 'vitest'
import {
  buildSettingsMutation,
  createSettingsDraft,
  sameEditableSettings,
  validateSettingsDraft,
} from '../../src/client/settings-form.ts'
import { parseCommandPrefixRules } from '../../src/client/rules.ts'
import type { ApproveForMeSettings } from '../../src/client/settings-types.ts'

const CURRENT: ApproveForMeSettings = {
  version: 1,
  mode: 'rules-and-llm',
  rules: {
    commandPrefixes: [
      { tool: 'shell', prefix: 'git status' },
      { tool: 'pwsh', prefix: 'Get-Content' },
    ],
    reviewerInstructions: 'Keep the scope narrow.',
  },
  reviewer: {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    timeoutMs: 45_000,
  },
  limits: {
    trustedTranscriptChars: 12_345,
    untrustedToolDataChars: 6_789,
    reviewerOutputChars: 1_500,
  },
}

describe('nested settings form', () => {
  it('splits shell families and round-trips the editable fields', () => {
    expect(createSettingsDraft(CURRENT)).toEqual({
      mode: 'rules-and-llm',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      shellRulesText: 'git status',
      pwshRulesText: 'Get-Content',
      reviewerInstructions: 'Keep the scope narrow.',
    })
  })

  it('ignores blank/comment lines and rejects duplicates or non-literal prefixes', () => {
    const parsed = parseCommandPrefixRules(
      '  # note\n\ngit status\n git diff \ngit status\ncat $HOME',
      'shell',
    )
    expect(parsed.prefixes).toEqual(['git status', 'git diff'])
    expect(parsed.errors).toEqual([
      { code: 'duplicate', line: 5, firstLine: 3 },
      { code: 'invalid-prefix', line: 6, reason: 'substitution-or-expansion' },
    ])
  })

  it('accepts session inheritance and rejects incomplete explicit reviewer routes', () => {
    const draft = createSettingsDraft(CURRENT)
    expect(validateSettingsDraft(draft, [])).toMatchObject({
      provider: 'provider-required',
      model: 'model-required',
    })
    expect(validateSettingsDraft({ ...draft, provider: '', model: '' }, []))
      .toMatchObject({ provider: undefined, model: undefined })
    const catalog = [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-v4-flash', name: 'Flash' }],
    }]
    expect(validateSettingsDraft({ ...draft, model: '' }, catalog))
      .toMatchObject({ provider: undefined, model: 'model-required' })
    expect(validateSettingsDraft({ ...draft, provider: '' }, catalog))
      .toMatchObject({ provider: 'provider-required', model: 'model-required' })
    expect(validateSettingsDraft({ ...draft, mode: 'rules-only' }, []))
      .toMatchObject({ provider: undefined, model: undefined })
  })

  it('normalizes editor rows while preserving timeout and hidden limits', () => {
    const draft = {
      ...createSettingsDraft(CURRENT),
      mode: 'rules-only' as const,
      shellRulesText: '# editor only\ngit diff\n',
      pwshRulesText: '\nGet-ChildItem',
      reviewerInstructions: '  Ask on installs.  ',
    }
    const next = buildSettingsMutation(draft, CURRENT)
    expect(next).toEqual({
      ...CURRENT,
      mode: 'rules-only',
      rules: {
        commandPrefixes: [
          { tool: 'shell', prefix: 'git diff' },
          { tool: 'pwsh', prefix: 'Get-ChildItem' },
        ],
        reviewerInstructions: 'Ask on installs.',
      },
    })
    expect(sameEditableSettings(CURRENT, next)).toBe(false)
    expect(sameEditableSettings(next, { ...next, limits: CURRENT.limits })).toBe(true)
  })

  it('materializes the default hidden timeout when model review is first enabled', () => {
    const { reviewer: _reviewer, ...base } = CURRENT
    const withoutReviewer: ApproveForMeSettings = {
      ...base,
      mode: 'rules-only',
    }
    const draft = {
      ...createSettingsDraft(withoutReviewer),
      mode: 'rules-and-llm' as const,
      provider: 'p',
      model: 'm',
    }
    expect(buildSettingsMutation(draft, withoutReviewer).reviewer).toEqual({
      provider: 'p',
      model: 'm',
      timeoutMs: 30_000,
    })
  })

  it('omits provider and model when switching to the current session route', () => {
    const draft = {
      ...createSettingsDraft(CURRENT),
      provider: '',
      model: '',
    }
    expect(buildSettingsMutation(draft, CURRENT).reviewer).toEqual({
      timeoutMs: 45_000,
    })
  })
})
