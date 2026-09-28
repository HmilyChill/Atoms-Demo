import type { NextRequest } from 'next/server'
import { requireUser } from '@/lib/auth/guard'
import { getStore } from '@/lib/db/store'
import { AppError } from '@/lib/errors'
import { ok, route } from '@/lib/api/http'
import { eventsFor, nextStepOf } from '@/lib/agents/orchestrator'

/**
 * Run 快照。事件可丢、状态不可丢 —— 前端任何时候都能用本接口对齐。
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    const user = await requireUser()
    const { id } = await ctx.params
    const store = getStore()
    const run = store.getRun(id)
    if (!run) throw new AppError('NOT_FOUND', '生成任务不存在', '请返回项目页重新发起生成')
    store.requireProjectForOwner(run.project_id, user.id)

    const artifacts = store.listArtifactsByRun(id)
    return ok({
      run: {
        id: run.id,
        projectId: run.project_id,
        sessionId: run.session_id,
        status: run.status,
        stage: run.stage,
        mode: run.mode,
        userInput: run.user_input,
        errorCode: run.error_code,
        errorMessage: run.error_message,
        tokenUsage: run.token_usage,
        callCount: run.call_count,
        startedAt: run.started_at,
        finishedAt: run.finished_at,
      },
      nextStep: nextStepOf(run),
      artifacts: artifacts.map((a) => ({
        id: a.id,
        type: a.type,
        summary: a.summary,
        payload: safeParse(a.payload),
        createdAt: a.created_at,
      })),
      events: eventsFor(id),
    })
  })
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
