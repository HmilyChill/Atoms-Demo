/**
 * 结构化日志（M12 T-M12-1）。
 *
 * 要求（docs/04 F-M12-1）：日志需含 `runId` / `stage` / `provider` / 耗时 / token，
 * 使"每次 Run 可追溯到每一步的耗时与用量"。
 *
 * 两条硬约束：
 *  1. **绝不记录密钥**：所有字段先经过脱敏（键名或值形似密钥一律替换），
 *     这是 M11 密钥红线在日志侧的落地。
 *  2. **可测试**：输出单行 JSON（便于日志系统采集），同时保留一个内存环形缓冲，
 *     让测试（以及排查）能直接读取最近日志，而不必去抓 stdout。
 */

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogFields {
  /** 事件名，例如 run.created / step.finished / provider.call */
  event: string
  runId?: string
  projectId?: string
  stage?: string
  agent?: string
  provider?: string
  durationMs?: number
  tokenUsage?: number
  callCount?: number
  code?: string
  message?: string
  [key: string]: unknown
}

export interface LogRecord extends LogFields {
  ts: string
  level: LogLevel
}

const SECRET_VALUE_RE = /^(sk-|ghp_|github_pat_|Bearer\s)/i
const MASK = '***'

/**
 * 判断字段名是否属于"凭据"。
 *
 * ⚠️ 这里必须精确：早期版本用了过宽的正则（含 `token` 子串），
 * 结果把 `tokenUsage` 也脱敏成了 `***`——恰好抹掉了 M12 要求记录的信息。
 * 因此改为"归一化后精确/后缀匹配"。
 */
export function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (normalized === 'token' || normalized === 'authorization' || normalized === 'cookie') return true
  return (
    normalized.endsWith('token') ||
    normalized.endsWith('secret') ||
    normalized.endsWith('password') ||
    normalized.endsWith('apikey') ||
    normalized === 'credential' ||
    normalized === 'bearer'
  )
}

/** 递归脱敏：字段名属于凭据，或值形似密钥，一律替换 */
export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]'
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    return SECRET_VALUE_RE.test(value) ? MASK : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? MASK : sanitize(v, depth + 1)
    }
    return out
  }
  return String(value)
}

const RING_SIZE = 200
const globalForLogs = globalThis as unknown as { __atomsLogs?: LogRecord[] }

function ring(): LogRecord[] {
  if (!globalForLogs.__atomsLogs) globalForLogs.__atomsLogs = []
  return globalForLogs.__atomsLogs
}

/** 只做格式化，便于单测断言输出内容 */
export function formatLine(level: LogLevel, fields: LogFields, now: Date = new Date()): string {
  const record: LogRecord = { ts: now.toISOString(), level, ...(sanitize(fields) as LogFields) }
  return JSON.stringify(record)
}

export function log(level: LogLevel, fields: LogFields): LogRecord {
  const record: LogRecord = { ts: new Date().toISOString(), level, ...(sanitize(fields) as LogFields) }
  const buffer = ring()
  buffer.push(record)
  if (buffer.length > RING_SIZE) buffer.splice(0, buffer.length - RING_SIZE)

  const line = JSON.stringify(record)
  // 日志写入本身绝不能影响主流程
  try {
    if (level === 'error') process.stderr.write(`${line}\n`)
    else process.stdout.write(`${line}\n`)
  } catch {
    /* 忽略写入失败 */
  }
  return record
}

export const logger = {
  info: (fields: LogFields) => log('info', fields),
  warn: (fields: LogFields) => log('warn', fields),
  error: (fields: LogFields) => log('error', fields),
}

/** 读取最近日志（测试与故障排查用） */
export function recentLogs(filter?: { event?: string; runId?: string }): LogRecord[] {
  const all = ring()
  return all.filter((r) => {
    if (filter?.event && r.event !== filter.event) return false
    if (filter?.runId && r.runId !== filter.runId) return false
    return true
  })
}

export function clearLogs(): void {
  globalForLogs.__atomsLogs = []
}

/** 一次操作的耗时计时器 */
export function startTimer(): () => number {
  const startedAt = Date.now()
  return () => Date.now() - startedAt
}
