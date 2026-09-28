/**
 * 归属隔离与级联删除测试（M1 / M11）。
 * 直接验证存储适配器层，隔离出是"存储层问题"还是"HTTP/鉴权层问题"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.ATOMS_DB_FILE = '.data/test-isolation.db'
// 确保测试走本地 SQLite 执行器，而不是误连到托管库
delete process.env.TURSO_DATABASE_URL
delete process.env.ATOMS_DB_URL

const { getStore } = await import('@/lib/db/store')

const stamp = Date.now().toString(36)

test('存储适配器：本地环境应选择 SQLite 执行器', async () => {
  const store = getStore()
  assert.equal(store.kind, 'sqlite', '未配置托管库时应使用本地 SQLite')
  // 触发一次真实查询，确认懒初始化（建表）确实生效
  const user = await store.createUser({ email: `k-${stamp}@t.local`, passwordHash: 'h', displayName: 'K' })
  assert.equal((await store.findUserById(user.id))?.email, user.email)
})

test('跨用户归属隔离：B 不能读到 A 的项目', async () => {
  const store = getStore()
  const a = await store.createUser({ email: `a-${stamp}@t.local`, passwordHash: 'h', displayName: 'A' })
  const b = await store.createUser({ email: `b-${stamp}@t.local`, passwordHash: 'h', displayName: 'B' })
  assert.notEqual(a.id, b.id, '两个用户 id 必须不同')

  const p = await store.createProject({ ownerId: a.id, name: 'A 的项目' })
  assert.equal((await store.getProjectForOwner(p.id, a.id))?.id, p.id, 'A 应能读到自己的项目')
  assert.equal(await store.getProjectForOwner(p.id, b.id), null, 'B 不应读到 A 的项目')
  assert.equal(await store.getProjectForOwner(p.id, 'user_not_exist'), null, '不存在的用户不应读到')
})

test('按 id 查询用户不会串号', async () => {
  const store = getStore()
  const a = await store.createUser({ email: `c-${stamp}@t.local`, passwordHash: 'h1', displayName: 'C' })
  const b = await store.createUser({ email: `d-${stamp}@t.local`, passwordHash: 'h2', displayName: 'D' })
  assert.equal((await store.findUserById(a.id))?.email, a.email)
  assert.equal((await store.findUserById(b.id))?.email, b.email)
  assert.equal(await store.findUserById('user_not_exist'), null)
})

test('删除项目会级联清理会话、Run、Spec 版本与生成物数据', async () => {
  const store = getStore()
  const u = await store.createUser({ email: `e-${stamp}@t.local`, passwordHash: 'h', displayName: 'E' })
  const p = await store.createProject({ ownerId: u.id, name: '待删除' })
  const s = await store.createSession({ projectId: p.id })
  const run = await store.createRun({
    sessionId: s.id,
    projectId: p.id,
    mode: 'create',
    userInput: 'x',
    requireConfirm: false,
  })
  await store.addArtifact({ runId: run.id, projectId: p.id, type: 'plan', payload: { goal: 'g' } })
  await store.addSpecVersion({ projectId: p.id, spec: { meta: { name: 'x' } }, parentVersion: null })
  await store.createRecord(p.id, 'tasks', { title: 't' })
  await store.appendEvent(run.id, 'run.started', {})

  await store.deleteProject(p.id)

  assert.equal(await store.getProject(p.id), null, '项目应已删除')
  assert.equal(await store.getSession(s.id), null, '会话应级联删除')
  assert.equal(await store.getRun(run.id), null, 'Run 应级联删除')
  assert.equal(await store.getLatestSpecVersion(p.id), null, 'Spec 版本应级联删除')
  assert.equal((await store.listRecords(p.id, 'tasks')).length, 0, '生成物数据应级联删除')
  assert.equal((await store.listEvents(run.id)).length, 0, '事件日志应级联删除')
})

test('种子数据与本次测试创建的账号互不影响（验证 owner 条件真的生效）', async () => {
  const store = getStore()
  const u1 = await store.createUser({ email: `f-${stamp}@t.local`, passwordHash: 'h', displayName: 'F' })
  const u2 = await store.createUser({ email: `g-${stamp}@t.local`, passwordHash: 'h', displayName: 'G' })
  await store.createProject({ ownerId: u1.id, name: 'P1' })
  await store.createProject({ ownerId: u1.id, name: 'P2' })
  await store.createProject({ ownerId: u2.id, name: 'P3' })

  assert.equal((await store.listProjectsByOwner(u1.id)).length, 2, 'u1 应只看到自己的 2 个项目')
  assert.equal((await store.listProjectsByOwner(u2.id)).length, 1, 'u2 应只看到自己的 1 个项目')
})

test('回归：requireProjectForOwner 必须抛错而不是静默返回 null', async () => {
  // 背景：曾出现"调用 getProjectForOwner 但忽略其 null 返回值"的越权缺陷（IDOR）。
  // 该回归测试锁死修复：非归属访问必须抛出 NOT_FOUND。
  const store = getStore()
  const owner = await store.createUser({ email: `h-${stamp}@t.local`, passwordHash: 'h', displayName: 'H' })
  const intruder = await store.createUser({ email: `i-${stamp}@t.local`, passwordHash: 'h', displayName: 'I' })
  const project = await store.createProject({ ownerId: owner.id, name: '受保护的项目' })

  // 归属者可正常取得
  assert.equal((await store.requireProjectForOwner(project.id, owner.id)).id, project.id)

  // 非归属者必须抛错
  await assert.rejects(
    () => store.requireProjectForOwner(project.id, intruder.id),
    (err: unknown) => {
      const e = err as { code?: string; status?: number }
      return e.code === 'NOT_FOUND' && e.status === 404
    },
    '非归属访问必须抛出 NOT_FOUND（避免通过错误码枚举资源）',
  )

  // 项目不存在同样抛错
  await assert.rejects(() => store.requireProjectForOwner('proj_not_exist', owner.id))
})

test('Spec 版本号在并发写入下仍单调递增且不重复（INSERT..SELECT 原子取号）', async () => {
  const store = getStore()
  const u = await store.createUser({ email: `j-${stamp}@t.local`, passwordHash: 'h', displayName: 'J' })
  const p = await store.createProject({ ownerId: u.id, name: '并发取号' })

  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      store.addSpecVersion({
        projectId: p.id,
        spec: { meta: { name: `v${i}` } },
        parentVersion: null,
        changeSummary: `第 ${i} 次`,
      }),
    ),
  )

  const versions = results.map((r) => r.version).sort((a, b) => a - b)
  assert.deepEqual(versions, [1, 2, 3, 4, 5, 6], `版本号应无重复且连续，实际：${JSON.stringify(versions)}`)
  assert.equal((await store.listSpecVersions(p.id)).length, 6, '应落库 6 个版本')
})

test('事件 eventId 在并发写入下仍单调递增且无重复', async () => {
  const store = getStore()
  const u = await store.createUser({ email: `l-${stamp}@t.local`, passwordHash: 'h', displayName: 'L' })
  const p = await store.createProject({ ownerId: u.id, name: '事件并发' })
  const s = await store.createSession({ projectId: p.id })
  const run = await store.createRun({
    sessionId: s.id,
    projectId: p.id,
    mode: 'create',
    userInput: 'x',
    requireConfirm: false,
  })

  await Promise.all(Array.from({ length: 8 }, (_, i) => store.appendEvent(run.id, 'agent.delta', { i })))
  const events = await store.listEvents(run.id)
  const ids = events.map((e) => e.event_id)
  assert.equal(ids.length, 8, '应写入 8 条事件')
  assert.deepEqual(
    ids,
    [1, 2, 3, 4, 5, 6, 7, 8],
    `eventId 应无重复且连续，实际：${JSON.stringify(ids)}`,
  )
})

test('回滚语义：以新版本追加、历史版本保留、生成物数据不丢（TST-M7-2 的存储层证据）', async () => {
  const store = getStore()
  const u = await store.createUser({ email: `m-${stamp}@t.local`, passwordHash: 'h', displayName: 'M' })
  const p = await store.createProject({ ownerId: u.id, name: '回滚' })

  const v1 = await store.addSpecVersion({ projectId: p.id, spec: { meta: { name: 'v1' } }, parentVersion: null })
  await store.createRecord(p.id, 'tasks', { title: '第一条' })

  const v2 = await store.addSpecVersion({
    projectId: p.id,
    spec: { meta: { name: 'v2' } },
    parentVersion: v1.version,
    changeSummary: '新增负责人字段',
  })
  await store.createRecord(p.id, 'tasks', { title: '第二条' })

  // 回滚 = 把 v1 的内容作为**新版本**追加（而不是删掉 v2）
  const rolled = await store.addSpecVersion({
    projectId: p.id,
    spec: { meta: { name: 'v1' } },
    parentVersion: v2.version,
    changeSummary: `回滚到 v${v1.version}`,
  })

  assert.equal(rolled.version, 3, '回滚应以新版本追加')
  const versions = await store.listSpecVersions(p.id)
  assert.deepEqual(
    versions.map((v) => v.version).sort((a, b) => a - b),
    [1, 2, 3],
    '历史版本必须保留（回滚不是删除）',
  )
  assert.equal((await store.getLatestSpecVersion(p.id))?.version, 3, '当前版本应指向回滚结果')

  // 关键：回滚绝不能清掉生成物的数据
  const records = await store.listRecords(p.id, 'tasks')
  assert.equal(records.length, 2, `回滚后生成物数据必须仍在（实际 ${records.length} 条）`)
})
