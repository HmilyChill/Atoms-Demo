import { env, resolveProviderKind } from '@/lib/env'
import { isCircuitOpen } from '@/lib/quota/guard'
import { MockProvider } from './mock'
import { DeepSeekProvider } from './deepseek'
import type { LlmProvider, ProviderKind } from './types'

/**
 * Provider 工厂（I-07 的唯一入口）。
 * 上层永远只拿到 LlmProvider 接口，不得出现 provider 名称分支。
 *
 * 熔断降级发生在这里：当日额度耗尽时自动改用 Mock，上层无感知。
 */

const globalForProvider = globalThis as unknown as { __atomsProvider?: LlmProvider }

export function getLlmProvider(): LlmProvider {
  const wantReal = resolveProviderKind() === 'deepseek' && !isCircuitOpen()
  const desired: ProviderKind = wantReal ? 'deepseek' : 'mock'
  if (!globalForProvider.__atomsProvider || globalForProvider.__atomsProvider.kind !== desired) {
    globalForProvider.__atomsProvider = desired === 'deepseek' ? new DeepSeekProvider() : new MockProvider()
  }
  return globalForProvider.__atomsProvider
}

/** 仅用于测试：重置缓存的 provider */
export function resetLlmProvider(): void {
  globalForProvider.__atomsProvider = undefined
}

export interface ProviderInfo {
  kind: ProviderKind
  model: string
  demoMode: boolean
  /** 是否配置了真实密钥（不含任何密钥内容） */
  hasKey: boolean
}

export function getProviderInfo(): ProviderInfo {
  const kind = resolveProviderKind()
  return {
    kind,
    model: kind === 'deepseek' ? env.deepseekModel : 'mock-deterministic',
    demoMode: kind === 'mock',
    hasKey: env.deepseekApiKey !== '',
  }
}
