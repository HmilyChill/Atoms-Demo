import type { AppSpec } from '@/lib/spec/types'
import type { LlmProvider, LlmRequest, LlmResult } from './types'
import { EMPTY_USAGE, estimateTokens } from './types'
import {
  analyzeRequirement,
  applyChangeRequest,
  buildContract,
  buildDataModels,
  buildPagesArtifact,
  buildPlan,
  buildTemplateSpec,
} from './templates'

/**
 * Mock provider：不依赖任何外部服务与密钥的**确定性**产出。
 *
 * 它是"演示永不失败"的保险丝（docs/03 §11），也是自动化测试与无 key 演示的默认 provider。
 * 与真实 provider 输出同构 —— 上层不得出现 provider 分支。
 */
export class MockProvider implements LlmProvider {
  readonly kind = 'mock' as const
  private readonly latencyMs: number

  constructor(options: { latencyMs?: number } = {}) {
    // 让人能看清多智能体的推进过程；测试中传 0 以保证速度与确定性
    this.latencyMs = options.latencyMs ?? (Number.parseInt(process.env.MOCK_LATENCY_MS ?? '120', 10) || 0)
  }

  async complete<T = unknown>(req: LlmRequest): Promise<LlmResult<T>> {
    const startedAt = Date.now()
    if (this.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.latencyMs))
    }

    const analysis = analyzeRequirement(req.input)
    const generatedAt = new Date(startedAt).toISOString()
    let data: unknown

    switch (req.expects) {
      case 'plan':
        data = buildPlan(analysis)
        break
      case 'contract':
        data = buildContract(analysis)
        break
      case 'pages':
        data = buildPagesArtifact(analysis)
        break
      case 'dataModel':
        data = { models: buildDataModels(analysis) }
        break
      case 'spec':
        data = buildTemplateSpec(analysis, generatedAt)
        break
      case 'patch': {
        let current: AppSpec | null = null
        if (req.context) {
          try {
            current = JSON.parse(req.context) as AppSpec
          } catch {
            current = null
          }
        }
        const base = current ?? buildTemplateSpec(analysis, generatedAt)
        const result = applyChangeRequest(base, req.input)
        data = { spec: result.spec, changeSummary: result.changeSummary, applied: result.applied }
        break
      }
      default:
        data = { text: `已根据需求生成结果：${analysis.title}` }
    }

    const promptTokens = estimateTokens(req.system + req.input + (req.context ?? ''))
    const completionTokens = estimateTokens(JSON.stringify(data))
    return {
      data: data as T,
      usage: { ...EMPTY_USAGE, promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      durationMs: Date.now() - startedAt,
      provider: 'mock',
    }
  }
}
