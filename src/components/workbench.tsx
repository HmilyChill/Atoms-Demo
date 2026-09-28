'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

// ─────────────────────────── 类型 ───────────────────────────

interface RunEventDto {
  eventId: number
  type: string
  payload: Record<string, unknown>
  at: string
}

interface ArtifactDto {
  id: string
  type: string
  summary: string
  payload: unknown
  createdAt: string
}

interface RunSnapshot {
  id: string
  status: string
  stage: string
  mode: string
  errorMessage: string | null
  tokenUsage: number
  callCount: number
}

interface VersionDto {
  version: number
  parentVersion: number | null
  changeSummary: string
  createdAt: string
  isCurrent: boolean
}

interface DiffChangeDto {
  path: string
  kind: 'added' | 'removed' | 'changed'
  before?: unknown
  after?: unknown
  description: string
}

interface DiffResultDto {
  from: number
  to: number
  summary: string
  changes: DiffChangeDto[]
}

interface VerificationDto {
  ok?: boolean
  summary?: string
  render?: { errors?: string[]; pagesChecked?: number; componentsChecked?: number }
  contract?: { total?: number; passed?: Array<{ id: string; text: string }>; failed?: Array<{ id: string; text: string; reason?: string }> }
  unverified?: string[]
}

interface AgentCard {
  key: string
  agent: string
  label: string
  status: 'running' | 'done' | 'failed'
  durationMs?: number
  tokens?: number
  provider?: string
  note?: string
}

interface PlanDto {
  goal?: string
  deliverable?: string
  steps?: Array<{ order: number; title: string; detail: string }>
  pageOutline?: Array<{ id: string; title: string; purpose: string }>
}

interface ContractDto {
  mustDo?: Array<{ id: string; text: string }>
  mustNot?: Array<{ id: string; text: string }>
  acceptance?: string[]
}

interface SpecSummary {
  meta?: { name?: string; description?: string; schemaVersion?: number; generatedAt?: string }
  theme?: { primary?: string; radius?: string; density?: string }
  dataModels?: Array<{ name: string; label: string; fields: Array<{ name: string; label: string; type: string; required?: boolean }> }>
  pages?: Array<{ id: string; title: string; layout: string; components: Array<{ id: string; type: string; title?: string }> }>
  navigation?: Array<{ label: string; pageId: string }>
}

const STEP_LABEL: Record<string, string> = {
  created: '已创建',
  planned: '计划已完成',
  awaiting_confirm: '等待你确认契约',
  confirmed: '已确认',
  paged: '页面架构完成',
  modeled: '数据模型完成',
  specced: 'App Spec 完成',
  patched: '增量修改完成',
  verify_failed: '校验未通过',
  repaired: '自动修复完成',
  verified: '校验通过',
  verified_partial: '部分通过（如实上报）',
  finished: '已完成',
  cancelled: '已取消',
}

const TABS = [
  { key: 'plan', label: '执行计划' },
  { key: 'contract', label: '需求契约' },
  { key: 'pages', label: '页面架构' },
  { key: 'dataModel', label: '数据模型' },
  { key: 'spec', label: 'App Spec' },
  { key: 'verify', label: '校验报告' },
  { key: 'versions', label: '版本与迭代' },
] as const

type TabKey = (typeof TABS)[number]['key']

// ─────────────────────────── 组件 ───────────────────────────

export function Workbench({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [input, setInput] = useState('')
  const [autoConfirm, setAutoConfirm] = useState(false)
  const [run, setRun] = useState<RunSnapshot | null>(null)
  const [events, setEvents] = useState<RunEventDto[]>([])
  const [artifacts, setArtifacts] = useState<ArtifactDto[]>([])
  const [spec, setSpec] = useState<SpecSummary | null>(null)
  const [versions, setVersions] = useState<VersionDto[]>([])
  const [diff, setDiff] = useState<DiffResultDto | null>(null)
  const [verification, setVerification] = useState<VerificationDto | null>(null)
  const [previewToken, setPreviewToken] = useState('')
  const [previewKey, setPreviewKey] = useState(0)
  const [tab, setTab] = useState<TabKey>('plan')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [shareUrl, setShareUrl] = useState('')
  const [previewError, setPreviewError] = useState('')

  const drivingRef = useRef(false)
  const esRef = useRef<EventSource | null>(null)
  const autoStartedRef = useRef(false)

  // ── 数据加载 ──

  const loadSpec = useCallback(
    async (version?: number) => {
      const url = version ? `/api/projects/${projectId}/spec?version=${version}` : `/api/projects/${projectId}/spec`
      const res = await fetch(url, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) return
      setSpec((json.data.spec ?? null) as SpecSummary | null)
      setVersions((json.data.versions ?? []) as VersionDto[])
      setVerification((json.data.verification ?? null) as VerificationDto | null)
    },
    [projectId],
  )

  const loadArtifacts = useCallback(async (runId: string) => {
    const res = await fetch(`/api/runs/${runId}`, { cache: 'no-store' })
    if (!res.ok) return
    const json = await res.json()
    setArtifacts((json.data.artifacts ?? []) as ArtifactDto[])
  }, [])

  const loadPreviewToken = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/preview-token`, { cache: 'no-store' })
    if (!res.ok) return
    const json = await res.json()
    setPreviewToken(String(json.data.token ?? ''))
    setPreviewKey((k) => k + 1)
  }, [projectId])

  useEffect(() => {
    void loadSpec()
    void loadPreviewToken()
  }, [loadSpec, loadPreviewToken])

  // 预览 iframe 内运行时上报的错误（错误必须可见，不能静默白屏）
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data as { source?: string; type?: string; payload?: { scope?: string; message?: string } }
      if (data?.source !== 'atoms-preview' && data?.source !== 'atoms-preview-host') return
      if (data.type === 'error' && data.payload) {
        setPreviewError(`${data.payload.scope ?? '预览'}：${data.payload.message ?? ''}`)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const afterRun = useCallback(
    async (runId: string) => {
      await Promise.all([loadSpec(), loadArtifacts(runId), loadPreviewToken()])
    },
    [loadSpec, loadArtifacts, loadPreviewToken],
  )

  /** 驱动循环：每次请求只推进一步（规避函数超时）；带硬性步数上限，避免死循环 */
  const drive = useCallback(
    async (runId: string) => {
      if (drivingRef.current) return
      drivingRef.current = true
      setBusy(true)
      try {
        for (let i = 0; i < 40; i += 1) {
          const res = await fetch(`/api/runs/${runId}/step`, { method: 'POST' })
          const json = await res.json().catch(() => ({}))
          if (!res.ok) {
            setError(String(json?.error?.message ?? '推进生成失败'))
            break
          }
          const snapshot = json.data.run as RunSnapshot
          setRun(snapshot)
          await loadArtifacts(runId)
          if (json.data.done === true) break
          if (snapshot.status === 'awaiting_confirm' || snapshot.status === 'failed') break
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : '推进生成时发生异常')
      } finally {
        drivingRef.current = false
        setBusy(false)
        await afterRun(runId)
      }
    },
    [afterRun, loadArtifacts],
  )

  const subscribe = useCallback(
    (runId: string, afterEventId: number) => {
      esRef.current?.close()
      const es = new EventSource(`/api/runs/${runId}/events?after=${afterEventId}`)
      esRef.current = es
      const handler = (evt: MessageEvent) => {
        try {
          const parsed = JSON.parse(evt.data) as RunEventDto
          setEvents((prev) => (prev.some((p) => p.eventId === parsed.eventId) ? prev : [...prev, parsed]))
        } catch {
          /* 忽略无法解析的事件 */
        }
      }
      const types = [
        'run.started',
        'plan.ready',
        'contract.ready',
        'agent.started',
        'agent.delta',
        'agent.finished',
        'spec.ready',
        'preview.updated',
        'verify.started',
        'verify.result',
        'repair.attempt',
        'run.finished',
        'run.failed',
        'run.cancelled',
      ]
      types.forEach((t) => es.addEventListener(t, handler as EventListener))
      es.addEventListener('stream.end', () => es.close())
      es.onerror = () => es.close()
    },
    [],
  )

  const startRun = useCallback(
    async (requirement: string) => {
      const text = requirement.trim()
      if (text.length === 0) {
        setError('请先描述你想要的应用')
        return
      }
      setError('')
      setNotice('')
      setEvents([])
      setVerification(null)
      setBusy(true)
      try {
        const res = await fetch('/api/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, userInput: text, autoConfirm }),
        })
        const json = await res.json()
        if (!res.ok) throw new Error(String(json?.error?.message ?? '无法开始生成'))

        const runId = String(json.data.runId)
        setNotice(
          json.data.mode === 'iterate'
            ? '已识别为「迭代修改」：将在现有应用上做增量修改'
            : '已识别为「首次生成」：将依次产出计划 → 契约 → 页面 → 数据模型 → App Spec → 校验',
        )

        // 先取快照对齐（事件可丢、状态不可丢），再订阅增量
        const snap = await fetch(`/api/runs/${runId}`, { cache: 'no-store' }).then((r) => r.json())
        const seedEvents = (snap?.data?.events ?? []) as RunEventDto[]
        setEvents(seedEvents)
        setArtifacts((snap?.data?.artifacts ?? []) as ArtifactDto[])
        setRun(snap?.data?.run as RunSnapshot)
        const lastId = seedEvents.length > 0 ? seedEvents[seedEvents.length - 1].eventId : 0
        subscribe(runId, lastId)
        setBusy(false)
        await drive(runId)
      } catch (err) {
        setError(err instanceof Error ? err.message : '无法开始生成')
        setBusy(false)
      }
    },
    [projectId, autoConfirm, subscribe, drive],
  )

  // ?req=...&autostart=1 —— 支持"一键试用"直达生成
  useEffect(() => {
    if (autoStartedRef.current) return
    const params = new URLSearchParams(window.location.search)
    const req = params.get('req') ?? ''
    const autostart = params.get('autostart') === '1'
    if (req) {
      setInput(req)
      if (autostart) {
        autoStartedRef.current = true
        void startRun(req)
      }
    }
  }, [startRun])

  const confirmRun = useCallback(async () => {
    if (!run) return
    setBusy(true)
    try {
      const res = await fetch(`/api/runs/${run.id}/confirm`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(String(json?.error?.message ?? '确认失败'))
      setRun(json.data.run as RunSnapshot)
    } catch (err) {
      setError(err instanceof Error ? err.message : '确认失败')
    } finally {
      setBusy(false)
    }
    await drive(run.id)
  }, [run, drive])

  const cancelRun = useCallback(async () => {
    if (!run) return
    await fetch(`/api/runs/${run.id}/cancel`, { method: 'POST' })
    setNotice('已取消本次生成。已产出的产物已保留，可继续查看。')
  }, [run])

  const rollback = useCallback(
    async (version: number) => {
      setBusy(true)
      setError('')
      try {
        const res = await fetch(`/api/projects/${projectId}/versions/${version}/rollback`, { method: 'POST' })
        const json = await res.json()
        if (!res.ok) throw new Error(String(json?.error?.message ?? '回滚失败'))
        setNotice(`已回滚到 v${version}（作为新版本 v${json.data.version} 追加，历史版本未被删除）`)
        await loadSpec()
        await loadPreviewToken()
      } catch (err) {
        setError(err instanceof Error ? err.message : '回滚失败')
      } finally {
        setBusy(false)
      }
    },
    [projectId, loadSpec, loadPreviewToken],
  )

  /** 加载"某版本 → 当前最新版"的结构差异，让"只改目标片段"这件事可见 */
  const loadDiff = useCallback(
    async (fromVersion: number) => {
      setBusy(true)
      setError('')
      try {
        const res = await fetch(`/api/projects/${projectId}/diff?from=${fromVersion}`, { cache: 'no-store' })
        const json = await res.json()
        if (!res.ok) throw new Error(String(json?.error?.message ?? '加载差异失败'))
        setDiff(json.data as DiffResultDto)
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载差异失败')
      } finally {
        setBusy(false)
      }
    },
    [projectId],
  )

  const createShare = useCallback(async () => {    setBusy(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/share`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(String(json?.error?.message ?? '生成分享链接失败'))
      setShareUrl(String(json.data.url))
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成分享链接失败')
    } finally {
      setBusy(false)
    }
  }, [projectId])

  // ── 事件归约 ──

  const derived = useMemo(() => {
    const agents: AgentCard[] = []
    let verify: Record<string, unknown> | null = null
    const repairs: Array<Record<string, unknown>> = []
    let finished: Record<string, unknown> | null = null
    let failure: string | null = null

    for (const e of events) {
      switch (e.type) {
        case 'agent.started': {
          agents.push({
            key: `${String(e.payload.agent)}-${e.eventId}`,
            agent: String(e.payload.agent ?? ''),
            label: String(e.payload.label ?? ''),
            status: 'running',
          })
          break
        }
        case 'agent.finished': {
          const idx = [...agents].reverse().findIndex((a) => a.agent === String(e.payload.agent) && a.status === 'running')
          if (idx >= 0) {
            const realIdx = agents.length - 1 - idx
            const target = agents[realIdx]
            target.status = e.payload.error ? 'failed' : 'done'
            target.durationMs = Number(e.payload.durationMs ?? 0)
            target.tokens = Number(e.payload.tokenUsage ?? 0)
            target.provider = e.payload.provider ? String(e.payload.provider) : undefined
            target.note = e.payload.error ? String(e.payload.error) : undefined
          }
          break
        }
        case 'verify.result':
          verify = e.payload
          break
        case 'repair.attempt':
          repairs.push(e.payload)
          break
        case 'run.finished':
          finished = e.payload
          break
        case 'run.failed':
          failure = String(e.payload.message ?? '生成失败')
          break
        default:
          break
      }
    }
    return { agents, verify, repairs, finished, failure }
  }, [events])

  const artifactOf = useCallback(
    (type: string): ArtifactDto | null => {
      const list = artifacts.filter((a) => a.type === type)
      return list.length > 0 ? list[list.length - 1] : null
    },
    [artifacts],
  )

  const plan = artifactOf('plan')?.payload as PlanDto | undefined
  const contract = artifactOf('contract')?.payload as ContractDto | undefined
  const pagesArtifact = artifactOf('pages')?.payload as { pages?: Array<{ id: string; title: string; components: string[] }> } | undefined
  const dataModelArtifact = artifactOf('dataModel')?.payload as
    | { models?: Array<{ name: string; label: string; fields: Array<{ name: string; label: string; type: string; required?: boolean }> }> }
    | undefined
  const reportArtifact = artifactOf('verification')?.payload as VerificationDto | undefined
  const report = reportArtifact ?? verification ?? undefined

  const running = busy || (run !== null && ['pending', 'running'].includes(run.status))
  const awaiting = run?.status === 'awaiting_confirm'

  return (
    <div className="flex h-screen flex-col">
      {/* ── 顶栏 ── */}
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5">
        <a href="/" className="text-sm text-slate-500 hover:text-indigo-600">
          ← 项目列表
        </a>
        <span className="text-sm font-semibold">{projectName}</span>
        {run && (
          <span
            className={
              run.status === 'failed'
                ? 'rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-700'
                : run.status === 'succeeded'
                  ? 'rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700'
                  : 'rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700'
            }
          >
            {STEP_LABEL[run.stage] ?? run.stage}
            {run.callCount > 0 ? ` · ${run.callCount} 次调用 · ${run.tokenUsage} tokens` : ''}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2 text-xs">
          {spec?.meta?.name && <span className="text-slate-500">当前应用：{spec.meta.name}</span>}
          <button
            onClick={() => void loadPreviewToken()}
            className="rounded-md border border-slate-300 px-3 py-1 text-slate-600 hover:bg-slate-50"
          >
            刷新预览
          </button>
          <button
            onClick={createShare}
            disabled={busy || !spec}
            className="rounded-md border border-slate-300 px-3 py-1 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            只读分享
          </button>
          <a
            href={`/api/projects/${projectId}/export`}
            className={`rounded-md border border-slate-300 px-3 py-1 text-slate-600 hover:bg-slate-50 ${spec ? '' : 'pointer-events-none opacity-50'}`}
          >
            导出单文件应用
          </a>
          <a
            href={`/api/projects/${projectId}/export?format=zip`}
            className={`rounded-md border border-slate-300 px-3 py-1 text-slate-600 hover:bg-slate-50 ${spec ? '' : 'pointer-events-none opacity-50'}`}
          >
            导出工程 ZIP
          </a>
        </div>
      </header>

      {(notice || error || shareUrl || previewError) && (
        <div className="space-y-1 border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs">
          {notice && <div className="text-slate-600">{notice}</div>}
          {error && <div className="text-red-700">错误：{error}</div>}
          {previewError && (
            <div className="text-amber-700">
              预览内捕获到运行时错误（已回传，未静默隐藏）：{previewError}
            </div>
          )}
          {shareUrl && (
            <div className="flex items-center gap-2 text-slate-600">
              <span>只读分享链接（7 天有效）：</span>
              <input readOnly value={shareUrl} className="w-[420px] rounded border border-slate-300 px-2 py-1" />
              <button
                onClick={() => void navigator.clipboard?.writeText(shareUrl)}
                className="rounded border border-slate-300 px-2 py-0.5 hover:bg-white"
              >
                复制
              </button>
            </div>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* ── 左栏：需求与时间线 ── */}
        <section className="atoms-scroll flex w-[360px] shrink-0 flex-col gap-3 border-r border-slate-200 bg-white p-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">
              {spec ? '继续迭代这个应用' : '描述你想要的应用'}
            </label>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={4}
              placeholder="例如：做一个个人待办清单，能新增任务、标记完成、按状态筛选、删除"
              className="w-full resize-y rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
            <div className="mt-2 flex flex-wrap gap-2">
              {[
                '做一个个人待办清单：能新增任务、标记完成、按状态筛选、删除。',
                '给这个应用增加一个优先级字段',
                '增加一个图表看板',
              ].map((s) => (
                <button
                  key={s}
                  onClick={() => setInput(s)}
                  className="rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-100"
                >
                  {s.length > 16 ? `${s.slice(0, 16)}…` : s}
                </button>
              ))}
            </div>
            <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
              <input type="checkbox" checked={autoConfirm} onChange={(e) => setAutoConfirm(e.target.checked)} />
              跳过人工确认（一键演示）
            </label>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => void startRun(input)}
                disabled={running}
                className="flex-1 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
              >
                {running ? '生成中…' : spec ? '提交迭代' : '开始生成'}
              </button>
              {running && (
                <button onClick={cancelRun} className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50">
                  取消
                </button>
              )}
            </div>
            {awaiting && (
              <button
                onClick={confirmRun}
                className="mt-2 w-full rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700"
              >
                确认计划与需求契约，继续生成
              </button>
            )}
          </div>

          <div className="min-h-0 flex-1">
            <div className="mb-2 flex items-center justify-between text-xs font-medium text-slate-600">
              <span>智能体时间线</span>
              <span className="text-slate-400">{derived.agents.length} 个步骤</span>
            </div>
            {derived.agents.length === 0 ? (
              <div className="rounded-md border border-dashed border-slate-300 p-6 text-center text-xs text-slate-400">
                提交需求后，这里会显示每个智能体的状态与耗时
              </div>
            ) : (
              <ul className="space-y-2">
                {derived.agents.map((a) => (
                  <li key={a.key} className="rounded-md border border-slate-200 p-2.5">
                    <div className="flex items-center gap-2 text-xs">
                      <span
                        className={
                          a.status === 'running'
                            ? 'h-2 w-2 animate-pulse rounded-full bg-indigo-500'
                            : a.status === 'done'
                              ? 'h-2 w-2 rounded-full bg-emerald-500'
                              : 'h-2 w-2 rounded-full bg-red-500'
                        }
                      />
                      <span className="font-medium text-slate-800">{a.agent}</span>
                      <span className="text-slate-500">{a.label}</span>
                      {a.durationMs !== undefined && (
                        <span className="ml-auto text-slate-400">{a.durationMs}ms</span>
                      )}
                    </div>
                    {(a.tokens !== undefined || a.provider) && (
                      <div className="mt-1 text-[11px] text-slate-400">
                        {a.provider ? `provider: ${a.provider}` : ''}
                        {a.tokens ? ` · ${a.tokens} tokens` : ''}
                      </div>
                    )}
                    {a.note && <div className="mt-1 text-[11px] text-red-600">失败：{a.note}</div>}
                  </li>
                ))}
              </ul>
            )}

            {derived.repairs.length > 0 && (
              <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-2.5 text-[11px] text-amber-900">
                <div className="font-medium">自动修复记录</div>
                {derived.repairs.map((r, i) => (
                  <div key={i} className="mt-1">
                    第 {String(r.round)} 轮：
                    {Array.isArray(r.fixes) && r.fixes.length > 0 ? (r.fixes as string[]).join('、') : '无需修复'}
                    {Array.isArray(r.unrepairable) && (r.unrepairable as string[]).length > 0 && (
                      <div className="text-red-700">
                        无法自动修复：{(r.unrepairable as string[]).join('；')}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {derived.finished && (
              <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-2.5 text-[11px] text-emerald-900">
                生成完成：v{String(derived.finished.version)} · 耗时 {String(derived.finished.totalMs)}ms ·{' '}
                {derived.finished.verificationOk ? '校验通过' : '校验部分通过（详见校验报告）'}
              </div>
            )}
            {derived.failure && (
              <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-2.5 text-[11px] text-red-800">
                生成失败：{derived.failure}
              </div>
            )}
          </div>
        </section>

        {/* ── 中栏：产物 ── */}
        <section className="flex min-w-0 flex-1 flex-col border-r border-slate-200 bg-white">
          <div className="flex flex-wrap gap-1 border-b border-slate-200 px-3 py-2">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={
                  tab === t.key
                    ? 'rounded-md bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700'
                    : 'rounded-md px-3 py-1 text-xs text-slate-600 hover:bg-slate-100'
                }
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="atoms-scroll min-h-0 flex-1 p-4 text-sm">
            {tab === 'plan' && (
              <div className="space-y-4">
                {plan ? (
                  <>
                    <div>
                      <div className="text-xs text-slate-500">目标</div>
                      <div className="mt-1">{plan.goal}</div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-500">交付物</div>
                      <div className="mt-1">{plan.deliverable}</div>
                    </div>
                    <div>
                      <div className="mb-2 text-xs text-slate-500">执行步骤</div>
                      <ol className="space-y-2">
                        {(plan.steps ?? []).map((s) => (
                          <li key={s.order} className="rounded-md border border-slate-200 p-2.5">
                            <div className="text-xs font-medium">
                              {s.order}. {s.title}
                            </div>
                            <div className="mt-1 text-xs text-slate-500">{s.detail}</div>
                          </li>
                        ))}
                      </ol>
                    </div>
                  </>
                ) : (
                  <Empty text="尚未生成执行计划" />
                )}
              </div>
            )}

            {tab === 'contract' && (
              <div className="space-y-4">
                {contract ? (
                  <>
                    <div>
                      <div className="mb-2 text-xs font-medium text-emerald-700">必做项（可机检）</div>
                      <ul className="space-y-1">
                        {(contract.mustDo ?? []).map((m) => (
                          <li key={m.id} className="rounded border border-slate-200 px-2.5 py-1.5 text-xs">
                            {m.text}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <div className="mb-2 text-xs font-medium text-amber-700">禁做项</div>
                      <ul className="space-y-1">
                        {(contract.mustNot ?? []).map((m) => (
                          <li key={m.id} className="rounded border border-slate-200 px-2.5 py-1.5 text-xs">
                            {m.text}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <div className="mb-2 text-xs font-medium text-slate-600">验收点（可测试的结果）</div>
                      <ul className="list-inside list-disc space-y-1 text-xs text-slate-600">
                        {(contract.acceptance ?? []).map((a, i) => (
                          <li key={i}>{a}</li>
                        ))}
                      </ul>
                    </div>
                  </>
                ) : (
                  <Empty text="尚未生成需求契约" />
                )}
              </div>
            )}

            {tab === 'pages' && (
              <div className="space-y-3">
                {pagesArtifact?.pages ? (
                  pagesArtifact.pages.map((p) => (
                    <div key={p.id} className="rounded-md border border-slate-200 p-3">
                      <div className="text-xs font-medium">
                        {p.title} <span className="text-slate-400">/{p.id}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {(p.components ?? []).map((c, i) => (
                          <span key={i} className="rounded bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                            {c}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))
                ) : (
                  <Empty text="尚未生成页面架构" />
                )}
              </div>
            )}

            {tab === 'dataModel' && (
              <div className="space-y-3">
                {dataModelArtifact?.models ? (
                  dataModelArtifact.models.map((m) => (
                    <div key={m.name} className="rounded-md border border-slate-200 p-3">
                      <div className="text-xs font-medium">
                        {m.label} <span className="text-slate-400">/{m.name}</span>
                      </div>
                      <table className="mt-2 w-full text-xs">
                        <thead>
                          <tr className="text-slate-500">
                            <th className="text-left">字段</th>
                            <th className="text-left">类型</th>
                            <th className="text-left">必填</th>
                          </tr>
                        </thead>
                        <tbody>
                          {m.fields.map((f) => (
                            <tr key={f.name} className="border-t border-slate-100">
                              <td className="py-1">{f.label}</td>
                              <td className="py-1 text-slate-500">{f.type}</td>
                              <td className="py-1 text-slate-500">{f.required ? '是' : '否'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))
                ) : (
                  <Empty text="尚未生成数据模型" />
                )}
              </div>
            )}

            {tab === 'spec' && (
              <div className="space-y-3">
                {spec ? (
                  <>
                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <Info label="应用名称" value={spec.meta?.name ?? '-'} />
                      <Info label="Spec 版本" value={`v${versions[0]?.version ?? '-'}`} />
                      <Info label="数据集合" value={`${spec.dataModels?.length ?? 0} 个`} />
                      <Info label="页面" value={`${spec.pages?.length ?? 0} 个`} />
                      <Info label="主题主色" value={spec.theme?.primary ?? '-'} />
                      <Info label="Schema 版本" value={String(spec.meta?.schemaVersion ?? '-')} />
                    </div>
                    <div>
                      <div className="mb-2 text-xs text-slate-500">页面与组件</div>
                      <ul className="space-y-1 text-xs">
                        {(spec.pages ?? []).map((p) => (
                          <li key={p.id} className="rounded border border-slate-200 p-2">
                            <div className="font-medium">{p.title}</div>
                            <div className="mt-1 text-slate-500">{p.components.map((c) => c.type).join(' / ')}</div>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <details className="text-xs">
                      <summary className="cursor-pointer text-slate-500">查看 App Spec 原文（JSON）</summary>
                      <pre className="atoms-mono mt-2 max-h-72 overflow-auto rounded bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-100">
                        {JSON.stringify(spec, null, 2)}
                      </pre>
                    </details>
                  </>
                ) : (
                  <Empty text="尚未生成 App Spec" />
                )}
              </div>
            )}

            {tab === 'verify' && (
              <div className="space-y-3">
                {report ? (
                  <>
                    <div
                      className={
                        report.ok
                          ? 'rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900'
                          : 'rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900'
                      }
                    >
                      <div className="font-medium">{report.ok ? '校验全部通过' : '校验未全部通过（如实上报）'}</div>
                      <div className="mt-1">{report.summary}</div>
                    </div>
                    <div className="text-xs">
                      <div className="text-slate-500">
                        渲染冒烟：检查 {report.render?.pagesChecked ?? 0} 个页面 / {report.render?.componentsChecked ?? 0} 个组件
                      </div>
                      {(report.render?.errors ?? []).length > 0 && (
                        <ul className="mt-1 list-inside list-disc text-red-700">
                          {(report.render?.errors ?? []).map((e, i) => (
                            <li key={i}>{e}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div className="text-xs">
                      <div className="mb-1 font-medium text-emerald-700">
                        契约通过（{(report.contract?.passed ?? []).length}）
                      </div>
                      <ul className="space-y-1">
                        {(report.contract?.passed ?? []).map((p) => (
                          <li key={p.id}>✓ {p.text}</li>
                        ))}
                      </ul>
                    </div>
                    {(report.contract?.failed ?? []).length > 0 && (
                      <div className="text-xs">
                        <div className="mb-1 font-medium text-red-700">
                          契约未通过（{(report.contract?.failed ?? []).length}）
                        </div>
                        <ul className="space-y-1">
                          {(report.contract?.failed ?? []).map((f) => (
                            <li key={f.id}>
                              ✗ {f.text} {f.reason ? <span className="text-slate-500">（{f.reason}）</span> : null}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {(report.unverified ?? []).length > 0 && (
                      <div className="rounded-md border border-slate-200 bg-slate-50 p-2.5 text-xs text-slate-600">
                        <div className="font-medium">未校验项（不计为通过）</div>
                        <ul className="mt-1 list-inside list-disc">
                          {(report.unverified ?? []).map((u, i) => (
                            <li key={i}>{u}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                ) : (
                  <Empty text="尚未产生校验报告" />
                )}
              </div>
            )}

            {tab === 'versions' && (
              <div className="space-y-3">
                {diff && (
                  <div className="rounded-md border border-indigo-200 bg-indigo-50 p-3">
                    <div className="flex items-center gap-2 text-xs text-indigo-900">
                      <span className="font-medium">
                        版本差异 v{diff.from} → v{diff.to}
                      </span>
                      <span className="text-indigo-700">{diff.summary}</span>
                      <button
                        onClick={() => setDiff(null)}
                        className="ml-auto rounded border border-indigo-300 px-2 py-0.5 text-[11px] text-indigo-700 hover:bg-white"
                      >
                        关闭
                      </button>
                    </div>
                    {diff.changes.length === 0 ? (
                      <div className="mt-2 text-[11px] text-indigo-800">两个版本结构完全一致</div>
                    ) : (
                      <ul className="mt-2 space-y-1">
                        {diff.changes.map((c, i) => (
                          <li key={i} className="text-[11px] text-indigo-900">
                            <span
                              className={
                                c.kind === 'added'
                                  ? 'mr-1 rounded bg-emerald-100 px-1 text-emerald-700'
                                  : c.kind === 'removed'
                                    ? 'mr-1 rounded bg-red-100 px-1 text-red-700'
                                    : 'mr-1 rounded bg-amber-100 px-1 text-amber-800'
                              }
                            >
                              {c.kind === 'added' ? '新增' : c.kind === 'removed' ? '移除' : '修改'}
                            </span>
                            {c.description.replace(/^(新增|移除|修改)：/, '')}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                {versions.length === 0 ? (
                  <Empty text="还没有任何版本" />
                ) : (
                  versions.map((v) => (
                    <div key={v.version} className="flex items-center gap-3 rounded-md border border-slate-200 p-3">
                      <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium">v{v.version}</span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs">{v.changeSummary || '（无变更说明）'}</div>
                        <div className="text-[11px] text-slate-400">
                          {new Date(v.createdAt).toLocaleString('zh-CN')}
                          {v.parentVersion ? ` · 父版本 v${v.parentVersion}` : ' · 初始版本'}
                        </div>
                      </div>
                      {v.isCurrent ? (
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">当前</span>
                      ) : (
                        <div className="flex gap-2">
                          <button
                            onClick={() => void loadSpec(v.version)}
                            className="rounded border border-slate-300 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50"
                          >
                            查看
                          </button>
                          <button
                            onClick={() => void loadDiff(v.version)}
                            disabled={busy}
                            className="rounded border border-indigo-300 px-2 py-0.5 text-[11px] text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
                          >
                            与当前对比
                          </button>
                          <button
                            onClick={() => void rollback(v.version)}
                            disabled={busy}
                            className="rounded border border-slate-300 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                          >
                            回滚到此版本
                          </button>
                        </div>
                      )}
                    </div>
                  ))
                )}
                <p className="text-[11px] text-slate-400">
                  回滚不会删除历史版本：目标版本的内容会作为**新版本**追加，因此版本链始终可回溯，生成物的数据也不会丢失。
                </p>
              </div>
            )}
          </div>
        </section>

        {/* ── 右栏：沙箱预览 ── */}
        <section className="flex w-[44%] min-w-[380px] flex-col bg-slate-100">
          <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 text-xs">
            <span className="font-medium text-slate-700">实时预览</span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">
              沙箱隔离（未授予同源权限）
            </span>
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={() => setPreviewKey((k) => k + 1)}
                className="rounded border border-slate-300 px-2 py-0.5 text-slate-600 hover:bg-slate-50"
              >
                重新加载
              </button>
              {previewToken && (
                <a
                  href={`/preview/${projectId}?pt=${encodeURIComponent(previewToken)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded border border-slate-300 px-2 py-0.5 text-slate-600 hover:bg-slate-50"
                >
                  新窗口打开
                </a>
              )}
            </div>
          </div>
          <div className="min-h-0 flex-1 p-3">
            {previewToken ? (
              <iframe
                key={previewKey}
                title="生成的应用预览"
                src={`/preview/${projectId}?pt=${encodeURIComponent(previewToken)}`}
                sandbox="allow-scripts allow-forms"
                className="h-full w-full rounded-lg border border-slate-200 bg-white"
              />
            ) : (
              <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white text-xs text-slate-400">
                正在准备预览…
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-dashed border-slate-300 p-8 text-center text-xs text-slate-400">{text}</div>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-slate-200 p-2.5">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="mt-0.5 font-medium">{value}</div>
    </div>
  )
}
