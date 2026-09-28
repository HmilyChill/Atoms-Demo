import type { NextRequest } from 'next/server'
import { requireUser } from '@/lib/auth/guard'
import { getStore } from '@/lib/db/store'
import { AppError } from '@/lib/errors'
import { ok, route } from '@/lib/api/http'
import { confirmRun } from '@/lib/agents/orchestrator'

/** 确认计划与需求契约（Gate）：未确认不得继续执行 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    const user = await requireUser()
    const { id } = await ctx.params
    const store = getStore()
    const run = await store.getRun(id)
    if (!run) throw new AppError('NOT_FOUND', '生成任务不存在', '请返回项目页重新发起生成')
    await store.requireProjectForOwner(run.project_id, user.id)

    const result = await confirmRun(id)
    return ok({ run: { id: result.run.id, status: result.run.status, stage: result.run.stage }, done: false })
  })
}
