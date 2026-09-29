import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { env } from '@/lib/env'
import { AppError } from '@/lib/errors'
import { logger } from '@/lib/obs/logger'
import { DDL, SCHEMA_VERSION } from './schema'
import { newId, nowIso } from '@/lib/ids'
import { NodeSqliteExecutor, TursoExecutor, type SqlExecutor } from './executor'

// ─────────────────────────────────────────────────────────────
// 实体类型（见 docs/03-项目流程Spec.md §4）
// ─────────────────────────────────────────────────────────────

export interface UserRow {
  id: string
  email: string
  password_hash: string
  display_name: string
  created_at: string
  updated_at: string
}

export interface ProjectRow {
  id: string
  owner_id: string
  name: string
  description: string
  schema_version: number
  current_spec_version: number | null
  created_at: string
  updated_at: string
}

export type SessionStatus =
  | 'idle'
  | 'planning'
  | 'awaiting_confirm'
  | 'generating'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'cancelled'

export interface SessionRow {
  id: string
  project_id: string
  title: string
  status: SessionStatus
  created_at: string
  updated_at: string
}

export interface MessageRow {
  id: string
  session_id: string
  role: 'user' | 'agent' | 'system'
  content: string
  run_id: string | null
  created_at: string
}

export type RunStatus = 'pending' | 'running' | 'awaiting_confirm' | 'succeeded' | 'failed' | 'cancelled'
export type RunMode = 'create' | 'iterate'

export interface RunRow {
  id: string
  session_id: string
  project_id: string
  status: RunStatus
  stage: string
  mode: RunMode
  require_confirm: number
  user_input: string
  error_code: string | null
  error_message: string | null
  token_usage: number
  call_count: number
  started_at: string
  finished_at: string | null
  updated_at: string
}

export type ArtifactType =
  | 'plan'
  | 'contract'
  | 'pages'
  | 'dataModel'
  | 'spec'
  | 'verification'
  | 'repair'
  | 'export'

export interface ArtifactRow {
  id: string
  run_id: string
  project_id: string
  type: ArtifactType
  summary: string
  payload: string
  created_at: string
}

export interface SpecVersionRow {
  id: string
  project_id: string
  version: number
  spec: string
  parent_version: number | null
  change_summary: string
  created_at: string
}

export interface AppRecordRow {
  id: string
  project_id: string
  collection: string
  data: string
  created_at: string
  updated_at: string
}

export interface EventLogRow {
  id: string
  run_id: string
  event_id: number
  type: string
  payload: string
  created_at: string
}

// ─────────────────────────────────────────────────────────────
// 存储适配器接口（I-08）：所有模块只能通过它读写数据
//
// ⚠️ 所有方法均为**异步**：远程数据库只能经 HTTP 访问，同步接口无法承载。
//    这样本地 SQLite 与 Turso（线上）可以共用同一套上层代码。
// ─────────────────────────────────────────────────────────────

export interface StoreProvider {
  readonly kind: 'sqlite' | 'turso'
  readonly schemaVersion: number

  // users
  createUser(input: { email: string; passwordHash: string; displayName: string }): Promise<UserRow>
  findUserByEmail(email: string): Promise<UserRow | null>
  findUserById(id: string): Promise<UserRow | null>

  // projects
  createProject(input: { ownerId: string; name: string; description?: string }): Promise<ProjectRow>
  listProjectsByOwner(ownerId: string): Promise<ProjectRow[]>
  getProjectForOwner(id: string, ownerId: string): Promise<ProjectRow | null>
  /** 归属校验：不属于该用户时抛出 NOT_FOUND（避免"忘记检查返回值"导致越权） */
  requireProjectForOwner(id: string, ownerId: string): Promise<ProjectRow>
  getProject(id: string): Promise<ProjectRow | null>
  updateProject(id: string, patch: { name?: string; description?: string }): Promise<ProjectRow>
  setCurrentSpecVersion(projectId: string, version: number): Promise<void>
  deleteProject(id: string): Promise<void>

  // sessions & messages
  createSession(input: { projectId: string; title?: string }): Promise<SessionRow>
  getSession(id: string): Promise<SessionRow | null>
  listSessions(projectId: string): Promise<SessionRow[]>
  updateSession(id: string, patch: { title?: string; status?: SessionStatus }): Promise<void>
  addMessage(input: {
    sessionId: string
    role: MessageRow['role']
    content: string
    runId?: string | null
  }): Promise<MessageRow>
  listMessages(sessionId: string): Promise<MessageRow[]>

  // runs
  createRun(input: {
    sessionId: string
    projectId: string
    mode: RunMode
    userInput: string
    requireConfirm: boolean
  }): Promise<RunRow>
  getRun(id: string): Promise<RunRow | null>
  listRunsByProject(projectId: string, limit?: number): Promise<RunRow[]>
  findActiveRunBySession(sessionId: string): Promise<RunRow | null>
  updateRun(
    id: string,
    patch: Partial<{
      status: RunStatus
      stage: string
      errorCode: string | null
      errorMessage: string | null
      finishedAt: string | null
    }>,
  ): Promise<void>
  addRunUsage(id: string, tokens: number, calls: number): Promise<void>

  // artifacts
  addArtifact(input: {
    runId: string
    projectId: string
    type: ArtifactType
    summary?: string
    payload: unknown
  }): Promise<ArtifactRow>
  listArtifactsByRun(runId: string): Promise<ArtifactRow[]>
  getLatestArtifact(projectId: string, type: ArtifactType): Promise<ArtifactRow | null>

  // spec versions
  addSpecVersion(input: {
    projectId: string
    spec: unknown
    parentVersion: number | null
    changeSummary?: string
  }): Promise<SpecVersionRow>
  getSpecVersion(projectId: string, version: number): Promise<SpecVersionRow | null>
  getLatestSpecVersion(projectId: string): Promise<SpecVersionRow | null>
  listSpecVersions(projectId: string): Promise<SpecVersionRow[]>

  // generated-app data
  listRecords(projectId: string, collection: string): Promise<AppRecordRow[]>
  createRecord(projectId: string, collection: string, data: Record<string, unknown>): Promise<AppRecordRow>
  updateRecord(
    projectId: string,
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<AppRecordRow | null>
  deleteRecord(projectId: string, collection: string, id: string): Promise<boolean>
  listCollections(projectId: string): Promise<string[]>

  // events (I-05 / M12)
  appendEvent(runId: string, type: string, payload: unknown): Promise<EventLogRow>
  listEventsSince(runId: string, afterEventId: number, limit?: number): Promise<EventLogRow[]>
  listEvents(runId: string): Promise<EventLogRow[]>

  close(): void
}

export function rowToJson<T>(value: string): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return {} as T
  }
}

// ─────────────────────────────────────────────────────────────
// 懒初始化执行器：首次访问时才建表（远程 DDL 是异步的）
// ─────────────────────────────────────────────────────────────

class SchemaInitExecutor implements SqlExecutor {
  readonly kind: 'sqlite' | 'turso'
  private readonly inner: SqlExecutor
  private ready: Promise<void> | null = null

  // 注意：不要用 TS 参数属性（constructor(private x)）——
  // Node 的 strip-only 类型剥离不支持该语法，测试会直接加载失败。
  constructor(inner: SqlExecutor) {
    this.inner = inner
    this.kind = inner.kind
  }

  private ensure(): Promise<void> {
    if (!this.ready) {
      this.ready = this.inner.exec(DDL).catch((err) => {
        this.ready = null // 失败后允许重试，避免永久卡死
        throw new Error(`数据库初始化失败：${err instanceof Error ? err.message : String(err)}`)
      })
    }
    return this.ready
  }

  async exec(sql: string): Promise<void> {
    await this.ensure()
    await this.inner.exec(sql)
  }

  async run(sql: string, params?: Parameters<SqlExecutor['run']>[1]) {
    await this.ensure()
    return this.inner.run(sql, params)
  }

  async get<T>(sql: string, params?: Parameters<SqlExecutor['get']>[1]) {
    await this.ensure()
    return this.inner.get<T>(sql, params)
  }

  async all<T>(sql: string, params?: Parameters<SqlExecutor['all']>[1]) {
    await this.ensure()
    return this.inner.all<T>(sql, params)
  }

  close(): void {
    this.inner.close()
  }
}

// ─────────────────────────────────────────────────────────────
// 唯一实现：同一套 SQL，跑在可替换的执行器上
// ─────────────────────────────────────────────────────────────

class SqlStore implements StoreProvider {
  readonly kind: 'sqlite' | 'turso'
  readonly schemaVersion = SCHEMA_VERSION
  private readonly executor: SqlExecutor

  constructor(executor: SqlExecutor) {
    this.executor = new SchemaInitExecutor(executor)
    this.kind = executor.kind
  }

  close(): void {
    this.executor.close()
  }

  // ── users ──
  async createUser(input: { email: string; passwordHash: string; displayName: string }): Promise<UserRow> {
    const now = nowIso()
    const row: UserRow = {
      id: newId('user'),
      email: input.email.toLowerCase(),
      password_hash: input.passwordHash,
      display_name: input.displayName,
      created_at: now,
      updated_at: now,
    }
    await this.executor.run(
      `INSERT INTO users (id,email,password_hash,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
      [row.id, row.email, row.password_hash, row.display_name, row.created_at, row.updated_at],
    )
    return row
  }

  async findUserByEmail(email: string): Promise<UserRow | null> {
    const r = await this.executor.get<UserRow>(`SELECT * FROM users WHERE email = ?`, [email.toLowerCase()])
    return r ?? null
  }

  async findUserById(id: string): Promise<UserRow | null> {
    const r = await this.executor.get<UserRow>(`SELECT * FROM users WHERE id = ?`, [id])
    return r ?? null
  }

  // ── projects ──
  async createProject(input: { ownerId: string; name: string; description?: string }): Promise<ProjectRow> {
    const now = nowIso()
    const row: ProjectRow = {
      id: newId('proj'),
      owner_id: input.ownerId,
      name: input.name,
      description: input.description ?? '',
      schema_version: SCHEMA_VERSION,
      current_spec_version: null,
      created_at: now,
      updated_at: now,
    }
    await this.executor.run(
      `INSERT INTO projects (id,owner_id,name,description,schema_version,current_spec_version,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        row.id,
        row.owner_id,
        row.name,
        row.description,
        row.schema_version,
        row.current_spec_version,
        row.created_at,
        row.updated_at,
      ],
    )
    return row
  }

  async listProjectsByOwner(ownerId: string): Promise<ProjectRow[]> {
    return this.executor.all<ProjectRow>(
      `SELECT * FROM projects WHERE owner_id = ? ORDER BY updated_at DESC`,
      [ownerId],
    )
  }

  async getProjectForOwner(id: string, ownerId: string): Promise<ProjectRow | null> {
    const r = await this.executor.get<ProjectRow>(`SELECT * FROM projects WHERE id = ? AND owner_id = ?`, [
      id,
      ownerId,
    ])
    return r ?? null
  }

  async requireProjectForOwner(id: string, ownerId: string): Promise<ProjectRow> {
    const project = await this.getProjectForOwner(id, ownerId)
    if (!project) {
      // 统一返回 NOT_FOUND：不通过错误码泄露"资源是否存在"
      throw new AppError('NOT_FOUND', '项目不存在或你没有访问权限', '返回项目列表重新选择')
    }
    return project
  }

  async getProject(id: string): Promise<ProjectRow | null> {
    const r = await this.executor.get<ProjectRow>(`SELECT * FROM projects WHERE id = ?`, [id])
    return r ?? null
  }

  async updateProject(id: string, patch: { name?: string; description?: string }): Promise<ProjectRow> {
    const cur = await this.getProject(id)
    if (!cur) throw new Error(`project not found: ${id}`)
    const name = patch.name ?? cur.name
    const description = patch.description ?? cur.description
    await this.executor.run(`UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE id = ?`, [
      name,
      description,
      nowIso(),
      id,
    ])
    return { ...cur, name, description }
  }

  async setCurrentSpecVersion(projectId: string, version: number): Promise<void> {
    await this.executor.run(`UPDATE projects SET current_spec_version = ?, updated_at = ? WHERE id = ?`, [
      version,
      nowIso(),
      projectId,
    ])
  }

  async deleteProject(id: string): Promise<void> {
    await this.executor.run(`DELETE FROM projects WHERE id = ?`, [id])
  }

  // ── sessions & messages ──
  async createSession(input: { projectId: string; title?: string }): Promise<SessionRow> {
    const now = nowIso()
    const row: SessionRow = {
      id: newId('sess'),
      project_id: input.projectId,
      title: input.title ?? '新建会话',
      status: 'idle',
      created_at: now,
      updated_at: now,
    }
    await this.executor.run(
      `INSERT INTO sessions (id,project_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
      [row.id, row.project_id, row.title, row.status, row.created_at, row.updated_at],
    )
    return row
  }

  async getSession(id: string): Promise<SessionRow | null> {
    const r = await this.executor.get<SessionRow>(`SELECT * FROM sessions WHERE id = ?`, [id])
    return r ?? null
  }

  async listSessions(projectId: string): Promise<SessionRow[]> {
    return this.executor.all<SessionRow>(
      `SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at DESC`,
      [projectId],
    )
  }

  async updateSession(id: string, patch: { title?: string; status?: SessionStatus }): Promise<void> {
    const cur = await this.getSession(id)
    if (!cur) return
    await this.executor.run(`UPDATE sessions SET title = ?, status = ?, updated_at = ? WHERE id = ?`, [
      patch.title ?? cur.title,
      patch.status ?? cur.status,
      nowIso(),
      id,
    ])
  }

  async addMessage(input: {
    sessionId: string
    role: MessageRow['role']
    content: string
    runId?: string | null
  }): Promise<MessageRow> {
    const row: MessageRow = {
      id: newId('msg'),
      session_id: input.sessionId,
      role: input.role,
      content: input.content,
      run_id: input.runId ?? null,
      created_at: nowIso(),
    }
    await this.executor.run(
      `INSERT INTO messages (id,session_id,role,content,run_id,created_at) VALUES (?,?,?,?,?,?)`,
      [row.id, row.session_id, row.role, row.content, row.run_id, row.created_at],
    )
    return row
  }

  async listMessages(sessionId: string): Promise<MessageRow[]> {
    return this.executor.all<MessageRow>(
      `SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC`,
      [sessionId],
    )
  }

  // ── runs ──
  async createRun(input: {
    sessionId: string
    projectId: string
    mode: RunMode
    userInput: string
    requireConfirm: boolean
  }): Promise<RunRow> {
    const now = nowIso()
    const row: RunRow = {
      id: newId('run'),
      session_id: input.sessionId,
      project_id: input.projectId,
      status: 'pending',
      stage: 'created',
      mode: input.mode,
      require_confirm: input.requireConfirm ? 1 : 0,
      user_input: input.userInput,
      error_code: null,
      error_message: null,
      token_usage: 0,
      call_count: 0,
      started_at: now,
      finished_at: null,
      updated_at: now,
    }
    await this.executor.run(
      `INSERT INTO runs (id,session_id,project_id,status,stage,mode,require_confirm,user_input,
        error_code,error_message,token_usage,call_count,started_at,finished_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        row.id,
        row.session_id,
        row.project_id,
        row.status,
        row.stage,
        row.mode,
        row.require_confirm,
        row.user_input,
        row.error_code,
        row.error_message,
        row.token_usage,
        row.call_count,
        row.started_at,
        row.finished_at,
        row.updated_at,
      ],
    )
    return row
  }

  async getRun(id: string): Promise<RunRow | null> {
    const r = await this.executor.get<RunRow>(`SELECT * FROM runs WHERE id = ?`, [id])
    return r ?? null
  }

  async listRunsByProject(projectId: string, limit = 20): Promise<RunRow[]> {
    return this.executor.all<RunRow>(
      `SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?`,
      [projectId, limit],
    )
  }

  async findActiveRunBySession(sessionId: string): Promise<RunRow | null> {
    const r = await this.executor.get<RunRow>(
      `SELECT * FROM runs WHERE session_id = ? AND status IN ('pending','running','awaiting_confirm')
       ORDER BY started_at DESC LIMIT 1`,
      [sessionId],
    )
    return r ?? null
  }

  async updateRun(
    id: string,
    patch: Partial<{
      status: RunStatus
      stage: string
      errorCode: string | null
      errorMessage: string | null
      finishedAt: string | null
    }>,
  ): Promise<void> {
    const cur = await this.getRun(id)
    if (!cur) return
    await this.executor.run(
      `UPDATE runs SET status=?, stage=?, error_code=?, error_message=?, finished_at=?, updated_at=? WHERE id=?`,
      [
        patch.status ?? cur.status,
        patch.stage ?? cur.stage,
        patch.errorCode === undefined ? cur.error_code : patch.errorCode,
        patch.errorMessage === undefined ? cur.error_message : patch.errorMessage,
        patch.finishedAt === undefined ? cur.finished_at : patch.finishedAt,
        nowIso(),
        id,
      ],
    )
  }

  async addRunUsage(id: string, tokens: number, calls: number): Promise<void> {
    await this.executor.run(
      `UPDATE runs SET token_usage = token_usage + ?, call_count = call_count + ?, updated_at = ? WHERE id = ?`,
      [tokens, calls, nowIso(), id],
    )
  }

  // ── artifacts ──
  async addArtifact(input: {
    runId: string
    projectId: string
    type: ArtifactType
    summary?: string
    payload: unknown
  }): Promise<ArtifactRow> {
    const row: ArtifactRow = {
      id: newId('art'),
      run_id: input.runId,
      project_id: input.projectId,
      type: input.type,
      summary: input.summary ?? '',
      payload: JSON.stringify(input.payload),
      created_at: nowIso(),
    }
    await this.executor.run(
      `INSERT INTO artifacts (id,run_id,project_id,type,summary,payload,created_at) VALUES (?,?,?,?,?,?,?)`,
      [row.id, row.run_id, row.project_id, row.type, row.summary, row.payload, row.created_at],
    )
    return row
  }

  async listArtifactsByRun(runId: string): Promise<ArtifactRow[]> {
    return this.executor.all<ArtifactRow>(`SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at ASC`, [
      runId,
    ])
  }

  async getLatestArtifact(projectId: string, type: ArtifactType): Promise<ArtifactRow | null> {
    const r = await this.executor.get<ArtifactRow>(
      `SELECT * FROM artifacts WHERE project_id = ? AND type = ? ORDER BY created_at DESC LIMIT 1`,
      [projectId, type],
    )
    return r ?? null
  }

  // ── spec versions ──
  async addSpecVersion(input: {
    projectId: string
    spec: unknown
    parentVersion: number | null
    changeSummary?: string
  }): Promise<SpecVersionRow> {
    const id = newId('spec')
    const now = nowIso()
    // 用 INSERT..SELECT 在同一语句内取 MAX(version)+1，避免"先读后写"在并发下的版本号竞争
    await this.executor.run(
      `INSERT INTO spec_versions (id,project_id,version,spec,parent_version,change_summary,created_at)
       SELECT ?, ?, COALESCE(MAX(version), 0) + 1, ?, ?, ?, ? FROM spec_versions WHERE project_id = ?`,
      [id, input.projectId, JSON.stringify(input.spec), input.parentVersion, input.changeSummary ?? '', now, input.projectId],
    )
    // 按主键回读（而不是 ORDER BY version DESC LIMIT 1）：
    // 并发下"最新一行"可能已被别的请求覆盖，会导致返回值错乱。
    const row = await this.executor.get<SpecVersionRow>(`SELECT * FROM spec_versions WHERE id = ?`, [id])
    if (!row) throw new Error('写入 Spec 版本后未能读回，数据库状态异常')
    await this.setCurrentSpecVersion(input.projectId, row.version)
    return row
  }

  async getSpecVersion(projectId: string, version: number): Promise<SpecVersionRow | null> {
    const r = await this.executor.get<SpecVersionRow>(
      `SELECT * FROM spec_versions WHERE project_id = ? AND version = ?`,
      [projectId, version],
    )
    return r ?? null
  }

  async getLatestSpecVersion(projectId: string): Promise<SpecVersionRow | null> {
    const r = await this.executor.get<SpecVersionRow>(
      `SELECT * FROM spec_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1`,
      [projectId],
    )
    return r ?? null
  }

  async listSpecVersions(projectId: string): Promise<SpecVersionRow[]> {
    return this.executor.all<SpecVersionRow>(
      `SELECT * FROM spec_versions WHERE project_id = ? ORDER BY version DESC`,
      [projectId],
    )
  }

  // ── generated-app data ──
  async listRecords(projectId: string, collection: string): Promise<AppRecordRow[]> {
    return this.executor.all<AppRecordRow>(
      `SELECT * FROM app_records WHERE project_id = ? AND collection = ? ORDER BY created_at DESC`,
      [projectId, collection],
    )
  }

  async createRecord(
    projectId: string,
    collection: string,
    data: Record<string, unknown>,
  ): Promise<AppRecordRow> {
    const now = nowIso()
    const row: AppRecordRow = {
      id: newId('rec'),
      project_id: projectId,
      collection,
      data: JSON.stringify(data),
      created_at: now,
      updated_at: now,
    }
    await this.executor.run(
      `INSERT INTO app_records (id,project_id,collection,data,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
      [row.id, row.project_id, row.collection, row.data, row.created_at, row.updated_at],
    )
    return row
  }

  async updateRecord(
    projectId: string,
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<AppRecordRow | null> {
    const r = await this.executor.get<AppRecordRow>(
      `SELECT * FROM app_records WHERE id = ? AND project_id = ? AND collection = ?`,
      [id, projectId, collection],
    )
    if (!r) return null
    const merged = { ...rowToJson<Record<string, unknown>>(r.data), ...data }
    await this.executor.run(`UPDATE app_records SET data = ?, updated_at = ? WHERE id = ?`, [
      JSON.stringify(merged),
      nowIso(),
      id,
    ])
    return { ...r, data: JSON.stringify(merged) }
  }

  async deleteRecord(projectId: string, collection: string, id: string): Promise<boolean> {
    const res = await this.executor.run(
      `DELETE FROM app_records WHERE id = ? AND project_id = ? AND collection = ?`,
      [id, projectId, collection],
    )
    return Number(res.changes ?? 0) > 0
  }

  async listCollections(projectId: string): Promise<string[]> {
    const rows = await this.executor.all<{ collection: string }>(
      `SELECT DISTINCT collection FROM app_records WHERE project_id = ?`,
      [projectId],
    )
    return rows.map((r) => r.collection)
  }

  // ── events ──
  async appendEvent(runId: string, type: string, payload: unknown): Promise<EventLogRow> {
    const id = newId('evt')
    const now = nowIso()
    // 同一语句内取 MAX(event_id)+1，保证 eventId 单调递增且无并发竞争
    await this.executor.run(
      `INSERT INTO event_logs (id,run_id,event_id,type,payload,created_at)
       SELECT ?, ?, COALESCE(MAX(event_id), 0) + 1, ?, ?, ? FROM event_logs WHERE run_id = ?`,
      [id, runId, type, JSON.stringify(payload ?? {}), now, runId],
    )
    // 按主键回读：并发下"最新一行"可能已被其它请求覆盖
    const row = await this.executor.get<EventLogRow>(`SELECT * FROM event_logs WHERE id = ?`, [id])
    if (!row) throw new Error('写入事件后未能读回，数据库状态异常')
    return row
  }

  async listEventsSince(runId: string, afterEventId: number, limit = 200): Promise<EventLogRow[]> {
    return this.executor.all<EventLogRow>(
      `SELECT * FROM event_logs WHERE run_id = ? AND event_id > ? ORDER BY event_id ASC LIMIT ?`,
      [runId, afterEventId, limit],
    )
  }

  async listEvents(runId: string): Promise<EventLogRow[]> {
    return this.executor.all<EventLogRow>(
      `SELECT * FROM event_logs WHERE run_id = ? ORDER BY event_id ASC`,
      [runId],
    )
  }
}

// ─────────────────────────────────────────────────────────────
// 执行器选择：有托管库 URL 就用 Turso，否则用本地 SQLite 文件
// ─────────────────────────────────────────────────────────────

interface LocalDatabase {
  exec(sql: string): void
  prepare(sql: string): unknown
  close(): void
}

/**
 * 懒加载 `node:sqlite`。
 *
 * 为什么不用顶层 `import`：那是**导入期**求值 —— 一旦运行时没有这个内置模块，
 * **整个应用连启动都做不到**，哪怕你只配了 Turso、根本不需要本地 SQLite。
 *
 * 为什么用 `process.getBuiltinModule`（Node 22.3+）：
 * 试过 `createRequire(import.meta.url)('node:sqlite')`，**在 Next 的服务端产物里会失败**
 * （bundle 上下文里 `import.meta.url` 不可靠）—— 单元测试却发现不了，是端到端冒烟抓出来的。
 * `getBuiltinModule` 不做静态分析、也不依赖模块解析，正是为这种场景提供的。
 */
function loadNodeSqlite(): new (path: string) => LocalDatabase {
  const getBuiltin = (process as unknown as { getBuiltinModule?: (name: string) => unknown }).getBuiltinModule
  const mod = typeof getBuiltin === 'function' ? (getBuiltin('node:sqlite') as { DatabaseSync?: unknown } | undefined) : undefined
  if (!mod || typeof mod.DatabaseSync !== 'function') {
    throw new AppError(
      'INTERNAL',
      '当前 Node 运行时不支持内置 SQLite（需要 Node 22.5+，推荐 24）',
      '请配置 TURSO_DATABASE_URL 使用托管数据库，或把 Node 升级到 24',
    )
  }
  return mod.DatabaseSync as new (path: string) => LocalDatabase
}

/**
 * 打开本地 SQLite：优先项目内的 `.data/`，**不可写时退回系统临时目录**。
 *
 * 为什么需要退回：Vercel 这类 Serverless 的文件系统是**只读**的，
 * `new DatabaseSync('.data/atoms.db')` 会直接抛错 → 整个站点 500。
 * 退回 `/tmp` 至少能跑起来（同一实例内数据仍在），但**不持久**，
 * 因此这里必须留下醒目告警，引导配置托管库（docs/06 §3.2）。
 */
function openLocalDatabase(): LocalDatabase {
  const DatabaseSync = loadNodeSqlite()
  const candidates = [env.dbFile, join(tmpdir(), 'atoms.db')]
  let lastError: unknown = null

  for (let i = 0; i < candidates.length; i += 1) {
    const file = candidates[i]
    try {
      mkdirSync(dirname(file), { recursive: true })
      const db = new DatabaseSync(file)
      if (i > 0) {
        logger.warn({
          event: 'storage.fallback',
          message: `数据目录不可写（${env.dbFile}），已退回临时目录 ${file}`,
          impact: '数据在实例回收后会丢失；线上持久化请配置 TURSO_DATABASE_URL',
        })
      }
      return db
    } catch (err) {
      lastError = err
    }
  }

  throw new AppError(
    'INTERNAL',
    `无法打开本地数据库：${lastError instanceof Error ? lastError.message : String(lastError)}`,
    '请配置 TURSO_DATABASE_URL 使用托管数据库（Serverless 的文件系统通常是只读的）',
  )
}

export function createExecutor(): SqlExecutor {
  const url = env.databaseUrl
  if (url !== '') {
    return new TursoExecutor({ url, token: env.databaseToken, timeoutMs: env.databaseTimeoutMs })
  }
  return new NodeSqliteExecutor(openLocalDatabase() as never)
}

// HMR 下复用同一连接（Next dev 会重复求值模块）
const globalForStore = globalThis as unknown as { __atomsStore?: StoreProvider }

export function getStore(): StoreProvider {
  if (!globalForStore.__atomsStore) {
    globalForStore.__atomsStore = new SqlStore(createExecutor())
  }
  return globalForStore.__atomsStore
}

/** 仅用于测试：重置单例并关闭连接 */
export function resetStore(): void {
  globalForStore.__atomsStore?.close()
  globalForStore.__atomsStore = undefined
}

/**
 * 用指定执行器创建存储实例。
 * 用途：测试（对 Turso 协议做端到端验证时，可注入指向本地模拟服务的执行器），
 * 以及将来需要同时连多个库的场景。
 */
export function createStoreWithExecutor(executor: SqlExecutor): StoreProvider {
  return new SqlStore(executor)
}
