/**
 * 归属隔离与级联删除测试（M1 / M11）。
 * 直接验证存储适配器层，隔离出是"存储层问题"还是"HTTP/鉴权层问题"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.ATOMS_DB_FILE = '.data/test-isolation.db'

const { getStore } = await import('@/lib/db/store')

const stamp = Date.now().toString(36)

test('跨用户归属隔离：B 不能读到 A 的项目', () => {
  const store = getStore()
  const a = store.createUser({ email: `a-${stamp}@t.local`, passwordHash: 'h', displayName: 'A' })
  const b = store.createUser({ email: `b-${stamp}@t.local`, passwordHash: 'h', displayName: 'B' })
  assert.notEqual(a.id, b.id, '两个用户 id 必须不同')

  const p = store.createProject({ ownerId: a.id, name: 'A 的项目' })
  assert.equal(store.getProjectForOwner(p.id, a.id)?.id, p.id, 'A 应能读到自己的项目')
  assert.equal(store.getProjectForOwner(p.id, b.id), null, 'B 不应读到 A 的项目')
  assert.equal(store.getProjectForOwner(p.id, 'user_not_exist'), null, '不存在的用户不应读到')
})

test('按 id 查询用户不会串号', () => {
  const store = getStore()
  const a = store.createUser({ email: `c-${stamp}@t.local`, passwordHash: 'h1', displayName: 'C' })
  const b = store.createUser({ email: `d-${stamp}@t.local`, passwordHash: 'h2', displayName: 'D' })
  assert.equal(store.findUserById(a.id)?.email, a.email)
  assert.equal(store.findUserById(b.id)?.email, b.email)
  assert.equal(store.findUserById('user_not_exist'), null)
})

test('删除项目会级联清理会话、Run、Spec 版本与生成物数据', () => {
  const store = getStore()
  const u = store.createUser({ email: `e-${stamp}@t.local`, passwordHash: 'h', displayName: 'E' })
  const p = store.createProject({ ownerId: u.id, name: '待删除' })
  const s = store.createSession({ projectId: p.id })
  const run = store.createRun({ sessionId: s.id, projectId: p.id, mode: 'create', userInput: 'x', requireConfirm: false })
  store.addArtifact({ runId: run.id, projectId: p.id, type: 'plan', payload: { goal: 'g' } })
  store.addSpecVersion({ projectId: p.id, spec: { meta: { name: 'x' } }, parentVersion: null })
  store.createRecord(p.id, 'tasks', { title: 't' })
  store.appendEvent(run.id, 'run.started', {})

  store.deleteProject(p.id)

  assert.equal(store.getProject(p.id), null, '项目应已删除')
  assert.equal(store.getSession(s.id), null, '会话应级联删除')
  assert.equal(store.getRun(run.id), null, 'Run 应级联删除')
  assert.equal(store.getLatestSpecVersion(p.id), null, 'Spec 版本应级联删除')
  assert.equal(store.listRecords(p.id, 'tasks').length, 0, '生成物数据应级联删除')
  assert.equal(store.listEvents(run.id).length, 0, '事件日志应级联删除')
})

test('种子数据与本次测试创建的账号互不影响（验证 owner 条件真的生效）', () => {
  const store = getStore()
  const u1 = store.createUser({ email: `f-${stamp}@t.local`, passwordHash: 'h', displayName: 'F' })
  const u2 = store.createUser({ email: `g-${stamp}@t.local`, passwordHash: 'h', displayName: 'G' })
  store.createProject({ ownerId: u1.id, name: 'P1' })
  store.createProject({ ownerId: u1.id, name: 'P2' })
  store.createProject({ ownerId: u2.id, name: 'P3' })

  assert.equal(store.listProjectsByOwner(u1.id).length, 2, 'u1 应只看到自己的 2 个项目')
  assert.equal(store.listProjectsByOwner(u2.id).length, 1, 'u2 应只看到自己的 1 个项目')
})

test('回归：requireProjectForOwner 必须抛错而不是静默返回 null', () => {
  // 背景：曾出现"调用 getProjectForOwner 但忽略其 null 返回值"的越权缺陷（IDOR）。
  // 该回归测试锁死修复：非归属访问必须抛出 NOT_FOUND。
  const store = getStore()
  const owner = store.createUser({ email: `h-${stamp}@t.local`, passwordHash: 'h', displayName: 'H' })
  const intruder = store.createUser({ email: `i-${stamp}@t.local`, passwordHash: 'h', displayName: 'I' })
  const project = store.createProject({ ownerId: owner.id, name: '受保护的项目' })

  // 归属者可正常取得
  assert.equal(store.requireProjectForOwner(project.id, owner.id).id, project.id)

  // 非归属者必须抛错
  assert.throws(
    () => store.requireProjectForOwner(project.id, intruder.id),
    (err: unknown) => {
      const e = err as { code?: string; status?: number }
      return e.code === 'NOT_FOUND' && e.status === 404
    },
    '非归属访问必须抛出 NOT_FOUND（避免通过错误码枚举资源）',
  )

  // 项目不存在同样抛错
  assert.throws(() => store.requireProjectForOwner('proj_not_exist', owner.id))
})
