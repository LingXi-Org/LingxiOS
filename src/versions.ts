import { AGENT_OS_PROTOCOL_VERSION, KERNEL_PROTOCOL_VERSION } from './protocol/constants.js'

/** Release compatibility identifiers; a matching number does not replace startup checks. */
export const releaseVersions = Object.freeze({
  runtime: '3.6.0',
  controlPlane: AGENT_OS_PROTOCOL_VERSION,
  kernel: KERNEL_PROTOCOL_VERSION,
  schema: 14,
  assistantMessage: 2,
  /** Maximum readable public text event version; producer opt-in is separate. */
  publicText: 2,
} as const)
