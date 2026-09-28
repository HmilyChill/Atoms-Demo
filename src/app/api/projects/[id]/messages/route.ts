import type { NextRequest } from 'next/server'
import { requireUser } from '@/lib/auth/guard'
import { getStore } from '@/lib/db/store'
import { ok, route } from '@/lib/api/http'

/**
 * 会话消息历史（F-M2-2）。
 *
 * 原先 `messages` 表只有写入、没有任何读取入口（`listMessages` 无人调用），
 * 导致"刷新后还能看到刚才聊了什么"这件事实际不成立。
 * 这里补上读取入口，工作台据此渲染消息列表。
 *
 * 约定：不传 `sessionId` 时取该项目的第一个会话（与发起生成时选会话的规则一致）。
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    const user = await requireUser()
    const { id } = await ctx.params
    const store = getStore()
    await store.requireProjectForOwner(id, user.id)

    const wanted = (new URL(req.url).searchParams.get('sessionId') ?? '').trim()
    let sessionId = wanted
    if (sessionId) {
      const session = await store.getSession(sessionId)
      if (!session || session.project_id !== id) {
        sessionId = ''
      }
    }
    if (!sessionId) {
      const sessions = await store.listSessions(id)
      sessionId = sessions[0]?.id ?? ''
    }
    if (!sessionId) return ok({ sessionId: null, messages: [] })

    const messages = await store.listMessages(sessionId)
    return ok({
      sessionId,
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        runId: m.run_id,
        createdAt: m.created_at,
      })),
    })
  })
}
