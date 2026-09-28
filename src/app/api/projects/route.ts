import type { NextRequest } from 'next/server'
import { requireUser } from '@/lib/auth/guard'
import { getStore } from '@/lib/db/store'
import { AppError } from '@/lib/errors'
import { ok, readJson, route } from '@/lib/api/http'

export async function GET(): Promise<Response> {
  return route(async () => {
    const user = await requireUser()
    const projects = await getStore().listProjectsByOwner(user.id)
    return ok({
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        currentSpecVersion: p.current_spec_version,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
      })),
    })
  })
}

export async function POST(req: NextRequest): Promise<Response> {
  return route(async () => {
    const user = await requireUser()
    const body = await readJson<{ name?: string; description?: string }>(req)
    const name = (body.name ?? '').trim()
    if (name.length === 0) {
      throw new AppError('BAD_REQUEST', '请填写项目名称', '例如：任务清单 Demo')
    }
    if (name.length > 60) {
      throw new AppError('BAD_REQUEST', '项目名称过长', '请控制在 60 个字符以内')
    }
    const store = getStore()
    const project = await store.createProject({
      ownerId: user.id,
      name,
      description: (body.description ?? '').trim(),
    })
    // 每个项目自动带一个会话，作为多轮迭代的载体
    await store.createSession({ projectId: project.id, title: '初始会话' })
    return ok({ project: { id: project.id, name: project.name, description: project.description } })
  })
}
