import { notFound } from 'next/navigation'
import { verifyPreviewToken } from '@/lib/auth/preview-token'
import { getCurrentUser } from '@/lib/auth/guard'
import { getStore, rowToJson } from '@/lib/db/store'
import type { AppSpec } from '@/lib/spec/types'
import { readCompatibleSpec } from '@/lib/spec/schema-compat'
import { PreviewHost } from './preview-host'

export const dynamic = 'force-dynamic'

/**
 * 生成物预览页 —— 被工作台以 `sandbox="allow-scripts"` 的 iframe 加载。
 *
 * 鉴权：优先使用 URL 中的预览令牌（不依赖 Cookie），因为沙箱 iframe 处于不透明源，
 * 跨源请求不会携带 SameSite=Lax 的登录 Cookie。
 */
export default async function PreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ pt?: string }>
}) {
  const { id } = await params
  const { pt } = await searchParams

  const claims = verifyPreviewToken(pt)
  let allowed = claims !== null && claims.projectId === id
  const readOnly = claims?.mode === 'ro'

  if (!allowed) {
    const user = await getCurrentUser()
    if (user && (await getStore().getProjectForOwner(id, user.id))) allowed = true
  }

  if (!allowed) {
    // 无效/篡改/过期令牌一律 404（TST-M13-2）：
    // 200 的"友好错误页"会让"令牌是否有效"在状态码层面无法区分，也让爬取者以为命中了资源。
    notFound()
  }

  const latest = await getStore().getLatestSpecVersion(id)
  if (!latest) {
    return (
      <div className="p-8 text-sm text-slate-600">
        <div className="mx-auto max-w-md rounded-lg border border-slate-200 bg-white p-5">
          <h1 className="text-base font-semibold">还没有生成结果</h1>
          <p className="mt-2 leading-relaxed">该项目尚未生成过应用，请先在主界面提交一次需求。</p>
        </div>
      </div>
    )
  }

  let spec: AppSpec
  try {
    // 版本兼容校验：不兼容时给出明确原因，不用近似结构强行渲染
    spec = readCompatibleSpec(latest.spec, `v${latest.version} 的 App Spec`)
  } catch (err) {
    const message = err instanceof Error ? err.message : '无法读取该版本的应用数据'
    return (
      <div className="p-8 text-sm text-slate-600">
        <div className="mx-auto max-w-md rounded-lg border border-amber-200 bg-amber-50 p-5">
          <h1 className="text-base font-semibold text-amber-900">无法预览这个版本</h1>
          <p className="mt-2 leading-relaxed">{message}</p>
          <p className="mt-2 text-xs text-amber-800">请回到工作台生成一个新版本后再预览。</p>
        </div>
      </div>
    )
  }

  return (
    <PreviewHost
      spec={spec}
      projectId={id}
      token={pt ?? ''}
      readOnly={readOnly}
      version={latest.version}
    />
  )
}
