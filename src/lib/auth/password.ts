import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const KEYLEN = 64
const PREFIX = 'scrypt'

/** 只存哈希，明文永不落库、永不进日志 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, KEYLEN)
  return `${PREFIX}$${salt.toString('hex')}$${hash.toString('hex')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== PREFIX) return false
  const salt = Buffer.from(parts[1], 'hex')
  const expected = Buffer.from(parts[2], 'hex')
  if (salt.length === 0 || expected.length === 0) return false
  const actual = scryptSync(password, salt, expected.length)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export interface PasswordPolicyResult {
  ok: boolean
  message?: string
}

/** 最小可用的口令策略：只做长度与基本强度，避免"注册即放弃" */
export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  if (typeof password !== 'string' || password.length < 6) {
    return { ok: false, message: '密码至少需要 6 位字符' }
  }
  if (password.length > 200) {
    return { ok: false, message: '密码过长，请控制在 200 位以内' }
  }
  return { ok: true }
}
