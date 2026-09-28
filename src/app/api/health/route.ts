import { ok, route } from '@/lib/api/http'
import { getProviderInfo } from '@/lib/llm'
import { quotaSnapshot } from '@/lib/quota/guard'

/**
 * 健康检查（无需鉴权）。
 *
 * 用途：部署后的自检入口 —— 无论是 Vercel 还是自建环境，
 * 都可以先用它确认「服务起来了 / 运行在演示模式还是真实模式 / 当日配额消耗」。
 * 注意：不返回任何密钥内容，只返回是否已配置。
 */
export async function GET(): Promise<Response> {
  return route(async () => {
    const provider = getProviderInfo()
    return ok({
      ok: true,
      service: 'atoms-demo',
      time: new Date().toISOString(),
      provider: {
        kind: provider.kind,
        model: provider.model,
        demoMode: provider.demoMode,
        hasKey: provider.hasKey,
        // F-M11-4：额度熔断后必须如实标注"已降级"，否则界面会说"正在用真实模型"而实际在跑 Mock
        degraded: provider.degraded,
        note: provider.note,
      },
      quota: quotaSnapshot(),
      runtime: {
        node: process.version,
        env: process.env.NODE_ENV ?? 'unknown',
      },
    })
  })
}
