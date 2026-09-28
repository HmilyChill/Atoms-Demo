/**
 * Turso（SQL over HTTP）适配器协议测试。
 *
 * 做法：在测试进程内起一个**本地 Turso 协议模拟服务**（node:http + 真实 node:sqlite），
 * 它按官方 /v2/pipeline 协议收请求、在真实 SQLite 上执行、再按协议编码返回。
 * 这样就能在不接触真实 Turso 账号的前提下，把【请求编码 → 线上 SQL 执行 → 响应解码】
 * 这条链路真正跑通，而不是只做字符串断言。
 *
 * 协议依据：https://docs.turso.tech/sdk/http/reference
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { DatabaseSync } from 'node:sqlite'

import { TursoExecutor, encodeArg, decodeCell, normalizeDatabaseUrl } from '@/lib/db/executor'
import { createStoreWithExecutor } from '@/lib/db/store'

// ─────────── 本地 Turso 协议模拟服务 ───────────

interface Cell {
  type: 'null' | 'integer' | 'float' | 'text' | 'blob'
  value?: string
  base64?: string
}

interface RecordedRequest {
  url: string
  authorization: string
  body: { requests: Array<Record<string, unknown>> }
}

/** 把协议单元格还原成 SQLite 可绑定的 JS 值 */
function cellToSqlite(cell: Cell): string | number | null | Uint8Array {
  switch (cell.type) {
    case 'null':
      return null
    case 'integer':
    case 'float':
      return cell.value === undefined ? null : Number(cell.value)
    case 'text':
      return cell.value ?? ''
    case 'blob':
      return cell.base64 ? Buffer.from(cell.base64, 'base64') : new Uint8Array()
    default:
      return null
  }
}

/** 把 SQLite 返回的 JS 值编码成协议单元格（value 用字符串以避免精度丢失） */
function sqliteToCell(value: unknown): Cell {
  if (value === null || value === undefined) return { type: 'null' }
  if (typeof value === 'bigint') return { type: 'integer', value: value.toString() }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { type: 'integer', value: String(value) } : { type: 'float', value: String(value) }
  }
  if (typeof value === 'string') return { type: 'text', value }
  if (value instanceof Uint8Array) return { type: 'blob', base64: Buffer.from(value).toString('base64') }
  return { type: 'text', value: String(value) }
}

interface FakeTurso {
  server: Server
  port: number
  requests: RecordedRequest[]
  /** 让下一次响应返回错误（用于测错误路径） */
  failNextWith: { status?: number; errorMessage?: string } | null
  close: () => Promise<void>
}

async function startFakeTurso(): Promise<FakeTurso> {
  const db = new DatabaseSync(':memory:')
  const requests: RecordedRequest[] = []
  const fake: Partial<FakeTurso> = { requests, failNextWith: null }

  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      if (fake.failNextWith?.status) {
        const status = fake.failNextWith.status
        fake.failNextWith = null
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'simulated failure' }))
        return
      }

      const body = JSON.parse(raw) as RecordedRequest['body']
      requests.push({ url: req.url ?? '', authorization: String(req.headers.authorization ?? ''), body })

      const results: Array<Record<string, unknown>> = []
      for (const entry of body.requests) {
        const type = entry.type as string
        if (type === 'close') {
          results.push({ type: 'ok', response: { type: 'close' } })
          continue
        }
        const stmt = entry.stmt as { sql: string; args?: Cell[] }
        try {
          if (fake.failNextWith?.errorMessage) {
            results.push({ type: 'error', error: { message: fake.failNextWith.errorMessage } })
            fake.failNextWith = null
            continue
          }

          const params = (stmt.args ?? []).map(cellToSqlite)
          const isPragma = /^\s*pragma/i.test(stmt.sql)
          const isSelect = /^\s*(select|with)/i.test(stmt.sql)

          if (isPragma) {
            db.exec(stmt.sql)
            results.push({ type: 'ok', response: { type: 'execute', result: emptyResult() } })
          } else if (isSelect) {
            const rows = db.prepare(stmt.sql).all(...params) as Array<Record<string, unknown>>
            const cols = rows.length > 0 ? Object.keys(rows[0]).map((name) => ({ name, decltype: null })) : []
            results.push({
              type: 'ok',
              response: {
                type: 'execute',
                result: {
                  cols,
                  rows: rows.map((r) => Object.values(r).map(sqliteToCell)),
                  affected_row_count: 0,
                  last_insert_rowid: null,
                },
              },
            })
          } else {
            const info = db.prepare(stmt.sql).run(...params)
            results.push({
              type: 'ok',
              response: {
                type: 'execute',
                result: {
                  cols: [],
                  rows: [],
                  affected_row_count: Number(info.changes ?? 0),
                  last_insert_rowid: info.lastInsertRowid === undefined ? null : Number(info.lastInsertRowid),
                },
              },
            })
          }
        } catch (err) {
          results.push({ type: 'error', error: { message: err instanceof Error ? err.message : String(err) } })
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ baton: null, base_url: null, results }))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  fake.server = server
  fake.port = port
  fake.close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
    })

  return fake as FakeTurso
}

function emptyResult() {
  return { cols: [], rows: [], affected_row_count: 0, last_insert_rowid: null }
}

const fake = await startFakeTurso()
after(async () => {
  await fake.close()
})

/**
 * 显式捕获真实 fetch 并注入执行器。
 * 原因：测试同进程运行，其它测试文件（如工作台 UI 测试）会临时替换全局 fetch；
 * 注入自己捕获的引用可让本文件与全局污染解耦。
 */
const realFetch = globalThis.fetch

function newExecutor() {
  return new TursoExecutor({
    url: `http://127.0.0.1:${fake.port}`,
    token: 'test-token-abc',
    fetchImpl: realFetch,
  })
}

// ─────────── 协议层 ───────────

test('Turso 协议：请求格式符合 /v2/pipeline 规范（URL / Bearer / requests / close）', async () => {
  fake.requests.length = 0
  const executor = newExecutor()
  await executor.get('SELECT 1 AS n')

  assert.equal(fake.requests.length, 1, '应发出一次请求')
  const req = fake.requests[0]
  assert.equal(req.url, '/v2/pipeline', '应打到 /v2/pipeline')
  assert.equal(req.authorization, 'Bearer test-token-abc', '应使用 Bearer 鉴权')
  assert.ok(Array.isArray(req.body.requests), 'body 应含 requests 数组')
  const types = req.body.requests.map((r) => r.type)
  assert.deepEqual(types, ['execute', 'close'], '必须以 close 结尾，避免连接泄漏')
})

test('Turso 协议：参数按类型编码（text / integer / float / null）', () => {
  assert.deepEqual(encodeArg('你好'), { type: 'text', value: '你好' })
  assert.deepEqual(encodeArg(42), { type: 'integer', value: '42' })
  assert.deepEqual(encodeArg(3.5), { type: 'float', value: '3.5' })
  assert.deepEqual(encodeArg(null), { type: 'null' })
  assert.deepEqual(encodeArg(undefined), { type: 'null' })
  // 布尔在本项目里以 INTEGER 0/1 存储
  assert.deepEqual(encodeArg(true), { type: 'integer', value: '1' })
  assert.deepEqual(encodeArg(false), { type: 'integer', value: '0' })
})

test('Turso 协议：响应单元格按类型解码', () => {
  assert.equal(decodeCell({ type: 'null' }), null)
  assert.equal(decodeCell({ type: 'integer', value: '7' }), 7)
  assert.equal(decodeCell({ type: 'float', value: '1.25' }), 1.25)
  assert.equal(decodeCell({ type: 'text', value: 'abc' }), 'abc')
})

test('Turso 协议：URL 规范化为 https（libsql:// 与 turso://）', () => {
  assert.equal(normalizeDatabaseUrl('libsql://demo-org.turso.io'), 'https://demo-org.turso.io')
  assert.equal(normalizeDatabaseUrl('turso://demo-org.turso.io'), 'https://demo-org.turso.io')
  assert.equal(normalizeDatabaseUrl('https://demo-org.turso.io/'), 'https://demo-org.turso.io')
})

test('Turso 协议：exec 会拆分多条 DDL，并跳过服务端自管的 journal_mode', async () => {
  fake.requests.length = 0
  const executor = newExecutor()
  await executor.exec('CREATE TABLE a (x TEXT); PRAGMA journal_mode = WAL; CREATE TABLE b (y TEXT);')

  const sqls = fake.requests[0].body.requests
    .filter((r) => r.type === 'execute')
    .map((r) => (r.stmt as { sql: string }).sql)
  assert.equal(sqls.length, 2, `应发送 2 条语句（WAL 被跳过），实际：${JSON.stringify(sqls)}`)
  assert.ok(sqls[0].includes('CREATE TABLE a'))
  assert.ok(sqls[1].includes('CREATE TABLE b'))
})

test('Turso 协议：服务端返回错误时抛出带原始消息的异常', async () => {
  const executor = newExecutor()
  fake.failNextWith = { errorMessage: 'no such table: nope' }
  await assert.rejects(
    () => executor.all('SELECT * FROM nope'),
    /no such table: nope/,
    '应把服务端错误消息透传出来，便于排查',
  )
})

test('Turso 协议：HTTP 非 200 时抛出异常', async () => {
  const executor = newExecutor()
  fake.failNextWith = { status: 401 }
  await assert.rejects(() => executor.get('SELECT 1'), /HTTP 401/)
})

// ─────────── 端到端：真实 SqlStore 跑在 Turso 执行器上 ───────────

test('端到端：完整 SqlStore 跑在 Turso 协议之上（建表 → 写入 → 读回 → 归属隔离）', async () => {
  const store = createStoreWithExecutor(newExecutor())
  assert.equal(store.kind, 'turso', '应报告为 turso 执行器')

  const suffix = Date.now().toString(36)
  const alice = await store.createUser({ email: `alice-${suffix}@t.local`, passwordHash: 'h', displayName: 'Alice' })
  const bob = await store.createUser({ email: `bob-${suffix}@t.local`, passwordHash: 'h', displayName: 'Bob' })

  // 登录路径：按邮箱查回，字段完整
  const found = await store.findUserByEmail(alice.email.toUpperCase())
  assert.equal(found?.id, alice.id, '邮箱查询应大小写不敏感')
  assert.equal(found?.display_name, 'Alice')

  const project = await store.createProject({ ownerId: alice.id, name: 'Turso 项目' })
  const session = await store.createSession({ projectId: project.id, title: '会话' })
  const run = await store.createRun({
    sessionId: session.id,
    projectId: project.id,
    mode: 'create',
    userInput: '做一个待办清单',
    requireConfirm: false,
  })

  await store.addArtifact({ runId: run.id, projectId: project.id, type: 'plan', payload: { goal: '目标' } })
  const v1 = await store.addSpecVersion({ projectId: project.id, spec: { meta: { name: 'v1' } }, parentVersion: null })
  const v2 = await store.addSpecVersion({ projectId: project.id, spec: { meta: { name: 'v2' } }, parentVersion: 1 })
  assert.equal(v1.version, 1, '首个版本号应为 1')
  assert.equal(v2.version, 2, '第二个版本号应为 2')

  const record = await store.createRecord(project.id, 'tasks', { title: '写周报', done: false })
  await store.updateRecord(project.id, 'tasks', record.id, { done: true })
  const records = await store.listRecords(project.id, 'tasks')
  assert.equal(records.length, 1)
  assert.equal(JSON.parse(records[0].data).done, true, '更新应真实生效')

  const e1 = await store.appendEvent(run.id, 'run.started', { a: 1 })
  const e2 = await store.appendEvent(run.id, 'agent.started', { agent: 'Mike' })
  assert.equal(e1.event_id, 1, 'eventId 应从 1 开始')
  assert.equal(e2.event_id, 2, 'eventId 应单调递增')
  const since = await store.listEventsSince(run.id, 1)
  assert.equal(since.length, 1, '增量拉取应只返回之后的 1 条')

  // 归属隔离在远程执行器上同样成立
  assert.equal(await store.getProjectForOwner(project.id, bob.id), null)
  await assert.rejects(
    () => store.requireProjectForOwner(project.id, bob.id),
    (err: unknown) => (err as { code?: string }).code === 'NOT_FOUND',
  )

  // 级联删除
  await store.deleteProject(project.id)
  assert.equal(await store.getProject(project.id), null)
  assert.equal(await store.getSession(session.id), null, '会话应级联删除')
  assert.equal(await store.getRun(run.id), null, 'Run 应级联删除')
  assert.equal((await store.listSpecVersions(project.id)).length, 0, 'Spec 版本应级联删除')
  assert.equal((await store.listEvents(run.id)).length, 0, '事件应级联删除')
})

test('端到端：Turso 执行器上并发取号仍然无重复', async () => {
  const store = createStoreWithExecutor(newExecutor())
  const suffix = Date.now().toString(36)
  const user = await store.createUser({ email: `c-${suffix}@t.local`, passwordHash: 'h', displayName: 'C' })
  const project = await store.createProject({ ownerId: user.id, name: '远程并发' })

  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      store.addSpecVersion({ projectId: project.id, spec: { meta: { name: `v${i}` } }, parentVersion: null }),
    ),
  )
  const versions = results.map((r) => r.version).sort((a, b) => a - b)
  assert.deepEqual(versions, [1, 2, 3, 4, 5], `版本号应无重复，实际：${JSON.stringify(versions)}`)
})
