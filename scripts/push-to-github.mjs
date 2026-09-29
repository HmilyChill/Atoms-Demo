#!/usr/bin/env node
/**
 * 把本地仓库推送到 GitHub —— 走 **GitHub REST API（Git Data API）**，保留完整提交历史与 tag。
 *
 * 为什么不用 `git push`：
 *   本机环境下 git 的 TLS 无法初始化（schannel: SEC_E_NO_CREDENTIALS），
 *   而 Node 的网络栈正常（api.github.com 可达）。因此用 API 逐个重建提交。
 *
 * 用法：
 *   node scripts/push-to-github.mjs --dry-run          # 本地演练，不联网（可随时验证）
 *   GITHUB_TOKEN=ghp_xxx node scripts/push-to-github.mjs
 *
 * 可选环境变量：
 *   GITHUB_REPO     仓库名（默认 atoms-demo）
 *   GITHUB_BRANCH   分支名（默认 main）
 *   GITHUB_OWNER    显式指定属主（默认取当前 token 的登录名）
 */

import { spawnSync } from 'node:child_process'
import { openSync, closeSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'

const TOKEN = (process.env.GITHUB_TOKEN ?? '').trim()
const REPO = (process.env.GITHUB_REPO ?? 'atoms-demo').trim()
const BRANCH = (process.env.GITHUB_BRANCH ?? 'main').trim()
const DRY_RUN = process.argv.includes('--dry-run')
const API = 'https://api.github.com'
const TMP_DIR = path.join(process.cwd(), '.data', 'push-tmp')

// ─────────────────────────── 本地 git 读取 ───────────────────────────
// 注意：本机禁止 child_process 的管道 stdio（spawn EPERM），
// 因此所有 git 调用的输出都重定向到**文件**再读取。

mkdirSync(TMP_DIR, { recursive: true })
let seq = 0

function git(args, options = {}) {
  seq += 1
  const outFile = path.join(TMP_DIR, `out-${seq}.bin`)
  const errFile = path.join(TMP_DIR, `err-${seq}.txt`)
  const outFd = openSync(outFile, 'w')
  const errFd = openSync(errFile, 'w')
  const res = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { stdio: ['ignore', outFd, errFd] })
  closeSync(outFd)
  closeSync(errFd)
  if (res.status !== 0) {
    const err = readFileSync(errFile, 'utf8').trim()
    throw new Error(`git ${args.join(' ')} 失败（status=${res.status}）：${err}`)
  }
  return options.binary ? readFileSync(outFile) : readFileSync(outFile, 'utf8')
}

function localCommits() {
  return git(['rev-list', '--reverse', 'HEAD']).trim().split(/\r?\n/).filter(Boolean)
}

function commitMeta(sha) {
  const raw = git(['log', '-1', '--format=%an%x00%ae%x00%aI%x00%B', sha])
  const [name, email, date, ...rest] = raw.split('\x00')
  return { name, email, date, message: rest.join('\x00').trim() }
}

function commitFiles(sha) {
  const raw = git(['ls-tree', '-r', sha])
  return raw
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [meta, filePath] = line.split('\t')
      const [mode, type, blobSha] = meta.split(/\s+/)
      return { path: filePath, mode, type, blobSha }
    })
}

function localTags() {
  const raw = git(['show-ref', '--tags'])
  return raw
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sha, ref] = line.split(/\s+/)
      const name = ref.replace('refs/tags/', '')
      const target = git(['rev-parse', `${name}^{commit}`]).trim()
      return { name, target, annotatedSha: sha }
    })
}

// ─────────────────────────── GitHub API ───────────────────────────

/**
 * 带重试的请求。
 *
 * 为什么必须重试：本机网络的对外访问是**间歇性**的（实测同一域名连续 3 次
 * `fetch failed`、第 4 次 200）。一次推送要发约 300 个请求，不重试几乎必然中断。
 * 只重试网络层错误与 5xx/429，**不重试 4xx**（那是真错误，重试只会浪费时间）。
 */
async function apiOnce(method, endpoint, body) {
  const res = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'atoms-demo-push',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { ok: res.ok, status: res.status, json, text }
}

async function api(method, endpoint, body, attempts = 5) {
  let lastError = null
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await apiOnce(method, endpoint, body)
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`HTTP ${res.status}`)
        if (i < attempts) {
          await new Promise((r) => setTimeout(r, 1000 * i))
          continue
        }
      }
      return res
    } catch (err) {
      lastError = err
      if (i < attempts) await new Promise((r) => setTimeout(r, 1000 * i))
    }
  }
  throw lastError ?? new Error('请求失败')
}

// ─────────────────────────── 主流程 ───────────────────────────

async function main() {
  console.log('=== 读取本地仓库 ===')
  const commits = localCommits()
  const tags = localTags()
  console.log(`  提交数：${commits.length}`)
  console.log(`  tag：${tags.map((t) => t.name).join(', ') || '（无）'}`)

  if (commits.length === 0) throw new Error('本地仓库没有提交，无法推送')

  const headFiles = commitFiles(commits[commits.length - 1])
  console.log(`  HEAD 文件数：${headFiles.length}`)

  // 统计需要上传的 blob（按本地 blob sha 去重）
  const uniqueBlobs = new Set()
  let treeEntries = 0
  for (const sha of commits) {
    const files = commitFiles(sha)
    treeEntries += files.length
    files.forEach((f) => uniqueBlobs.add(f.blobSha))
  }
  console.log(`  唯一 blob 数：${uniqueBlobs.size}`)
  console.log(`  tree 条目合计：${treeEntries}`)
  console.log(`  预计 API 调用：约 ${uniqueBlobs.size + commits.length * 2 + tags.length + 4} 次`)

  if (DRY_RUN) {
    console.log('\n=== DRY RUN：本地演练通过，未联网、未创建任何远程对象 ===')
    console.log('  提交顺序（最旧 → 最新）：')
    commits.forEach((sha, i) => {
      const meta = commitMeta(sha)
      console.log(`   ${i + 1}. ${sha.slice(0, 7)}  ${meta.message.split('\n')[0]}`)
    })
    console.log('\n  加 GITHUB_TOKEN 环境变量后重新运行即可真正推送。')
    rmSync(TMP_DIR, { recursive: true, force: true })
    return
  }

  if (!TOKEN) throw new Error('缺少 GITHUB_TOKEN 环境变量')

  console.log('\n=== 校验令牌 ===')
  const me = await api('GET', '/user')
  if (!me.ok) throw new Error(`令牌无效或权限不足（HTTP ${me.status}）：${me.text.slice(0, 200)}`)
  const owner = (process.env.GITHUB_OWNER ?? me.json.login).trim()
  console.log(`  已认证：${me.json.login}`)

  console.log('\n=== 准备仓库 ===')
  let repoExists = (await api('GET', `/repos/${owner}/${REPO}`)).ok
  if (!repoExists) {
    const created = await api('POST', '/user/repos', {
      name: REPO,
      private: false,
      description: 'Atoms Demo · 智能体驱动的应用生成（Spec 驱动 + 沙箱预览 + 校验自愈）',
      auto_init: false,
      has_issues: true,
      has_wiki: false,
    })
    if (!created.ok && created.status !== 422) {
      throw new Error(`创建仓库失败（HTTP ${created.status}）：${created.text.slice(0, 200)}`)
    }
    repoExists = true
    console.log(`  已创建 public 仓库：${owner}/${REPO}`)
  } else {
    console.log(`  仓库已存在：${owner}/${REPO}（将强制更新 ${BRANCH} 分支）`)
  }

  /**
   * 空仓库引导。
   *
   * GitHub 的 Git Data API 在**完全空**的仓库上会拒绝建 blob：
   *   POST /git/blobs -> 409 {"message":"Git Repository is empty."}
   * 这是服务端限制（空仓库没有可挂靠的 ref），不是权限问题。
   * 解法：先用 Contents API 落一个初始提交把仓库"激活"，再用 Git Data API 重建完整历史；
   * 那个引导提交随后会被强推覆盖，不会出现在最终历史里。
   */
  const headRef = await api('GET', `/repos/${owner}/${REPO}/git/ref/heads/${BRANCH}`)
  if (!headRef.ok) {
    console.log('  仓库还是空的 → 先落一个引导提交（Git Data API 不允许在空仓库上建 blob）')
    const boot = await api('PUT', `/repos/${owner}/${REPO}/contents/.atoms-bootstrap`, {
      message: 'chore: 引导空仓库（随后由完整历史强推覆盖）',
      content: Buffer.from('bootstrap\n').toString('base64'),
      branch: BRANCH,
    })
    if (!boot.ok) {
      throw new Error(`引导提交失败（HTTP ${boot.status}）：${boot.text.slice(0, 200)}`)
    }
    console.log('  ✓ 引导提交完成，继续重建完整历史')
  }

  console.log('\n=== 上传 blob 并重建提交历史 ===')
  const blobCache = new Map() // 本地 blob sha -> 远程 blob sha
  const commitMap = new Map() // 本地 commit sha -> 远程 commit sha
  let parentSha = null

  for (let i = 0; i < commits.length; i += 1) {
    const localSha = commits[i]
    const files = commitFiles(localSha)
    const meta = commitMeta(localSha)

    const tree = []
    for (const file of files) {
      let remoteBlob = blobCache.get(file.blobSha)
      if (!remoteBlob) {
        const content = git(['cat-file', 'blob', file.blobSha], { binary: true })
        const uploaded = await api('POST', `/repos/${owner}/${REPO}/git/blobs`, {
          content: content.toString('base64'),
          encoding: 'base64',
        })
        if (!uploaded.ok) throw new Error(`上传 blob 失败（${file.path}）：HTTP ${uploaded.status}`)
        remoteBlob = uploaded.json.sha
        blobCache.set(file.blobSha, remoteBlob)
      }
      tree.push({ path: file.path, mode: file.mode, type: 'blob', sha: remoteBlob })
    }

    const treeRes = await api('POST', `/repos/${owner}/${REPO}/git/trees`, { tree })
    if (!treeRes.ok) throw new Error(`创建 tree 失败：HTTP ${treeRes.status} ${treeRes.text.slice(0, 160)}`)

    const commitRes = await api('POST', `/repos/${owner}/${REPO}/git/commits`, {
      message: meta.message,
      tree: treeRes.json.sha,
      parents: parentSha ? [parentSha] : [],
      author: { name: meta.name, email: meta.email, date: meta.date },
      committer: { name: meta.name, email: meta.email, date: meta.date },
    })
    if (!commitRes.ok) throw new Error(`创建 commit 失败：HTTP ${commitRes.status} ${commitRes.text.slice(0, 160)}`)

    parentSha = commitRes.json.sha
    commitMap.set(localSha, parentSha)
    console.log(`  [${i + 1}/${commits.length}] ${localSha.slice(0, 7)} → ${parentSha.slice(0, 7)}  ${meta.message.split('\n')[0]}`)
  }

  console.log('\n=== 更新分支引用 ===')
  const existingRef = await api('GET', `/repos/${owner}/${REPO}/git/ref/heads/${BRANCH}`)
  if (existingRef.ok) {
    const updated = await api('PATCH', `/repos/${owner}/${REPO}/git/refs/heads/${BRANCH}`, { sha: parentSha, force: true })
    if (!updated.ok) throw new Error(`更新分支失败：HTTP ${updated.status}`)
    console.log(`  已强制更新 ${BRANCH} → ${parentSha.slice(0, 7)}`)
  } else {
    const createdRef = await api('POST', `/repos/${owner}/${REPO}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: parentSha })
    if (!createdRef.ok) throw new Error(`创建分支失败：HTTP ${createdRef.status} ${createdRef.text.slice(0, 160)}`)
    console.log(`  已创建 ${BRANCH} → ${parentSha.slice(0, 7)}`)
  }

  console.log('\n=== 重建 tag ===')
  for (const tag of tags) {
    const remoteTarget = commitMap.get(tag.target)
    if (!remoteTarget) {
      console.log(`  跳过 ${tag.name}（目标提交不在推送范围内）`)
      continue
    }
    const res = await api('POST', `/repos/${owner}/${REPO}/git/refs`, { ref: `refs/tags/${tag.name}`, sha: remoteTarget })
    if (res.ok) {
      console.log(`  ✓ ${tag.name} → ${remoteTarget.slice(0, 7)}`)
    } else if (res.status === 422) {
      console.log(`  · ${tag.name} 已存在，跳过`)
    } else {
      console.log(`  ✗ ${tag.name} 失败：HTTP ${res.status}`)
    }
  }

  console.log('\n=== 完成 ===')
  console.log(`  仓库：https://github.com/${owner}/${REPO}`)
  console.log(`  分支：${BRANCH}（${commits.length} 个提交，历史完整保留）`)
  console.log('  请确认仓库为 public，并检查是否误提交了任何密钥。')
  rmSync(TMP_DIR, { recursive: true, force: true })
}

main().catch((err) => {
  console.error(`\n推送失败：${err instanceof Error ? err.message : String(err)}`)
  rmSync(TMP_DIR, { recursive: true, force: true })
  process.exit(1)
})
