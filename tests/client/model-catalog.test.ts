import { describe, expect, it, vi } from 'vitest'

import {
  legacyModelCatalogSource,
  sessionModelCatalogSource,
} from '../../src/client/model-catalog.ts'

const catalog = {
  groups: [{ id: 'deepseek', name: 'DeepSeek', models: [] }],
  failures: [],
}

describe('DSH model catalog adapters', () => {
  it('unwraps the rc.2 API proxy envelope', async () => {
    const models = vi.fn(() => Promise.resolve({
      result: { ok: true as const, value: catalog },
    }))

    await expect(legacyModelCatalogSource({ models }).load()).resolves.toEqual({
      ok: true,
      value: catalog,
    })
    expect(models).toHaveBeenCalledWith({})
  })

  it('uses the alpha.1 session Remote result directly', async () => {
    const modelCatalog = vi.fn(() => Promise.resolve({
      ok: true as const,
      value: catalog,
    }))

    await expect(sessionModelCatalogSource({ modelCatalog }).load()).resolves.toEqual({
      ok: true,
      value: catalog,
    })
    expect(modelCatalog).toHaveBeenCalledWith()
  })
})
