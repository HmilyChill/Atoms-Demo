import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from '@/lib/env'

/**
 * 预览令牌（preview token）。
 *
 * 为什么需要它（docs/00 §11.1 A4 + docs/03 §9 S5）：
 *  预览 iframe 使用 `sandbox="allow-scripts"`（**不授予 same-origin**），
 *  此时文档处于不透明源（opaque origin），跨源请求不会携带 SameSite=Lax 的登录 Cookie。
 *  因此预览内的数据读写改用**短期令牌**，既能保持严格沙箱，又能让生成的应用真实读写数据。
 *
 * 令牌同时用于只读分享（mode=ro）。
 */

export type PreviewMode = 'rw' | 'ro'

const TTL_MS = 1000 * 60 * 30 // 30 分钟

function sign(payload: string): string {
  return createHmac('sha256', `${env.authSecret}:preview`).update(payload).digest('hex')
}

export function createPreviewToken(projectId: string, mode: PreviewMode, now: number = Date.now()): string {
  const exp = now + TTL_MS
  const payload = `${projectId}.${exp}.${mode}`
  return `${payload}.${sign(payload)}`
}

export interface PreviewClaims {
  projectId: string
  mode: PreviewMode
  exp: number
}

export function verifyPreviewToken(token: string | undefined | null, now: number = Date.now()): PreviewClaims | null {
  if (!token) return null
  const idx = token.lastIndexOf('.')
  if (idx <= 0) return null
  const payload = token.slice(0, idx)
  const sig = token.slice(idx + 1)
  const expected = sign(payload)
  if (sig.length !== expected.length) return null
  try {
    if (!timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null
  } catch {
    return null
  }
  const [projectId, expStr, mode] = payload.split('.')
  const exp = Number(expStr)
  if (!projectId || !Number.isFinite(exp) || exp <= now) return null
  if (mode !== 'rw' && mode !== 'ro') return null
  return { projectId, mode, exp }
}

export const PREVIEW_TOKEN_HEADER = 'x-atoms-preview-token'
