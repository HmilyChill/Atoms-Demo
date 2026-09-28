/**
 * App Spec 版本差异测试（M7 的 Diff 视图）。
 *
 * 为什么需要：我在文档里承诺"增量修改只动目标片段"。diff 是把这句话变成
 * **可验证、可展示**的关键——测试同时锁定"该出现的变更必须出现"与
 * "不该出现的变更绝不出现"（后者才是"只动目标片段"的真正含义）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { analyzeRequirement, applyChangeRequest, buildTemplateSpec } from '@/lib/llm/templates'
import { describeChange, diffSpecs } from '@/lib/spec/diff'
import type { AppSpec } from '@/lib/spec/types'

const FIXED_TIME = '2026-01-01T00:00:00.000Z'
const S1 = '做一个个人待办清单：能新增任务、标记完成、按状态筛选、删除。'

function baseSpec(): AppSpec {
  return buildTemplateSpec(analyzeRequirement(S1), FIXED_TIME)
}

test('Diff：同一份 Spec 对比应报告"完全一致"', () => {
  const spec = baseSpec()
  const result = diffSpecs(spec, structuredClone(spec))
  assert.equal(result.changes.length, 0, '不应有任何变更')
  assert.equal(result.summary, '两个版本完全一致')
})

test('Diff：新增字段应报告为 added，并指明字段名', () => {
  const before = baseSpec()
  // 注意：tasks 模板本身已有 priority 字段，这里用一个确实不存在的字段
  const after = applyChangeRequest(before, '请增加一个负责人字段').spec

  const result = diffSpecs(before, after)
  assert.ok(result.changes.length > 0, '应检出变更')

  const addedField = result.changes.find((c) => c.kind === 'added' && c.path.includes('负责人'))
  assert.ok(addedField, `应报告新增了「负责人」字段，实际：${JSON.stringify(result.changes.map((c) => c.path))}`)
})

test('Diff：只改目标片段 —— 主题、导航、页面数量都不应出现在变更里', () => {
  const before = baseSpec()
  const after = applyChangeRequest(before, '请增加一个负责人字段').spec

  const result = diffSpecs(before, after)
  const paths = result.changes.map((c) => c.path)

  // 先确认这次改动确实生效（否则"没有多余变更"就变成了空断言）
  assert.ok(
    paths.some((p) => p.includes('负责人')),
    `本次应确实新增了字段，实际：${JSON.stringify(paths)}`,
  )
  assert.equal(paths.some((p) => p.startsWith('主题')), false, '主题不应被改动')
  assert.equal(paths.includes('导航'), false, '导航不应被改动')
  assert.equal(paths.some((p) => p.startsWith('页面「')), false, '页面结构不应被改动')
  assert.equal(result.changes.some((c) => c.kind === 'removed'), false, '不应有移除项')
})

test('Diff：主题改色应只报告主题一项', () => {
  const before = baseSpec()
  const after = applyChangeRequest(before, '把主题主色改成 #0ea5e9').spec

  const result = diffSpecs(before, after)
  assert.equal(result.changes.length, 1, `应只有 1 项变更，实际：${JSON.stringify(result.changes)}`)
  assert.equal(result.changes[0].path, '主题 › primary')
  assert.equal(result.changes[0].before, '#4f46e5')
  assert.equal(result.changes[0].after, '#0ea5e9')
})

test('Diff：新增页面应报告页面级 added', () => {
  const before = baseSpec()
  const after = structuredClone(before)
  after.pages.push({
    id: 'extra',
    title: '额外页面',
    layout: 'single',
    components: [{ id: 'extra-heading', type: 'heading', text: '额外' }],
  })
  after.navigation.push({ label: '额外页面', pageId: 'extra' })

  const result = diffSpecs(before, after)
  const addedPage = result.changes.find((c) => c.kind === 'added' && c.path.includes('额外页面'))
  assert.ok(addedPage, `应报告新增页面，实际：${JSON.stringify(result.changes.map((c) => c.path))}`)
  assert.ok(result.changes.some((c) => c.path === '导航'), '导航变化也应被报告')
})

test('Diff：删除组件/字段应报告 removed', () => {
  const before = baseSpec()
  const after = structuredClone(before)
  after.pages[0].components = after.pages[0].components.filter((c) => c.type !== 'filter')
  after.dataModels[0].fields = after.dataModels[0].fields.filter((f) => f.name !== 'note')

  const result = diffSpecs(before, after)
  const removed = result.changes.filter((c) => c.kind === 'removed')
  assert.ok(
    removed.some((c) => c.path.includes('filter')),
    `应报告移除 filter 组件，实际：${JSON.stringify(result.changes.map((c) => `${c.kind}:${c.path}`))}`,
  )
  assert.ok(
    removed.some((c) => c.path.includes('备注')),
    '应报告移除「备注」字段',
  )
})

test('Diff：describeChange 输出可读中文', () => {
  const before = baseSpec()
  const after = applyChangeRequest(before, '把主题主色改成 #123456').spec
  const { changes } = diffSpecs(before, after)
  const text = describeChange(changes[0])
  assert.ok(text.startsWith('修改：'), text)
  assert.ok(text.includes('主题 › primary'), text)
  assert.ok(text.includes('#4f46e5') && text.includes('#123456'), text)
})
