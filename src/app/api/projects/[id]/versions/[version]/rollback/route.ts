import type { NextRequest } from 'next/server'
import { requireUser } from '@/lib/auth/guard'
import { getStore, rowToJson } from '@/lib/db/store'
import { AppError } from '@/lib/errors'
import { ok, route } from '@/lib/api/http'
import { emit } from '@/lib/events/bus'

/**
 * 版本回滚（M7）。
 * 约定：回滚**不删除**任何版本，而是把目标版本的内容作为**新版本**追加，
 * 从而保证版本链永远可回溯（并保留生成物的数据，不动 app_records）。
 */
export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; version: string }> },
): Promise<Response> {
  return route(async () => {
    const user = await requireUser()
    const { id, version } = await ctx.params
    getStore().requireProjectForOwner(id, user.id)

    const targetVersion = Number.parseInt(version, 10)
    if (!Number.isFinite(targetVersion)) {
      throw new AppError('BAD_REQUEST', '版本号不合法', '请从版本列表中选择要回滚的版本')
    }

    const store = getStore()
    const target = store.getSpecVersion(id, targetVersion)
    if (!target) throw new AppError('NOT_FOUND', '该版本不存在', '请刷新版本列表后重试')

    const current = store.getLatestSpecVersion(id)
    if (current && current.version === targetVersion) {
      throw new AppError('CONFLICT', '当前已经是最新版本，无需回滚', '如需修改请提交新的迭代需求')
    }

    const created = store.addSpecVersion({
      projectId: id,
      spec: rowToJson<Record<string, unknown>>(target.spec),
      parentVersion: current ? current.version : null,
      changeSummary: `回滚到 v${targetVersion}`,
    })

    // 用该项目的最近一次 Run 作为事件宿主（若存在），保证可观测时间线不出现断点
    const runs = store.listRunsByProject(id, 1)
    if (runs[0]) {
      emit(runs[0].id, 'preview.updated', { version: created.version, entryUrl: `/preview/${id}`, reason: 'rollback' })
    }

    return ok({ version: created.version, rolledBackTo: targetVersion })
  })
}
