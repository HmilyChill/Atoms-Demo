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
  /**
   * 是否因"当日额度熔断"而**被迫降级**（F-M11-4）。
   * 有这个字段才能让 UI 说实话：否则额度耗尽后界面仍显示"真实模型"，与"自动切 Mock 并标注"相矛盾。
   */
  degraded: boolean
  /** 给用户看的一句话说明（不含任何密钥信息） */
  note: string
}

export function getProviderInfo(): ProviderInfo {
  const configured = resolveProviderKind()
  const open = isCircuitOpen()
  // 配置了真实模型但额度已熔断 → 实际在用 Mock，必须如实标注
  const kind: ProviderKind = configured === 'deepseek' && open ? 'mock' : configured
  const degraded = configured === 'deepseek' && open

  return {
    kind,
    model: kind === 'deepseek' ? env.deepseekModel : 'mock-deterministic',
    demoMode: kind === 'mock',
    hasKey: env.deepseekApiKey !== '',
    degraded,
    note: degraded
      ? '当日调用额度已用完，已自动降级为确定性 Mock（结果可复现，功能完整）'
      : kind === 'deepseek'
        ? '使用真实模型'
        : env.deepseekApiKey === ''
          ? '未配置 API Key，运行在确定性 Mock 模式'
          : '演示模式',
  }
}
