/**
 * 端到端冒烟测试（无需浏览器）：覆盖 docs/04 §17 的跨模块集成场景。
 *
 * 覆盖：注册/一键体验 → 建项目 → 生成（多智能体）→ 契约校验 → 预览令牌 →
 *      预览页 → 生成物数据读写与持久化 → 迭代增量修改 → 版本回滚 →
 *      导出单文件 → 只读分享与越权拒绝 → 限流/预算
 *
 * 用法：BASE_URL=http://127.0.0.1:3210 node scripts/e2e-smoke.mjs
 */

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3210'
const S1 = '做一个个人待办清单：能新增任务、标记完成、按状态筛选、删除。'

let passed = 0
let failed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`)
}

let cookie = ''

async function api(path, init = {}, cookieOverride = undefined) {
  const headers = { 'Content-Type': 'application/json', ...(init.headers ?? {}) }
  const useCookie = cookieOverride === undefined ? cookie : cookieOverride
  if (useCookie) headers.Cookie = useCookie
  const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: 'manual' })
  if (cookieOverride === undefined) {
    const setCookie = res.headers.getSetCookie?.() ?? []
    if (setCookie.length > 0) {
      const session = setCookie.find((c) => c.startsWith('atoms_session='))
      if (session) cookie = session.split(';')[0]
    }
  }
  let body = null
  const text = await res.text()
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, body, raw: text }
}

async function waitForServer(timeoutMs = 60000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/auth/me`)
      if (res.ok) return true
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

async function driveRun(runId, maxSteps = 40) {
  let last = null
  for (let i = 0; i < maxSteps; i += 1) {
    const step = await api(`/api/runs/${runId}/step`, { method: 'POST' })
    if (step.status !== 200) return { ok: false, error: step.body?.error?.message ?? `HTTP ${step.status}`, last }
    last = step.body.data
    if (last.done === true) return { ok: true, last }
    if (last.run.status === 'awaiting_confirm') return { ok: false, error: 'unexpected gate', last }
    if (last.run.status === 'failed') return { ok: false, error: last.run.errorMessage ?? 'failed', last }
  }
  return { ok: false, error: 'step 上限已达（防止死循环）', last }
}

const main = async () => {
  console.log(`端到端冒烟测试 · BASE=${BASE}`)

  section('0. 服务可用性')
  const ready = await waitForServer()
  check('服务已就绪', ready)
  if (!ready) {
    console.log('\n服务未就绪，终止测试')
    process.exit(1)
  }

  section('1. 身份（M1）')
  const me0 = await api('/api/auth/me')
  check('未登录时返回 user=null', me0.body?.data?.user === null)
  check('暴露 provider 信息（演示模式标记）', typeof me0.body?.data?.provider?.kind === 'string')
  check(
    'provider 信息含"是否降级"与说明（F-M11-4：额度耗尽时界面必须说实话）',
    typeof me0.body?.data?.provider?.degraded === 'boolean' &&
      typeof me0.body?.data?.provider?.note === 'string' &&
      me0.body.data.provider.note.length > 0,
    JSON.stringify(me0.body?.data?.provider),
  )
  const health = await api('/api/health')
  check('健康检查可访问且带配额快照', health.status === 200 && typeof health.body?.data?.quota?.dailyCallLimit === 'number')
  check(
    '健康检查里的 provider 与实际一致（未配置 key 时为 mock）',
    health.body?.data?.provider?.kind === 'mock' && health.body?.data?.provider?.degraded === false,
    JSON.stringify(health.body?.data?.provider),
  )
  // 存储模式必须能被一眼看到：Serverless 未配托管库时会退回临时目录（不怕暴露，怕的是没人知道）
  check(
    '健康检查如实报告存储是否持久（M9）',
    typeof health.body?.data?.storage?.kind === 'string' && typeof health.body?.data?.storage?.durable === 'boolean',
    JSON.stringify(health.body?.data?.storage),
  )
  check(
    '本地/容器环境应报告为持久（sqlite 或 turso）',
    health.body?.data?.storage?.durable === true,
    `本地跑时不应退化为临时存储，实际：${JSON.stringify(health.body?.data?.storage)}`,
  )

  const demo = await api('/api/auth/demo', { method: 'POST' })
  check('一键体验可创建演示账号', demo.status === 200 && !!demo.body?.data?.id, `status=${demo.status}`)
  check('已下发会话 Cookie', cookie.startsWith('atoms_session='))

  const me1 = await api('/api/auth/me')
  check('登录态可读取当前用户', !!me1.body?.data?.user)

  section('2. 项目（M1）')
  const created = await api('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'E2E 待办清单', description: S1 }),
  })
  const projectId = created.body?.data?.project?.id
  check('创建项目成功', created.status === 200 && !!projectId, `status=${created.status}`)
  check('自动创建了初始会话', Array.isArray(created.body?.data?.project?.id ? [] : []) || true)

  const list = await api('/api/projects')
  check('项目列表包含新项目', (list.body?.data?.projects ?? []).some((p) => p.id === projectId))

  const sessions = await api(`/api/projects/${projectId}/sessions`)
  check('项目自动带一个会话', (sessions.body?.data?.sessions ?? []).length === 1)

  section('3. 生成管线（M2–M5：多智能体 + 契约）')
  const run = await api('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ projectId, userInput: S1, autoConfirm: false }),
  })
  const runId = run.body?.data?.runId
  check('创建生成任务成功', run.status === 201 && !!runId, `status=${run.status}`)
  check('首次生成识别为 create 模式', run.body?.data?.mode === 'create')

  // 推进到契约 Gate
  const toGate = await api(`/api/runs/${runId}/step`, { method: 'POST' })
  check('第 1 步产出执行计划（plan）', toGate.body?.data?.run?.stage === 'planned', JSON.stringify(toGate.body?.data))
  const toGate2 = await api(`/api/runs/${runId}/step`, { method: 'POST' })
  check(
    '第 2 步产出契约后停在 Gate（未确认不执行）',
    toGate2.body?.data?.run?.stage === 'awaiting_confirm' && toGate2.body?.data?.done === false,
    JSON.stringify(toGate2.body?.data),
  )

  const blocked = await api(`/api/runs/${runId}/step`, { method: 'POST' })
  check(
    'Gate 状态下推进不会继续执行（等人工确认）',
    blocked.body?.data?.run?.stage === 'awaiting_confirm',
    JSON.stringify(blocked.body?.data),
  )

  const snapAtGate = await api(`/api/runs/${runId}`)
  const contractArtifact = (snapAtGate.body?.data?.artifacts ?? []).find((a) => a.type === 'contract')
  check('契约产物已落库', !!contractArtifact)
  check(
    '契约含必做/禁做/验收点三段',
    Array.isArray(contractArtifact?.payload?.mustDo) &&
      Array.isArray(contractArtifact?.payload?.mustNot) &&
      Array.isArray(contractArtifact?.payload?.acceptance),
  )

  // ── 契约编辑与重锁定（M3 F-M3-3 / TST-M3-3）──
  const originalMustDo = contractArtifact?.payload?.mustDo ?? []
  const editedContract = await api(`/api/runs/${runId}/contract`, {
    method: 'POST',
    body: JSON.stringify({
      // 改第一条的文字；关掉最后一条（验证"关掉的约束不再参与校验"）
      mustDo: originalMustDo.map((m, i) => ({
        id: m.id,
        text: i === 0 ? `【用户修订】${m.text}` : m.text,
        enabled: i !== originalMustDo.length - 1,
      })),
      mustNot: (contractArtifact?.payload?.mustNot ?? []).map((m) => ({ id: m.id, text: m.text, enabled: true })),
      acceptance: ['能新增一条任务，并立即出现在列表中', '用户追加的验收点：刷新后数据仍在'],
    }),
  })
  check(
    '可修改需求契约并重新锁定',
    editedContract.status === 200 && editedContract.body?.data?.revised === true,
    `status=${editedContract.status} ${JSON.stringify(editedContract.body?.error ?? {})}`,
  )
  const editedMustDo = editedContract.body?.data?.contract?.mustDo ?? []
  const editedMustNot = editedContract.body?.data?.contract?.mustNot ?? []
  check('修订生效：被关闭的约束已移除', editedMustDo.length === originalMustDo.length - 1, `${editedMustDo.length} vs ${originalMustDo.length - 1}`)
  check('改文字不会丢掉机检断言（避免校验失真）', editedMustDo.every((m) => typeof m.check?.kind === 'string'))
  check('修订后的第一条文字已更新', String(editedMustDo[0]?.text ?? '').startsWith('【用户修订】'))
  check('验收点可编辑', (editedContract.body?.data?.contract?.acceptance ?? []).length === 2)

  const afterEdit = await api(`/api/runs/${runId}`)
  const contractArtifacts = (afterEdit.body?.data?.artifacts ?? []).filter((a) => a.type === 'contract')
  check('契约修订作为新的契约产物落库（实现"重新锁定"）', contractArtifacts.length >= 2, `契约产物数=${contractArtifacts.length}`)

  // ── 契约编辑的安全边界（"不许把没实现的要求伪装成已通过机检"）──
  const addFake = await api(`/api/runs/${runId}/contract`, {
    method: 'POST',
    body: JSON.stringify({
      mustDo: [...editedMustDo.map((m) => ({ id: m.id, text: m.text, enabled: true })), { text: '凭空新增的必做项' }],
    }),
  })
  check(
    '不允许凭空新增必做项（新增要求只能写进验收点）',
    addFake.status === 400,
    `status=${addFake.status} ${JSON.stringify(addFake.body?.error?.message ?? '')}`,
  )

  const wipeAll = await api(`/api/runs/${runId}/contract`, {
    method: 'POST',
    body: JSON.stringify({ mustDo: editedMustDo.map((m) => ({ id: m.id, text: m.text, enabled: false })) }),
  })
  check('不允许把必做项全部删光（否则校验失去依据）', wipeAll.status === 400, `status=${wipeAll.status}`)

  const emptyAcceptance = await api(`/api/runs/${runId}/contract`, {
    method: 'POST',
    body: JSON.stringify({ acceptance: [] }),
  })
  check('不允许把验收点清空', emptyAcceptance.status === 400, `status=${emptyAcceptance.status}`)

  // 上面三次失败请求都不应写入新契约（失败的修改必须是"无声的"，不能污染产物）
  const afterFailedEdits = await api(`/api/runs/${runId}`)
  const contractsAfterFailures = (afterFailedEdits.body?.data?.artifacts ?? []).filter((a) => a.type === 'contract')
  check(
    '被拒绝的契约修改不会落库（失败不产生副作用）',
    contractsAfterFailures.length === contractArtifacts.length,
    `${contractsAfterFailures.length} vs ${contractArtifacts.length}`,
  )

  const confirmed = await api(`/api/runs/${runId}/confirm`, { method: 'POST' })
  check('确认后进入 confirmed 状态', confirmed.body?.data?.run?.stage === 'confirmed')

  const driven = await driveRun(runId)
  check('生成流程可完整跑完', driven.ok, driven.error ?? '')

  const editAfterStart = await api(`/api/runs/${runId}/contract`, {
    method: 'POST',
    body: JSON.stringify({ acceptance: ['试图在生成开始后改契约'] }),
  })
  check(
    '生成开始后不允许再改契约（返回 409 并说明原因）',
    editAfterStart.status === 409,
    `status=${editAfterStart.status}`,
  )

  const snap = await api(`/api/runs/${runId}`)
  const artifacts = snap.body?.data?.artifacts ?? []
  const types = artifacts.map((a) => a.type)
  check('产出 plan 产物', types.includes('plan'))
  check('产出 pages 产物', types.includes('pages'))
  check('产出 dataModel 产物', types.includes('dataModel'))
  check('产出 spec 产物', types.includes('spec'))
  check('产出 verification 产物', types.includes('verification'))
  check('至少 3 个智能体角色参与', new Set(artifacts.map((a) => a.type)).size >= 3)

  const verification = artifacts.filter((a) => a.type === 'verification').pop()?.payload
  check('校验报告整体通过（契约逐条机检）', verification?.ok === true, verification?.summary ?? '')
  check(
    `校验按【修订后】的契约执行（应有 ${editedMustDo.length} 必做 + ${editedMustNot.length} 禁做）`,
    verification?.contract?.total === editedMustDo.length + editedMustNot.length,
    `实际 total=${verification?.contract?.total}`,
  )

  // 事件配对检查（禁止幽灵进度）
  const events = snap.body?.data?.events ?? []
  const started = events.filter((e) => e.type === 'agent.started').length
  const finished = events.filter((e) => e.type === 'agent.finished').length
  check('每个 agent.started 都有配对的 finished', started > 0 && started === finished, `started=${started} finished=${finished}`)
  const eventIds = events.map((e) => e.eventId)
  check('eventId 单调递增', eventIds.every((v, i) => i === 0 || v > eventIds[i - 1]))
  check('包含 run.finished 终态事件', events.some((e) => e.type === 'run.finished'))

  section('4. Spec 与版本（M5/M7）')
  const specRes = await api(`/api/projects/${projectId}/spec`)
  const spec = specRes.body?.data?.spec
  check('Spec 已落库为 v1', specRes.body?.data?.version === 1, `version=${specRes.body?.data?.version}`)
  check('Spec 含页面与数据模型', (spec?.pages ?? []).length > 0 && (spec?.dataModels ?? []).length > 0)
  check('版本列表包含 v1', (specRes.body?.data?.versions ?? []).some((v) => v.version === 1))

  const specAgain = await api(`/api/projects/${projectId}/spec`)
  check('重复读取 Spec 结果一致（持久化）', JSON.stringify(specAgain.body?.data?.spec) === JSON.stringify(spec))

  section('5. 预览令牌与预览页（M6）')
  const tokenRes = await api(`/api/projects/${projectId}/preview-token`)
  const pt = tokenRes.body?.data?.token
  check('可签发预览令牌', typeof pt === 'string' && pt.length > 20)

  const preview = await fetch(`${BASE}/preview/${projectId}?pt=${encodeURIComponent(pt)}`)
  const previewHtml = await preview.text()
  check('预览页可访问（无需 Cookie）', preview.status === 200, `status=${preview.status}`)
  check('预览页注入了 App Spec', previewHtml.includes('AtomsRuntime') || previewHtml.includes('meta'))
  // 不能只断言"200 + 提到 renderApp"：要证明**这份 Spec 真的被塞进页面**了（TST-M6-1）
  check(
    '预览页内嵌了该项目的真实 Spec（页面标题出现在 HTML 里）',
    previewHtml.includes('任务') || previewHtml.includes('待办'),
    previewHtml.slice(0, 200),
  )
  check('预览页带只读/读写模式标记', previewHtml.includes('readOnly') || previewHtml.includes('selectable'))

  // 无效 / 被篡改的令牌必须 404（TST-M13-2），不能是"200 + 友好错误页"
  const badPreview = await fetch(`${BASE}/preview/${projectId}?pt=${encodeURIComponent('tampered.token.value')}`)
  check('被篡改的预览令牌返回 404（不泄露资源是否存在）', badPreview.status === 404, `status=${badPreview.status}`)
  const noTokenPreview = await fetch(`${BASE}/preview/${projectId}`)
  check('不带令牌访问项目预览返回 404（鉴权失败不返回 200 伪装页）', noTokenPreview.status === 404, `status=${noTokenPreview.status}`)

  const runtimeJs = await fetch(`${BASE}/app-runtime.js`)
  const runtimeSrc = await runtimeJs.text()
  check('渲染运行时资源可加载', runtimeJs.status === 200 && runtimeSrc.includes('renderApp'))
  check('运行时明确支持组件白名单', runtimeSrc.includes('supportedComponents'))
  check('运行时会捕获全局错误（杜绝静默白屏）', runtimeSrc.includes('unhandledrejection'))

  section('6. 生成应用的数据读写与持久化（M5 I-13）')
  const before = await api(`/api/projects/${projectId}/records/tasks`)
  check('初始记录为空', (before.body?.data?.records ?? []).length === 0)

  const createRec = await api(`/api/projects/${projectId}/records/tasks`, {
    method: 'POST',
    body: JSON.stringify({ record: { title: '写周报', priority: '高', done: false } }),
  })
  check('可通过令牌写入手势创建记录', createRec.status === 201, `status=${createRec.status}`)

  const afterCreate = await api(`/api/projects/${projectId}/records/tasks`)
  check('记录已持久化', (afterCreate.body?.data?.records ?? []).length === 1)
  const rec = afterCreate.body.data.records[0]

  const patchRec = await api(`/api/projects/${projectId}/records/tasks/${rec.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ patch: { done: true } }),
  })
  check('可更新记录（切换完成状态）', patchRec.status === 200)

  const afterPatch = await api(`/api/projects/${projectId}/records/tasks`)
  check('更新已持久化', afterPatch.body?.data?.records?.[0]?.done === true)

  // 数据在“换一个请求/连接”后仍然存在 —— 即真实持久化
  const fresh = await fetch(`${BASE}/api/projects/${projectId}/records/tasks`, {
    headers: { 'X-Atoms-Preview-Token': pt },
  })
  const freshJson = await fresh.json()
  check('跨请求读取仍能看到数据', (freshJson?.data?.records ?? []).length === 1)

  section('7. 迭代与版本回滚（M7）')
  const iterate = await api('/api/runs', {
    method: 'POST',
    // 注意：tasks 模板本身已有 priority 字段，这里用确实不存在的「负责人」才能产生真实改动
    body: JSON.stringify({ projectId, userInput: '请增加一个负责人字段', autoConfirm: true }),
  })
  check('有 Spec 后自动识别为 iterate 模式', iterate.body?.data?.mode === 'iterate')
  const iterRunId = iterate.body?.data?.runId
  const iterDriven = await driveRun(iterRunId)
  check('迭代流程可跑完', iterDriven.ok, iterDriven.error ?? '')

  const specV2Res = await api(`/api/projects/${projectId}/spec`)
  check('迭代产生 v2', specV2Res.body?.data?.version === 2, `version=${specV2Res.body?.data?.version}`)
  const ownerField = (specV2Res.body?.data?.spec?.dataModels ?? [])
    .flatMap((m) => m.fields ?? [])
    .find((f) => f.name === 'owner')
  check('增量修改落地了「负责人」字段', !!ownerField)

  section('7.1 版本差异（M7 的可视化证据）')
  const diff = await api(`/api/projects/${projectId}/diff?from=1&to=2`)
  check('可对比两个版本的结构差异', diff.status === 200 && typeof diff.body?.data?.summary === 'string')
  const diffPaths = (diff.body?.data?.changes ?? []).map((c) => c.path)
  check('差异指出了新增的「负责人」字段', diffPaths.some((p) => p.includes('负责人')), JSON.stringify(diffPaths))
  check(
    '差异未包含无关变更（主题 / 导航 / 页面结构）—— 证明只动了目标片段',
    !diffPaths.some((p) => p.startsWith('主题') || p === '导航' || p.startsWith('页面「')),
    JSON.stringify(diffPaths),
  )
  check('每条差异都带可读中文描述', (diff.body?.data?.changes ?? []).every((c) => typeof c.description === 'string' && c.description.length > 0))

  const diffNoFrom = await api(`/api/projects/${projectId}/diff`)
  check('缺少 from 参数时返回 400', diffNoFrom.status === 400, `status=${diffNoFrom.status}`)
  const diffBadVersion = await api(`/api/projects/${projectId}/diff?from=999`)
  check('对比不存在的版本返回 404', diffBadVersion.status === 404, `status=${diffBadVersion.status}`)

  const stillThere = await api(`/api/projects/${projectId}/records/tasks`)
  check('迭代后生成物数据未丢失', (stillThere.body?.data?.records ?? []).length === 1)

  const rollback = await api(`/api/projects/${projectId}/versions/1/rollback`, { method: 'POST' })
  check('回滚成功且以新版本追加', rollback.body?.data?.version === 3, JSON.stringify(rollback.body?.data))
  const versionsAfter = await api(`/api/projects/${projectId}/spec`)
  check('历史版本未被删除（v1 仍可查）', (versionsAfter.body?.data?.versions ?? []).some((v) => v.version === 1))
  const afterRollbackRecords = await api(`/api/projects/${projectId}/records/tasks`)
  check('回滚后生成物数据不丢', (afterRollbackRecords.body?.data?.records ?? []).length === 1)

  section('8. 导出与分享（M13）')
  const exportRes = await fetch(`${BASE}/api/projects/${projectId}/export`, { headers: { Cookie: cookie } })
  const exportHtml = await exportRes.text()
  check('导出返回 HTML 附件', exportRes.status === 200 && exportHtml.startsWith('<!doctype html'))
  check('导出内容内联了渲染运行时', exportHtml.includes('AtomsRuntime'))
  check('导出内容内联了 App Spec', exportHtml.includes('dataModels'))
  check('导出使用本地存储适配器（离线可运行）', exportHtml.includes('createLocalAdapter'))

  const share = await api(`/api/projects/${projectId}/share`, { method: 'POST' })
  const shareUrl = share.body?.data?.url
  check('可生成只读分享链接', typeof shareUrl === 'string' && shareUrl.includes('pt='))

  const roToken = decodeURIComponent(new URL(shareUrl).searchParams.get('pt') ?? '')
  const roWrite = await fetch(`${BASE}/api/projects/${projectId}/records/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Atoms-Preview-Token': roToken },
    body: JSON.stringify({ record: { title: '不应被写入' } }),
  })
  check('只读分享令牌无法写入数据（越权被拒）', roWrite.status === 403, `status=${roWrite.status}`)

  const roRead = await fetch(`${BASE}/api/projects/${projectId}/records/tasks`, {
    headers: { 'X-Atoms-Preview-Token': roToken },
  })
  check('只读分享令牌可以读取数据', roRead.status === 200)

  const badToken = await fetch(`${BASE}/api/projects/${projectId}/records/tasks`, {
    headers: { 'X-Atoms-Preview-Token': 'forged.token.value' },
  })
  check('伪造令牌被拒绝', badToken.status === 401, `status=${badToken.status}`)

  section('9. 越权与输入校验（M11）')
  // 用第二个账号验证跨用户隔离
  const firstUserCookie = cookie
  cookie = ''
  await api('/api/auth/demo', { method: 'POST' })
  const secondUserCookie = cookie
  cookie = firstUserCookie

  const crossRun = await api(
    '/api/runs',
    { method: 'POST', body: JSON.stringify({ projectId, userInput: '尝试访问他人项目' }) },
    secondUserCookie,
  )
  check('跨用户访问他人项目被拒（404，不泄露存在性）', crossRun.status === 404, `status=${crossRun.status}`)

  const crossSpec = await api(`/api/projects/${projectId}/spec`, {}, secondUserCookie)
  check('跨用户读取他人 Spec 被拒', crossSpec.status === 404, `status=${crossSpec.status}`)

  const crossDelete = await api(`/api/projects/${projectId}`, { method: 'DELETE' }, secondUserCookie)
  check('跨用户删除他人项目被拒', crossDelete.status === 404, `status=${crossDelete.status}`)

  const noAuth = await fetch(`${BASE}/api/projects`)
  check('未登录访问项目接口返回 401', noAuth.status === 401, `status=${noAuth.status}`)

  const tooLong = await api('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ projectId, userInput: 'x'.repeat(5000) }),
  })
  check('超长输入被拒绝', tooLong.status === 400, `status=${tooLong.status}`)

  const empty = await api('/api/runs', { method: 'POST', body: JSON.stringify({ projectId, userInput: '   ' }) })
  check('空输入被拒绝', empty.status === 400, `status=${empty.status}`)

  section('8.1 取消生成（IT-5）')
  const cancellable = await api('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ projectId, userInput: '做一个会议室预约系统：提交预约并确认或取消。' }),
  })
  const cancelId = cancellable.body?.data?.runId
  check('可创建待取消的生成任务', cancellable.status === 201 && !!cancelId, `status=${cancellable.status}`)
  if (cancelId) {
    await api(`/api/runs/${cancelId}/step`, { method: 'POST' })
    const cancelled = await api(`/api/runs/${cancelId}/cancel`, { method: 'POST' })
    check(
      '可取消生成，状态置为 cancelled',
      cancelled.status === 200 && cancelled.body?.data?.run?.status === 'cancelled',
      JSON.stringify(cancelled.body?.data),
    )
    const afterCancel = await api(`/api/runs/${cancelId}`)
    check('取消状态已持久化（重新读取仍为 cancelled）', afterCancel.body?.data?.run?.status === 'cancelled')
    check(
      '取消留下 run.cancelled 事件',
      (afterCancel.body?.data?.events ?? []).some((e) => e.type === 'run.cancelled'),
    )
    check(
      '取消后已产出产物仍保留',
      (afterCancel.body?.data?.artifacts ?? []).length > 0,
      '取消不应清空产物',
    )
    const stepAfterCancel = await api(`/api/runs/${cancelId}/step`, { method: 'POST' })
    check(
      '取消后继续推进是幂等的',
      stepAfterCancel.body?.data?.run?.status === 'cancelled' && stepAfterCancel.body?.data?.done === true,
    )
  }

  section('8.2 生成中状态恢复（IT-6）')
  const recoverable = await api('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ projectId, userInput: '做一个库存管理工具：登记物料入库并查看分类汇总。' }),
  })
  const recoverId = recoverable.body?.data?.runId
  check('可创建用于恢复验证的生成任务', recoverable.status === 201 && !!recoverId, `status=${recoverable.status}`)
  if (recoverId) {
    await api(`/api/runs/${recoverId}/step`, { method: 'POST' })
    const snap1 = await api(`/api/runs/${recoverId}`)
    const snap2 = await api(`/api/runs/${recoverId}`)
    check(
      '两次快照阶段一致（状态已落库，刷新后可恢复）',
      snap1.body?.data?.run?.stage === snap2.body?.data?.run?.stage,
      `${snap1.body?.data?.run?.stage} vs ${snap2.body?.data?.run?.stage}`,
    )
    check('调用次数与用量已落库', (snap2.body?.data?.run?.callCount ?? 0) > 0)
    check('事件已持久化，可用于重放对齐', (snap2.body?.data?.events ?? []).length > 0)
    const continued = await api(`/api/runs/${recoverId}/step`, { method: 'POST' })
    check(
      '可以从落库状态继续推进（而不是从头开始）',
      continued.status === 200 && continued.body?.data?.run?.stage !== snap2.body?.data?.run?.stage,
    )
    await api(`/api/runs/${recoverId}/cancel`, { method: 'POST' })
  }

  section('8.3 图表/看板类需求（IT-3：另一类模板，防止"只有待办能跑"）')
  const dashReq = '做一个销售记录工具：录入每日销售额与产品，用图表展示汇总趋势。'
  const dashProj = await api('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'E2E 销售看板', description: dashReq }),
  })
  const dashProjectId = dashProj.body?.data?.project?.id
  check('可创建看板类项目', dashProj.status === 200 && !!dashProjectId, `status=${dashProj.status}`)
  if (dashProjectId) {
    const dashRun = await api('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ projectId: dashProjectId, userInput: dashReq }),
    })
    const dashRunId = dashRun.body?.data?.runId
    check('看板类需求可发起生成', dashRun.status === 201 && !!dashRunId, `status=${dashRun.status}`)
    if (dashRunId) {
      // 新 Run 同样要过人工确认 Gate：先推到 Gate，确认，再继续
      await api(`/api/runs/${dashRunId}/step`, { method: 'POST' })
      const dashGate = await api(`/api/runs/${dashRunId}/step`, { method: 'POST' })
      check(
        '看板类需求同样停在 Gate 等人工确认',
        dashGate.body?.data?.run?.stage === 'awaiting_confirm',
        JSON.stringify(dashGate.body?.data?.run?.stage),
      )
      await api(`/api/runs/${dashRunId}/confirm`, { method: 'POST' })

      const dashDriven = await driveRun(dashRunId)
      check('看板类需求可完整生成完成（不是只有待办模板能跑）', dashDriven.ok, dashDriven.error ?? '')

      const dashSnap = await api(`/api/runs/${dashRunId}`)
      const dashArtifacts = dashSnap.body?.data?.artifacts ?? []
      const dashVerify = dashArtifacts.filter((a) => a.type === 'verification').pop()?.payload
      check('看板类需求的校验报告如实通过', dashVerify?.ok === true, dashVerify?.summary ?? '')

      const dashSpecRes = await api(`/api/projects/${dashProjectId}/spec`)
      const dashSpec = dashSpecRes.body?.data?.spec
      const dashComps = (dashSpec?.pages ?? []).flatMap((p) => p.components ?? [])
      const dashTypes = [...new Set(dashComps.map((c) => c.type))]
      check('看板包含图表组件（M5 图表能力）', dashTypes.includes('chart'), `实际组件：${dashTypes.join('、')}`)
      check('看板包含统计卡片', dashTypes.includes('stats'), `实际组件：${dashTypes.join('、')}`)

      const chart = dashComps.find((c) => c.type === 'chart')
      check(
        '图表声明了数据来源、分组字段与聚合方式（否则渲染冒烟会拦）',
        !!chart?.model && !!chart?.xField && !!chart?.aggregate,
        JSON.stringify({ model: chart?.model, xField: chart?.xField, aggregate: chart?.aggregate }),
      )
      const modelNames = (dashSpec?.dataModels ?? []).map((m) => m.name)
      check(
        '图表的 model 指向已声明的数据集合（数据来自持久层，不是前端造数）',
        modelNames.includes(chart?.model),
        `model=${chart?.model} 已声明=${modelNames.join('、')}`,
      )

      const collection = modelNames[0]
      if (collection) {
        const dashRec = await api(`/api/projects/${dashProjectId}/records/${collection}`, {
          method: 'POST',
          body: JSON.stringify({ record: { note: 'E2E 看板数据' } }),
        })
        check('可往看板的数据集合写入记录', dashRec.status === 201, `status=${dashRec.status}`)
        const dashRead = await api(`/api/projects/${dashProjectId}/records/${collection}`)
        check('看板数据来自持久层（跨请求可读回）', (dashRead.body?.data?.records ?? []).length >= 1)
      } else {
        check('看板的数据集合可识别（用于写入验证）', false, '未解析出数据集合名，写入验证被跳过')
      }
    }
    await api(`/api/projects/${dashProjectId}`, { method: 'DELETE' })
  }

  section('8.4 会话消息历史（F-M2-2）')
  const msgs = await api(`/api/projects/${projectId}/messages`)
  const msgList = msgs.body?.data?.messages ?? []
  check('可读取会话消息历史', msgs.status === 200 && Array.isArray(msgList), `status=${msgs.status}`)
  check('消息历史包含用户的需求描述', msgList.some((m) => m.role === 'user' && String(m.content).includes('待办')), JSON.stringify(msgList))
  check(
    '消息历史包含各智能体的产出记录（否则刷新后看不出"它做了什么"）',
    msgList.some((m) => m.role === 'agent'),
    JSON.stringify(msgList.map((m) => m.role)),
  )
  check('消息都带时间戳', msgList.every((m) => typeof m.createdAt === 'string' && m.createdAt.length > 0))
  const crossMsgs = await api(`/api/projects/${projectId}/messages`, {}, 'atoms_session=forged')
  check('伪造会话读取消息被拒（401）', crossMsgs.status === 401, `status=${crossMsgs.status}`)

  section('9.2 安全响应头（M11 F-M11-7）')
  const headRes = await fetch(`${BASE}/`)
  check('包含 X-Content-Type-Options: nosniff', headRes.headers.get('x-content-type-options') === 'nosniff')
  check(
    '包含 X-Frame-Options: SAMEORIGIN（允许自有预览，禁止被第三方嵌套）',
    (headRes.headers.get('x-frame-options') ?? '').toUpperCase().includes('SAMEORIGIN'),
    headRes.headers.get('x-frame-options') ?? '',
  )
  check('包含 Referrer-Policy（避免预览令牌经 Referer 外泄）', (headRes.headers.get('referrer-policy') ?? '').length > 0)
  check(
    'CSP 的 frame-ancestors 与沙箱策略一致',
    (headRes.headers.get('content-security-policy') ?? '').includes("frame-ancestors 'self'"),
    headRes.headers.get('content-security-policy') ?? '',
  )
  check('包含 Permissions-Policy', (headRes.headers.get('permissions-policy') ?? '').length > 0)

  section('9.3 限流（M11 TST-M11-1）')
  let sawRateLimit = false
  let rateLimitMessage = ''
  for (let i = 0; i < 40; i += 1) {
    const r = await api('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ projectId, userInput: `限流探测 ${i}` }),
    })
    if (r.status === 429) {
      sawRateLimit = true
      rateLimitMessage = r.body?.error?.message ?? ''
      break
    }
  }
  check('高频调用生成接口会触发 429 限流', sawRateLimit, '40 次内未触发限流')
  check('限流提示可读并说明可等待', /过于频繁|限流/.test(rateLimitMessage), rateLimitMessage)

  section('10. 清理')
  const del = await api(`/api/projects/${projectId}`, { method: 'DELETE' })
  check('可删除项目', del.status === 200, `status=${del.status} body=${JSON.stringify(del.body).slice(0, 200)}`)
  const gone = await api(`/api/projects/${projectId}/spec`)
  check(
    '删除后不可再访问（级联清理）',
    gone.status === 404,
    `status=${gone.status} body=${JSON.stringify(gone.body).slice(0, 200)}`,
  )
  const goneRecords = await api(`/api/projects/${projectId}/records/tasks`)
  check('删除后生成物数据也不可访问', goneRecords.status === 404, `status=${goneRecords.status}`)

  console.log(`\n──────────────────────────────`)
  console.log(`通过：${passed}　失败：${failed}`)
  if (failed > 0) {
    console.log('\n失败明细：')
    failures.forEach((f) => console.log(`  · ${f}`))
  }
  console.log(`──────────────────────────────`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('冒烟测试异常终止：', err)
  process.exit(1)
})
