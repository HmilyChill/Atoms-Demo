import type { NextRequest } from 'next/server'
import { requireUser } from '@/lib/auth/guard'
import { getStore } from '@/lib/db/store'
import { AppError } from '@/lib/errors'
import { ok, readJson, route } from '@/lib/api/http'
import { emit } from '@/lib/events/bus'
import { logger } from '@/lib/obs/logger'
import { isContract, type Contract, type ContractItem } from '@/lib/spec/contract'

/**
 * 契约编辑与重锁定（M3 F-M3-3 / T-M3-4）。
 *
 * 为什么需要：契约是"防止需求漂移"的核心机制，但**只读的契约等于不可干预**。
 * 这里允许用户在确认前修改契约：改文字、关掉不想要的约束、编辑验收点。
 *
 * 诚实边界（很重要）：
 *  - 必做/禁做项都带**可机检断言**（check）。用户改的只是 `text`，断言保持原样，
 *    因此"改文字"不会让校验失真。
 *  - 用户**关掉**一项约束 → 该校验不再执行，这是明确生效的。
 *  - 用户**新增**的自然语言要求会进入 `acceptance`（人类可读验收点），
 *    但**不会**被伪装成机检项——避免"看起来校验过了"的假象。
 */

interface EditableItem {
  id?: string
  text?: string
  /** 省略视为保留；false 表示用户主动去掉这条约束 */
  enabled?: boolean
}

interface PatchBody {
  mustDo?: EditableItem[]
  mustNot?: EditableItem[]
  acceptance?: string[]
}

function mergeItems(original: ContractItem[], edited: EditableItem[] | undefined, kind: string): ContractItem[] {
  if (!Array.isArray(edited)) return original

  const byId = new Map(original.map((item) => [item.id, item]))
  const out: ContractItem[] = []

  for (const entry of edited) {
    const text = (entry.text ?? '').trim()
    if (entry.enabled === false) continue // 用户主动去掉该约束
    if (text.length === 0) continue // 空文本视为删除

    const base = entry.id ? byId.get(entry.id) : undefined
    if (base) {
      out.push({ ...base, text: text.slice(0, 200) })
      continue
    }

    // 新增项：没有可机检断言，明确拒绝伪装成机检项
    throw new AppError(
      'BAD_REQUEST',
      `${kind}暂不支持新增约束项`,
      '新增要求请写进「验收点」——它会被如实呈现，但不会被伪装成已通过机检',
    )
  }

  if (out.length === 0) {
    throw new AppError(
      'BAD_REQUEST',
      `${kind}不能全部删除`,
      `至少要保留一条${kind}，否则校验将失去依据`,
    )
  }
  return out
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return route(async () => {
    const user = await requireUser()
    const { id } = await ctx.params
    const store = getStore()
    const run = await store.getRun(id)
    if (!run) throw new AppError('NOT_FOUND', '生成任务不存在', '请返回项目页重新发起生成')
    await store.requireProjectForOwner(run.project_id, user.id)

    if (run.stage !== 'awaiting_confirm') {
      throw new AppError(
        'CONFLICT',
        '当前不在等待确认阶段，无法修改契约',
        '契约只能在生成开始前（等待确认时）调整',
      )
    }

    // 取最近一次契约作为基准（断言以它为准）
    const artifacts = await store.listArtifactsByRun(id)
    const latestContract = [...artifacts].reverse().find((a) => a.type === 'contract')
    if (!latestContract) {
      throw new AppError('NOT_FOUND', '没有找到待修改的需求契约', '请重新发起生成')
    }

    let current: unknown
    try {
      current = JSON.parse(latestContract.payload)
    } catch {
      throw new AppError('VALIDATION_FAILED', '契约数据已损坏，无法修改', '请重新发起生成')
    }
    if (!isContract(current)) {
      throw new AppError('VALIDATION_FAILED', '契约结构不合法，无法修改', '请重新发起生成')
    }

    const body = await readJson<PatchBody>(req)
    const mustDo = mergeItems(current.mustDo, body.mustDo, '必做项')
    const mustNot = mergeItems(current.mustNot, body.mustNot, '禁做项')
    const acceptance = Array.isArray(body.acceptance)
      ? body.acceptance.map((a) => String(a).trim()).filter((a) => a.length > 0).slice(0, 30)
      : current.acceptance

    const updated: Contract = { mustDo, mustNot, acceptance }
    if (acceptance.length === 0) {
      throw new AppError('BAD_REQUEST', '验收点不能为空', '请至少保留一条可测试的验收点')
    }

    // 作为**新的契约产物**写入：后续校验会读取"最近一条"，从而实现"重新锁定"
    await store.addArtifact({
      runId: id,
      projectId: run.project_id,
      type: 'contract',
      summary: `契约已由用户修订（必做 ${mustDo.length} · 禁做 ${mustNot.length} · 验收点 ${acceptance.length}）`,
      payload: updated,
    })
    await emit(id, 'contract.ready', {
      mustDo: mustDo.map((i) => i.text),
      mustNot: mustNot.map((i) => i.text),
      acceptance,
      revised: true,
    })
    logger.info({
      event: 'contract.revised',
      runId: id,
      projectId: run.project_id,
      stage: run.stage,
      mustDo: mustDo.length,
      mustNot: mustNot.length,
      acceptance: acceptance.length,
    })

    return ok({ contract: updated, revised: true })
  })
}
