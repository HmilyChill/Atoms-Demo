/**
 * 生成物渲染运行时的浏览器级测试（用 jsdom 提供真实 DOM）。
 *
 * 这是"生成的应用真的可交互"这一硬指标的**可执行证据**：
 * 直接加载 public/app-runtime.js（与沙箱预览、导出包使用的是同一份代码），
 * 用一份真实 Spec 渲染，然后**模拟真实用户操作**并断言数据读写被正确触发。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'

import { analyzeRequirement, buildTemplateSpec } from '@/lib/llm/templates'
import type { AppSpec } from '@/lib/spec/types'

const S1 = '做一个个人待办清单：能新增任务、标记完成、按状态筛选、删除。'
const FIXED_TIME = '2026-01-01T00:00:00.000Z'

const RUNTIME_SOURCE = readFileSync(path.join(process.cwd(), 'public', 'app-runtime.js'), 'utf8')

interface Row {
  id: string
  [k: string]: unknown
}

/** 内存数据适配器：与 HTTP / localStorage 适配器遵循同一契约 */
function createMemoryAdapter(seed: Record<string, Row[]> = {}) {
  const data: Record<string, Row[]> = JSON.parse(JSON.stringify(seed))
  let seq = 0
  const calls: Array<{ op: string; collection: string; payload?: unknown }> = []
  return {
    calls,
    data,
    adapter: {
      kind: 'memory',
      list: (c: string) => {
        calls.push({ op: 'list', collection: c })
        return Promise.resolve((data[c] ?? []).map((r) => ({ ...r })))
      },
      create: (c: string, record: Record<string, unknown>) => {
        calls.push({ op: 'create', collection: c, payload: record })
        seq += 1
        const row: Row = { id: `rec_${seq}`, ...record }
        data[c] = [...(data[c] ?? []), row]
        return Promise.resolve({ id: row.id })
      },
      update: (c: string, id: string, patch: Record<string, unknown>) => {
        calls.push({ op: 'update', collection: c, payload: { id, patch } })
        data[c] = (data[c] ?? []).map((r) => (r.id === id ? { ...r, ...patch } : r))
        return Promise.resolve({ id })
      },
      remove: (c: string, id: string) => {
        calls.push({ op: 'remove', collection: c, payload: { id } })
        data[c] = (data[c] ?? []).filter((r) => r.id !== id)
        return Promise.resolve({ removed: true })
      },
    },
  }
}

function boot(spec: AppSpec, adapter: unknown, options: Record<string, unknown> = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
  })
  const { window } = dom
  const errors: Array<{ scope: string; message: string }> = []
  /** 宿主收到的消息（运行时只在 parent !== self 时才发送，因此需要给窗口装一个 parent 替身） */
  const messages: Array<{ source: string; type: string; payload: Record<string, unknown> }> = []
  Object.defineProperty(window, 'parent', {
    value: { postMessage: (m: unknown) => messages.push(m as never) },
    configurable: true,
    writable: true,
  })

  window.eval(RUNTIME_SOURCE)

  const runtime = (window as unknown as { AtomsRuntime: { renderApp: (r: HTMLElement, s: AppSpec, o: Record<string, unknown>) => { destroy: () => void } } })
    .AtomsRuntime
  assert.ok(runtime, '运行时应当被正确加载并挂载到 window.AtomsRuntime')

  const root = window.document.getElementById('root') as HTMLElement
  const app = runtime.renderApp(root, spec, {
    dataAdapter: adapter,
    readOnly: Boolean(options.readOnly),
    selectable: options.selectable,
    onError: (e: { scope: string; message: string }) => errors.push(e),
  })

  return { dom, window, document: window.document, root, app, errors, messages }
}

/** 等待运行时内部的 Promise 链（loadAll → paint）完成 */
async function flush(times = 6) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

test('渲染运行时：加载后渲染出应用外壳、导航与页面组件', async () => {
  const spec = buildTemplateSpec(analyzeRequirement(S1), FIXED_TIME)
  const mem = createMemoryAdapter({ tasks: [] })
  const { document, errors } = boot(spec, mem.adapter)
  await flush()

  assert.equal(errors.length, 0, `不应有运行时错误：${JSON.stringify(errors)}`)
  assert.equal(document.querySelector('h1')?.textContent, spec.meta.name, '应渲染应用名称')
  assert.equal(document.querySelectorAll('.atoms-nav button').length, spec.navigation.length, '导航项数量应与 Spec 一致')
  assert.ok(document.querySelector('.atoms-table'), '应渲染数据表格')
  assert.ok(document.querySelector('form'), '应渲染录入表单')
  assert.ok(document.querySelector('select'), '应渲染筛选下拉')
})

test('渲染运行时：统计组件按真实数据计算（不是静态占位）', async () => {
  const spec = buildTemplateSpec(analyzeRequirement(S1), FIXED_TIME)
  const mem = createMemoryAdapter({
    tasks: [
      { id: 'a', title: 'A', done: false },
      { id: 'b', title: 'B', done: true },
      { id: 'c', title: 'C', done: false },
    ],
  })
  const { document } = boot(spec, mem.adapter)
  await flush()

  const statValue = document.querySelector('.atoms-stat .v')?.textContent
  assert.equal(statValue, '3', '任务总数应按实际数据渲染为 3')
  assert.equal(document.querySelectorAll('.atoms-table tbody tr').length, 3, '表格应有 3 行')
})

test('渲染运行时：通过表单真实提交数据（交互闭环）', async () => {
  const spec = buildTemplateSpec(analyzeRequirement(S1), FIXED_TIME)
  const mem = createMemoryAdapter({ tasks: [] })
  const { document } = boot(spec, mem.adapter)
  await flush()

  const form = document.querySelector('form') as HTMLFormElement
  const inputs = form.querySelectorAll('input, textarea, select')
  // 依次填写：title / priority / due / note
  const titleInput = inputs[0] as HTMLInputElement
  titleInput.value = '写周报'
  const submit = form.querySelector('button[type="submit"]') as HTMLButtonElement
  submit.click()
  await flush()

  const created = mem.calls.find((c) => c.op === 'create')
  assert.ok(created, '提交表单应触发数据写入')
  assert.equal(created?.collection, 'tasks')
  assert.equal((created?.payload as Record<string, unknown>).title, '写周报')
  assert.equal(mem.data.tasks.length, 1, '数据应真实写入适配器')

  // 提交后列表应刷新出新记录（说明是"真实交互"，不是假按钮）
  assert.equal(document.querySelectorAll('.atoms-table tbody tr').length, 1, '列表应立即出现新记录')
  assert.ok(document.body.textContent?.includes('已保存'), '应给出成功反馈')
})

test('渲染运行时：必填校验会阻止提交并就地提示', async () => {
  const spec = buildTemplateSpec(analyzeRequirement(S1), FIXED_TIME)
  const mem = createMemoryAdapter({ tasks: [] })
  const { document } = boot(spec, mem.adapter)
  await flush()

  const form = document.querySelector('form') as HTMLFormElement
  const emptySubmit = form.querySelector('button[type="submit"]') as HTMLButtonElement
  emptySubmit.click()
  await flush()

  assert.equal(mem.calls.filter((c) => c.op === 'create').length, 0, '必填未填时不应写入数据')
  assert.ok(document.querySelector('.atoms-field .err')?.textContent?.includes('必填'), '应就地提示必填')
})

test('渲染运行时：行内切换完成状态会真实更新数据', async () => {
  const spec = buildTemplateSpec(analyzeRequirement(S1), FIXED_TIME)
  const mem = createMemoryAdapter({ tasks: [{ id: 'x1', title: '写周报', done: false }] })
  const { document } = boot(spec, mem.adapter)
  await flush()

  const buttons = Array.from(document.querySelectorAll('.atoms-table tbody button')) as HTMLButtonElement[]
  const toggle = buttons.find((b) => b.textContent?.includes('切换完成'))
  assert.ok(toggle, '应渲染出切换完成按钮')
  toggle.click()
  await flush()

  const update = mem.calls.find((c) => c.op === 'update')
  assert.ok(update, '点击应触发数据更新')
  assert.equal((update?.payload as { patch: Record<string, unknown> }).patch.done, true, '应把 done 置为 true')
  assert.equal(mem.data.tasks[0].done, true, '适配器中的数据应真实变更')
})

test('渲染运行时：删除操作会真实移除数据', async () => {
  const spec = buildTemplateSpec(analyzeRequirement(S1), FIXED_TIME)
  const mem = createMemoryAdapter({ tasks: [{ id: 'x1', title: '待删除', done: false }] })
  const { document } = boot(spec, mem.adapter)
  await flush()

  const buttons = Array.from(document.querySelectorAll('.atoms-table tbody button')) as HTMLButtonElement[]
  const del = buttons.find((b) => b.textContent?.includes('删除'))
  assert.ok(del, '应渲染出删除按钮')
  del.click()
  await flush()

  assert.ok(mem.calls.some((c) => c.op === 'remove'), '应触发删除')
  assert.equal(mem.data.tasks.length, 0, '数据应被真实删除')
  assert.equal(document.querySelectorAll('.atoms-table tbody tr').length, 1, '删除后应展示空态行')
})

test('渲染运行时：筛选交互只显示匹配的数据', async () => {
  const spec = buildTemplateSpec(analyzeRequirement(S1), FIXED_TIME)
  const mem = createMemoryAdapter({
    tasks: [
      { id: 'a', title: '未完成的任务', done: false },
      { id: 'b', title: '已完成的任务', done: true },
    ],
  })
  const { document, window } = boot(spec, mem.adapter)
  await flush()

  assert.equal(document.querySelectorAll('.atoms-table tbody tr').length, 2, '初始应显示 2 行')

  const filterSelect = document.querySelector('.atoms-card select') as HTMLSelectElement
  assert.ok(filterSelect, '应渲染筛选下拉')
  filterSelect.value = 'true'
  filterSelect.dispatchEvent(new window.Event('change', { bubbles: true }))
  await flush()

  const rows = document.querySelectorAll('.atoms-table tbody tr')
  assert.equal(rows.length, 1, '筛选后应只显示 1 行')
  assert.ok(rows[0].textContent?.includes('已完成的任务'), '应显示匹配的那一条')
})

test('渲染运行时：看板类 Spec 会渲染出真实图表（SVG）', async () => {
  const spec = buildTemplateSpec(analyzeRequirement('做一个销售记录工具：录入每日销售额与产品，用图表展示汇总趋势。'), FIXED_TIME)
  const mem = createMemoryAdapter({
    sales: [
      { id: 's1', product: 'A 产品', amount: 100, channel: '线上' },
      { id: 's2', product: 'B 产品', amount: 250, channel: '线下' },
      { id: 's3', product: 'A 产品', amount: 50, channel: '线上' },
    ],
  })
  const { document } = boot(spec, mem.adapter)
  await flush()

  // 图表位于第二个页面（数据看板），先导航过去
  const navButtons = Array.from(document.querySelectorAll('.atoms-nav button')) as HTMLButtonElement[]
  const overviewButton = navButtons.find((b) => b.textContent?.includes('数据看板'))
  assert.ok(overviewButton, '应存在「数据看板」导航项')
  overviewButton.click()
  await flush()

  const svg = document.querySelector('svg.atoms-chart')
  assert.ok(svg, '应渲染图表 SVG')
  const rects = svg?.querySelectorAll('rect') ?? []
  assert.equal(rects.length, 2, '应按产品聚合为 2 个柱子（A 产品被合并）')

  // 汇总总额应为 400
  const statValues = Array.from(document.querySelectorAll('.atoms-stat .v')).map((n: Element) => n.textContent)
  assert.ok(statValues.includes('400'), `销售总额应为 400，实际：${JSON.stringify(statValues)}`)
})

test('渲染运行时：遇到白名单外组件必须显式报错，而不是静默白屏', async () => {
  const spec = structuredClone(buildTemplateSpec(analyzeRequirement(S1), FIXED_TIME)) as AppSpec & {
    pages: Array<{ components: Array<Record<string, unknown>> }>
  }
  spec.pages[0].components.push({ id: 'bad-1', type: 'webgl-scene', title: '3D 场景' })

  const mem = createMemoryAdapter({ tasks: [] })
  const { document, errors } = boot(spec, mem.adapter)
  await flush()

  assert.ok(document.querySelector('.atoms-errbox'), '应渲染错误框')
  assert.ok(document.body.textContent?.includes('不支持的组件'), '错误文案应说明组件不被支持')
  assert.ok(errors.some((e) => e.message.includes('不支持的组件')), '错误应回传给宿主（onError）')
})

test('渲染运行时：只读模式下隐藏表单与操作按钮', async () => {
  const spec = buildTemplateSpec(analyzeRequirement(S1), FIXED_TIME)
  const mem = createMemoryAdapter({ tasks: [{ id: 'x1', title: '只读数据', done: false }] })
  const { document } = boot(spec, mem.adapter, { readOnly: true })
  await flush()

  assert.equal(document.querySelectorAll('form').length, 0, '只读模式不应渲染表单')
  assert.equal(document.querySelectorAll('.atoms-table tbody button').length, 0, '只读模式不应渲染行内操作按钮')
  assert.ok(document.body.textContent?.includes('只读分享'), '应显示只读标识')
  assert.equal(document.querySelectorAll('.atoms-table tbody tr').length, 1, '只读模式仍应显示数据')
})

test('渲染运行时：标签页组件可切换', async () => {  const base = buildTemplateSpec(analyzeRequirement(S1), FIXED_TIME)
  const spec: AppSpec = {
    ...base,
    pages: [
      {
        id: 'p1',
        title: '标签页页面',
        layout: 'single',
        components: [
          {
            id: 'tabs-1',
            type: 'tabs',
            tabs: [
              { label: '第一页签', components: [{ id: 't1-callout', type: 'callout', text: '这是第一个页签的内容' }] },
              { label: '第二页签', components: [{ id: 't2-callout', type: 'callout', text: '这是第二个页签的内容' }] },
            ],
          },
        ],
      },
    ],
    navigation: [{ label: '标签页页面', pageId: 'p1' }],
  }
  const mem = createMemoryAdapter({})
  const { document } = boot(spec, mem.adapter)
  await flush()

  assert.ok(document.body.textContent?.includes('这是第一个页签的内容'), '默认应显示第一个页签')

  const tabButtons = Array.from(document.querySelectorAll('.atoms-tabs button')) as HTMLButtonElement[]
  assert.equal(tabButtons.length, 2, '应渲染两个页签按钮')
  tabButtons[1].click()
  await flush()

  assert.ok(document.body.textContent?.includes('这是第二个页签的内容'), '切换后应显示第二个页签内容')
})

// ─────────── 选中元素定向修改 ───────────

function findButton(document: Document, text: string): HTMLButtonElement | undefined {
  return (Array.from(document.querySelectorAll('button')) as HTMLButtonElement[]).find((b) =>
    b.textContent?.includes(text),
  )
}

test('选中元素：每个组件都带可定位标记', async () => {
  const spec = buildTemplateSpec(analyzeRequirement(S1), FIXED_TIME)
  const mem = createMemoryAdapter({ tasks: [] })
  const { document } = boot(spec, mem.adapter)
  await flush()

  const tagged = document.querySelectorAll('[data-atoms-component]')
  assert.equal(
    tagged.length,
    spec.pages[0].components.length,
    '每个顶层组件都应有 data-atoms-component 标记',
  )
  assert.ok(document.querySelector('[data-atoms-type="table"]'), '应能按类型定位到表格组件')
})

test('选中元素：开启选择模式后点击组件会把该元素回传宿主', async () => {
  const spec = buildTemplateSpec(analyzeRequirement(S1), FIXED_TIME)
  const mem = createMemoryAdapter({ tasks: [] })
  const { document, messages } = boot(spec, mem.adapter)
  await flush()

  const selectButton = findButton(document, '选择元素')
  assert.ok(selectButton, '应提供「选择元素」按钮')
  selectButton.click()
  await flush(2)

  const table = document.querySelector('[data-atoms-type="table"]') as HTMLElement
  assert.ok(table, '应存在表格组件')
  table.click()
  await flush(2)

  const selected = messages.find((m) => m.type === 'element-selected')
  assert.ok(selected, `应回传 element-selected，实际消息：${JSON.stringify(messages.map((m) => m.type))}`)
  assert.equal(selected.source, 'atoms-preview')
  assert.equal(selected.payload.componentType, 'table', '应带上组件类型')
  assert.equal(typeof selected.payload.componentId, 'string', '应带上组件 id')
  assert.equal(selected.payload.summary, '表格', '应给出可读的组件名称')
})

test('选中元素：未开启选择模式时点击不会回传（不干扰正常操作）', async () => {
  const spec = buildTemplateSpec(analyzeRequirement(S1), FIXED_TIME)
  const mem = createMemoryAdapter({ tasks: [{ id: 'x1', title: '正常操作', done: false }] })
  const { document, messages } = boot(spec, mem.adapter)
  await flush()

  const table = document.querySelector('[data-atoms-type="table"]') as HTMLElement
  table.click()
  await flush(2)

  assert.equal(
    messages.some((m) => m.type === 'element-selected'),
    false,
    '非选择模式下不应回传元素选中',
  )
})

test('选中元素：只读分享模式不提供「选择元素」（来访者无法回到工作台修改）', async () => {
  const spec = buildTemplateSpec(analyzeRequirement(S1), FIXED_TIME)
  const mem = createMemoryAdapter({ tasks: [] })
  const { document } = boot(spec, mem.adapter, { readOnly: true })
  await flush()

  assert.equal(findButton(document, '选择元素'), undefined, '只读模式不应出现选择元素按钮')
})

test('选中元素：显式关闭 selectable 时也不出现该按钮', async () => {
  const spec = buildTemplateSpec(analyzeRequirement(S1), FIXED_TIME)
  const mem = createMemoryAdapter({ tasks: [] })
  const { document } = boot(spec, mem.adapter, { selectable: false })
  await flush()
  assert.equal(findButton(document, '选择元素'), undefined)
})

// ─────────── 审批状态流转（IT-2：中等复杂度需求）───────────

const S2 = '做一个活动报名与审批系统：学生提交报名，管理员审批通过或驳回，能看到自己的报名状态。'

test('审批流：审批管理页的「通过」会真实把状态改为已通过（IT-2）', async () => {
  const spec = buildTemplateSpec(analyzeRequirement(S2), FIXED_TIME)
  const mem = createMemoryAdapter({
    applications: [{ id: 'a1', student: '张三', course: '魔药学', status: '待审批' }],
  })
  const { document } = boot(spec, mem.adapter)
  await flush()

  // 切到「审批管理」页
  const navButton = findButton(document, '审批管理')
  assert.ok(navButton, '应存在审批管理导航')
  navButton.click()
  await flush()

  const approve = findButton(document, '通过')
  assert.ok(approve, '应渲染出「通过」按钮')
  approve.click()
  await flush()

  const update = mem.calls.find((c) => c.op === 'update')
  assert.ok(update, '点击通过应触发数据更新')
  assert.equal((update?.payload as { patch: Record<string, unknown> }).patch.status, '已通过', '状态应改为已通过')
  assert.equal(mem.data.applications[0].status, '已通过', '适配器中的数据应真实变更')
})

test('审批流：「驳回」写入已驳回，且已通过的按钮被禁用（幂等提示）', async () => {
  const spec = buildTemplateSpec(analyzeRequirement(S2), FIXED_TIME)
  const mem = createMemoryAdapter({
    applications: [{ id: 'a1', student: '李四', course: '占卜学', status: '待审批' }],
  })
  const { document } = boot(spec, mem.adapter)
  await flush()

  findButton(document, '审批管理')?.click()
  await flush()

  const reject = findButton(document, '驳回')
  assert.ok(reject, '应渲染出「驳回」按钮')
  reject.click()
  await flush()

  assert.equal(mem.data.applications[0].status, '已驳回', '状态应改为已驳回')

  // 状态已是已驳回后，「驳回」按钮应处于禁用态（避免重复提交）
  const rejectAfter = findButton(document, '驳回') as HTMLButtonElement | undefined
  assert.equal(rejectAfter?.disabled, true, '已处于该状态的按钮应被禁用')
})

test('审批流：按审批状态筛选只显示对应记录', async () => {
  const spec = buildTemplateSpec(analyzeRequirement(S2), FIXED_TIME)
  const mem = createMemoryAdapter({
    applications: [
      { id: 'a1', student: '张三', course: '魔药学', status: '待审批' },
      { id: 'a2', student: '李四', course: '占卜学', status: '已通过' },
    ],
  })
  const { document, window } = boot(spec, mem.adapter)
  await flush()

  findButton(document, '审批管理')?.click()
  await flush()
  assert.equal(document.querySelectorAll('.atoms-table tbody tr').length, 2, '初始应显示 2 条')

  const filterSelect = document.querySelector('.atoms-card select') as HTMLSelectElement
  filterSelect.value = '已通过'
  filterSelect.dispatchEvent(new window.Event('change', { bubbles: true }))
  await flush()

  const rows = document.querySelectorAll('.atoms-table tbody tr')
  assert.equal(rows.length, 1, '筛选后应只剩 1 条')
  assert.ok(rows[0].textContent?.includes('李四'), '应显示状态匹配的那一条')
})
