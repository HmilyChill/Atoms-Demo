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
