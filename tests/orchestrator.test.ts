/**
 * 编排引擎与版本链测试（M4 / M7）。
 *
 * 覆盖 docs/04 中此前缺失的这些验收项：
 *  - TST-M4-1 状态机非法迁移被拒绝，且不留幻觉进度
 *  - T-M4-7 / TST-M4-3 单 Run 调用预算超限 → 中止并如实报错
 *  - TST-M7-3 版本链完整性（parentVersion 可回溯）
 *  - IT-5 取消生成
 *  - IT-6 生成中状态恢复（状态与事件都落库，可刷新后对齐）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.ATOMS_DB_FILE = '.data/test-isolation.db'
process.env.MOCK_LATENCY_MS = '0'
delete process.env.TURSO_DATABASE_URL
delete process.env.ATOMS_DB_URL

const { getStore } = await import('@/lib/db/store')
const { advanceRun, cancelRun, createRun, nextStepOf } = await import('@/lib/agents/orchestrator')
const { allEvents } = await import('@/lib/events/bus')

const stamp = Date.now().toString(36)
const TODO = '做一个个人待办清单：能新增任务、标记完成、按状态筛选、删除。'

async function seed(label: string) {
  const store = getStore()
  const user = await store.createUser({
    email: `orch-${label}-${stamp}@t.local`,
    passwordHash: 'h',
    displayName: 'Orch',
  })
  const project = await store.createProject({ ownerId: user.id, name: `编排-${label}` })
  const session = await store.createSession({ projectId: project.id })
  return { store, user, project, session }
}

async function driveToEnd(runId: string, maxSteps = 40) {
  let last: Awaited<ReturnType<typeof advanceRun>> | null = null
  for (let i = 0; i < maxSteps; i += 1) {
    last = await advanceRun(runId)
    if (last.done) return last
  }
  return last
}

test('状态机：非法/未知阶段被拒绝，并如实失败而不是静默卡死', async () => {
  const { store, project, session } = await seed('illegal')
  const run = await createRun({
    projectId: project.id,
    sessionId: session.id,
    userInput: TODO,
    mode: 'create',
    requireConfirm: false,
  })

  // 人为把状态改成引擎不认识的值（模拟数据损坏或版本不匹配）
  await store.updateRun(run.id, { stage: 'not_a_real_stage' })
  assert.equal(nextStepOf({ ...run, stage: 'not_a_real_stage' }), null, '未知阶段不应有下一步')

  const result = await advanceRun(run.id)
  assert.equal(result.done, true, '应直接结束而不是继续空转')
  assert.equal(result.run.status, 'failed', '应如实标记失败')
  assert.equal(result.run.error_code, 'CONFLICT', '应给出冲突错误码')
  assert.equal(result.run.stage, 'not_a_real_stage', '不应伪造阶段推进')
  assert.match(result.run.error_message ?? '', /无法识别的生成状态/, '错误信息应说明原因')

  const events = await allEvents(run.id)
  assert.ok(
    events.some((e) => e.type === 'run.failed'),
    '应留下 run.failed 事件，保证时间线不出现"永远转圈"',
  )
})

test('调用预算：超过单 Run 上限即中止，并如实报错（不会悄悄换成近似结果）', async () => {
  const previous = process.env.RUN_CALL_BUDGET
  process.env.RUN_CALL_BUDGET = '1'
  try {
    const { store, project, session } = await seed('budget')
    const run = await createRun({
      projectId: project.id,
      sessionId: session.id,
      userInput: TODO,
      mode: 'create',
      requireConfirm: false,
    })

    // 第 1 次调用（plan）应在预算内
    const first = await advanceRun(run.id)
    assert.equal(first.run.status, 'running', '第 1 步应正常推进')
    assert.equal((await store.getRun(run.id))?.call_count, 1, '应记录 1 次调用')

    // 第 2 次调用应触发预算上限
    const second = await advanceRun(run.id)
    assert.equal(second.done, true)
    assert.equal(second.run.status, 'failed', '超预算应中止')
    assert.equal(second.run.error_code, 'BUDGET_EXCEEDED', '应给出预算错误码')
    assert.match(second.run.error_message ?? '', /调用次数上限/, '错误信息应说明是调用次数上限')
    assert.equal((await store.getRun(run.id))?.call_count, 1, '超限的调用不应被计入')
  } finally {
    if (previous === undefined) delete process.env.RUN_CALL_BUDGET
    else process.env.RUN_CALL_BUDGET = previous
  }
})

test('provider 失败：可重试错误会重试，且时间线里 started/finished 仍然配对（TST-M4-2）', async () => {
  const { store, project, session } = await seed('retry')
  const { resetLlmProvider } = await import('@/lib/llm')
  const { LlmError } = await import('@/lib/llm/types')
  const real = (await import('@/lib/llm/templates')).buildPlan

  let calls = 0
  let attemptsSeen = 0
  // 注入一个"第 1 次必然失败、第 2 次成功"的假 provider（Mock 恒成功，测不到重试链路）
  const g = globalThis as unknown as { __atomsProvider?: unknown }
  const fake = {
    kind: 'mock',
    async complete<T>(req: { input: string }): Promise<{
      data: T
      usage: { totalTokens: number }
      durationMs: number
      provider: 'mock'
    }> {
      calls += 1
      if (calls === 1) throw new LlmError('timeout', '模拟超时')
      const analysis = (await import('@/lib/llm/templates')).analyzeRequirement(req.input)
      return { data: real(analysis) as unknown as T, usage: { totalTokens: 10 }, durationMs: 1, provider: 'mock' }
    },
  }
  g.__atomsProvider = fake
  try {
    const run = await createRun({
      projectId: project.id,
      sessionId: session.id,
      userInput: TODO,
      mode: 'create',
      requireConfirm: false,
    })
    const first = await advanceRun(run.id)
    assert.equal(first.run.status, 'running', '重试成功后应继续推进')
    assert.equal(calls, 2, '第一次失败后应重试一次（而不是直接失败）')

    const events = await allEvents(run.id)
    attemptsSeen = events.filter((e) => e.type === 'agent.started').length
    const finished = events.filter((e) => e.type === 'agent.finished').length
    assert.equal(attemptsSeen, finished, 'agent.started / finished 必须配对（不留永远转圈的卡片）')
    assert.ok(
      events.some((e) => e.type === 'agent.delta' && String(e.payload?.chunk ?? '').includes('正在重试')),
      '重试过程应对用户可见',
    )
  } finally {
    g.__atomsProvider = undefined
    resetLlmProvider()
  }
})

test('provider 持续失败：用尽重试后如实失败，并给出可读原因（TST-M4-2）', async () => {
  const { project, session } = await seed('retry-fail')
  const { resetLlmProvider } = await import('@/lib/llm')
  const { LlmError } = await import('@/lib/llm/types')

  const g = globalThis as unknown as { __atomsProvider?: unknown }
  g.__atomsProvider = {
    kind: 'mock',
    async complete(): Promise<never> {
      throw new LlmError('network', '模拟服务不可用')
    },
  }
  try {
    const run = await createRun({
      projectId: project.id,
      sessionId: session.id,
      userInput: TODO,
      mode: 'create',
      requireConfirm: false,
    })
    const result = await advanceRun(run.id)
    assert.equal(result.done, true, '重试用尽后应结束（不能无限重试）')
    assert.equal(result.run.status, 'failed')
    assert.match(String(result.run.error_message ?? ''), /模拟服务不可用|不可用/, '错误信息应保留真实原因')

    const events = await allEvents(run.id)
    assert.ok(events.some((e) => e.type === 'run.failed'), '应留下 run.failed 事件')
  } finally {
    g.__atomsProvider = undefined
    resetLlmProvider()
  }
})

test('token 预算：用量达到上限即中止（只限次数挡不住烧额度）（F-M11-3）', async () => {
  const previous = process.env.RUN_TOKEN_BUDGET
  const { store, project, session } = await seed('token-budget')
  const run = await createRun({
    projectId: project.id,
    sessionId: session.id,
    userInput: TODO,
    mode: 'create',
    requireConfirm: false,
  })
  await advanceRun(run.id) // 正常产出计划，并获得一些 token 用量
  const used = (await store.getRun(run.id))?.token_usage ?? 0

  // 把上限压到"已经用掉"的水平，下一次调用必须被拦住
  process.env.RUN_TOKEN_BUDGET = String(Math.max(1, used))
  try {
    const next = await advanceRun(run.id)
    assert.equal(next.done, true, '达到 token 上限应中止')
    assert.equal(next.run.status, 'failed')
    assert.match(String(next.run.error_message ?? ''), /token 上限/, '错误信息应说明是 token 上限')
  } finally {
    if (previous === undefined) delete process.env.RUN_TOKEN_BUDGET
    else process.env.RUN_TOKEN_BUDGET = previous
  }
})

test('自愈：最多 2 轮，仍修不好则如实收敛为部分通过（TST-M8-2）', async () => {
  const { store, project, session } = await seed('repair-limit')
  const { resetLlmProvider } = await import('@/lib/llm')
  const { MockProvider } = await import('@/lib/llm/mock')

  // 注入"在 spec 阶段悄悄塞进一个图表组件"的 provider：
  // 待办类需求的契约里「不引入图表看板」是禁做项 → 校验必然失败，且修复无法把它变通过。
  const g = globalThis as unknown as { __atomsProvider?: unknown }
  const inner = new MockProvider()
  g.__atomsProvider = {
    kind: 'mock',
    async complete(req: { expects: string } & Record<string, unknown>) {
      const res = (await (inner as unknown as { complete: (r: unknown) => Promise<unknown> }).complete(req)) as {
        data: { pages?: Array<{ components: Array<Record<string, unknown>> }>; dataModels?: Array<{ name: string }> }
      }
      if (req.expects === 'spec' && res?.data?.pages?.[0]) {
        res.data.pages[0].components.push({
          id: 'c-forbidden-chart',
          type: 'chart',
          model: res.data.dataModels?.[0]?.name ?? 'tasks',
          chart: 'bar',
          xField: 'title',
          yField: 'title',
          aggregate: 'count',
        })
      }
      return res
    },
  }

  try {
    const run = await createRun({
      projectId: project.id,
      sessionId: session.id,
      userInput: TODO,
      mode: 'create',
      requireConfirm: false,
    })
    const result = await driveToEnd(run.id)
    assert.equal(result?.done, true, '应收敛，而不是无限修复')

    const events = await allEvents(run.id)
    const repairAttempts = events.filter((e) => e.type === 'repair.attempt').length
    assert.ok(repairAttempts <= 2, `修复轮次不得超过 2（实际 ${repairAttempts}）`)
    assert.ok(repairAttempts >= 1, '这个用例必须真的触发过修复，否则测不到上限')

    const verification = (await store.listArtifactsByRun(run.id)).filter((a) => a.type === 'verification').pop()
    const report = verification ? JSON.parse(verification.payload) : null
    assert.equal(report?.ok, false, '修不好就必须如实报"未通过"，绝不谎报')

    // 终态必须明确说明"部分通过"，而不是假装完全成功
    const lastVerify = events.filter((e) => e.type === 'verify.result').pop()
    assert.equal(lastVerify?.payload?.ok, false, '最后一次校验结果必须是"未通过"')
    assert.ok(
      events.some(
        (e) => e.type === 'agent.delta' && String(e.payload?.chunk ?? '').includes('已达到自动修复上限'),
      ),
      '应明确告知用户"已到修复上限、仍有未通过项"',
    )
  } finally {
    g.__atomsProvider = undefined
    resetLlmProvider()
  }
})

test('取消生成：状态置为 cancelled，留下事件，且已产出产物保留', async () => {
  const { store, project, session } = await seed('cancel')
  const run = await createRun({
    projectId: project.id,
    sessionId: session.id,
    userInput: TODO,
    mode: 'create',
    requireConfirm: false,
  })

  await advanceRun(run.id) // 先产出 plan 产物
  const artifactsBefore = await store.listArtifactsByRun(run.id)
  assert.ok(artifactsBefore.length > 0, '取消前应有已产出产物')

  const cancelled = await cancelRun(run.id)
  assert.equal(cancelled.done, true)
  assert.equal(cancelled.run.status, 'cancelled')
  assert.equal((await store.getSession(session.id))?.status, 'cancelled', '会话状态应同步')

  const events = await allEvents(run.id)
  assert.ok(events.some((e) => e.type === 'run.cancelled'), '应留下 run.cancelled 事件')

  const artifactsAfter = await store.listArtifactsByRun(run.id)
  assert.equal(artifactsAfter.length, artifactsBefore.length, '取消不应删除已产出产物')

  // 幂等：取消后继续推进不应再改变状态
  const again = await advanceRun(run.id)
  assert.equal(again.done, true)
  assert.equal(again.run.status, 'cancelled')
})

test('取消生成：未开始的 Run 也可取消（不会卡在 pending）', async () => {
  const { store, project, session } = await seed('cancel-idle')
  const run = await createRun({
    projectId: project.id,
    sessionId: session.id,
    userInput: TODO,
    mode: 'create',
    requireConfirm: true,
  })
  // 未推进任何一步就取消
  const cancelled = await cancelRun(run.id)
  assert.equal(cancelled.run.status, 'cancelled')
  assert.equal((await store.getRun(run.id))?.stage, 'cancelled')
})

test('生成中状态恢复：状态与事件都已落库，重新读取即可对齐（IT-6）', async () => {
  const { store, project, session } = await seed('recover')
  const run = await createRun({
    projectId: project.id,
    sessionId: session.id,
    userInput: TODO,
    mode: 'create',
    requireConfirm: false,
  })

  await advanceRun(run.id)
  await advanceRun(run.id)
  // 注意：requireConfirm=false 时会跳过人工确认，因此第 2 步（contract）后阶段为 confirmed

  // 模拟"页面刷新后再查一次"：不依赖任何进程内状态
  const reloaded = await store.getRun(run.id)
  assert.equal(reloaded?.stage, 'confirmed', `刷新后阶段应保持一致，实际 ${reloaded?.stage}`)
  assert.equal(reloaded?.status, 'running')
  assert.equal(reloaded?.call_count, 2, '调用次数应已落库')

  // 再推进一步，确认它确实是从落库状态继续（而不是从头开始）
  const third = await advanceRun(run.id)
  assert.equal(third.run.stage, 'paged', '应能从落库的阶段继续推进')

  const events = await allEvents(run.id)
  const startedCount = events.filter((e) => e.type === 'agent.started').length
  const finishedCount = events.filter((e) => e.type === 'agent.finished').length
  assert.ok(startedCount >= 2, '事件应已持久化，可用于重放对齐')
  assert.equal(startedCount, finishedCount, '每个 started 都应有配对的 finished（无幽灵进度）')

  // 事件 ID 单调递增，断线续传（Last-Event-ID）才有意义
  const ids = events.map((e) => e.eventId)
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'eventId 应单调递增')
  assert.equal(new Set(ids).size, ids.length, 'eventId 不应重复')
})

test('版本链：parentVersion 正确串联，可逐级回溯（TST-M7-3）', async () => {
  const { store, project } = await seed('chain')

  const v1 = await store.addSpecVersion({ projectId: project.id, spec: { meta: { name: 'v1' } }, parentVersion: null })
  const v2 = await store.addSpecVersion({ projectId: project.id, spec: { meta: { name: 'v2' } }, parentVersion: 1 })
  const v3 = await store.addSpecVersion({ projectId: project.id, spec: { meta: { name: 'v3' } }, parentVersion: 2 })

  assert.deepEqual([v1.version, v2.version, v3.version], [1, 2, 3], '版本号应连续')
  assert.equal(v1.parent_version, null, '首版无父版本')
  assert.equal(v2.parent_version, 1)
  assert.equal(v3.parent_version, 2)

  // 从最新版沿 parentVersion 回溯到根
  const chain: number[] = []
  let cursor: number | null = v3.version
  while (cursor !== null) {
    const node = await store.getSpecVersion(project.id, cursor)
    assert.ok(node, `版本 v${cursor} 应存在`)
    chain.push(cursor)
    cursor = node!.parent_version
  }
  assert.deepEqual(chain, [3, 2, 1], '应能一路回溯到首版')

  // 项目上的 current_spec_version 指针应指向最新版
  assert.equal((await store.getProject(project.id))?.current_spec_version, 3)

  // 回滚以"新版本追加"实现：历史版本不删除，且父版本指向当前最新
  const rolled = await store.addSpecVersion({
    projectId: project.id,
    spec: { meta: { name: 'v1' } },
    parentVersion: 3,
    changeSummary: '回滚到 v1',
  })
  assert.equal(rolled.version, 4)
  assert.equal(rolled.parent_version, 3, '回滚版本应挂在当时的最新版之后')
  assert.equal((await store.listSpecVersions(project.id)).length, 4, '历史版本不应被删除')
  assert.ok(await store.getSpecVersion(project.id, 1), '原 v1 仍可读取')
})

// ─────────── 事件流：断线续传与回放 ───────────

async function seedRunWithSteps(label: string, steps: number) {
  const { store, project, session } = await seed(label)
  const run = await createRun({
    projectId: project.id,
    sessionId: session.id,
    userInput: TODO,
    mode: 'create',
    requireConfirm: false,
  })
  for (let i = 0; i < steps; i += 1) await advanceRun(run.id)
  return { store, run }
}

test('事件流：按 Last-Event-ID 增量拉取，可安全重连且不重复消费（TST-M4-5）', async () => {
  const { store, run } = await seedRunWithSteps('resume', 3)

  const all = await store.listEvents(run.id)
  assert.ok(all.length >= 5, `应已产生多条事件，实际 ${all.length}`)

  // 模拟"客户端只收到前 2 条就断线了"
  const cursor = all[1].event_id
  const resumed = await store.listEventsSince(run.id, cursor)

  assert.equal(resumed.length, all.length - 2, '应只返回游标之后的事件（不重不漏）')
  assert.ok(
    resumed.every((e) => e.event_id > cursor),
    'eventId 必须严格大于游标',
  )

  // 重连幂等：同一个 after 重复拉取，结果一致（不会产生重复消费）
  const again = await store.listEventsSince(run.id, cursor)
  assert.deepEqual(
    again.map((e) => e.event_id),
    resumed.map((e) => e.event_id),
    '同一游标重复拉取应得到相同结果',
  )
})

test('事件回放：可还原每一步的产出类型与先后顺序（TST-M12-2）', async () => {
  const { run } = await seedRunWithSteps('replay', 40)

  const events = await allEvents(run.id)
  const types = events.map((e) => e.type)

  assert.equal(types[0], 'run.started', '首事件应为 run.started')
  assert.equal(types[types.length - 1], 'run.finished', '末事件应为 run.finished')

  for (const expected of ['plan.ready', 'contract.ready', 'spec.ready', 'verify.result', 'run.finished']) {
    assert.ok(types.includes(expected as never), `回放应包含 ${expected}，实际：${JSON.stringify(types)}`)
  }

  // 顺序约束：计划 → 校验 → 规格落库 → 收敛
  // 注意：spec.ready 携带的是"规格已作为版本落库"的信息，因此在校验之后发出；
  // 真正的"产出规格"发生在 verify 之前（可通过 spec artifact 的存在证明）。
  assert.ok(types.indexOf('plan.ready') < types.indexOf('verify.result'), '计划应早于校验')
  assert.ok(types.indexOf('verify.result') < types.indexOf('spec.ready'), '规格落库应在校验之后')
  assert.ok(types.indexOf('spec.ready') < types.indexOf('run.finished'), '落库应早于收敛')

  // 每个 agent.started 都应有配对的 finished（回放时也成立）
  const started = types.filter((t) => t === 'agent.started').length
  const finished = types.filter((t) => t === 'agent.finished').length
  assert.equal(started, finished, '回放中不应出现"只有开始没有结束"的智能体')
})
