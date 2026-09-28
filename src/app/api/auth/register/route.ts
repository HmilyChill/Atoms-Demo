import type { NextRequest } from 'next/server'
import { getStore } from '@/lib/db/store'
import { AppError } from '@/lib/errors'
import { checkPasswordPolicy, hashPassword } from '@/lib/auth/password'
import { SESSION_COOKIE, SESSION_COOKIE_OPTIONS, createSessionToken } from '@/lib/auth/session'
import { ok, readJson, route } from '@/lib/api/http'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function POST(req: NextRequest): Promise<Response> {
  return route(async () => {
    const body = await readJson<{ email?: string; password?: string; displayName?: string }>(req)
    const email = (body.email ?? '').trim().toLowerCase()
    const password = body.password ?? ''
    const displayName = (body.displayName ?? '').trim() || email.split('@')[0] || '用户'

    if (!EMAIL_RE.test(email)) {
      throw new AppError('BAD_REQUEST', '邮箱格式不正确', '请填写形如 name@example.com 的邮箱')
    }
    const policy = checkPasswordPolicy(password)
    if (!policy.ok) {
      throw new AppError('BAD_REQUEST', policy.message ?? '密码不符合要求', '请更换一个更长的密码')
    }

    const store = getStore()
    if (store.findUserByEmail(email)) {
      throw new AppError('CONFLICT', '该邮箱已被注册', '可以直接登录，或换一个邮箱')
    }

    const user = store.createUser({ email, passwordHash: hashPassword(password), displayName })
    const res = ok({ id: user.id, email: user.email, displayName: user.display_name })
    res.cookies.set(SESSION_COOKIE, createSessionToken(user.id), SESSION_COOKIE_OPTIONS)
    return res
  })
}
