/** Client-safe view exposed by the optional Web settings companion. */
export interface ApproveForMeSettingsNamespaceView {
  readonly ns: 'approve-for-me'
  readonly schema: unknown
  readonly value: unknown
  readonly revision: number
}

export type ApproveForMeSettingsPathOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }

export interface ApproveForMeSettingsDescriptor {
  readonly writable: boolean
  readonly view?: ApproveForMeSettingsNamespaceView
}

export type ApproveForMeSettingsRpcFailure =
  | {
    readonly code: 'bad-request'
    readonly message: string
    readonly details: { readonly issues: [] }
  }
  | {
    readonly code: 'settings-conflict'
    readonly message: string
    readonly details: {
      readonly ns: 'approve-for-me'
      readonly expected: number
      readonly actual: number
    }
  }
  | {
    readonly code: 'settings-rejected'
    readonly message: string
    readonly details: { readonly ns: 'approve-for-me' }
  }

export type ApproveForMeSettingsRpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ApproveForMeSettingsRpcFailure }