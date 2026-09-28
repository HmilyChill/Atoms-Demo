/**
 * 多智能体编排引擎（M4）。
 *
 * 关键设计（docs/03 §9 与 §13）：
 *  - **短步骤**：每次 advanceRun 只推进一步 —— 单请求不会触发平台函数超时
 *  - **状态机**：stage 即状态，非法迁移一律拒绝
 *  - **事件配对**：每个 agent.started 必定有 agent.finished 或 run.failed（禁止幽灵进度）
 *  - **预算熔断**：单 Run 调用次数超限即中止并如实报错
 *  - **诚实失败**：任何异常都落到 run.failed 并带明确原因，绝不谎报成功
 */
import { AppError } from '@/lib/errors'
import { env } from '@/lib/env'
import { getStore, type ArtifactType, type RunRow, type RunStatus, type SessionStatus } from '@/lib/db/store'
import { emit, type RunEvent } from '@/lib/events/bus'
import { recordCall } from '@/lib/quota/guard'
import { getLlmProvider } from '@/lib/llm'
import { LlmError, type AgentRoleName, type LlmExpectation } from '@/lib/llm/types'
import { analyzeRequirement } from '@/lib/llm/templates'
import { validateSpec } from '@/lib/spec/validate'
import type { Contract } from '@/lib/spec/contract'
import { isContract } from '@/lib/spec/contract'
import type { AppSpec } from '@/lib/spec/types'
import { attemptRepair, verifySpec, type VerificationReport } from './verifier'
import { roleOf } from './roles'

export type StepKey =
  | 'plan'
  | 'contract'
  | 'pages'
  | 'dataModel'
  | 'spec'
  | 'patch'
  | 'verify'
  | 'repair'
  | 'finalize'

const MAX_REPAIR_ROUNDS = 2
const MAX_ATTEMPTS = 3

export interface AdvanceResult {
  run: RunRow
  status: RunStatus
  stage: string
  done: boolean
  /** 需要前端渲染的关键产物（避免前端再发一次请求） */
  payload?: Record<string, unknown>
}

function store() {
  return getStore()
}

export function createRun(input: {
  projectId: string
  sessionId: string
  userInput: string
  mode: 'create' | 'iterate'
  requireConfirm: boolean
}): RunRow {
  const s = store()
  const run = s.createRun({
    sessionId: input.sessionId,
    projectId: input.projectId,
    mode: input.mode,
    userInput: input.userInput,
    requireConfirm: input.requireConfirm,
  })
  s.addMessage({ sessionId: input.sessionId, role: 'user', content: input.userInput, runId: run.id })
  s.updateSession(input.sessionId, { status: 'planning' })
  emit(run.id, 'run.started', { runId: run.id, sessionId: input.sessionId, mode: input.mode })
  return run
}

function latestArtifactPayload<T>(runId: string, type: ArtifactType): T | null {
  const list = store().listArtifactsByRun(runId)
  const hit = [...list].reverse().find((a) => a.type === type)
  if (!hit) return null
  try {
    return JSON.parse(hit.payload) as T
  } catch {
    return null
  }
}

function countArtifacts(runId: string, type: ArtifactType): number {
  return store().listArtifactsByRun(runId).filter((a) => a.type === type).length
}

async function callAgent<T>(params: {
  run: RunRow
  roleKey: AgentRoleName
  expects: LlmExpectation
  input: string
  context?: string
}): Promise<T> {
  const { run } = params
  const role = roleOf(params.roleKey)
  const current = store().getRun(run.id) ?? run
  if (current.call_count + 1 > env.runCallBudget) {
    throw new AppError(
      'BUDGET_EXCEEDED',
      `本次生成已达到调用次数上限（${env.runCallBudget} 次），已停止以避免继续消耗额度`,
      '可以缩小需求范围后重试，或稍后重新发起生成',
    )
  }

  emit(run.id, 'agent.started', { agent: role.agent, role: role.key, label: role.label, stage: current.stage })
  const startedAt = Date.now()
  let lastError: unknown = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const provider = getLlmProvider()
      const res = await provider.complete<T>({
        role: role.key,
        system: role.system,
        input: params.input,
        expects: params.expects,
        context: params.context,
        timeoutMs: env.llmTimeoutMs,
      })
      store().addRunUsage(run.id, res.usage.totalTokens, 1)
      recordCall(res.usage.totalTokens, res.provider === 'deepseek')
      emit(run.id, 'agent.delta', {
        agent: role.agent,
        role: role.key,
        chunk: `${role.label} 已产出结构化结果（${res.usage.totalTokens} tokens）`,
      })
      emit(run.id, 'agent.finished', {
        agent: role.agent,
        role: role.key,
        durationMs: res.durationMs,
        tokenUsage: res.usage.totalTokens,
        provider: res.provider,
        attempt,
      })
      return res.data
    } catch (err) {
      lastError = err
      const retryable = err instanceof LlmError ? err.retryable : false
      if (!retryable || attempt === MAX_ATTEMPTS) break
      emit(run.id, 'agent.delta', {
        agent: role.agent,
        role: role.key,
        chunk: `第 ${attempt} 次调用失败（${err instanceof Error ? err.message : '未知原因'}），正在重试`,
      })
    }
  }

  const reason = lastError instanceof Error ? lastError.message : '未知原因'
  emit(run.id, 'agent.finished', {
    agent: role.agent,
    role: role.key,
    durationMs: Date.now() - startedAt,
    error: reason,
  })
  if (lastError instanceof LlmError) {
    throw new AppError('PROVIDER_UNAVAILABLE', `模型调用失败：${reason}`, '可稍后重试，或确认已配置可用的 API Key')
  }
  throw lastError
}

function failRun(runId: string, stage: string, err: unknown): AdvanceResult {
  const message =
    err instanceof AppError ? err.message : err instanceof Error ? err.message : '生成过程中出现未预期的错误'
  const code = err instanceof AppError ? err.code : 'INTERNAL'
  store().updateRun(runId, { status: 'failed', stage, errorCode: code, errorMessage: message, finishedAt: new Date().toISOString() })
  const run = store().getRun(runId)!
  store().updateSession(run.session_id, { status: 'failed' })
  emit(runId, 'run.failed', { errorCode: code, message, stage })
  return { run, status: 'failed', stage, done: true }
}

export function nextStepOf(run: RunRow): StepKey | null {
  switch (run.stage) {
    case 'created':
      return run.mode === 'iterate' ? 'patch' : 'plan'
    case 'planned':
      return 'contract'
    case 'confirmed':
      return 'pages'
    case 'paged':
      return 'dataModel'
    case 'modeled':
      return 'spec'
    case 'specced':
    case 'patched':
    case 'repaired':
      return 'verify'
    case 'verify_failed':
      return 'repair'
    case 'verified':
    case 'verified_partial':
      return 'finalize'
    default:
      return null
  }
}

/** 推进一步；调用方（前端）负责循环调用直到 done */
export async function advanceRun(runId: string): Promise<AdvanceResult> {
  const s = store()
  let run = s.getRun(runId)
  if (!run) throw new AppError('NOT_FOUND', '生成任务不存在', '请返回项目页重新发起生成')

  if (['succeeded', 'failed', 'cancelled'].includes(run.status)) {
    return { run, status: run.status, stage: run.stage, done: true }
  }
  if (run.status === 'awaiting_confirm') {
    return { run, status: run.status, stage: run.stage, done: false }
  }

  const step = nextStepOf(run)
  if (!step) {
    // 未知状态：如实失败，避免静默卡死
    return failRun(runId, run.stage, new AppError('CONFLICT', `无法识别的生成状态：${run.stage}`, '请重新发起生成'))
  }

  s.updateRun(runId, { status: 'running' })

  try {
    switch (step) {
      case 'plan': {
        const data = await callAgent<Record<string, unknown>>({
          run,
          roleKey: 'planner',
          expects: 'plan',
          input: run.user_input,
        })
        const art = s.addArtifact({
          runId,
          projectId: run.project_id,
          type: 'plan',
          summary: String(data.goal ?? '执行计划'),
          payload: data,
        })
        emit(runId, 'plan.ready', { artifactId: art.id, summary: art.summary })
        s.updateRun(runId, { stage: 'planned' })
        return finishStep(runId, 'planned', false)
      }

      case 'contract': {
        const data = await callAgent<Record<string, unknown>>({
          run,
          roleKey: 'planner',
          expects: 'contract',
          input: run.user_input,
        })
        if (!isContract(data)) {
          throw new AppError('VALIDATION_FAILED', '需求契约结构不合法，已停止以免产出偏离需求', '请重试或简化需求描述')
        }
        s.addArtifact({ runId, projectId: run.project_id, type: 'contract', summary: '需求契约', payload: data })
        emit(runId, 'contract.ready', {
          mustDo: (data as Contract).mustDo.map((i) => i.text),
          mustNot: (data as Contract).mustNot.map((i) => i.text),
          acceptance: (data as Contract).acceptance,
        })
        if (run.require_confirm === 1) {
          s.updateRun(runId, { stage: 'awaiting_confirm', status: 'awaiting_confirm' })
          s.updateSession(run.session_id, { status: 'awaiting_confirm' })
          return { run: s.getRun(runId)!, status: 'awaiting_confirm', stage: 'awaiting_confirm', done: false }
        }
        s.updateRun(runId, { stage: 'confirmed' })
        return finishStep(runId, 'confirmed', false)
      }

      case 'pages': {
        const data = await callAgent<Record<string, unknown>>({ run, roleKey: 'pm', expects: 'pages', input: run.user_input })
        s.addArtifact({ runId, projectId: run.project_id, type: 'pages', summary: '页面与信息架构', payload: data })
        s.updateRun(runId, { stage: 'paged' })
        return finishStep(runId, 'paged', false)
      }

      case 'dataModel': {
        const data = await callAgent<Record<string, unknown>>({
          run,
          roleKey: 'architect',
          expects: 'dataModel',
          input: run.user_input,
        })
        s.addArtifact({ runId, projectId: run.project_id, type: 'dataModel', summary: '数据模型设计', payload: data })
        s.updateRun(runId, { stage: 'modeled' })
        return finishStep(runId, 'modeled', false)
      }

      case 'spec': {
        let spec: unknown = null
        let lastIssues: string[] = []
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          const prompt =
            attempt === 1
              ? run.user_input
              : `${run.user_input}\n\n上一次产出的 Spec 存在以下问题，请修正后重新产出：\n${lastIssues.join('\n')}`
          const data = await callAgent<Record<string, unknown>>({
            run,
            roleKey: 'engineer',
            expects: 'spec',
            input: prompt,
          })
          const candidates = (data as { spec?: unknown }).spec ?? data
          const validation = validateSpec(candidates)
          if (validation.ok) {
            spec = candidates
            break
          }
          lastIssues = validation.issues.filter((i) => i.severity === 'error').map((i) => `${i.path} ${i.message}`)
        }

        if (!spec) {
          const analysis = analyzeRequirement(run.user_input)
          throw new AppError(
            'VALIDATION_FAILED',
            `生成的 App Spec 未通过结构校验（应用「${analysis.title}」）：${lastIssues.slice(0, 3).join('；') || '未知问题'}`,
            '已如实报告失败原因，未使用近似结果替代。可重试或调整需求描述',
          )
        }

        s.addArtifact({ runId, projectId: run.project_id, type: 'spec', summary: 'App Spec', payload: spec })
        s.updateRun(runId, { stage: 'specced' })
        return finishStep(runId, 'specced', false)
      }

      case 'patch': {
        const currentVersion = s.getLatestSpecVersion(run.project_id)
        if (!currentVersion) {
          throw new AppError('CONFLICT', '当前项目还没有可修改的应用，请先生成一个应用', '返回并先完成一次生成')
        }
        const data = await callAgent<{ spec: AppSpec; changeSummary: string; applied: boolean }>({
          run,
          roleKey: 'iterate',
          expects: 'patch',
          input: run.user_input,
          context: currentVersion.spec,
        })
        const validation = validateSpec(data.spec)
        if (!validation.ok) {
          const first = validation.issues.find((i) => i.severity === 'error')
          throw new AppError(
            'VALIDATION_FAILED',
            `增量修改后的 Spec 未通过校验：${first ? `${first.path} ${first.message}` : '未知问题'}`,
            '已保留上一版本，未写入不合法结果。可换一种说法重试',
          )
        }
        s.addArtifact({
          runId,
          projectId: run.project_id,
          type: 'spec',
          summary: data.changeSummary || '增量修改',
          payload: data.spec,
        })
        emit(runId, 'agent.delta', {
          agent: 'Alex',
          role: 'iterate',
          chunk: data.applied
            ? `已完成增量修改：${data.changeSummary}`
            : `诉求未能自动落地，已如实标注：${data.changeSummary}`,
        })
        s.updateRun(runId, { stage: 'patched' })
        return finishStep(runId, 'patched', false)
      }

      case 'verify': {
        const spec = latestArtifactPayload<AppSpec>(runId, 'spec')
        if (!spec) {
          throw new AppError('CONFLICT', '没有找到待校验的 App Spec', '请重新发起生成')
        }
        const contract = latestArtifactPayload<Contract>(runId, 'contract')
        const role = roleOf('verifier')
        emit(runId, 'agent.started', { agent: role.agent, role: role.key, label: role.label, stage: 'verify' })
        emit(runId, 'verify.started', { checkCount: (contract?.mustDo.length ?? 0) + (contract?.mustNot.length ?? 0) + 3 })
        const startedAt = Date.now()
        const report = verifySpec(spec, contract)
        s.addArtifact({
          runId,
          projectId: run.project_id,
          type: 'verification',
          summary: report.summary,
          payload: report,
        })
        emit(runId, 'agent.finished', { agent: role.agent, role: role.key, durationMs: Date.now() - startedAt })
        emit(runId, 'verify.result', {
          ok: report.ok,
          summary: report.summary,
          passed: report.contract.passed.map((p) => p.text),
          failed: report.contract.failed.map((f) => ({ text: f.text, reason: f.reason })),
          renderErrors: report.render.errors,
          unverified: report.unverified,
        })

        if (report.ok) {
          s.updateRun(runId, { stage: 'verified' })
          return finishStep(runId, 'verified', false)
        }

        const repairRounds = countArtifacts(runId, 'repair')
        if (repairRounds < MAX_REPAIR_ROUNDS) {
          s.updateRun(runId, { stage: 'verify_failed' })
          return finishStep(runId, 'verify_failed', false)
        }
        // 修复轮次已用尽：如实进入"部分通过"，绝不谎报
        s.updateRun(runId, { stage: 'verified_partial' })
        emit(runId, 'agent.delta', {
          agent: role.agent,
          role: role.key,
          chunk: `已达到自动修复上限（${MAX_REPAIR_ROUNDS} 轮），仍有未通过项，将如实上报`,
        })
        return finishStep(runId, 'verified_partial', false)
      }

      case 'repair': {
        const spec = latestArtifactPayload<AppSpec>(runId, 'spec')
        const report = latestArtifactPayload<VerificationReport>(runId, 'verification')
        if (!spec || !report) {
          throw new AppError('CONFLICT', '缺少待修复的 Spec 或校验报告', '请重新发起生成')
        }
        const round = countArtifacts(runId, 'repair') + 1
        const role = roleOf('repair')
        emit(runId, 'agent.started', { agent: role.agent, role: role.key, label: role.label, stage: 'repair' })
        const startedAt = Date.now()
        const outcome = attemptRepair(spec, report)
        s.addArtifact({
          runId,
          projectId: run.project_id,
          type: 'repair',
          summary: outcome.fixes.length > 0 ? `第 ${round} 轮修复：${outcome.fixes.join('、')}` : '本轮无可自动修复项',
          payload: outcome,
        })
        // 修复结果作为新的 Spec 候选（原版本仍保留在 artifacts 中，不丢）
        s.addArtifact({
          runId,
          projectId: run.project_id,
          type: 'spec',
          summary: `第 ${round} 轮修复后的 Spec`,
          payload: outcome.spec,
        })
        emit(runId, 'agent.finished', { agent: role.agent, role: role.key, durationMs: Date.now() - startedAt })
        emit(runId, 'repair.attempt', {
          round,
          fixes: outcome.fixes,
          unrepairable: outcome.unrepairable,
        })
        s.updateRun(runId, { stage: 'repaired' })
        return finishStep(runId, 'repaired', false)
      }

      case 'finalize': {
        const spec = latestArtifactPayload<AppSpec>(runId, 'spec')
        if (!spec) {
          throw new AppError('CONFLICT', '没有可落库的 App Spec', '请重新发起生成')
        }
        const project = s.getProject(run.project_id)
        const parent = project?.current_spec_version ?? null
        const report = latestArtifactPayload<VerificationReport>(runId, 'verification')
        const latestSpecArtifact = [...s.listArtifactsByRun(runId)].reverse().find((a) => a.type === 'spec')
        const changeSummary = latestSpecArtifact?.summary?.trim()
          ? latestSpecArtifact.summary
          : `生成「${spec.meta?.name ?? '应用'}」`
        const version = s.addSpecVersion({
          projectId: run.project_id,
          spec,
          parentVersion: parent,
          changeSummary: `${changeSummary}${report && !report.ok ? '（校验部分通过，详见校验报告）' : ''}`,
        })
        emit(runId, 'spec.ready', { version: version.version, pageCount: spec.pages?.length ?? 0 })
        emit(runId, 'preview.updated', { version: version.version, entryUrl: `/preview/${run.project_id}` })

        const finishedAt = new Date().toISOString()
        s.updateRun(runId, { status: 'succeeded', stage: 'finished', finishedAt })
        s.updateSession(run.session_id, { status: 'done' })
        emit(runId, 'run.finished', {
          version: version.version,
          totalMs: Date.parse(finishedAt) - Date.parse(run.started_at),
          tokenUsage: (s.getRun(runId)?.token_usage ?? 0),
          verificationOk: report?.ok ?? false,
        })
        run = s.getRun(runId)!
        return { run, status: 'succeeded', stage: 'finished', done: true, payload: { version: version.version } }
      }
    }
  } catch (err) {
    return failRun(runId, step, err)
  }
}

function finishStep(runId: string, stage: string, done: boolean): AdvanceResult {
  const run = store().getRun(runId)!
  return { run, status: run.status, stage, done }
}

export function confirmRun(runId: string): AdvanceResult {
  const s = store()
  const run = s.getRun(runId)
  if (!run) throw new AppError('NOT_FOUND', '生成任务不存在', '请返回项目页重新发起生成')
  if (run.stage !== 'awaiting_confirm') {
    throw new AppError('CONFLICT', '当前生成任务不在等待确认状态', '可直接继续推进，或刷新页面同步状态')
  }
  s.updateRun(runId, { stage: 'confirmed', status: 'running' })
  s.updateSession(run.session_id, { status: 'generating' })
  return finishStep(runId, 'confirmed', false)
}

export function cancelRun(runId: string): AdvanceResult {
  const s = store()
  const run = s.getRun(runId)
  if (!run) throw new AppError('NOT_FOUND', '生成任务不存在', '请返回项目页重新发起生成')
  if (['succeeded', 'failed', 'cancelled'].includes(run.status)) {
    return { run, status: run.status, stage: run.stage, done: true }
  }
  s.updateRun(runId, {
    status: 'cancelled',
    stage: 'cancelled',
    finishedAt: new Date().toISOString(),
    errorCode: 'CANCELLED',
    errorMessage: '已被用户取消',
  })
  s.updateSession(run.session_id, { status: 'cancelled' as SessionStatus })
  emit(runId, 'run.cancelled', { stage: run.stage })
  return { run: s.getRun(runId)!, status: 'cancelled', stage: 'cancelled', done: true }
}

export function eventsFor(runId: string): RunEvent[] {
  return store().listEvents(runId).map((r) => ({
    eventId: r.event_id,
    runId: r.run_id,
    type: r.type as RunEvent['type'],
    payload: JSON.parse(r.payload || '{}') as Record<string, unknown>,
    at: r.created_at,
  }))
}
