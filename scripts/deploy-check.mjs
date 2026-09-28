#!/usr/bin/env node
/**
 * 部署自检脚本：对**已部署的公网地址**跑一遍关键验收步骤。
 *
 * 用途：S0/S9 阶段的"陌生人视角复测"自动化版本。
 * 拿到在线链接后第一件事就运行它，能立刻发现环境变量、持久化、跨域等问题。
 *
 * 用法：
 *   node scripts/deploy-check.mjs https://your-app.vercel.app
 *   或 BASE_URL=https://your-app.vercel.app node scripts/deploy-check.mjs
 */

const BASE = (process.argv[2] ?? process.env.BASE_URL ?? '').replace(/\/$/, '')

if (!BASE) {
  console.error('用法：node scripts/deploy-check.mjs <部署地址>')
  process.exit(2)
}
if (!/^https?:\/\//.test(BASE)) {
  console.error('部署地址必须带协议，例如 https://your-app.vercel.app')
  process.exit(2)
}

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
async function api(path, init = {}) {
  const headers = { 'Content-Type': 'application/json', ...(init.headers ?? {}) }
  if (cookie) headers.Cookie = cookie
  const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: 'manual' })
  const setCookie = res.headers.getSetCookie?.() ?? []
  const session = setCookie.find((c) => c.startsWith('atoms_session='))
  if (session) cookie = session.split(';')[0]
  let body = null
  const text = await res.text()
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, body, raw: text }
}

async function main() {
  console.log(`部署自检 · ${BASE}`)

  section('1. 服务与配置')
  const health = await api('/api/health')
  check('健康检查可用', health.status === 200 && health.body?.data?.ok === true, `status=${health.status}`)
  const provider = health.body?.data?.provider
  console.log(`     provider=${provider?.kind} model=${provider?.model} demoMode=${provider?.demoMode}`)
  if (provider?.demoMode) {
    console.log('     ℹ️ 当前为演示模式（未配置 API Key）：功能完整，但生成结果来自确定性 Mock。')
  } else {
    console.log('     ℹ️ 已配置真实模型。建议随后确认一次真实生成的质量。')
  }
  const authSecretConfigured = health.body?.data?.ok === true
  check('服务端运行正常', authSecretConfigured)
  if (health.body?.data?.runtime?.env !== 'production') {
    console.log(`     ⚠️ NODE_ENV=${health.body?.data?.runtime?.env}（生产环境应为 production）`)
  }

  section('2. 首页与静态资源')
  const home = await fetch(`${BASE}/`)
  check('首页可访问', home.status === 200, `status=${home.status}`)
  const runtime = await fetch(`${BASE}/app-runtime.js`)
  check('渲染运行时资源可访问', runtime.status === 200, `status=${runtime.status}`)

  section('3. 身份（数据隔离与持久化前提）')
  const demo = await api('/api/auth/demo', { method: 'POST' })
  check('一键体验可创建账号', demo.status === 200 && !!demo.body?.data?.id, `status=${demo.status}`)
  check('已下发会话 Cookie', cookie.startsWith('atoms_session='))
  const me = await api('/api/auth/me')
  check('登录态可读取', !!me.body?.data?.user)

  section('4. 项目与持久化')
  const created = await api('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: '部署自检项目', description: '由 deploy-check 自动创建' }),
  })
  const projectId = created.body?.data?.project?.id
  check('可创建项目', created.status === 200 && !!projectId, `status=${created.status}`)
  const list = await api('/api/projects')
  check('项目列表包含新项目（服务端持久化生效）', (list.body?.data?.projects ?? []).some((p) => p.id === projectId))

  section('5. 生成管线（端到端）')
  const run = await api('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ projectId, userInput: '做一个个人待办清单：能新增任务、标记完成、按状态筛选、删除。', autoConfirm: true }),
  })
  const runId = run.body?.data?.runId
  check('可创建生成任务', run.status === 201 && !!runId, `status=${run.status} ${JSON.stringify(run.body?.error ?? {})}`)

  if (runId) {
    let done = false
    let last = null
    for (let i = 0; i < 40; i += 1) {
      const step = await api(`/api/runs/${runId}/step`, { method: 'POST' })
      if (step.status !== 200) {
        check('生成步骤可推进', false, `status=${step.status} ${JSON.stringify(step.body?.error ?? {})}`)
        break
      }
      last = step.body.data
      if (last.done) {
        done = true
        break
      }
      if (last.run.status === 'failed') break
    }
    check('生成流程可跑完', done, last?.run?.errorMessage ?? '')
    check('生成成功', last?.run?.status === 'succeeded', `status=${last?.run?.status}`)
  }

  const spec = await api(`/api/projects/${projectId}/spec`)
  check('Spec 已生成并持久化', spec.body?.data?.version === 1, `version=${spec.body?.data?.version}`)

  const verification = spec.body?.data?.verification
  check('产生了校验报告', !!verification)
  if (verification) {
    console.log(`     校验结论：${verification.ok ? '全部通过' : '未全部通过（如实上报）'} — ${verification.summary ?? ''}`)
  }

  section('6. 预览与生成物数据')
  const tokenRes = await api(`/api/projects/${projectId}/preview-token`)
  const pt = tokenRes.body?.data?.token
  check('可签发预览令牌', typeof pt === 'string' && pt.length > 20)
  const preview = await fetch(`${BASE}/preview/${projectId}?pt=${encodeURIComponent(pt ?? '')}`)
  check('预览页可访问', preview.status === 200, `status=${preview.status}`)

  const rec = await api(`/api/projects/${projectId}/records/tasks`, {
    method: 'POST',
    body: JSON.stringify({ record: { title: '部署自检记录', done: false } }),
  })
  check('生成应用的数据可写入', rec.status === 201, `status=${rec.status}`)
  const readBack = await fetch(`${BASE}/api/projects/${projectId}/records/tasks`, {
    headers: { 'X-Atoms-Preview-Token': pt ?? '' },
  })
  const readJson = await readBack.json().catch(() => null)
  check('数据可跨请求读回（真实持久化）', (readJson?.data?.records ?? []).length >= 1)

  section('7. 导出与安全')
  const exported = await fetch(`${BASE}/api/projects/${projectId}/export`, { headers: { Cookie: cookie } })
  const exportHtml = await exported.text()
  check('可导出单文件应用', exported.status === 200 && exportHtml.includes('AtomsRuntime'))
  check(
    '单文件导出不引用外部资源（离线可运行）',
    !/<script[^>]+src=/i.test(exportHtml) && !/<link[^>]+href=/i.test(exportHtml),
  )

  const zipExported = await fetch(`${BASE}/api/projects/${projectId}/export?format=zip`, {
    headers: { Cookie: cookie },
  })
  const zipBuf = Buffer.from(await zipExported.arrayBuffer())
  check(
    '可导出多文件工程 ZIP',
    zipExported.status === 200 && zipBuf[0] === 0x50 && zipBuf[1] === 0x4b,
    `status=${zipExported.status} bytes=${zipBuf.length}`,
  )
  check(
    'ZIP 的 Content-Type 正确',
    (zipExported.headers.get('content-type') ?? '').includes('application/zip'),
    zipExported.headers.get('content-type') ?? '',
  )
  // 曾出现：Content-Disposition 里带中文项目名 → HTTP 头要求 Latin-1 → 500
  check(
    'ZIP 响应头不含非 Latin-1 字符（中文项目名需 RFC 5987 编码）',
    !/[^\u0000-\u00ff]/.test(zipExported.headers.get('content-disposition') ?? ''),
    zipExported.headers.get('content-disposition') ?? '',
  )

  const noAuth = await fetch(`${BASE}/api/projects`)
  check('未登录访问被拒', noAuth.status === 401, `status=${noAuth.status}`)

  section('8. 清理')
  const del = await api(`/api/projects/${projectId}`, { method: 'DELETE' })
  check('可删除自检项目', del.status === 200, `status=${del.status}`)

  console.log('\n──────────────────────────────')
  console.log(`通过：${passed}　失败：${failed}`)
  if (failures.length > 0) {
    console.log('\n失败明细：')
    failures.forEach((f) => console.log(`  · ${f}`))
  }
  console.log('──────────────────────────────')
  if (failed > 0) {
    console.log('\n排查建议：')
    console.log('  1) 环境变量是否在 **Production**（不只是 Preview）配置了？')
    console.log('  2) 是否配置了 AUTH_SECRET？未配置会退回开发默认值。')
    console.log('  3) 服务端持久化：Vercel 文件系统只读 → 需接入托管数据库，否则第 4/6 步会失败。')
  }
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(`\n自检异常终止：${err instanceof Error ? err.message : String(err)}`)
  console.error('请确认部署地址可访问、且已配置必要环境变量。')
  process.exit(1)
})
