import type { NextRequest } from 'next/server'
import { requireUser } from '@/lib/auth/guard'
import { getStore } from '@/lib/db/store'
import { AppError } from '@/lib/errors'
import { env } from '@/lib/env'
import { ok, readJson, route, clientKey } from '@/lib/api/http'
import { checkRateLimit } from '@/lib/quota/guard'
import { createRun } from '@/lib/agents/orchestrator'

export async function POST(req: NextRequest): Promise<Response> {
  return route(async () => {
    const user = await requireUser()
    const limit = checkRateLimit(`runs:${clientKey(req, user.id)}`)
    if (!limit.ok) {
      throw new AppError(
        'RATE_LIMITED',
        '生成请求过于频繁，已为您限流',
        `请在 ${limit.retryAfterSec ?? 60} 秒后重试（演示额度有限，感谢理解）`,
      )
    }

    const body = await readJson<{
      projectId?: string
      sessionId?: string
      userInput?: string
      autoConfirm?: boolean
      mode?: 'create' | 'iterate'
    }>(req)

    const projectId = (body.projectId ?? '').trim()
    if (!projectId) throw new AppError('BAD_REQUEST', '缺少项目 id', '请从项目页发起生成')

    const store = getStore()
    await store.requireProjectForOwner(projectId, user.id)

    const userInput = (body.userInput ?? '').trim()
    if (userInput.length === 0) {
      throw new AppError('BAD_REQUEST', '请先描述你想要的应用', '例如：做一个个人待办清单，能新增、标记完成、按状态筛选')
    }
    if (userInput.length > env.maxInputLength) {
      throw new AppError(
        'BAD_REQUEST',
        `需求描述过长（上限 ${env.maxInputLength} 字）`,
        '请精简描述，或分多轮迭代补充',
      )
    }

    let sessionId = (body.sessionId ?? '').trim()
    if (sessionId) {
      const session = await store.getSession(sessionId)
      if (!session || session.project_id !== projectId) {
        throw new AppError('NOT_FOUND', '会话不存在', '请刷新页面后重试')
      }
    } else {
      const sessions = await store.listSessions(projectId)
      sessionId = sessions[0]?.id ?? (await store.createSession({ projectId })).id
    }

    const active = await store.findActiveRunBySession(sessionId)
    if (active) {
      throw new AppError('CONFLICT', '该会话已有正在进行的生成任务', '请先等待其完成或取消后再发起新的生成')
    }

    const hasSpec = (await store.getLatestSpecVersion(projectId)) !== null
    const mode: 'create' | 'iterate' = body.mode ?? (hasSpec ? 'iterate' : 'create')

    const run = await createRun({
      projectId,
      sessionId,
      userInput,
      mode,
      requireConfirm: body.autoConfirm === true ? false : true,
    })

    return ok({ runId: run.id, sessionId, mode, status: run.status, stage: run.stage }, { status: 201 })
  })
}
