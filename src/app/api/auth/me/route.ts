import { getCurrentUser } from '@/lib/auth/guard'
import { ok, route } from '@/lib/api/http'
import { getProviderInfo } from '@/lib/llm'
import { quotaSnapshot } from '@/lib/quota/guard'

export async function GET(): Promise<Response> {
  return route(async () => {
    const user = await getCurrentUser()
    return ok({
      user: user ? { id: user.id, email: user.email, displayName: user.display_name } : null,
      provider: getProviderInfo(),
      quota: quotaSnapshot(),
    })
  })
}
