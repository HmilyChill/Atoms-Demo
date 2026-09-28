/**
 * 生成管线单元测试：需求分析 → 模板 Spec → 契约核对 → 校验 → 修复 → 增量修改
 * 覆盖 docs/04 §1.2 的三个固定回归样例 S-1 / S-2 / S-3。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  analyzeRequirement,
  applyChangeRequest,
  buildContract,
  buildPlan,
  buildTemplateSpec,
} from '@/lib/llm/templates'
import { validateSpec } from '@/lib/spec/validate'
import { evaluateContract } from '@/lib/spec/contract'
import { attemptRepair, verifySpec } from '@/lib/agents/verifier'
import type { AppSpec } from '@/lib/spec/types'

const FIXED_TIME = '2026-01-01T00:00:00.000Z'

const S1 = '做一个个人待办清单：能新增任务、标记完成、按状态筛选、删除。'
const S2 = '做一个活动报名与审批系统：学生提交报名，管理员审批通过或驳回，能看到自己的报名状态。'
const S3 = '做一个销售记录工具：录入每日销售额与产品，用图表展示汇总趋势。'

test('S-1 待办清单：识别为 tasks 且管线全部通过', () => {
  const analysis = analyzeRequirement(S1)
  assert.equal(analysis.kind, 'tasks')

  const spec = buildTemplateSpec(analysis, FIXED_TIME)
  const validation = validateSpec(spec)
  assert.equal(validation.ok, true, JSON.stringify(validation.issues))

  const contract = buildContract(analysis)
  const evaluation = evaluateContract(spec, contract)
  assert.equal(evaluation.failed.length, 0, JSON.stringify(evaluation.failed))

  const report = verifySpec(spec, contract)
  assert.equal(report.ok, true, report.summary)
  assert.equal(report.unverified.length, 0)
})

test('S-2 报名审批：识别为 approval，契约包含状态流转动作', () => {
  const analysis = analyzeRequirement(S2)
  assert.equal(analysis.kind, 'approval')

  const spec = buildTemplateSpec(analysis, FIXED_TIME)
  const contract = buildContract(analysis)
  const report = verifySpec(spec, contract)
  assert.equal(report.ok, true, report.summary)

  const evaluation = evaluateContract(spec, contract)
  assert.ok(evaluation.passed.some((p) => p.item.text.includes('审批通过')))
})

test('S-3 销售看板：识别为 dashboard，图表字段必须为数值类型', () => {
  const analysis = analyzeRequirement(S3)
  assert.equal(analysis.kind, 'dashboard')

  const spec = buildTemplateSpec(analysis, FIXED_TIME)
  const validation = validateSpec(spec)
  assert.equal(validation.ok, true, JSON.stringify(validation.issues))

  const contract = buildContract(analysis)
  const report = verifySpec(spec, contract)
  assert.equal(report.ok, true, report.summary)
})

test('确定性：同一输入两次生成结果完全一致', () => {
  const a = buildTemplateSpec(analyzeRequirement(S1), FIXED_TIME)
  const b = buildTemplateSpec(analyzeRequirement(S1), FIXED_TIME)
  assert.equal(JSON.stringify(a), JSON.stringify(b))
})

test('计划产出包含可读的步骤与页面大纲', () => {
  const plan = buildPlan(analyzeRequirement(S2))
  assert.ok(plan.steps.length >= 4)
  assert.ok(plan.pageOutline.length >= 1)
  assert.ok(plan.goal.includes('报名') || plan.goal.length > 0)
})

test('校验器拒绝超范围组件（诚实原则：不静默近似）', () => {
  const spec = buildTemplateSpec(analyzeRequirement(S1), FIXED_TIME) as unknown as {
    pages: Array<{ components: Array<Record<string, unknown>> }>
  }
  spec.pages[0].components.push({ id: 'c-bad', type: 'threejs-canvas' })
  const res = validateSpec(spec)
  assert.equal(res.ok, false)
  assert.ok(res.issues.some((i) => i.message.includes('不支持的组件类型')))
})

test('校验器捕获引用不存在的数据集合', () => {
  const spec = buildTemplateSpec(analyzeRequirement(S1), FIXED_TIME)
  spec.pages[0].components.push({ id: 'c-orphan', type: 'table', model: 'not_exist', columns: [{ field: 'a' }] })
  const res = validateSpec(spec)
  assert.equal(res.ok, false)
  assert.ok(res.issues.some((i) => i.message.includes('不存在的数据集合')))
})

test('校验器捕获动作引用不存在的页面（避免"契约判通过但按钮点了没反应"）', () => {
  const spec = buildTemplateSpec(analyzeRequirement(S1), FIXED_TIME)
  spec.pages[0].components.push({
    id: 'c-nav',
    type: 'table',
    model: 'tasks',
    columns: [{ field: 'title' }],
    rowActions: [{ kind: 'navigate', label: '去详情', targetPageId: 'p-not-exist' }],
  } as never)

  const res = validateSpec(spec)
  assert.equal(res.ok, false)
  const issue = res.issues.find((i) => i.path.includes('rowActions[0].targetPageId'))
  assert.ok(issue, `应指出具体路径，实际：${JSON.stringify(res.issues.map((i) => i.path))}`)
  assert.ok(issue?.message.includes('不存在的页面'), issue?.message)
})

test('校验器拒绝运行时未实现的动作类型（超范围必须报错，绝不静默近似）', () => {
  const spec = buildTemplateSpec(analyzeRequirement(S1), FIXED_TIME)
  spec.pages[0].components.push({
    id: 'c-upd',
    type: 'table',
    model: 'tasks',
    columns: [{ field: 'title' }],
    rowActions: [{ kind: 'update', label: '编辑' }],
  } as never)

  const res = validateSpec(spec)
  assert.equal(res.ok, false)
  assert.ok(
    res.issues.some((i) => i.message.includes('不支持的动作类型')),
    JSON.stringify(res.issues),
  )
})

test('校验器要求 status/toggle 动作声明字段（否则运行时无从下手）', () => {
  const spec = buildTemplateSpec(analyzeRequirement(S1), FIXED_TIME)
  spec.pages[0].components.push({
    id: 'c-status',
    type: 'table',
    model: 'tasks',
    columns: [{ field: 'title' }],
    rowActions: [{ kind: 'toggle', label: '切换' }],
  } as never)

  const res = validateSpec(spec)
  assert.equal(res.ok, false)
  assert.ok(res.issues.some((i) => i.path.includes('.field') && i.message.includes('必须声明')))
})

test('校验报告：验收点如实单列（不冒充机检通过，也不冒充"未校验"）', () => {
  const analysis = analyzeRequirement(S1)
  const contract = buildContract(analysis)
  const spec = buildTemplateSpec(analysis, FIXED_TIME)
  const report = verifySpec(spec, contract)

  assert.ok(contract.acceptance.length > 0, '样例契约应带验收点')
  assert.deepEqual(report.contract.acceptance, contract.acceptance, '验收点应原样进入报告')
  // 关键：验收点不能被算进"机检通过"的总数，也不能把整份报告拉成"未校验"
  assert.equal(report.contract.total, contract.mustDo.length + contract.mustNot.length)
  assert.equal(report.unverified.length, 0, '验收点不应被当成校验器异常')
  assert.ok(report.summary.includes('验收点无法机检'), report.summary)
  assert.equal(report.ok, true, report.summary)
})

test('自愈：缺失筛选与删除能力时能自动补齐并通过校验', () => {
  const analysis = analyzeRequirement(S1)
  const contract = buildContract(analysis)
  const spec = buildTemplateSpec(analysis, FIXED_TIME)

  // 人为破坏：移除筛选组件，并去掉删除动作
  const broken: AppSpec = structuredClone(spec)
  broken.pages[0].components = broken.pages[0].components.filter((c) => c.type !== 'filter')
  for (const c of broken.pages[0].components) {
    if (c.type === 'table') c.rowActions = []
  }

  const before = verifySpec(broken, contract)
  assert.equal(before.ok, false)
  assert.ok(before.contract.failed.length >= 2)

  const outcome = attemptRepair(broken, before)
  assert.ok(outcome.fixes.length >= 2, JSON.stringify(outcome))

  const after = verifySpec(outcome.spec, contract)
  assert.equal(after.ok, true, `${after.summary} | unrepairable=${JSON.stringify(outcome.unrepairable)}`)
})

test('自愈：无法自动修复的项如实上报，不谎报通过', () => {
  const analysis = analyzeRequirement(S1)
  const contract = buildContract(analysis)
  const spec = structuredClone(buildTemplateSpec(analysis, FIXED_TIME))
  // 违反「不引入图表看板」这一禁做项
  spec.pages[0].components.push({
    id: 'c-chart-x',
    type: 'chart',
    model: 'tasks',
    chart: 'bar',
    xField: 'title',
    yField: 'title',
  })

  const report = verifySpec(spec, contract)
  assert.equal(report.ok, false)
  const outcome = attemptRepair(spec, report)
  assert.ok(outcome.unrepairable.length > 0, '违反禁做项必须计入 unrepairable')
  const after = verifySpec(outcome.spec, contract)
  assert.equal(after.ok, false, '不得因为修复而谎报通过')
})

test('增量修改：新增优先级字段只影响目标片段', () => {
  const analysis = analyzeRequirement(S1)
  const spec = buildTemplateSpec(analysis, FIXED_TIME)
  const before = structuredClone(spec)

  const result = applyChangeRequest(spec, '请增加一个优先级字段')
  assert.equal(result.applied, true)

  const model = result.spec.dataModels[0]
  assert.ok(model.fields.some((f) => f.name === 'priority'))

  // 表单与表格都补上了该字段
  const page = result.spec.pages[0]
  const form = page.components.find((c) => c.type === 'form')
  const table = page.components.find((c) => c.type === 'table')
  assert.ok(form?.fields?.includes('priority'))
  assert.ok(table?.columns?.some((c) => c.field === 'priority'))

  // 其余部分保持不变
  assert.equal(result.spec.pages.length, before.pages.length)
  assert.equal(result.spec.theme.primary, before.theme.primary)
  assert.equal(result.spec.navigation.length, before.navigation.length)

  const validation = validateSpec(result.spec)
  assert.equal(validation.ok, true, JSON.stringify(validation.issues))
})

test('增量修改：无法落地的诉求必须如实标注且不谎报 applied', () => {
  const spec = buildTemplateSpec(analyzeRequirement(S1), FIXED_TIME)
  const result = applyChangeRequest(spec, '请接入企业微信并支持组织架构同步')
  assert.equal(result.applied, false)
  assert.ok(result.spec.pages[0].components.some((c) => c.type === 'callout' && c.text?.includes('暂未自动落地')))
})

test('增量修改：请求图表时自动补齐数值字段（看板类需求）', () => {
  const analysis = analyzeRequirement(S1)
  const spec = buildTemplateSpec(analysis, FIXED_TIME)
  const result = applyChangeRequest(spec, '请增加一个图表看板')
  assert.equal(result.applied, true)

  const chart = result.spec.pages[0].components.find((c) => c.type === 'chart')
  assert.ok(chart, '应新增图表组件')
  const model = result.spec.dataModels[0]
  const yField = model.fields.find((f) => f.name === chart?.yField)
  assert.equal(yField?.type, 'number')
  assert.equal(validateSpec(result.spec).ok, true)
})

// ─────────── 模板覆盖（含后续新增的模板）───────────

const EXTRA_SAMPLES: Array<{ name: string; req: string; kind: string }> = [
  {
    name: '库存管理',
    req: '做一个库存管理工具：登记物料入库，查看库存台账与分类汇总图表。',
    kind: 'inventory',
  },
  {
    name: '内容管理',
    req: '做一个内容管理系统：新建文章、按状态筛选、发布或退回草稿。',
    kind: 'content',
  },
  {
    name: '预约管理',
    req: '做一个会议室预约系统：提交预约，管理员确认或取消，按资源筛选。',
    kind: 'booking',
  },
]

test('模板覆盖：每个模板都能识别正确、Spec 合法、且通过自身契约', () => {
  for (const sample of EXTRA_SAMPLES) {
    const analysis = analyzeRequirement(sample.req)
    assert.equal(analysis.kind, sample.kind, `${sample.name} 应识别为 ${sample.kind}（实际 ${analysis.kind}）`)

    const spec = buildTemplateSpec(analysis, FIXED_TIME)
    const validation = validateSpec(spec)
    assert.equal(validation.ok, true, `${sample.name} 的 Spec 应合法：${JSON.stringify(validation.issues)}`)

    // 组件 id 必须全局唯一，否则渲染冒烟会判为问题
    const contract = buildContract(analysis)
    const report = verifySpec(spec, contract)
    assert.equal(report.ok, true, `${sample.name} 应通过自身契约：${report.summary}`)
  }
})

test('模板覆盖：所有模板产出的组件 id 都全局唯一', () => {
  const allRequests = [
    '做一个个人待办清单：能新增任务、标记完成、按状态筛选、删除。',
    '做一个活动报名与审批系统：学生提交报名，管理员审批通过或驳回。',
    '做一个销售记录工具：录入每日销售额与产品，用图表展示汇总趋势。',
    ...EXTRA_SAMPLES.map((s) => s.req),
    '做一个数据管理工具。',
  ]
  for (const req of allRequests) {
    const spec = buildTemplateSpec(analyzeRequirement(req), FIXED_TIME)
    const ids = spec.pages.flatMap((p) => p.components.map((c) => c.id))
    assert.equal(new Set(ids).size, ids.length, `「${req}」的组件 id 出现重复：${JSON.stringify(ids)}`)
  }
})

test('模板优先级：报名归入审批流、预约归入预约模板（避免关键词互相抢）', () => {
  assert.equal(analyzeRequirement('做一个活动报名系统，管理员审批通过或驳回').kind, 'approval')
  assert.equal(analyzeRequirement('做一个会议室预约系统，按时段登记占用').kind, 'booking')
  // 库存里的"采购"不应被当成审批（没有审批关键词）
  assert.equal(analyzeRequirement('做一个物料采购与库存台账').kind, 'inventory')
})
