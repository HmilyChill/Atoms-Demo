/**
 * 质量校验与自愈（M8）—— 我们对冲 Atoms「预览报错却宣称完成」的核心模块。
 *
 * 三类校验：
 *  1. 结构校验：Spec 合法性与引用完整性（复用 I-10 校验器）
 *  2. 渲染冒烟：逐页面/逐组件做**结构性渲染检查**（字段绑定、图表轴、筛选字段等）
 *  3. 契约逐条核对：对「必做 / 禁做」逐条给出可判定的通过 / 未通过
 *
 * 诚实原则：校验器自身异常一律计为「未校验」，绝不计为通过；修复只做最小改动，
 * 无法自动修复的项必须如实上报（不做静默近似）。
 */
import type { AppSpec, SpecComponent, SpecDataModel, SpecField } from '@/lib/spec/types'
import { validateSpec, type ValidationIssue } from '@/lib/spec/validate'
import { evaluateContract, walkComponents, type Contract } from '@/lib/spec/contract'

export interface ContractItemResult {
  id: string
  text: string
  reason?: string
}

export interface VerificationReport {
  ok: boolean
  checkedAt: string
  structural: { ok: boolean; issues: ValidationIssue[] }
  render: { ok: boolean; errors: string[]; pagesChecked: number; componentsChecked: number }
  contract: {
    total: number
    passed: ContractItemResult[]
    failed: ContractItemResult[]
    /**
     * 验收点：**人类可读、无法机检**（F-M8-3）。
     * 单独列出来而不是混进 total / unverified：
     *  - 混进 total 会让人以为它被机检过（假通过）；
     *  - 混进 unverified 会让每次生成都变成"未校验"，等于这个字段失去意义。
     */
    acceptance: string[]
  }
  /** 因校验器异常等原因无法判定的项 */
  unverified: string[]
  summary: string
}

function clone<T>(v: T): T {
  return structuredClone(v)
}

/** 渲染冒烟：结构性检查每个组件能否被确定性渲染器渲染 */
export function renderSmoke(spec: AppSpec): { ok: boolean; errors: string[]; pagesChecked: number; componentsChecked: number } {
  const errors: string[] = []
  const models = new Map<string, SpecDataModel>((spec.dataModels ?? []).map((m) => [m.name, m]))
  const seenIds = new Set<string>()
  let componentsChecked = 0

  const checkComponent = (c: SpecComponent, where: string) => {
    componentsChecked += 1
    if (seenIds.has(c.id)) errors.push(`${where}：组件 id 重复（${c.id}）`)
    seenIds.add(c.id)

    const model = c.model ? models.get(c.model) : undefined
    const fieldOf = (name?: string): SpecField | undefined =>
      name && model ? model.fields.find((f) => f.name === name) : undefined

    if (c.type === 'tabs') {
      if (!Array.isArray(c.tabs) || c.tabs.length === 0) {
        errors.push(`${where}：tabs 组件没有标签页`)
      } else {
        c.tabs.forEach((t, ti) => t.components.forEach((cc) => checkComponent(cc, `${where} › 标签页${ti + 1}`)))
      }
      return
    }

    if (['form', 'table', 'list', 'detail', 'stats', 'chart', 'filter'].includes(c.type)) {
      if (!model) {
        errors.push(`${where}：绑定的数据集合「${c.model ?? '(空)'}」不存在`)
        return
      }
    }

    switch (c.type) {
      case 'form': {
        const fields = c.fields ?? []
        if (fields.length === 0) errors.push(`${where}：表单没有任何字段`)
        for (const f of fields) {
          if (!fieldOf(f)) errors.push(`${where}：表单引用了不存在的字段「${f}」`)
        }
        if (!c.action || c.action.kind !== 'create') {
          errors.push(`${where}：表单缺少 create 提交动作`)
        }
        break
      }
      case 'table': {
        const cols = c.columns ?? []
        if (cols.length === 0) errors.push(`${where}：表格没有任何列`)
        for (const col of cols) {
          if (!fieldOf(col.field)) errors.push(`${where}：表格引用了不存在的字段「${col.field}」`)
        }
        for (const a of c.rowActions ?? []) {
          if ((a.kind === 'toggle' || a.kind === 'status') && !fieldOf(a.field)) {
            errors.push(`${where}：行内动作引用了不存在的字段「${a.field ?? '(空)'}」`)
          }
        }
        break
      }
      case 'detail': {
        for (const f of c.fields ?? []) {
          if (!fieldOf(f)) errors.push(`${where}：详情引用了不存在的字段「${f}」`)
        }
        break
      }
      case 'list': {
        if (!c.itemTitle || !fieldOf(c.itemTitle)) {
          errors.push(`${where}：列表缺少有效的标题字段`)
        }
        if (c.itemSubtitle && !fieldOf(c.itemSubtitle)) {
          errors.push(`${where}：列表副标题字段「${c.itemSubtitle}」不存在`)
        }
        break
      }
      case 'stats': {
        if (c.metric === 'sum' || c.metric === 'avg') {
          const f = fieldOf(c.metricField)
          if (!f) errors.push(`${where}：汇总字段「${c.metricField ?? '(空)'}」不存在`)
          else if (f.type !== 'number') errors.push(`${where}：汇总字段「${f.name}」不是数值类型`)
        }
        break
      }
      case 'chart': {
        if (!c.xField || !fieldOf(c.xField)) errors.push(`${where}：图表缺少有效的 X 轴字段`)
        const y = fieldOf(c.yField)
        if (!y) errors.push(`${where}：图表缺少有效的 Y 轴字段`)
        else if (y.type !== 'number') errors.push(`${where}：图表 Y 轴字段「${y.name}」不是数值类型`)
        break
      }
      case 'filter': {
        if (!c.filterField || !fieldOf(c.filterField)) errors.push(`${where}：筛选组件缺少有效的筛选字段`)
        break
      }
      case 'heading':
      case 'text':
      case 'callout': {
        if (!c.text || c.text.trim() === '') errors.push(`${where}：${c.type} 组件没有文本内容`)
        break
      }
      default:
        break
    }
  }

  const pages = spec.pages ?? []
  pages.forEach((p) => p.components.forEach((c) => checkComponent(c, `页面「${p.title}」`)))

  return { ok: errors.length === 0, errors, pagesChecked: pages.length, componentsChecked }
}

export function verifySpec(specInput: unknown, contract: Contract | null): VerificationReport {
  const checkedAt = new Date().toISOString()
  const unverified: string[] = []

  let structural: VerificationReport['structural'] = { ok: false, issues: [] }
  let render: VerificationReport['render'] = { ok: false, errors: [], pagesChecked: 0, componentsChecked: 0 }
  let contractResult: VerificationReport['contract'] = { total: 0, passed: [], failed: [], acceptance: [] }

  try {
    const v = validateSpec(specInput)
    structural = { ok: v.ok, issues: v.issues }
  } catch (err) {
    unverified.push(`结构校验执行异常：${err instanceof Error ? err.message : String(err)}`)
  }

  let spec: AppSpec | null = null
  if (structural.ok) {
    spec = specInput as AppSpec
    try {
      render = renderSmoke(spec)
    } catch (err) {
      unverified.push(`渲染冒烟执行异常：${err instanceof Error ? err.message : String(err)}`)
      render = { ok: false, errors: [], pagesChecked: 0, componentsChecked: 0 }
    }

    if (contract) {
      try {
        const evaluation = evaluateContract(spec, contract)
        contractResult = {
          total: evaluation.total,
          passed: evaluation.passed.map((r) => ({ id: r.item.id, text: r.item.text })),
          failed: evaluation.failed.map((r) => ({ id: r.item.id, text: r.item.text, reason: r.reason })),
          acceptance: (contract.acceptance ?? []).map((a) => String(a)),
        }
      } catch (err) {
        unverified.push(`契约核对执行异常：${err instanceof Error ? err.message : String(err)}`)
      }
    } else {
      unverified.push('未提供需求契约，契约核对未执行')
    }
  } else {
    unverified.push('结构校验未通过，渲染冒烟与契约核对已跳过')
  }

  const ok = structural.ok && render.ok && contractResult.failed.length === 0 && unverified.length === 0

  const parts: string[] = []
  parts.push(structural.ok ? '结构校验通过' : `结构校验未通过（${structural.issues.filter((i) => i.severity === 'error').length} 项错误）`)
  parts.push(render.ok ? '渲染冒烟通过' : `渲染冒烟发现 ${render.errors.length} 个问题`)
  if (contract) {
    parts.push(
      contractResult.failed.length === 0
        ? `契约 ${contractResult.total} 项全部通过`
        : `契约 ${contractResult.failed.length}/${contractResult.total} 项未通过`,
    )
    // 验收点如实单独声明：不混进"通过项"，也不冒充"未校验"（后者会让每次生成都变成部分通过）
    if (contractResult.acceptance.length > 0) {
      parts.push(`${contractResult.acceptance.length} 条验收点无法机检、需人工确认`)
    }
  }
  if (unverified.length > 0) parts.push(`${unverified.length} 项未校验`)

  return {
    ok,
    checkedAt,
    structural,
    render,
    contract: contractResult,
    unverified,
    summary: parts.join('；'),
  }
}

// ─────────────────────────────────────────────────────────────
// 自愈：只做**最小改动**，无法修复的项如实上报
// ─────────────────────────────────────────────────────────────

export interface RepairOutcome {
  spec: AppSpec
  fixes: string[]
  /** 无法自动修复的项（必须如实展示给用户） */
  unrepairable: string[]
}

function firstModel(spec: AppSpec): SpecDataModel | undefined {
  return spec.dataModels?.[0]
}

function ensureModelField(model: SpecDataModel, field: SpecField): boolean {
  if (model.fields.some((f) => f.name === field.name)) return false
  model.fields.push(field)
  return true
}

export function attemptRepair(specInput: AppSpec, report: VerificationReport): RepairOutcome {
  const spec = clone(specInput)
  const fixes: string[] = []
  const unrepairable: string[] = []
  const page = spec.pages[0]
  const model = firstModel(spec)

  if (!page || !model) {
    return { spec, fixes, unrepairable: ['Spec 缺少页面或数据模型，无法自动修复'] }
  }

  const comps = page.components
  const has = (t: SpecComponent['type']) => walkComponents(spec).some((c) => c.type === t)

  const addComponent = (c: SpecComponent, label: string) => {
    comps.push(c)
    fixes.push(label)
  }

  // 1) 必做项：组件缺失
  for (const item of report.contract.failed) {
    const text = item.text
    if (/表单/.test(text) && !has('form')) {
      addComponent(
        {
          id: `c-form-${comps.length}`,
          type: 'form',
          model: model.name,
          title: `新增${model.label}`,
          fields: model.fields.filter((f) => f.type !== 'boolean').map((f) => f.name),
          submitLabel: '保存',
          action: { kind: 'create', label: '保存', model: model.name },
        },
        '补充缺失的录入表单',
      )
      continue
    }
    if (/列表|记录/.test(text) && !has('table')) {
      addComponent(
        {
          id: `c-table-${comps.length}`,
          type: 'table',
          model: model.name,
          title: `${model.label}列表`,
          columns: model.fields.filter((f) => f.inList).map((f) => ({ field: f.name })),
          rowActions: [{ kind: 'delete', label: '删除' }],
        },
        '补充缺失的记录列表',
      )
      continue
    }
    if (/筛选/.test(text) && !has('filter')) {
      const f = model.fields.find((x) => x.type === 'select' || x.type === 'boolean')
      if (f) {
        addComponent(
          { id: `c-filter-${comps.length}`, type: 'filter', model: model.name, filterField: f.name, title: `按${f.label}筛选` },
          `补充筛选组件（按${f.label}）`,
        )
      } else {
        unrepairable.push(`${text}：需要可筛选字段，当前数据模型中没有可选项或开关字段`)
      }
      continue
    }
    if (/统计|总数|数量/.test(text) && !has('stats')) {
      addComponent(
        { id: `c-stats-${comps.length}`, type: 'stats', model: model.name, metric: 'count', title: `${model.label}总数` },
        '补充统计组件',
      )
      continue
    }
    if (/图表/.test(text) && !has('chart')) {
      let num = model.fields.find((f) => f.type === 'number')
      if (!num) {
        num = { name: 'amount', label: '金额', type: 'number', inList: true }
        ensureModelField(model, num)
        fixes.push('为图表补充数值字段「金额」')
      }
      const xField = model.fields.find((f) => f.type === 'string' || f.type === 'select')?.name
      if (!xField) {
        unrepairable.push(`${text}：缺少可用于分类的字段`)
        continue
      }
      addComponent(
        { id: `c-chart-${comps.length}`, type: 'chart', model: model.name, title: '数据汇总', chart: 'bar', xField, yField: num.name, aggregate: 'sum' },
        '补充汇总图表',
      )
      continue
    }
    if (/删除/.test(text)) {
      const table = walkComponents(spec).find((c) => c.type === 'table')
      if (table) {
        const acts = table.rowActions ?? []
        if (!acts.some((a) => a.kind === 'delete')) {
          table.rowActions = [...acts, { kind: 'delete', label: '删除' }]
          fixes.push('为列表补充删除操作')
        }
        continue
      }
      unrepairable.push(`${text}：没有可挂载删除操作的列表`)
      continue
    }
    if (/标记完成|切换|完成状态/.test(text)) {
      let bool = model.fields.find((f) => f.type === 'boolean')
      if (!bool) {
        bool = { name: 'done', label: '已完成', type: 'boolean', defaultValue: false, inList: true }
        ensureModelField(model, bool)
        fixes.push('补充布尔字段「已完成」')
      }
      const table = walkComponents(spec).find((c) => c.type === 'table')
      if (table) {
        const acts = table.rowActions ?? []
        if (!acts.some((a) => a.kind === 'toggle')) {
          table.rowActions = [...acts, { kind: 'toggle', label: '切换完成', field: bool.name }]
          fixes.push('为列表补充完成状态切换')
        }
        continue
      }
      unrepairable.push(`${text}：没有可挂载切换操作的列表`)
      continue
    }
    if (/审批|通过|驳回|状态/.test(text)) {
      const sel = model.fields.find((f) => f.type === 'select')
      const table = walkComponents(spec).find((c) => c.type === 'table')
      if (sel && table) {
        const acts = table.rowActions ?? []
        if (!acts.some((a) => a.kind === 'status')) {
          const options = sel.options ?? []
          table.rowActions = [
            ...acts,
            ...options.slice(0, 2).map((o) => ({ kind: 'status' as const, label: o, field: sel.name, value: o })),
          ]
          fixes.push(`为列表补充状态流转动作（${sel.label}）`)
        }
        continue
      }
      unrepairable.push(`${text}：缺少可流转的状态字段或列表`)
      continue
    }
    if (/数值型/.test(text)) {
      const added = ensureModelField(model, { name: 'amount', label: '金额', type: 'number', inList: true })
      if (added) fixes.push('补充数值字段「金额」')
      else unrepairable.push(`${text}：已存在数值字段但仍未通过，请人工确认`)
      continue
    }
    // 禁做项被违反等：不做静默近似，如实上报
    unrepairable.push(`${text}${item.reason ? `（${item.reason}）` : ''}`)
  }

  // 2) 渲染冒烟问题：能修则修（字段引用缺失等）
  for (const err of report.render.errors) {
    if (/图表缺少有效的 X 轴字段/.test(err)) {
      const xField = model.fields.find((f) => f.type === 'string' || f.type === 'select')?.name
      const chart = walkComponents(spec).find((c) => c.type === 'chart')
      if (chart && xField) {
        chart.xField = xField
        fixes.push('修正图表 X 轴字段')
      } else {
        unrepairable.push(err)
      }
      continue
    }
    unrepairable.push(err)
  }

  // 3) 结构错误：不做自动近似，如实上报
  for (const issue of report.structural.issues) {
    if (issue.severity === 'error') unrepairable.push(`${issue.path}：${issue.message}`)
  }

  return { spec, fixes, unrepairable: Array.from(new Set(unrepairable)) }
}
