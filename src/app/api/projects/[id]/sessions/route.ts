import type { NextRequest } from 'next/server'
import { requireUser } from '@/lib/auth/guard'
import { getStore } from '@/lib/db/store'
import { ok, readJson, route } from '@/lib/api/http'

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    const user = await requireUser()
    const { id } = await ctx.params
    const store = getStore()
    await store.requireProjectForOwner(id, user.id)
    const sessions = await store.listSessions(id)
    return ok({
      sessions: sessions.map((s) => ({ id: s.id, title: s.title, status: s.status, createdAt: s.created_at })),
    })
  })
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    const user = await requireUser()
    const { id } = await ctx.params
    const store = getStore()
    await store.requireProjectForOwner(id, user.id)
    const body = await readJson<{ title?: string }>(req)
    const session = await store.createSession({
      projectId: id,
      title: (body.title ?? '').trim() || '新会话',
    })
    return ok({ session: { id: session.id, title: session.title } }, { status: 201 })
  })
}
