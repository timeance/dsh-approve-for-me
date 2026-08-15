export type ApprovalReviewMode = 'rules-only' | 'rules-and-llm'
export type ApprovalRuleTool = 'shell' | 'pwsh'

export interface ApprovalCommandPrefix {
  readonly tool: ApprovalRuleTool
  readonly prefix: string
}

export interface ApprovalReviewerSettings {
  readonly provider?: string
  readonly model?: string
  readonly timeoutMs: number
}

export interface ApprovalReviewLimits {
  readonly trustedTranscriptChars: number
  readonly untrustedToolDataChars: number
  readonly reviewerOutputChars: number
}

export interface ApproveForMeSettings {
  readonly version: 1
  readonly mode: ApprovalReviewMode
  readonly rules: {
    readonly commandPrefixes: readonly ApprovalCommandPrefix[]
    readonly reviewerInstructions: string
  }
  readonly reviewer?: ApprovalReviewerSettings
  readonly limits: ApprovalReviewLimits
}

export interface ReviewerModelOption {
  readonly id: string
  readonly name: string
  readonly description?: string
}

export interface ReviewerProviderOption {
  readonly id: string
  readonly name: string
  readonly models: readonly ReviewerModelOption[]
}

export interface ApproveForMeSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'saving' | 'resetting' | 'unavailable' | 'error'
  error: string | null
  writable: boolean
  revision: number | undefined
  value: ApproveForMeSettings | undefined
  modelsStatus: 'idle' | 'loading' | 'ready' | 'error'
  modelsError: string | null
  modelGroups: readonly ReviewerProviderOption[]
  modelFailures: readonly string[]
}
