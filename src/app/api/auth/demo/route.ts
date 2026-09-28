import type { NextRequest } from 'next/server'
import { randomBytes } from 'node:crypto'
import { getStore } from '@/lib/db/store'
import { AppError } from '@/lib/errors'
import { hashPassword } from '@/lib/auth/password'
import { SESSION_COOKIE, SESSION_COOKIE_OPTIONS, createSessionToken } from '@/lib/auth/session'
import { clientKey, ok, route } from '@/lib/api/http'
import { checkRateLimit } from '@/lib/quota/guard'

/**
 * 一键体验：自动创建一个演示账号并登录。
 *
 * 目的（docs/00 §11.5 E1「5 分钟零思考路径」）：
 *  把评审的启动成本压到一次点击 —— 不需要想邮箱、不需要想密码。
 * 防滥用：按 IP 限流；账号为随机邮箱，不收集任何真实信息。
 */
export async function POST(req: NextRequest): Promise<Response> {
  return route(async () => {
    const limit = checkRateLimit(`demo:${clientKey(req)}`, Date.now())
    if (!limit.ok) {
      throw new AppError('RATE_LIMITED', '体验账号创建过于频繁', `请在 ${limit.retryAfterSec ?? 60} 秒后重试，或直接注册账号`)
    }

    const suffix = randomBytes(4).toString('hex')
    const email = `demo-${suffix}@atoms-demo.local`
    const password = randomBytes(12).toString('base64url')

    const store = getStore()
    const user = store.createUser({
      email,
      passwordHash: hashPassword(password),
      displayName: `体验用户 ${suffix}`,
    })

    const res = ok({
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      note: '已为你创建独立的演示账号，数据与其他访问者完全隔离。',
    })
    res.cookies.set(SESSION_COOKIE, createSessionToken(user.id), SESSION_COOKIE_OPTIONS)
    return res
  })
}
