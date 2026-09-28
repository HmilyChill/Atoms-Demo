/**
 * LLM 适配器契约（I-07）——LLM 调用的唯一出口。
 *
 * 不变式（docs/03 §13.2）：
 *  1. 上层不得出现任何 provider 名称的分支判断
 *  2. Mock 与真实 provider 输出同构
 *  3. 每次调用都必须返回用量与耗时（供配额熔断与可观测使用）
 */

export type AgentRoleName =
  | 'planner'
  | 'pm'
  | 'architect'
  | 'engineer'
  | 'verifier'
  | 'repair'
  | 'iterate'

/** 期望产出类型：决定 Mock 走哪条确定性分支，也用于真实 provider 的输出约束 */
export type LlmExpectation =
  | 'plan'
  | 'contract'
  | 'pages'
  | 'dataModel'
  | 'spec'
  | 'patch'
  | 'text'

export interface LlmRequest {
  role: AgentRoleName
  system: string
  input: string
  expects: LlmExpectation
  /** patch 场景携带当前 Spec 的 JSON 字符串 */
  context?: string
  timeoutMs?: number
}

export interface LlmUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface LlmResult<T = unknown> {
  data: T
  usage: LlmUsage
  durationMs: number
  provider: ProviderKind
}

export type ProviderKind = 'mock' | 'deepseek'

/** 四类错误必须可区分：上层的重试策略不同（docs/03 §13.2 I-07） */
export type LlmErrorReason = 'timeout' | 'rate_limited' | 'invalid_structure' | 'refused' | 'network'

export class LlmError extends Error {
  readonly reason: LlmErrorReason
  readonly retryable: boolean

  constructor(reason: LlmErrorReason, message: string) {
    super(message)
    this.name = 'LlmError'
    this.reason = reason
    this.retryable = reason === 'timeout' || reason === 'rate_limited' || reason === 'network'
  }
}

export interface LlmProvider {
  readonly kind: ProviderKind
  complete<T = unknown>(req: LlmRequest): Promise<LlmResult<T>>
}

export const EMPTY_USAGE: LlmUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }

/** 粗略 token 估算（中文按字符计，够用于预算熔断与展示） */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.ceil(text.length / 2))
}
