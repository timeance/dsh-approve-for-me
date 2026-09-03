import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'

import type {
  ApproveForMeSettingsDescriptor,
  ApproveForMeSettingsPathOp,
  ApproveForMeSettingsRpcResult,
} from '../settings-remote-types.ts'

const RPC_CHANNEL = '/approve-for-me'

/** Browser adapter for the companion's authenticated Connection RPC channel. */
export class ApproveForMeSettingsRpc {
  constructor(private readonly rpc: ConnectionHandle['rpc']) {}

  describe(): Promise<ApproveForMeSettingsRpcResult<ApproveForMeSettingsDescriptor>> {
    return this.rpc.call(RPC_CHANNEL, 'describe', {}) as
      Promise<ApproveForMeSettingsRpcResult<ApproveForMeSettingsDescriptor>>
  }

  mutate(
    ops: readonly ApproveForMeSettingsPathOp[],
    expectedRevision?: number,
  ): Promise<ApproveForMeSettingsRpcResult<ApproveForMeSettingsDescriptor>> {
    const payload = expectedRevision === undefined
      ? { ops }
      : { ops, expectedRevision }
    return this.rpc.call(RPC_CHANNEL, 'mutate', payload) as
      Promise<ApproveForMeSettingsRpcResult<ApproveForMeSettingsDescriptor>>
  }
}
