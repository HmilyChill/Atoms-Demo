import type { NextRequest } from 'next/server'
import { requireUser } from '@/lib/auth/guard'
import { getStore, rowToJson } from '@/lib/db/store'
import { AppError } from '@/lib/errors'
import { ok, route } from '@/lib/api/http'
import { describeChange, diffSpecs } from '@/lib/spec/diff'
import type { AppSpec } from '@/lib/spec/types'

/**
 * 版本差异（M7）。
 * 用法：GET /api/projects/:id/diff?from=1[&to=2]
 *  - 只给 from：与**当前最新版本**对比
 *  - 同时给 to：两两对比
 *
 * 目的：让"增量修改只动目标片段"这件事可被直接看到。
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    const user = await requireUser()
    const { id } = await ctx.params
    const store = getStore()
    await store.requireProjectForOwner(id, user.id)

    const url = new URL(req.url)
    const fromParam = url.searchParams.get('from')
    if (!fromParam) throw new AppError('BAD_REQUEST', '缺少 from 参数', '请指定要对比的基准版本号')

    const fromVersion = Number.parseInt(fromParam, 10)
    if (!Number.isFinite(fromVersion)) {
      throw new AppError('BAD_REQUEST', 'from 版本号不合法', '请传入整数版本号')
    }

    const fromRow = await store.getSpecVersion(id, fromVersion)
    if (!fromRow) throw new AppError('NOT_FOUND', `版本 v${fromVersion} 不存在`, '请刷新版本列表后重试')

    const toParam = url.searchParams.get('to')
    const toRow = toParam
      ? await store.getSpecVersion(id, Number.parseInt(toParam, 10))
      : await store.getLatestSpecVersion(id)
    if (!toRow) {
      throw new AppError('NOT_FOUND', '目标版本不存在', '请检查版本号，或确认项目已生成过应用')
    }

    const before = rowToJson<AppSpec>(fromRow.spec)
    const after = rowToJson<AppSpec>(toRow.spec)
    const diff = diffSpecs(before, after)

    return ok({
      from: fromRow.version,
      to: toRow.version,
      summary: diff.summary,
      changes: diff.changes.map((c) => ({ ...c, description: describeChange(c) })),
    })
  })
}
