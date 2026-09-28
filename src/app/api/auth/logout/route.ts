import { SESSION_COOKIE } from '@/lib/auth/session'
import { ok, route } from '@/lib/api/http'

export async function POST(): Promise<Response> {
  return route(async () => {
    const res = ok({ loggedOut: true })
    res.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 })
    return res
  })
}
