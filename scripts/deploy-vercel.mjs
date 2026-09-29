/**
 * 用 Vercel REST API 部署到生产环境（不依赖 vercel CLI）。
 *
 * 为什么不用 CLI：
 *  - `pnpm dlx vercel` 会把 dlx 缓存写到 C 盘（本机沙箱禁止，且要求下载一律落 E 盘）；
 *  - CLI 的交互式 `vercel env add` 依赖 stdin 管道，在受限沙箱里不可靠。
 * REST API 只需要 fetch，每一步都可打印、可复现。
 *
 * 用法：
 *   VERCEL_TOKEN=xxx node scripts/deploy-vercel.mjs
 *   VERCEL_TOKEN=xxx node scripts/deploy-vercel.mjs --check     # 部署后跑部署自检
 *
 * 可选环境变量（用于线上持久化）：
 *   TURSO_DATABASE_URL / TURSO_AUTH_TOKEN —— 配了就会同步到 Vercel
 *
 * 安全：脚本**只打印变量名，绝不打印变量值**；本地密钥文件（.env.local 等）绝不上传。
 */
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const TOKEN = process.env.VERCEL_TOKEN ?? ''
const PROJECT = process.env.VERCEL_PROJECT ?? 'atoms-demo'
const API = 'https://api.vercel.com'
const ROOT = process.cwd()
const RUN_CHECK = process.argv.includes('--check')

/** 这些目录不进部署包（比 .gitignore 更严格：构建产物与本地数据绝不外传） */
const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
  '.data',
  '.pnpm-store',
  '.npm-cache',
  '.playwright-browsers',
  'Atoms-Demo',
  'exports',
  'tmp',
])
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db'])

/**
 * 本地密钥文件绝不上传。
 * `.env.local` 里是真实 DeepSeek Key；虽然它被 .gitignore 忽略、Next 也不会对外提供它，
 * 但一旦上传，它就会出现在 Vercel 的部署文件里（控制台可查看源码）——那等于把密钥交给第三方存储。
 * 线上用的是"项目环境变量"，不是这个文件。
 */
function isLocalEnvFile(name) {
  return name === '.env' || (name.startsWith('.env.') && name !== '.env.example')
}

// 不带令牌也能自检"到底会把哪些文件传上去"（密钥文件与题目原文必须不在其中）
if (process.argv.includes('--list-files')) {
  const files = collectFiles()
  const leaked = files.filter((f) => isLocalEnvFile(path.basename(f)))
  const challenge = files.filter((f) => f.includes('Atoms-Demo'))
  console.log(`将上传 ${files.length} 个文件：`)
  for (const f of files) console.log('  ' + f)
  console.log(`\n本地密钥文件：${leaked.length === 0 ? '无（正确）' : '!!! ' + leaked.join(', ')}`)
  console.log(`题目原文：${challenge.length === 0 ? '无（正确）' : '!!! ' + challenge.join(', ')}`)
  process.exit(leaked.length === 0 && challenge.length === 0 ? 0 : 1)
}

if (!TOKEN) {
  console.log('未设置 VERCEL_TOKEN')
  console.log('  获取方式：https://vercel.com/account/tokens → Create Token')
  process.exit(0)
}

function collectFiles(dir = ROOT, rel = '') {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || SKIP_FILES.has(entry) || isLocalEnvFile(entry)) continue
    const full = path.join(dir, entry)
    const relPath = rel ? rel + '/' + entry : entry
    const info = statSync(full)
    if (info.isDirectory()) out.push(...collectFiles(full, relPath))
    else out.push(relPath)
  }
  return out
}

async function api(method, endpoint, body) {
  const res = await fetch(API + endpoint, {
    method,
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, ok: res.ok, json, text }
}

/** 上传单个文件内容（按内容 sha1 去重，与 CLI 用的是同一套机制） */
async function uploadFile(relPath) {
  const content = readFileSync(path.join(ROOT, relPath))
  const sha = createHash('sha1').update(content).digest('hex')
  const res = await fetch(API + '/v2/files', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(content.length),
      'x-vercel-digest': sha,
    },
    body: new Uint8Array(content),
  })
  if (!res.ok && res.status !== 409) {
    throw new Error(`上传文件失败（${relPath}）：HTTP ${res.status}`)
  }
  return { file: relPath, sha, size: content.length }
}

const main = async () => {
  console.log('=== 校验令牌 ===')
  const me = await api('GET', '/v2/user')
  if (!me.ok) throw new Error(`令牌无效（HTTP ${me.status}）：${me.text.slice(0, 200)}`)
  console.log('  已认证：' + (me.json?.user?.username ?? me.json?.user?.email ?? '未知'))

  console.log('\n=== 准备项目 ===')
  let project = (await api('GET', `/v9/projects/${PROJECT}`)).json
  if (!project?.id) {
    const created = await api('POST', '/v11/projects', { name: PROJECT, framework: 'nextjs' })
    if (!created.json?.id) {
      // 最常见的坑：把 AI Gateway 的 key 当成部署令牌用了。
      // 两者前缀不同（AI Gateway 是 vck_），权限也完全不同：Gateway key 只能读账号 + 调模型。
      if (created.status === 403) {
        throw new Error(
          '令牌没有"创建项目"的权限。\n' +
            '   → 如果你用的是 vck_ 开头的 key，那是 **AI Gateway** 的 key（只能调模型），不能部署。\n' +
            '   → 部署需要 Vercel **Access Token**：https://vercel.com/account/tokens → Create Token\n' +
            '     Scope 选你的个人账号（不要选 AI Gateway），有效期建议 1 天即可。',
        )
      }
      throw new Error(`创建项目失败：HTTP ${created.status} ${created.text.slice(0, 200)}`)
    }
    project = created.json
    console.log('  已创建项目：' + PROJECT)
  } else {
    console.log('  项目已存在：' + PROJECT)
  }

  console.log('\n=== 配置环境变量（只打印变量名） ===')
  const existing = (await api('GET', `/v9/projects/${PROJECT}/env`)).json?.envs ?? []
  const envs = [
    // AUTH_SECRET 已存在就不动：每次重新生成会让所有人的登录态失效
    { key: 'AUTH_SECRET', value: randomBytes(32).toString('hex') },
    { key: 'DEMO_MODE', value: process.env.DEMO_MODE ?? 'false' },
  ]
  if (process.env.DEEPSEEK_API_KEY) {
    envs.push({ key: 'DEEPSEEK_API_KEY', value: process.env.DEEPSEEK_API_KEY })
    envs.push({ key: 'DEEPSEEK_BASE_URL', value: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com' })
    envs.push({ key: 'DEEPSEEK_MODEL', value: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash' })
  }
  if (process.env.TURSO_DATABASE_URL) {
    envs.push({ key: 'TURSO_DATABASE_URL', value: process.env.TURSO_DATABASE_URL })
    envs.push({ key: 'TURSO_AUTH_TOKEN', value: process.env.TURSO_AUTH_TOKEN ?? '' })
  }

  for (const item of envs) {
    if (existing.some((e) => e.key === item.key)) {
      console.log('  · ' + item.key + ' 已存在，跳过')
      continue
    }
    const res = await api('POST', `/v10/projects/${PROJECT}/env`, {
      key: item.key,
      value: item.value,
      type: 'encrypted',
      target: ['production', 'preview'],
    })
    console.log(`  ${res.ok ? '[OK]' : '[X]'} ${item.key}${res.ok ? '（已写入）' : `（HTTP ${res.status}）`}`)
  }
  if (!process.env.TURSO_DATABASE_URL) {
    console.log('  [注意] 未提供 TURSO_DATABASE_URL：线上使用临时目录存储，实例回收后数据会重置')
  }

  console.log('\n=== 上传文件 ===')
  const files = collectFiles()
  const leaked = files.filter((f) => isLocalEnvFile(path.basename(f)))
  if (leaked.length > 0) throw new Error('检测到本地密钥文件将被上传，已中止：' + leaked.join(', '))
  if (files.some((f) => f.includes('Atoms-Demo'))) throw new Error('检测到题目原文将被部署，已中止（保密要求）')

  const manifest = []
  for (const file of files) manifest.push(await uploadFile(file))
  const totalKb = Math.round(manifest.reduce((s, f) => s + f.size, 0) / 1024)
  console.log(`  [OK] ${manifest.length} 个文件（未压缩合计 ${totalKb} KB）`)

  console.log('\n=== 创建生产部署 ===')
  const deployment = await api('POST', '/v13/deployments?forceNew=1', {
    name: PROJECT,
    target: 'production',
    files: manifest,
    projectSettings: { framework: 'nextjs' },
  })
  if (!deployment.json?.id) {
    throw new Error(`创建部署失败：HTTP ${deployment.status} ${deployment.text.slice(0, 300)}`)
  }
  const id = deployment.json.id
  console.log('  部署 id：' + id)

  console.log('\n=== 等待构建完成 ===')
  let state = ''
  for (let i = 0; i < 90; i += 1) {
    await new Promise((r) => setTimeout(r, 5000))
    const info = (await api('GET', `/v13/deployments/${id}`)).json
    state = String(info?.readyState ?? info?.status ?? '')
    if (i % 3 === 0) console.log('  · ' + state)
    if (state === 'READY' || state === 'ERROR' || state === 'CANCELED') break
  }
  if (state !== 'READY') throw new Error(`部署未成功：${state}`)

  const site = deployment.json.url ? `https://${deployment.json.url}` : `https://${PROJECT}.vercel.app`
  console.log(`\n部署完成：${site}`)

  if (RUN_CHECK) {
    console.log('\n=== 线上自检 ===')
    const { spawnSync } = await import('node:child_process')
    // stdio: 'inherit' 是刻意的：本沙箱禁止管道 stdio
    spawnSync('node', ['scripts/deploy-check.mjs', site], { stdio: 'inherit' })
  }
  console.log('\n下一步：把线上链接回填到笔试文档与 README。')
}

main().catch((err) => {
  console.error(`\n部署失败：${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
