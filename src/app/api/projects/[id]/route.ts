import type { NextRequest } from 'next/server'
import { requireUser } from '@/lib/auth/guard'
import { getStore } from '@/lib/db/store'
import { AppError } from '@/lib/errors'
import { ok, readJson, route } from '@/lib/api/http'

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    const user = await requireUser()
    const { id } = await ctx.params
    const store = getStore()
    const project = store.getProjectForOwner(id, user.id)
    if (!project) throw new AppError('NOT_FOUND', '项目不存在或你没有访问权限', '返回项目列表重新选择')
    const sessions = store.listSessions(id)
    const runs = store.listRunsByProject(id, 10)
    const latest = store.getLatestSpecVersion(id)
    return ok({
      project: {
        id: project.id,
        name: project.name,
        description: project.description,
        currentSpecVersion: project.current_spec_version,
        createdAt: project.created_at,
        updatedAt: project.updated_at,
      },
      sessions: sessions.map((s) => ({ id: s.id, title: s.title, status: s.status, createdAt: s.created_at })),
      runs: runs.map((r) => ({
        id: r.id,
        status: r.status,
        stage: r.stage,
        mode: r.mode,
        userInput: r.user_input,
        errorMessage: r.error_message,
        tokenUsage: r.token_usage,
        callCount: r.call_count,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
      })),
      hasSpec: latest !== null,
    })
  })
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    const user = await requireUser()
    const { id } = await ctx.params
    const store = getStore()
    store.requireProjectForOwner(id, user.id)
    const body = await readJson<{ name?: string; description?: string }>(req)
    const patch: { name?: string; description?: string } = {}
    if (typeof body.name === 'string') {
      const name = body.name.trim()
      if (name.length === 0) throw new AppError('BAD_REQUEST', '项目名称不能为空', '请填写一个名称')
      patch.name = name.slice(0, 60)
    }
    if (typeof body.description === 'string') patch.description = body.description.slice(0, 500)
    const updated = store.updateProject(id, patch)
    return ok({ project: { id: updated.id, name: updated.name, description: updated.description } })
  })
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    const user = await requireUser()
    const { id } = await ctx.params
    const store = getStore()
    store.requireProjectForOwner(id, user.id)
    store.deleteProject(id)
    return ok({ deleted: true })
  })
}
