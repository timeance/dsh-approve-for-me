import { describe, expect, it } from 'vitest'

import {
  createSettingsDraft,
  isReviewerRouteAvailable,
  validateSettingsDraft,
} from '../../src/client/settings-form.ts'
import type { ApproveForMeSettings } from '../../src/client/settings-types.ts'

const CURRENT: ApproveForMeSettings = {
  version: 1,
  mode: 'rules-and-llm',
  rules: {
    commandPrefixes: [{ tool: 'shell', prefix: 'git status' }],
    reviewerInstructions: '',
  },
  reviewer: {
    provider: 'custom-provider',
    model: 'custom-model',
    timeoutMs: 30_000,
  },
  limits: {
    trustedTranscriptChars: 12_000,
    untrustedToolDataChars: 8_000,
    reviewerOutputChars: 2_000,
  },
}

describe('unavailable reviewer route preservation', () => {
  it('allows the exact existing route to survive a temporary catalog miss', () => {
    expect(validateSettingsDraft(createSettingsDraft(CURRENT), [], CURRENT)).toMatchObject({
      provider: undefined,
      model: undefined,
    })
  })

  it('still rejects a changed model that is absent from the catalog', () => {
    const draft = { ...createSettingsDraft(CURRENT), model: 'new-model' }
    const catalog = [{ id: 'custom-provider', name: 'Custom', models: [] }]

    expect(validateSettingsDraft(draft, catalog, CURRENT)).toMatchObject({
      provider: undefined,
      model: 'model-required',
    })
  })

  it('does not let a session-inherited route authorize a new unknown route', () => {
    const inherited: ApproveForMeSettings = {
      ...CURRENT,
      reviewer: { timeoutMs: 30_000 },
    }
    const draft = {
      ...createSettingsDraft(inherited),
      provider: 'missing-provider',
      model: 'missing-model',
    }

    expect(validateSettingsDraft(draft, [], inherited)).toMatchObject({
      provider: 'provider-required',
      model: 'model-required',
    })
  })

  it('reports a preserved route as unavailable without invalidating it', () => {
    const draft = createSettingsDraft(CURRENT)
    const catalog = [{
      id: 'custom-provider',
      name: 'Custom',
      models: [{ id: 'custom-model', name: 'Custom model' }],
    }]

    expect(isReviewerRouteAvailable(draft, [])).toBe(false)
    expect(isReviewerRouteAvailable(draft, catalog)).toBe(true)
  })

  it('does not reactivate a saved route while the catalog is unavailable', () => {
    const inactive: ApproveForMeSettings = {
      ...CURRENT,
      mode: 'rules-only',
    }
    const draft = {
      ...createSettingsDraft(inactive),
      mode: 'rules-and-llm' as const,
    }

    expect(validateSettingsDraft(draft, [], inactive)).toMatchObject({
      provider: 'provider-required',
      model: 'model-required',
    })
  })
})
