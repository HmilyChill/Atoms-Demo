/**
 * 导出包可运行性测试（M13 的硬指标）。
 *
 * 为什么必须有：我在文档里承诺"导出的单文件应用离线双击即可运行"，
 * 但端到端冒烟只能做字符串断言（contains('AtomsRuntime')）——那证明不了它**真的能跑**。
 * 本测试把导出的 HTML 真正加载进 jsdom 并执行其内联脚本，验证：
 *   ① 无网络也能渲染    ② 能真实录入数据    ③ 重新打开后数据仍在    ④ 全程零网络请求
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'

import { analyzeRequirement, buildTemplateSpec } from '@/lib/llm/templates'
import {
  buildExportHtml,
  escapeForInlineScript,
  exportStorageKey,
  slugify,
} from '@/lib/export/build-export-html'

const RUNTIME_SOURCE = readFileSync(path.join(process.cwd(), 'public', 'app-runtime.js'), 'utf8')
const FIXED_TIME = '2026-01-01T00:00:00.000Z'
const S1 = '做一个个人待办清单：能新增任务、标记完成、按状态筛选、删除。'
const PROJECT_ID = 'proj_exporttest01'

function makeExport(requirement = S1) {
  const spec = buildTemplateSpec(analyzeRequirement(requirement), FIXED_TIME)
  const html = buildExportHtml({
    appName: spec.meta.name,
    projectName: '导出测试项目',
    version: 1,
    spec,
    runtimeSource: RUNTIME_SOURCE,
    projectId: PROJECT_ID,
    exportedAt: '2026-01-01 00:00:00',
  })
  return { spec, html }
}

async function flush(times = 10) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

/** 加载导出包；seed 用于模拟"重新打开时浏览器里已有的数据"；同时记录所有网络请求 */
function loadExport(html: string, seed?: Record<string, string>) {
  const runtimeErrors: string[] = []
  const networkCalls: string[] = []

  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      // 断言"离线可运行"：任何网络请求都记为一次违规
      const blockedFetch = (input: unknown) => {
        networkCalls.push(String(input))
        return Promise.reject(new Error('导出包不应发起网络请求'))
      }
      Object.defineProperty(window, 'fetch', { value: blockedFetch, writable: true, configurable: true })
      window.addEventListener('error', (e) => runtimeErrors.push(String((e as ErrorEvent).message ?? e)))
      if (seed) {
        for (const [k, v] of Object.entries(seed)) window.localStorage.setItem(k, v)
      }
    },
  })

  return { dom, window: dom.window, document: dom.window.document, runtimeErrors, networkCalls }
}

test('导出包：内联了运行时与 Spec，且是自包含单文件', () => {
  const { html, spec } = makeExport()
  assert.ok(html.startsWith('<!doctype html>'), '应是完整 HTML 文档')
  assert.ok(html.includes('AtomsRuntime'), '应内联渲染运行时')
  assert.ok(html.includes('createLocalAdapter'), '应使用本地存储适配器')
  assert.ok(html.includes(spec.meta.name), '应包含应用名')
  assert.ok(html.includes('"dataModels"'), '应内联 App Spec')
  // 不应引用任何外部资源（否则离线跑不起来）
  assert.ok(!/<script[^>]+src=/i.test(html), '不应引用外部脚本')
  assert.ok(!/<link[^>]+href=/i.test(html), '不应引用外部样式')
})

test('导出包：在内联脚本被真正执行后，渲染出可用的应用（非静态快照）', async () => {
  const { html, spec } = makeExport()
  const { document, window, runtimeErrors, networkCalls } = loadExport(html)
  await flush()

  assert.equal(runtimeErrors.length, 0, `不应有运行时错误：${JSON.stringify(runtimeErrors)}`)
  assert.equal(networkCalls.length, 0, `离线运行不应发起网络请求，实际：${JSON.stringify(networkCalls)}`)

  assert.ok(window.__atomsExport, '应暴露导出句柄（说明内联脚本确实执行了）')
  assert.equal(document.querySelector('h1')?.textContent, spec.meta.name, '应渲染应用名称')
  assert.equal(document.querySelectorAll('.atoms-nav button').length, spec.navigation.length, '应渲染导航')
  assert.ok(document.querySelector('form'), '应渲染录入表单（可交互，而非静态展示）')
  assert.ok(document.querySelector('.atoms-table'), '应渲染数据表格')
})

test('导出包：可以真实录入数据并落库到 localStorage', async () => {
  const { html } = makeExport()
  const { document, window } = loadExport(html)
  await flush()

  const form = document.querySelector('form') as HTMLFormElement
  const titleInput = form.querySelector('input, textarea') as HTMLInputElement
  titleInput.value = '离线录一条'
  ;(form.querySelector('button[type="submit"]') as HTMLButtonElement).click()
  await flush()

  const key = exportStorageKey(PROJECT_ID)
  const raw = window.localStorage.getItem(key)
  assert.ok(raw, `应写入 localStorage（键：${key}）`)
  const parsed = JSON.parse(raw ?? '{}') as Record<string, Array<Record<string, unknown>>>
  assert.equal(parsed.tasks?.length, 1, '应写入 1 条任务')
  assert.equal(parsed.tasks?.[0]?.title, '离线录一条', '写入内容应正确')
  assert.ok(document.body.textContent?.includes('离线录一条'), '列表应立即显示新记录')
})

test('导出包：重新打开后数据仍在（持久化契约）', async () => {
  const { html } = makeExport()

  // 第一次打开：录入一条数据
  const first = loadExport(html)
  await flush()
  const form = first.document.querySelector('form') as HTMLFormElement
  ;(form.querySelector('input, textarea') as HTMLInputElement).value = '重开也要在'
  ;(form.querySelector('button[type="submit"]') as HTMLButtonElement).click()
  await flush()
  const persisted = first.window.localStorage.getItem(exportStorageKey(PROJECT_ID))
  assert.ok(persisted, '第一次应已落库')

  // 第二次打开：把已有数据作为浏览器状态注入
  const second = loadExport(html, { [exportStorageKey(PROJECT_ID)]: persisted ?? '{}' })
  await flush()

  const rows = second.document.querySelectorAll('.atoms-table tbody tr')
  assert.equal(rows.length, 1, '重新打开后应看到已保存的记录')
  assert.ok(second.document.body.textContent?.includes('重开也要在'), '记录内容应完整保留')
  assert.equal(second.document.querySelectorAll('.atoms-table tbody button').length > 0, true, '记录应仍可操作')
})

test('导出包：看板类应用同样可离线运行；无数据时显示空态，有数据时渲染图表', async () => {
  const { html } = makeExport('做一个销售记录工具：录入每日销售额与产品，用图表展示汇总趋势。')

  // ① 无数据：必须给出诚实的空态，而不是画一张假图
  const empty = loadExport(html)
  await flush()
  assert.equal(empty.runtimeErrors.length, 0, `不应有运行时错误：${JSON.stringify(empty.runtimeErrors)}`)
  const emptyNav = Array.from(empty.document.querySelectorAll('.atoms-nav button')) as HTMLButtonElement[]
  emptyNav.find((b) => b.textContent?.includes('数据看板'))?.click()
  await flush()
  assert.equal(empty.document.querySelector('svg.atoms-chart'), null, '无数据时不应渲染图表')
  assert.ok(empty.document.body.textContent?.includes('暂无可用于绘图的数据'), '应显示空态提示')

  // ② 有数据：渲染真实图表与汇总
  const seeded = {
    [exportStorageKey(PROJECT_ID)]: JSON.stringify({
      sales: [
        { id: 's1', product: 'A 产品', amount: 100, channel: '线上' },
        { id: 's2', product: 'B 产品', amount: 250, channel: '线下' },
        { id: 's3', product: 'A 产品', amount: 50, channel: '线上' },
      ],
    }),
  }
  const withData = loadExport(html, seeded)
  await flush()
  const nav = Array.from(withData.document.querySelectorAll('.atoms-nav button')) as HTMLButtonElement[]
  nav.find((b) => b.textContent?.includes('数据看板'))?.click()
  await flush()

  const svg = withData.document.querySelector('svg.atoms-chart')
  assert.ok(svg, '有数据时应渲染出图表')
  assert.equal(svg?.querySelectorAll('rect').length, 2, '应按产品聚合为 2 根柱子（A 产品合并）')
  const stats = Array.from(withData.document.querySelectorAll('.atoms-stat .v')).map((n: Element) => n.textContent)
  assert.ok(stats.includes('400'), `销售总额应为 400，实际：${JSON.stringify(stats)}`)
  assert.equal(withData.networkCalls.length, 0, '离线运行不应发起网络请求')
})

test('导出构建器边界：slugify 与内联脚本转义', () => {
  assert.equal(slugify('个人待办清单'), '个人待办清单')
  assert.equal(slugify('My App / v2!'), 'My-App-v2')
  assert.equal(slugify('///'), 'atoms-app', '全非法字符应回退到默认名')

  // 内联到 <script> 中时，</script 必须被拆开，否则会提前闭合脚本标签
  const dangerous = 'const s = "</script><script>alert(1)</script>"'
  const escaped = escapeForInlineScript(dangerous)
  assert.ok(!escaped.includes('</script'), '不应残留未转义的 </script')
  assert.ok(escaped.includes('<\\/script'), '应转义为 <\\/script')
})

test('导出包：注入含 </script 的文本不会破坏文档结构', async () => {
  const spec = buildTemplateSpec(analyzeRequirement(S1), FIXED_TIME)
  // 把危险文本塞进 Spec（模拟用户在需求里输入恶意内容）
  spec.pages[0].components.unshift({
    id: 'evil-callout',
    type: 'callout',
    text: '注意：</script><script>window.__hacked = true</script>',
  })
  const html = buildExportHtml({
    appName: spec.meta.name,
    projectName: '注入测试',
    version: 1,
    spec,
    runtimeSource: RUNTIME_SOURCE,
    projectId: PROJECT_ID,
    exportedAt: '2026-01-01 00:00:00',
  })

  const { window, document, runtimeErrors } = loadExport(html)
  await flush()

  assert.equal(runtimeErrors.length, 0, `不应有运行时错误：${JSON.stringify(runtimeErrors)}`)
  assert.notEqual((window as unknown as { __hacked?: boolean }).__hacked, true, '注入的脚本不应被执行')
  assert.ok(document.querySelector('form'), '应用仍应正常渲染')
})
