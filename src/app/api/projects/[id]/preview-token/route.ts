import type { NextRequest } from 'next/server'
import { requireUser } from '@/lib/auth/guard'
import { getStore } from '@/lib/db/store'
import { ok, route } from '@/lib/api/http'
import { createPreviewToken } from '@/lib/auth/preview-token'

/**
 * 签发预览令牌。
 *
 * 为什么不让预览 iframe 直接用登录 Cookie（docs/00 §11.1 A4）：
 *  预览使用 `sandbox="allow-scripts"`（不授予 same-origin），文档处于不透明源，
 *  跨源请求不会携带 SameSite=Lax 的 Cookie，因此改用**短期、限定项目**的令牌。
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    const user = await requireUser()
    const { id } = await ctx.params
    await getStore().requireProjectForOwner(id, user.id)
    const token = createPreviewToken(id, 'rw')
    return ok({ token, expiresInSec: 1800, mode: 'rw' })
  })
}
