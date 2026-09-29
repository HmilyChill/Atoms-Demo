/**
 * 安全基线测试（M0 TST-M0-3 / M10 TST-M10-4 密钥扫描 + M1 TST-M1-1 口令哈希）。
 *
 * 密钥扫描为什么要自动化：M0 时我是**手工**搜的，那只能证明"当时没漏"。
 * 之后又加了 Turso / DeepSeek 的密钥变量与推送脚本，必须用测试守住这条红线。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

import { checkPasswordPolicy, hashPassword, verifyPassword } from '@/lib/auth/password'

const ROOT = process.cwd()

/** 这些目录不属于"会被交付的源码"，跳过 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
  '.data',
  '.pnpm-store',
  '.npm-cache',
  '.playwright-browsers',
  'Atoms-Demo', // 题目原文与附件：按题目要求不入库
])

/** 二进制/大文件跳过 */
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.zip', '.woff', '.woff2', '.db'])

/**
 * 本地密钥文件跳过（`.env` / `.env.local` / `.env.*`）。
 *
 * 为什么不算漏报：这些文件**已被 .gitignore 忽略**（本文件另有断言锁死），
 * 永远进不了仓库；而它们按设计就装着真实密钥。
 * 扫描它们只会产生"必然失败"的假警报，反而会逼着人把密钥从本地删掉。
 * 真正要守住的是"**会交付出去的源码里**没有密钥"。
 */
function isLocalEnvFile(name: string): boolean {
  return name === '.env' || (name.startsWith('.env.') && name !== '.env.example')
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    if (isLocalEnvFile(entry)) continue
    const full = path.join(dir, entry)
    const info = statSync(full)
    if (info.isDirectory()) {
      walk(full, out)
    } else if (!SKIP_EXT.has(path.extname(entry).toLowerCase())) {
      out.push(full)
    }
  }
  return out
}

/**
 * 密钥形态特征。
 * 注意：本测试文件自身包含这些模式，因此扫描时排除自己，
 * 否则会"自己命中自己"。
 */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'OpenAI/DeepSeek 风格密钥', re: /sk-[A-Za-z0-9]{20,}/ },
  { name: 'GitHub PAT（经典）', re: /ghp_[A-Za-z0-9]{30,}/ },
  { name: 'GitHub PAT（fine-grained）', re: /github_pat_[A-Za-z0-9_]{30,}/ },
  { name: 'AWS Access Key', re: /AKIA[0-9A-Z]{16}/ },
  { name: '私钥文件内容', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'Turso/libSQL token（JWT 形态）', re: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/ },
]

test('密钥扫描：交付源码中不存在任何密钥形态的字符串（TST-M0-3 / TST-M10-4）', () => {
  const files = walk(ROOT).filter((f) => !f.endsWith(path.join('tests', 'security.test.ts')))
  assert.ok(files.length > 50, `应扫描到足够多的文件（实际 ${files.length}），否则说明遍历逻辑有问题`)

  const hits: string[] = []
  for (const file of files) {
    let content: string
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const { name, re } of SECRET_PATTERNS) {
      const match = content.match(re)
      if (match) {
        hits.push(`${path.relative(ROOT, file)} → ${name}：${match[0].slice(0, 12)}…`)
      }
    }
  }

  assert.deepEqual(hits, [], `发现疑似密钥，必须清理后再提交：\n${hits.join('\n')}`)
})

test('密钥扫描：仓库忽略规则覆盖所有敏感文件（避免误提交）', () => {
  const gitignore = readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
  for (const pattern of ['.env', '.data/', '.pnpm-store/', '.npm-cache/', 'node_modules/']) {
    assert.ok(gitignore.includes(pattern), `.gitignore 应包含 ${pattern}`)
  }
  // 本地密钥文件被整体忽略，但示例文件必须保留（否则新人不知道要配哪些变量）
  assert.ok(gitignore.includes('.env.*'), '.gitignore 应忽略 .env.* 系列（含 .env.local）')
  assert.ok(gitignore.includes('!.env.example'), '.env.example 必须被显式保留（negate）')
  // 题目原文按保密要求不入库
  assert.ok(gitignore.includes('Atoms-Demo/'), '.gitignore 应排除题目原文与附件')
})

test('密钥扫描：交付出去的源码里没有密钥，本地 .env 文件确实被 git 忽略', () => {
  // 上一条测试把 .env* 排除在扫描外，因此必须**反向确认它们真的被忽略**，
  // 否则"跳过"就变成了漏报。这里直接问 git 要答案。
  const check = (p: string) => {
    try {
      // stdio:'ignore' 是刻意的：本沙箱禁止子进程用管道 stdio（会 spawn EPERM）
      execFileSync('git', ['check-ignore', '-q', p], { cwd: ROOT, stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
  assert.equal(check('.env.local'), true, '.env.local 必须被 git 忽略（本地真实密钥就在这里）')
  assert.equal(check('.env'), true, '.env 必须被 git 忽略')
  assert.equal(check('.env.example'), false, '.env.example 必须能被提交（它是给新人的模板）')
})

test('密钥扫描：离线存储的敏感配置不落盘为明文默认值', () => {
  const envExample = readFileSync(path.join(ROOT, '.env.example'), 'utf8')
  // 示例文件里的密钥项必须为空（只有占位说明），不能给一个像真 key 的默认值
  const keyLines = envExample
    .split(/\r?\n/)
    .filter((l) => /^(DEEPSEEK_API_KEY|TURSO_AUTH_TOKEN)=/.test(l.trim()))
  assert.ok(keyLines.length >= 2, '示例文件应包含这两个密钥项做占位')
  for (const line of keyLines) {
    assert.match(line.trim(), /=$/, `示例文件中的密钥项必须留空：${line}`)
  }
})

// ─────────── 口令安全（TST-M1-1）───────────

test('口令：只存哈希，明文不落库且不可逆', () => {
  const password = 'correct horse battery staple'
  const stored = hashPassword(password)

  assert.equal(stored.includes(password), false, '存储值中不得包含明文口令')
  assert.match(stored, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/, '应为 scrypt$salt$hash 结构')
  assert.equal(verifyPassword(password, stored), true, '正确口令应通过校验')
  assert.equal(verifyPassword('wrong password', stored), false, '错误口令应失败')
})

test('口令：同一口令两次哈希结果不同（加盐），但都能校验通过', () => {
  const password = 'same-password-twice'
  const a = hashPassword(password)
  const b = hashPassword(password)
  assert.notEqual(a, b, '加盐后两次哈希必须不同（防彩虹表）')
  assert.equal(verifyPassword(password, a), true)
  assert.equal(verifyPassword(password, b), true)
})

test('口令：损坏或伪造的存储值不会误判为通过', () => {
  for (const bad of ['', 'plaintext', 'scrypt$', 'scrypt$zz$zz', 'bcrypt$aa$bb', 'scrypt$aabb$']) {
    assert.equal(verifyPassword('whatever', bad), false, `伪造值不应通过：${bad}`)
  }
})

test('口令策略：过短被拒、长度上限被拒、正常长度通过', () => {
  assert.equal(checkPasswordPolicy('12345').ok, false, '5 位应被拒绝')
  assert.equal(checkPasswordPolicy('123456').ok, true, '6 位应通过')
  assert.equal(checkPasswordPolicy('x'.repeat(201)).ok, false, '超长应被拒绝')
  assert.equal(checkPasswordPolicy('x'.repeat(200)).ok, true)
})
