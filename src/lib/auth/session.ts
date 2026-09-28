import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from '@/lib/env'

export const SESSION_COOKIE = 'atoms_session'
/** 7 天 */
const TTL_MS = 1000 * 60 * 60 * 24 * 7

function sign(payload: string): string {
  return createHmac('sha256', env.authSecret).update(payload).digest('hex')
}

export function createSessionToken(userId: string, now: number = Date.now()): string {
  const exp = now + TTL_MS
  const payload = `${userId}.${exp}`
  return `${payload}.${sign(payload)}`
}

/** 返回 userId；任何异常一律视为未登录（不区分原因，避免泄露信息） */
export function verifySessionToken(token: string | undefined | null, now: number = Date.now()): string | null {
  if (!token) return null
  const idx = token.lastIndexOf('.')
  if (idx <= 0 || idx >= token.length - 1) return null
  const payload = token.slice(0, idx)
  const sig = token.slice(idx + 1)
  const expected = sign(payload)
  if (sig.length !== expected.length) return null
  try {
    if (!timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null
  } catch {
    return null
  }
  const [userId, expStr] = payload.split('.')
  const exp = Number(expStr)
  if (!userId || !Number.isFinite(exp) || exp <= now) return null
  return userId
}

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: Math.floor(TTL_MS / 1000),
  secure: process.env.NODE_ENV === 'production',
}
