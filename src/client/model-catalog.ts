/** Model-catalog value shared by the rc.2 API and alpha.1 Session Remote. */
export interface ModelCatalog {
  readonly groups: readonly {
    readonly id: string
    readonly name: string
    readonly models: readonly {
      readonly id: string
      readonly name: string
      readonly description?: string
    }[]
  }[]
  readonly failures: readonly {
    readonly id: string
    readonly name: string
    readonly message: string
  }[]
}

export type ModelCatalogResult =
  | { readonly ok: true; readonly value: ModelCatalog }
  | {
    readonly ok: false
    readonly error: { readonly code: string; readonly message: string }
  }

/** Version-neutral model-catalog reader used by the controller. */
export interface ModelCatalogSource {
  load(): Promise<ModelCatalogResult>
}

/** Structural face of the legacy rc.2 `connection.api.llm` service. */
export interface LegacyModelCatalogApi {
  models(request: Record<string, never>): Promise<{
    readonly result: ModelCatalogResult
  }>
}

/** Structural face of the alpha.1 `ctx.remote.session` service. */
export interface SessionModelCatalogRemote {
  modelCatalog(): Promise<ModelCatalogResult>
}

export function legacyModelCatalogSource(api: LegacyModelCatalogApi): ModelCatalogSource {
  return {
    async load() {
      return (await api.models({})).result
    },
  }
}

export function sessionModelCatalogSource(remote: SessionModelCatalogRemote): ModelCatalogSource {
  return {
    load: () => remote.modelCatalog(),
  }
}
