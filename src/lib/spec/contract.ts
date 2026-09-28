/**
 * 需求契约（Contract）：生成前锁定的「必做 / 禁做 / 验收点」。
 *
 * 这是我们对冲 Atoms "需求漂移" 与 "报错却宣称完成" 的核心机制：
 *  - 必做项与禁做项都带**可机检的断言**（ContractCheck），由 M8 Verifier 逐条核对
 *  - 校验结果必须如实上报，禁止谎报通过
 */
import type { AppSpec, FieldType, SpecComponent, SpecComponentType } from './types'

export type ContractCheck =
  | { kind: 'component'; type: SpecComponentType }
  | { kind: 'model'; name: string }
  | { kind: 'minPages'; min: number }
  | { kind: 'action'; action: 'create' | 'update' | 'delete' | 'navigate' | 'status' | 'toggle' }
  | { kind: 'fieldType'; type: FieldType }
  | { kind: 'maxPages'; max: number }
  | { kind: 'maxModels'; max: number }
  | { kind: 'forbidComponent'; type: SpecComponentType }

export interface ContractItem {
  id: string
  /** 给人看的中文描述 */
  text: string
  check: ContractCheck
}

export interface Contract {
  mustDo: ContractItem[]
  mustNot: ContractItem[]
  /** 人类可读的验收点（可测试的结果描述，而不是抽象功能名） */
  acceptance: string[]
}

export interface ContractCheckResult {
  item: ContractItem
  passed: boolean
  /** 未通过时说明原因，供 UI 如实展示 */
  reason?: string
}

export interface ContractEvaluation {
  passed: ContractCheckResult[]
  failed: ContractCheckResult[]
  total: number
}

export function walkComponents(spec: AppSpec): SpecComponent[] {
  const out: SpecComponent[] = []
  const visit = (list: SpecComponent[] | undefined) => {
    if (!Array.isArray(list)) return
    for (const c of list) {
      out.push(c)
      if (c.type === 'tabs' && Array.isArray(c.tabs)) {
        for (const t of c.tabs) visit(t.components)
      }
    }
  }
  for (const p of spec.pages ?? []) visit(p.components)
  return out
}

function collectActions(spec: AppSpec): string[] {
  const kinds: string[] = []
  for (const c of walkComponents(spec)) {
    if (c.action) kinds.push(c.action.kind)
    if (Array.isArray(c.rowActions)) for (const a of c.rowActions) kinds.push(a.kind)
  }
  return kinds
}

function describeCheck(check: ContractCheck): string {
  switch (check.kind) {
    case 'component':
      return `需要存在 ${check.type} 组件`
    case 'model':
      return `需要存在数据集合 ${check.name}`
    case 'minPages':
      return `至少需要 ${check.min} 个页面`
    case 'action':
      return `需要存在 ${check.action} 动作`
    case 'fieldType':
      return `需要存在 ${check.type} 类型的字段`
    case 'maxPages':
      return `页面数量不得超过 ${check.max}`
    case 'maxModels':
      return `数据集合数量不得超过 ${check.max}`
    case 'forbidComponent':
      return `不允许出现 ${check.type} 组件`
  }
}

export function evaluateCheck(spec: AppSpec, check: ContractCheck): { passed: boolean; reason?: string } {
  const comps = walkComponents(spec)
  const models = spec.dataModels ?? []
  const pages = spec.pages ?? []
  const fields = models.flatMap((m) => m.fields ?? [])
  const actions = collectActions(spec)

  switch (check.kind) {
    case 'component': {
      const hit = comps.some((c) => c.type === check.type)
      return hit ? { passed: true } : { passed: false, reason: describeCheck(check) }
    }
    case 'model': {
      const hit = models.some((m) => m.name === check.name)
      return hit ? { passed: true } : { passed: false, reason: describeCheck(check) }
    }
    case 'minPages':
      return pages.length >= check.min ? { passed: true } : { passed: false, reason: describeCheck(check) }
    case 'action':
      return actions.includes(check.action) ? { passed: true } : { passed: false, reason: describeCheck(check) }
    case 'fieldType': {
      const hit = fields.some((f) => f.type === check.type)
      return hit ? { passed: true } : { passed: false, reason: describeCheck(check) }
    }
    case 'maxPages':
      return pages.length <= check.max ? { passed: true } : { passed: false, reason: describeCheck(check) }
    case 'maxModels':
      return models.length <= check.max ? { passed: true } : { passed: false, reason: describeCheck(check) }
    case 'forbidComponent': {
      const hit = comps.some((c) => c.type === check.type)
      return hit ? { passed: false, reason: describeCheck(check) } : { passed: true }
    }
  }
}

/** 逐条核对契约；任何异常一律计为未通过（绝不谎报） */
export function evaluateContract(spec: AppSpec, contract: Contract): ContractEvaluation {
  const all = [...contract.mustDo, ...contract.mustNot]
  const results: ContractCheckResult[] = all.map((item) => {
    try {
      const r = evaluateCheck(spec, item.check)
      return { item, passed: r.passed, reason: r.reason }
    } catch (err) {
      return {
        item,
        passed: false,
        reason: `校验器执行异常：${err instanceof Error ? err.message : String(err)}`,
      }
    }
  })
  return {
    passed: results.filter((r) => r.passed),
    failed: results.filter((r) => !r.passed),
    total: results.length,
  }
}

export function isContract(value: unknown): value is Contract {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Partial<Contract>
  return Array.isArray(v.mustDo) && Array.isArray(v.mustNot) && Array.isArray(v.acceptance)
}
