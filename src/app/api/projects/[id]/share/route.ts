import type { NextRequest } from 'next/server'
import { requireUser } from '@/lib/auth/guard'
import { getStore, rowToJson } from '@/lib/db/store'
import { ok, route } from '@/lib/api/http'
import { createPreviewToken } from '@/lib/auth/preview-token'

/**
 * 只读分享链接（M13，延展能力）。
 *
 * 实现要点：
 *  - 复用签名令牌（mode=ro），**无需在数据库里存令牌**，天然不可枚举
 *  - 只读令牌在数据接口处被强制拒绝写入（见 records 路由）
 *  - 令牌自带 7 天有效期；**手动吊销暂未支持**（已在 README 标注为已知限制）
 */
const SHARE_TTL_MS = 1000 * 60 * 60 * 24 * 7

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    const user = await requireUser()
    const { id } = await ctx.params
    const project = getStore().requireProjectForOwner(id, user.id)
    const latest = getStore().getLatestSpecVersion(id)

    const origin = new URL(req.url).origin
    const token = createPreviewToken(id, 'ro', Date.now() + SHARE_TTL_MS - 1000 * 60 * 30)
    const shareUrl = `${origin}/preview/${id}?pt=${encodeURIComponent(token)}`

    return ok({
      url: shareUrl,
      project: project?.name ?? '',
      version: latest?.version ?? null,
      expiresInDays: 7,
      note: '只读链接：访问者可以浏览与操作界面，但无法写入数据；链接在 7 天后自动失效。',
    })
  })
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    const user = await requireUser()
    const { id } = await ctx.params
    getStore().requireProjectForOwner(id, user.id)
    const latest = getStore().getLatestSpecVersion(id)
    if (!latest) {
      return ok({ available: false, reason: '项目还没有生成过应用，暂无内容可分享' })
    }
    const spec = rowToJson<Record<string, unknown>>(latest.spec)
    return ok({
      available: true,
      version: latest.version,
      collections: getStore().listCollections(id),
      specName: (spec.meta as { name?: string } | undefined)?.name ?? '',
    })
  })
}
