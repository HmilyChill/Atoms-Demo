import type { NextRequest } from 'next/server'
import { requireUser } from '@/lib/auth/guard'
import { getStore, rowToJson } from '@/lib/db/store'
import { AppError } from '@/lib/errors'
import { ok, route } from '@/lib/api/http'

/** 读取项目当前（或指定版本）的 App Spec；同时返回版本列表用于版本面板 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    const user = await requireUser()
    const { id } = await ctx.params
    getStore().requireProjectForOwner(id, user.id)

    const url = new URL(req.url)
    const versionParam = url.searchParams.get('version')
    const store = getStore()

    const versions = store.listSpecVersions(id)
    let target = null
    if (versionParam) {
      const v = Number.parseInt(versionParam, 10)
      if (!Number.isFinite(v)) throw new AppError('BAD_REQUEST', '版本号不合法', '请从版本列表中选择')
      target = store.getSpecVersion(id, v)
      if (!target) throw new AppError('NOT_FOUND', '该版本不存在', '请在版本列表中选择其它版本')
    } else {
      target = versions[0] ?? null
    }

    const verification = store.getLatestArtifact(id, 'verification')

    return ok({
      version: target ? target.version : null,
      spec: target ? rowToJson<Record<string, unknown>>(target.spec) : null,
      changeSummary: target ? target.change_summary : '',
      versions: versions.map((v) => ({
        version: v.version,
        parentVersion: v.parent_version,
        changeSummary: v.change_summary,
        createdAt: v.created_at,
        isCurrent: v.version === (versions[0]?.version ?? -1),
      })),
      verification: verification ? rowToJson<Record<string, unknown>>(verification.payload) : null,
    })
  })
}
