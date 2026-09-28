import type { NextRequest } from 'next/server'
import { getStore } from '@/lib/db/store'
import { AppError } from '@/lib/errors'
import { verifyPassword } from '@/lib/auth/password'
import { SESSION_COOKIE, SESSION_COOKIE_OPTIONS, createSessionToken } from '@/lib/auth/session'
import { clientKey, ok, readJson, route } from '@/lib/api/http'
import { checkRateLimit } from '@/lib/quota/guard'

export async function POST(req: NextRequest): Promise<Response> {
  return route(async () => {
    const limit = checkRateLimit(`login:${clientKey(req)}`)
    if (!limit.ok) {
      throw new AppError('RATE_LIMITED', '尝试过于频繁，请稍后再试', `请在 ${limit.retryAfterSec ?? 60} 秒后重试`)
    }

    const body = await readJson<{ email?: string; password?: string }>(req)
    const email = (body.email ?? '').trim().toLowerCase()
    const password = body.password ?? ''
    if (!email || !password) {
      throw new AppError('BAD_REQUEST', '请填写邮箱与密码', '两者均为必填')
    }

    const user = await getStore().findUserByEmail(email)
    // 统一错误信息：不区分「用户不存在」与「密码错误」，避免账号枚举
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw new AppError('UNAUTHORIZED', '邮箱或密码不正确', '请检查后重试，或先注册新账号')
    }

    const res = ok({ id: user.id, email: user.email, displayName: user.display_name })
    res.cookies.set(SESSION_COOKIE, createSessionToken(user.id), SESSION_COOKIE_OPTIONS)
    return res
  })
}
