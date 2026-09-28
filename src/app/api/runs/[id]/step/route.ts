import type { NextRequest } from 'next/server'
import { requireUser } from '@/lib/auth/guard'
import { getStore } from '@/lib/db/store'
import { AppError } from '@/lib/errors'
import { ok, route } from '@/lib/api/http'
import { advanceRun } from '@/lib/agents/orchestrator'

/**
 * 推进一个短步骤。
 *
 * 这是"规避 Serverless 函数超时"的关键：单次请求只执行一步（一次模型调用 + 一次落库），
 * 由前端循环驱动，因此任何平台都能跑，且进度天然可观测。
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    const user = await requireUser()
    const { id } = await ctx.params
    const store = getStore()
    const run = await store.getRun(id)
    if (!run) throw new AppError('NOT_FOUND', '生成任务不存在', '请返回项目页重新发起生成')
    await store.requireProjectForOwner(run.project_id, user.id)

    const result = await advanceRun(id)
    return ok({
      run: {
        id: result.run.id,
        status: result.run.status,
        stage: result.run.stage,
        errorCode: result.run.error_code,
        errorMessage: result.run.error_message,
        tokenUsage: result.run.token_usage,
        callCount: result.run.call_count,
      },
      done: result.done,
      payload: result.payload ?? null,
    })
  })
}
