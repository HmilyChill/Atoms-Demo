/**
 * 可观测性与数据版本兼容测试（M12 结构化日志 / M9 T-M9-3 schemaVersion）。
 *
 * M12 的验收标准是"每次 Run 可追溯到每一步的耗时与用量"，所以这里不只测 logger 本身，
 * 而是**真跑一次生成**，再回到日志里核对每一步是否留下了 runId / stage / provider / 耗时 / token。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.ATOMS_DB_FILE = '.data/test-isolation.db'
process.env.MOCK_LATENCY_MS = '0'
delete process.env.TURSO_DATABASE_URL
delete process.env.ATOMS_DB_URL

const { getStore } = await import('@/lib/db/store')
const { createRun, advanceRun } = await import('@/lib/agents/orchestrator')
const { clearLogs, formatLine, log, recentLogs, sanitize } = await import('@/lib/obs/logger')
const { checkSchemaVersion, readCompatibleSpec } = await import('@/lib/spec/schema-compat')
const { buildTemplateSpec, analyzeRequirement } = await import('@/lib/llm/templates')

const stamp = Date.now().toString(36)

// ─────────────────── M12：结构化日志 ───────────────────

test('日志：输出单行 JSON，且含时间戳、级别与事件名', () => {
  const line = formatLine('info', { event: 'unit.test', runId: 'run_1', stage: 'plan' })
  assert.equal(line.includes('\n'), false, '必须是单行（便于日志采集）')

  const parsed = JSON.parse(line) as Record<string, unknown>
  assert.equal(parsed.level, 'info')
  assert.equal(parsed.event, 'unit.test')
  assert.equal(parsed.runId, 'run_1')
  assert.equal(parsed.stage, 'plan')
  assert.ok(typeof parsed.ts === 'string' && !Number.isNaN(Date.parse(parsed.ts as string)), '应有合法时间戳')
})

test('日志：绝不记录密钥，但也不会误伤 token 用量等正常字段', () => {
  const sanitized = sanitize({
    apiKey: 'sk-abcdefghijklmnop',
    authorization: 'Bearer abc',
    preview_token: 'pt-xyz',
    nested: { token: 'secret-value', safe: 'ok' },
    note: 'Bearer should-be-masked',
    // 这些是**必须保留**的度量字段：早期过宽的正则会把它们抹成 ***
    tokenUsage: 123,
    token_usage: 456,
    callCount: 7,
    durationMs: 42,
  }) as Record<string, unknown>

  assert.equal(sanitized.apiKey, '***', '键名像密钥应脱敏')
  assert.equal(sanitized.authorization, '***')
  assert.equal(sanitized.preview_token, '***', '预览令牌必须脱敏')
  assert.equal((sanitized.nested as Record<string, unknown>).token, '***')
  assert.equal((sanitized.nested as Record<string, unknown>).safe, 'ok', '正常字段不应被误伤')
  assert.equal(sanitized.note, '***', '值形似 Bearer 令牌应脱敏')

  assert.equal(sanitized.tokenUsage, 123, 'token 用量必须保留（M12 要求记录它）')
  assert.equal(sanitized.token_usage, 456, 'token 用量必须保留')
  assert.equal(sanitized.callCount, 7, '调用次数必须保留')
  assert.equal(sanitized.durationMs, 42, '耗时必须保留')
})

test('日志：可用事件名与 runId 过滤（便于按一次 Run 排查）', () => {
  clearLogs()
  log('info', { event: 'a', runId: 'r1' })
  log('info', { event: 'b', runId: 'r1' })
  log('info', { event: 'a', runId: 'r2' })

  assert.equal(recentLogs({ event: 'a' }).length, 2)
  assert.equal(recentLogs({ runId: 'r1' }).length, 2)
  assert.equal(recentLogs({ event: 'a', runId: 'r1' }).length, 1)
})

test('日志：真实跑完一次生成后，每一步都可追溯（runId/stage/provider/耗时/token）', async () => {
  clearLogs()
  const store = getStore()
  const user = await store.createUser({
    email: `obs-${stamp}@t.local`,
    passwordHash: 'h',
    displayName: 'OBS',
  })
  const project = await store.createProject({ ownerId: user.id, name: '日志可追溯' })
  const session = await store.createSession({ projectId: project.id })

  const run = await createRun({
    projectId: project.id,
    sessionId: session.id,
    userInput: '做一个个人待办清单：能新增任务、标记完成、按状态筛选、删除。',
    mode: 'create',
    requireConfirm: false,
  })

  let done = false
  for (let i = 0; i < 40 && !done; i += 1) {
    const result = await advanceRun(run.id)
    done = result.done
  }
  assert.equal(done, true, '生成应在步数上限内完成')

  // ① 每次模型调用都留下 provider / 耗时 / token
  const calls = recentLogs({ event: 'provider.call', runId: run.id })
  assert.ok(calls.length >= 5, `应有至少 5 次模型调用日志，实际 ${calls.length}`)
  for (const c of calls) {
    assert.equal(c.runId, run.id)
    assert.equal(c.provider, 'mock', '应记录实际使用的 provider')
    assert.ok(typeof c.stage === 'string' && (c.stage as string).length > 0, '应记录所处阶段')
    assert.ok((c.durationMs ?? -1) >= 0, '应记录耗时')
    assert.ok((c.tokenUsage ?? 0) > 0, '应记录 token 用量')
  }

  // ② 阶段推进可追溯
  const stages = recentLogs({ event: 'step.started', runId: run.id }).map((l) => l.stage)
  for (const expected of ['plan', 'contract', 'pages', 'dataModel', 'spec', 'verify', 'finalize']) {
    assert.ok(stages.includes(expected), `应记录阶段 ${expected}，实际：${JSON.stringify(stages)}`)
  }

  // ③ 收尾有总耗时与总用量
  const finished = recentLogs({ event: 'run.finished', runId: run.id })
  assert.equal(finished.length, 1, '应有一条 run.finished 日志')
  const f = finished[0]
  assert.ok((f.durationMs ?? 0) > 0, '应记录总耗时')
  assert.ok((f.tokenUsage ?? 0) > 0, '应记录总 token')
  assert.ok((f.callCount ?? 0) >= 5, '应记录调用次数')
  assert.equal(typeof f.version, 'number', '应记录产出规格版本')

  // ④ 全部日志中不得出现密钥形态的字符串
  const dump = JSON.stringify(recentLogs({ runId: run.id }))
  assert.equal(/sk-[A-Za-z0-9]{8,}/.test(dump), false, '日志中不应出现密钥')
})

// ─────────────────── M9：schemaVersion 兼容 ───────────────────

test('版本兼容：当前版本可正常读取', () => {
  const spec = buildTemplateSpec(analyzeRequirement('待办清单'), '2026-01-01T00:00:00.000Z')
  const result = checkSchemaVersion(spec)
  assert.equal(result.legacy, false)
  assert.equal(readCompatibleSpec(JSON.stringify(spec)).meta.name, spec.meta.name)
})

test('版本兼容：低版本走兼容路径而不是报错（评审可能打开更早的项目）', () => {
  const spec = buildTemplateSpec(analyzeRequirement('待办清单'), '2026-01-01T00:00:00.000Z')
  const legacy = structuredClone(spec) as { meta: { schemaVersion: number } }
  legacy.meta.schemaVersion = 0
  const result = checkSchemaVersion(legacy)
  assert.equal(result.legacy, true, '应识别为旧版本并兼容读取')
  assert.equal(result.schemaVersion, 0)
})

test('版本兼容：高于当前支持的版本必须明确报错，且说明原因', () => {
  const spec = buildTemplateSpec(analyzeRequirement('待办清单'), '2026-01-01T00:00:00.000Z')
  const future = structuredClone(spec) as { meta: { schemaVersion: number } }
  future.meta.schemaVersion = 99

  assert.throws(
    () => checkSchemaVersion(future, 'v1 的 App Spec'),
    (err: unknown) => {
      const e = err as { code?: string; message?: string }
      return e.code === 'CONFLICT' && (e.message ?? '').includes('99')
    },
    '应由版本过新而明确失败，并指出实际版本号',
  )
})

test('版本兼容：缺少 schemaVersion 时报错，而不是猜测结构', () => {
  assert.throws(
    () => checkSchemaVersion({ meta: {} }),
    (err: unknown) => (err as { code?: string }).code === 'VALIDATION_FAILED',
  )
  assert.throws(
    () => readCompatibleSpec('{"meta":{"name":"x"}}'),
    (err: unknown) => (err as { code?: string }).code === 'VALIDATION_FAILED',
  )
})

test('版本兼容：损坏的 JSON 给出可读错误，而不是抛出原始异常', () => {
  assert.throws(
    () => readCompatibleSpec('{not json'),
    (err: unknown) => {
      const e = err as { code?: string; message?: string }
      return e.code === 'VALIDATION_FAILED' && (e.message ?? '').includes('不是合法 JSON')
    },
  )
})
