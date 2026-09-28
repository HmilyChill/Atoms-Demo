import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { env } from '@/lib/env'
import { AppError } from '@/lib/errors'
import { DDL, SCHEMA_VERSION } from './schema'
import { newId, nowIso } from '@/lib/ids'

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

export type SessionStatus = 'idle' | 'planning' | 'awaiting_confirm' | 'generating' | 'verifying' | 'done' | 'failed' | 'cancelled'

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
// ─────────────────────────────────────────────────────────────

export interface StoreProvider {
  readonly kind: string
  readonly schemaVersion: number

  // users
  createUser(input: { email: string; passwordHash: string; displayName: string }): UserRow
  findUserByEmail(email: string): UserRow | null
  findUserById(id: string): UserRow | null

  // projects
  createProject(input: { ownerId: string; name: string; description?: string }): ProjectRow
  listProjectsByOwner(ownerId: string): ProjectRow[]
  getProjectForOwner(id: string, ownerId: string): ProjectRow | null
  /**
   * 归属校验（I-01）：不属于该用户时抛出 NOT_FOUND。
   * 所有对外入口必须使用本方法，避免"忘记检查返回值"导致的越权（IDOR）。
   */
  requireProjectForOwner(id: string, ownerId: string): ProjectRow
  getProject(id: string): ProjectRow | null
  updateProject(id: string, patch: { name?: string; description?: string }): ProjectRow
  setCurrentSpecVersion(projectId: string, version: number): void
  deleteProject(id: string): void

  // sessions & messages
  createSession(input: { projectId: string; title?: string }): SessionRow
  getSession(id: string): SessionRow | null
  listSessions(projectId: string): SessionRow[]
  updateSession(id: string, patch: { title?: string; status?: SessionStatus }): void
  addMessage(input: { sessionId: string; role: MessageRow['role']; content: string; runId?: string | null }): MessageRow
  listMessages(sessionId: string): MessageRow[]

  // runs
  createRun(input: {
    sessionId: string
    projectId: string
    mode: RunMode
    userInput: string
    requireConfirm: boolean
  }): RunRow
  getRun(id: string): RunRow | null
  listRunsByProject(projectId: string, limit?: number): RunRow[]
  findActiveRunBySession(sessionId: string): RunRow | null
  updateRun(
    id: string,
    patch: Partial<{
      status: RunStatus
      stage: string
      errorCode: string | null
      errorMessage: string | null
      finishedAt: string | null
    }>,
  ): void
  addRunUsage(id: string, tokens: number, calls: number): void

  // artifacts
  addArtifact(input: {
    runId: string
    projectId: string
    type: ArtifactType
    summary?: string
    payload: unknown
  }): ArtifactRow
  listArtifactsByRun(runId: string): ArtifactRow[]
  getLatestArtifact(projectId: string, type: ArtifactType): ArtifactRow | null

  // spec versions
  addSpecVersion(input: {
    projectId: string
    spec: unknown
    parentVersion: number | null
    changeSummary?: string
  }): SpecVersionRow
  getSpecVersion(projectId: string, version: number): SpecVersionRow | null
  getLatestSpecVersion(projectId: string): SpecVersionRow | null
  listSpecVersions(projectId: string): SpecVersionRow[]

  // generated-app data
  listRecords(projectId: string, collection: string): AppRecordRow[]
  createRecord(projectId: string, collection: string, data: Record<string, unknown>): AppRecordRow
  updateRecord(projectId: string, collection: string, id: string, data: Record<string, unknown>): AppRecordRow | null
  deleteRecord(projectId: string, collection: string, id: string): boolean
  listCollections(projectId: string): string[]

  // events (I-05 / M12)
  appendEvent(runId: string, type: string, payload: unknown): EventLogRow
  listEventsSince(runId: string, afterEventId: number, limit?: number): EventLogRow[]
  listEvents(runId: string): EventLogRow[]

  close(): void
}

function rowToJson<T>(value: string): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return {} as T
  }
}

export { rowToJson }

class SqliteStore implements StoreProvider {
  readonly kind = 'sqlite'
  readonly schemaVersion = SCHEMA_VERSION
  private db: DatabaseSync

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec(DDL)
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      /* 忽略重复关闭 */
    }
  }

  // ── users ──
  createUser(input: { email: string; passwordHash: string; displayName: string }): UserRow {
    const now = nowIso()
    const row: UserRow = {
      id: newId('user'),
      email: input.email.toLowerCase(),
      password_hash: input.passwordHash,
      display_name: input.displayName,
      created_at: now,
      updated_at: now,
    }
    this.db
      .prepare(
        `INSERT INTO users (id,email,password_hash,display_name,created_at,updated_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(row.id, row.email, row.password_hash, row.display_name, row.created_at, row.updated_at)
    return row
  }

  findUserByEmail(email: string): UserRow | null {
    const r = this.db.prepare(`SELECT * FROM users WHERE email = ?`).get(email.toLowerCase())
    return (r as UserRow | undefined) ?? null
  }

  findUserById(id: string): UserRow | null {
    const r = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(id)
    return (r as UserRow | undefined) ?? null
  }

  // ── projects ──
  createProject(input: { ownerId: string; name: string; description?: string }): ProjectRow {
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
    this.db
      .prepare(
        `INSERT INTO projects (id,owner_id,name,description,schema_version,current_spec_version,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id,
        row.owner_id,
        row.name,
        row.description,
        row.schema_version,
        row.current_spec_version,
        row.created_at,
        row.updated_at,
      )
    return row
  }

  listProjectsByOwner(ownerId: string): ProjectRow[] {
    return this.db
      .prepare(`SELECT * FROM projects WHERE owner_id = ? ORDER BY updated_at DESC`)
      .all(ownerId) as unknown as ProjectRow[]
  }

  getProjectForOwner(id: string, ownerId: string): ProjectRow | null {
    const r = this.db.prepare(`SELECT * FROM projects WHERE id = ? AND owner_id = ?`).get(id, ownerId)
    return (r as ProjectRow | undefined) ?? null
  }

  requireProjectForOwner(id: string, ownerId: string): ProjectRow {
    const project = this.getProjectForOwner(id, ownerId)
    if (!project) {
      // 统一返回 NOT_FOUND：不通过错误码泄露"资源是否存在"
      throw new AppError('NOT_FOUND', '项目不存在或你没有访问权限', '返回项目列表重新选择')
    }
    return project
  }

  getProject(id: string): ProjectRow | null {
    const r = this.db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id)
    return (r as ProjectRow | undefined) ?? null
  }

  updateProject(id: string, patch: { name?: string; description?: string }): ProjectRow {
    const cur = this.getProject(id)
    if (!cur) throw new Error(`project not found: ${id}`)
    const name = patch.name ?? cur.name
    const description = patch.description ?? cur.description
    this.db
      .prepare(`UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE id = ?`)
      .run(name, description, nowIso(), id)
    return { ...cur, name, description }
  }

  setCurrentSpecVersion(projectId: string, version: number): void {
    this.db
      .prepare(`UPDATE projects SET current_spec_version = ?, updated_at = ? WHERE id = ?`)
      .run(version, nowIso(), projectId)
  }

  deleteProject(id: string): void {
    this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(id)
  }

  // ── sessions & messages ──
  createSession(input: { projectId: string; title?: string }): SessionRow {
    const now = nowIso()
    const row: SessionRow = {
      id: newId('sess'),
      project_id: input.projectId,
      title: input.title ?? '新建会话',
      status: 'idle',
      created_at: now,
      updated_at: now,
    }
    this.db
      .prepare(`INSERT INTO sessions (id,project_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
      .run(row.id, row.project_id, row.title, row.status, row.created_at, row.updated_at)
    return row
  }

  getSession(id: string): SessionRow | null {
    const r = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id)
    return (r as SessionRow | undefined) ?? null
  }

  listSessions(projectId: string): SessionRow[] {
    return this.db
      .prepare(`SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at DESC`)
      .all(projectId) as unknown as SessionRow[]
  }

  updateSession(id: string, patch: { title?: string; status?: SessionStatus }): void {
    const cur = this.getSession(id)
    if (!cur) return
    this.db
      .prepare(`UPDATE sessions SET title = ?, status = ?, updated_at = ? WHERE id = ?`)
      .run(patch.title ?? cur.title, patch.status ?? cur.status, nowIso(), id)
  }

  addMessage(input: {
    sessionId: string
    role: MessageRow['role']
    content: string
    runId?: string | null
  }): MessageRow {
    const row: MessageRow = {
      id: newId('msg'),
      session_id: input.sessionId,
      role: input.role,
      content: input.content,
      run_id: input.runId ?? null,
      created_at: nowIso(),
    }
    this.db
      .prepare(`INSERT INTO messages (id,session_id,role,content,run_id,created_at) VALUES (?,?,?,?,?,?)`)
      .run(row.id, row.session_id, row.role, row.content, row.run_id, row.created_at)
    return row
  }

  listMessages(sessionId: string): MessageRow[] {
    return this.db
      .prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC`)
      .all(sessionId) as unknown as MessageRow[]
  }

  // ── runs ──
  createRun(input: {
    sessionId: string
    projectId: string
    mode: RunMode
    userInput: string
    requireConfirm: boolean
  }): RunRow {
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
    this.db
      .prepare(
        `INSERT INTO runs (id,session_id,project_id,status,stage,mode,require_confirm,user_input,
          error_code,error_message,token_usage,call_count,started_at,finished_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
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
      )
    return row
  }

  getRun(id: string): RunRow | null {
    const r = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id)
    return (r as RunRow | undefined) ?? null
  }

  listRunsByProject(projectId: string, limit = 20): RunRow[] {
    return this.db
      .prepare(`SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?`)
      .all(projectId, limit) as unknown as RunRow[]
  }

  findActiveRunBySession(sessionId: string): RunRow | null {
    const r = this.db
      .prepare(
        `SELECT * FROM runs WHERE session_id = ? AND status IN ('pending','running','awaiting_confirm')
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(sessionId)
    return (r as RunRow | undefined) ?? null
  }

  updateRun(
    id: string,
    patch: Partial<{
      status: RunStatus
      stage: string
      errorCode: string | null
      errorMessage: string | null
      finishedAt: string | null
    }>,
  ): void {
    const cur = this.getRun(id)
    if (!cur) return
    this.db
      .prepare(
        `UPDATE runs SET status=?, stage=?, error_code=?, error_message=?, finished_at=?, updated_at=? WHERE id=?`,
      )
      .run(
        patch.status ?? cur.status,
        patch.stage ?? cur.stage,
        patch.errorCode === undefined ? cur.error_code : patch.errorCode,
        patch.errorMessage === undefined ? cur.error_message : patch.errorMessage,
        patch.finishedAt === undefined ? cur.finished_at : patch.finishedAt,
        nowIso(),
        id,
      )
  }

  addRunUsage(id: string, tokens: number, calls: number): void {
    this.db
      .prepare(`UPDATE runs SET token_usage = token_usage + ?, call_count = call_count + ?, updated_at = ? WHERE id = ?`)
      .run(tokens, calls, nowIso(), id)
  }

  // ── artifacts ──
  addArtifact(input: {
    runId: string
    projectId: string
    type: ArtifactType
    summary?: string
    payload: unknown
  }): ArtifactRow {
    const row: ArtifactRow = {
      id: newId('art'),
      run_id: input.runId,
      project_id: input.projectId,
      type: input.type,
      summary: input.summary ?? '',
      payload: JSON.stringify(input.payload),
      created_at: nowIso(),
    }
    this.db
      .prepare(`INSERT INTO artifacts (id,run_id,project_id,type,summary,payload,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(row.id, row.run_id, row.project_id, row.type, row.summary, row.payload, row.created_at)
    return row
  }

  listArtifactsByRun(runId: string): ArtifactRow[] {
    return this.db
      .prepare(`SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at ASC`)
      .all(runId) as unknown as ArtifactRow[]
  }

  getLatestArtifact(projectId: string, type: ArtifactType): ArtifactRow | null {
    const r = this.db
      .prepare(`SELECT * FROM artifacts WHERE project_id = ? AND type = ? ORDER BY created_at DESC LIMIT 1`)
      .get(projectId, type)
    return (r as ArtifactRow | undefined) ?? null
  }

  // ── spec versions ──
  addSpecVersion(input: {
    projectId: string
    spec: unknown
    parentVersion: number | null
    changeSummary?: string
  }): SpecVersionRow {
    const latest = this.getLatestSpecVersion(input.projectId)
    const version = (latest?.version ?? 0) + 1
    const row: SpecVersionRow = {
      id: newId('spec'),
      project_id: input.projectId,
      version,
      spec: JSON.stringify(input.spec),
      parent_version: input.parentVersion,
      change_summary: input.changeSummary ?? '',
      created_at: nowIso(),
    }
    this.db
      .prepare(
        `INSERT INTO spec_versions (id,project_id,version,spec,parent_version,change_summary,created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(row.id, row.project_id, row.version, row.spec, row.parent_version, row.change_summary, row.created_at)
    this.setCurrentSpecVersion(input.projectId, version)
    return row
  }

  getSpecVersion(projectId: string, version: number): SpecVersionRow | null {
    const r = this.db
      .prepare(`SELECT * FROM spec_versions WHERE project_id = ? AND version = ?`)
      .get(projectId, version)
    return (r as SpecVersionRow | undefined) ?? null
  }

  getLatestSpecVersion(projectId: string): SpecVersionRow | null {
    const r = this.db
      .prepare(`SELECT * FROM spec_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1`)
      .get(projectId)
    return (r as SpecVersionRow | undefined) ?? null
  }

  listSpecVersions(projectId: string): SpecVersionRow[] {
    return this.db
      .prepare(`SELECT * FROM spec_versions WHERE project_id = ? ORDER BY version DESC`)
      .all(projectId) as unknown as SpecVersionRow[]
  }

  // ── generated-app data ──
  listRecords(projectId: string, collection: string): AppRecordRow[] {
    return this.db
      .prepare(`SELECT * FROM app_records WHERE project_id = ? AND collection = ? ORDER BY created_at DESC`)
      .all(projectId, collection) as unknown as AppRecordRow[]
  }

  createRecord(projectId: string, collection: string, data: Record<string, unknown>): AppRecordRow {
    const now = nowIso()
    const row: AppRecordRow = {
      id: newId('rec'),
      project_id: projectId,
      collection,
      data: JSON.stringify(data),
      created_at: now,
      updated_at: now,
    }
    this.db
      .prepare(`INSERT INTO app_records (id,project_id,collection,data,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
      .run(row.id, row.project_id, row.collection, row.data, row.created_at, row.updated_at)
    return row
  }

  updateRecord(
    projectId: string,
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): AppRecordRow | null {
    const r = this.db
      .prepare(`SELECT * FROM app_records WHERE id = ? AND project_id = ? AND collection = ?`)
      .get(id, projectId, collection) as AppRecordRow | undefined
    if (!r) return null
    const merged = { ...rowToJson<Record<string, unknown>>(r.data), ...data }
    this.db
      .prepare(`UPDATE app_records SET data = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(merged), nowIso(), id)
    return { ...r, data: JSON.stringify(merged) }
  }

  deleteRecord(projectId: string, collection: string, id: string): boolean {
    const res = this.db
      .prepare(`DELETE FROM app_records WHERE id = ? AND project_id = ? AND collection = ?`)
      .run(id, projectId, collection)
    return Number(res.changes ?? 0) > 0
  }

  listCollections(projectId: string): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT collection FROM app_records WHERE project_id = ?`)
      .all(projectId) as unknown as Array<{ collection: string }>
    return rows.map((r) => r.collection)
  }

  // ── events ──
  appendEvent(runId: string, type: string, payload: unknown): EventLogRow {
    const next = this.db
      .prepare(`SELECT COALESCE(MAX(event_id), 0) AS m FROM event_logs WHERE run_id = ?`)
      .get(runId) as { m: number }
    const eventId = Number(next?.m ?? 0) + 1
    const row: EventLogRow = {
      id: newId('evt'),
      run_id: runId,
      event_id: eventId,
      type,
      payload: JSON.stringify(payload ?? {}),
      created_at: nowIso(),
    }
    this.db
      .prepare(`INSERT INTO event_logs (id,run_id,event_id,type,payload,created_at) VALUES (?,?,?,?,?,?)`)
      .run(row.id, row.run_id, row.event_id, row.type, row.payload, row.created_at)
    return row
  }

  listEventsSince(runId: string, afterEventId: number, limit = 200): EventLogRow[] {
    return this.db
      .prepare(`SELECT * FROM event_logs WHERE run_id = ? AND event_id > ? ORDER BY event_id ASC LIMIT ?`)
      .all(runId, afterEventId, limit) as unknown as EventLogRow[]
  }

  listEvents(runId: string): EventLogRow[] {
    return this.db
      .prepare(`SELECT * FROM event_logs WHERE run_id = ? ORDER BY event_id ASC`)
      .all(runId) as unknown as EventLogRow[]
  }
}

// HMR 下复用同一连接（Next dev 会重复求值模块）
const globalForStore = globalThis as unknown as { __atomsStore?: StoreProvider }

export function getStore(): StoreProvider {
  if (!globalForStore.__atomsStore) {
    globalForStore.__atomsStore = new SqliteStore(env.dbFile)
  }
  return globalForStore.__atomsStore
}
