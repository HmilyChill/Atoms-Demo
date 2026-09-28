/**
 * SQL 执行器抽象（存储适配器的底层）。
 *
 * 设计动机：把"SQL 与业务逻辑"和"如何连数据库"彻底分开。
 * 上层 `SqlStore` 只写一次 SQL；底层可替换：
 *   - NodeSqliteExecutor：本机 / 容器（持久卷）用 Node 内置 node:sqlite，零原生依赖
 *   - TursoExecutor：Serverless（如 Vercel，文件系统只读）用 Turso SQL over HTTP，纯 fetch、零新依赖
 *
 * 为什么必须异步：远程数据库只能经 HTTP 访问，因此执行器接口统一返回 Promise。
 *
 * 协议依据：https://docs.turso.tech/sdk/http/reference
 *   POST /v2/pipeline   Authorization: Bearer <token>
 *   { "requests": [ { "type":"execute", "stmt": { "sql": "...", "args": [ {"type":"text","value":"..."} ] } }, { "type":"close" } ] }
 *   响应 results[i].response.result = { cols, rows, affected_row_count, last_insert_rowid }
 *   单元格为 { type, value }，value 为字符串（避免精度丢失）；blob 用 base64。
 */

export type SqlParam = string | number | boolean | bigint | null | undefined | Uint8Array

export interface RunResult {
  changes: number
  lastInsertRowid: number | bigint | null
}

export interface SqlExecutor {
  readonly kind: 'sqlite' | 'turso'
  /** 执行可能包含多条语句的 DDL（内部自行拆分） */
  exec(sql: string): Promise<void>
  run(sql: string, params?: SqlParam[]): Promise<RunResult>
  get<T>(sql: string, params?: SqlParam[]): Promise<T | undefined>
  all<T>(sql: string, params?: SqlParam[]): Promise<T[]>
  close(): void
}

/** 把 DDL 拆成单条语句（本项目 DDL 中不含字符串字面量里的分号，简单拆分足够） */
export function splitStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

// ─────────────────────────────────────────────────────────────
// 本地：Node 内置 node:sqlite（零原生依赖）
// ─────────────────────────────────────────────────────────────

interface NodeStatement {
  run(...params: unknown[]): { changes?: number | bigint; lastInsertRowid?: number | bigint }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

interface NodeDatabase {
  exec(sql: string): void
  prepare(sql: string): NodeStatement
  close(): void
}

function normalizeNodeParams(params: SqlParam[] = []): unknown[] {
  return params.map((p) => {
    if (p === undefined) return null
    if (typeof p === 'boolean') return p ? 1 : 0
    return p
  })
}

export class NodeSqliteExecutor implements SqlExecutor {
  readonly kind = 'sqlite' as const
  private readonly db: NodeDatabase

  constructor(db: NodeDatabase) {
    this.db = db
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql)
  }

  async run(sql: string, params: SqlParam[] = []): Promise<RunResult> {
    const res = this.db.prepare(sql).run(...normalizeNodeParams(params))
    const changes = typeof res.changes === 'bigint' ? Number(res.changes) : (res.changes ?? 0)
    const lastInsertRowid = res.lastInsertRowid ?? null
    return { changes, lastInsertRowid }
  }

  async get<T>(sql: string, params: SqlParam[] = []): Promise<T | undefined> {
    return this.db.prepare(sql).get(...normalizeNodeParams(params)) as T | undefined
  }

  async all<T>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...normalizeNodeParams(params)) as T[]
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      /* 忽略重复关闭 */
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 远程：Turso SQL over HTTP（纯 fetch）
// ─────────────────────────────────────────────────────────────

interface TursoCell {
  type: 'null' | 'integer' | 'float' | 'text' | 'blob'
  value?: string
  base64?: string
}

interface TursoExecuteResult {
  cols?: Array<{ name: string; decltype?: string | null }>
  rows?: TursoCell[][]
  affected_row_count?: number
  last_insert_rowid?: number | null
}

interface TursoPipelineResponse {
  baton?: string | null
  base_url?: string | null
  results?: Array<{
    type: 'ok' | 'error'
    response?: { type: string; result?: TursoExecuteResult }
    error?: { message?: string; code?: string }
  }>
}

/** 把 libsql:// 与 turso:// 规范化为 https:// */
export function normalizeDatabaseUrl(raw: string): string {
  const url = raw.trim().replace(/\/+$/, '')
  if (url.startsWith('libsql://')) return `https://${url.slice('libsql://'.length)}`
  if (url.startsWith('turso://')) return `https://${url.slice('turso://'.length)}`
  return url
}

export function encodeArg(param: SqlParam): TursoCell {
  if (param === null || param === undefined) return { type: 'null' }
  if (typeof param === 'boolean') return { type: 'integer', value: param ? '1' : '0' }
  if (typeof param === 'bigint') return { type: 'integer', value: param.toString() }
  if (typeof param === 'number') {
    return Number.isInteger(param)
      ? { type: 'integer', value: String(param) }
      : { type: 'float', value: String(param) }
  }
  if (typeof param === 'string') return { type: 'text', value: param }
  // Uint8Array → blob（协议要求 base64）
  return { type: 'blob', base64: Buffer.from(param).toString('base64') }
}

export function decodeCell(cell: TursoCell): unknown {
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

function decodeRow<T>(cells: TursoCell[], cols: Array<{ name: string }> | undefined): T {
  const row: Record<string, unknown> = {}
  const names = cols?.map((c) => c.name) ?? []
  cells.forEach((cell, i) => {
    const key = names[i] ?? String(i)
    row[key] = decodeCell(cell)
  })
  return row as T
}

export interface TursoExecutorOptions {
  url: string
  token: string
  /** 单次请求超时（毫秒） */
  timeoutMs?: number
  /** 注入用（测试可替换 fetch） */
  fetchImpl?: typeof fetch
}

export class TursoExecutor implements SqlExecutor {
  readonly kind = 'turso' as const
  private readonly endpoint: string
  private readonly token: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: TursoExecutorOptions) {
    this.endpoint = `${normalizeDatabaseUrl(options.url)}/v2/pipeline`
    this.token = options.token
    this.timeoutMs = options.timeoutMs ?? 20_000
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  private async pipeline(requests: Array<Record<string, unknown>>): Promise<TursoPipelineResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        // 显式 close：文档指出连接闲置 10 秒才回收，主动关闭避免连接泄漏
        body: JSON.stringify({ requests: [...requests, { type: 'close' }] }),
        signal: controller.signal,
      })
      const text = await res.text()
      if (!res.ok) {
        throw new Error(`Turso 返回 HTTP ${res.status}：${text.slice(0, 200)}`)
      }
      let json: TursoPipelineResponse
      try {
        json = JSON.parse(text) as TursoPipelineResponse
      } catch {
        throw new Error(`Turso 返回了非 JSON 内容：${text.slice(0, 200)}`)
      }
      const failed = (json.results ?? []).find((r) => r.type === 'error')
      if (failed) {
        throw new Error(`Turso 执行失败：${failed.error?.message ?? failed.error?.code ?? '未知错误'}`)
      }
      return json
    } finally {
      clearTimeout(timer)
    }
  }

  private executeStmt(sql: string, params: SqlParam[] = []): Record<string, unknown> {
    return {
      type: 'execute',
      stmt: params.length > 0 ? { sql, args: params.map(encodeArg) } : { sql },
    }
  }

  private firstResult(json: TursoPipelineResponse, index = 0): TursoExecuteResult {
    const entry = json.results?.[index]
    return entry?.response?.result ?? {}
  }

  async exec(sql: string): Promise<void> {
    const statements = splitStatements(sql).filter((s) => !/^PRAGMA\s+journal_mode/i.test(s))
    if (statements.length === 0) return
    await this.pipeline(statements.map((s) => this.executeStmt(s)))
  }

  async run(sql: string, params: SqlParam[] = []): Promise<RunResult> {
    const json = await this.pipeline([this.executeStmt(sql, params)])
    const result = this.firstResult(json)
    return {
      changes: result.affected_row_count ?? 0,
      lastInsertRowid: result.last_insert_rowid ?? null,
    }
  }

  async get<T>(sql: string, params: SqlParam[] = []): Promise<T | undefined> {
    const json = await this.pipeline([this.executeStmt(sql, params)])
    const result = this.firstResult(json)
    const cells = result.rows?.[0]
    if (!cells) return undefined
    return decodeRow<T>(cells, result.cols)
  }

  async all<T>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    const json = await this.pipeline([this.executeStmt(sql, params)])
    const result = this.firstResult(json)
    return (result.rows ?? []).map((cells) => decodeRow<T>(cells, result.cols))
  }

  close(): void {
    /* HTTP 无长连接需要关闭 */
  }
}
