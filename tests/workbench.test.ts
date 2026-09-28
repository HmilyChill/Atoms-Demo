/**
 * 工作台界面测试（M2/M3/M6/M7 的 UI 集成）。
 *
 * 为什么需要：工作台是 ~700 行客户端逻辑（SSE 时间线、短步骤驱动循环、产物归约、版本回滚），
 * 此前**没有任何自动化覆盖**。而之前那个"表格渲染崩溃"的 bug 已经证明：
 * 未被测试的 UI 代码里真的会藏 bug——而 HTTP 冒烟测不出来。
 *
 * 做法：jsdom 提供 DOM，stub 替掉 fetch 与 EventSource，
 * 真实渲染 React 组件并**模拟用户点击**，断言请求与界面都正确。
 *
 * 注意：用 createElement 而非 JSX —— Node 的类型剥离只删类型、不做 JSX 转换。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { MessageChannel as NodeMessageChannel } from 'node:worker_threads'

import { analyzeRequirement, buildTemplateSpec } from '@/lib/llm/templates'
import type { AppSpec } from '@/lib/spec/types'

const FIXED_TIME = '2026-01-01T00:00:00.000Z'
const SPEC: AppSpec = buildTemplateSpec(
  analyzeRequirement('做一个个人待办清单：能新增任务、标记完成、按状态筛选、删除。'),
  FIXED_TIME,
)

// ─────────── 环境搭建（必须在导入 react-dom 之前完成）───────────

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/projects/proj_wb',
  pretendToBeVisual: true,
})
const g = globalThis as unknown as Record<string, unknown>

/** Node 24 里部分全局是只读 getter（如 navigator），必须用 defineProperty 注入 */
function setGlobal(key: string, value: unknown) {
  Object.defineProperty(g, key, { value, writable: true, configurable: true })
}

setGlobal('window', dom.window)
setGlobal('document', dom.window.document)
setGlobal('navigator', dom.window.navigator)
setGlobal('HTMLElement', dom.window.HTMLElement)
setGlobal('Event', dom.window.Event)
setGlobal('CustomEvent', dom.window.CustomEvent)
setGlobal('MouseEvent', dom.window.MouseEvent)
setGlobal('IS_REACT_ACT_ENVIRONMENT', true)
// React 调度器依赖 MessageChannel；jsdom 可能没有，用 Node 的补上
if (!(dom.window as unknown as Record<string, unknown>).MessageChannel) {
  ;(dom.window as unknown as Record<string, unknown>).MessageChannel = NodeMessageChannel
}
setGlobal('MessageChannel', (dom.window as unknown as Record<string, unknown>).MessageChannel)

interface FetchCall {
  url: string
  method: string
  body: unknown
}

const calls: FetchCall[] = []
/** 由各测试设置：step 接口依次返回的 done 值；'hang' 表示该请求永不返回 */
let stepResponses: boolean[] | 'hang' = [true]
/** 由各测试设置：项目是否已有 Spec（决定按钮是「开始生成」还是「提交迭代」） */
let specAvailable = true
/** 由各测试设置：是否停在"等待确认"Gate（用于测契约编辑） */
let awaitingGate = false
/** 由各测试设置：项目详情里返回的"进行中的 Run"（用于测刷新后恢复） */
let resumeRun: Record<string, unknown> | null = null

function jsonResponse(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ data }) } as unknown as Response
}

const ARTIFACTS = [
  {
    id: 'a1',
    type: 'plan',
    summary: '执行计划',
    payload: {
      goal: '交付一个待办清单',
      deliverable: '可交互应用',
      steps: [{ order: 1, title: '解析需求', detail: 'd' }],
      pageOutline: [],
    },
    createdAt: FIXED_TIME,
  },
  {
    id: 'a2',
    type: 'contract',
    summary: '需求契约',
    payload: {
      mustDo: [{ id: 'md-1', text: '提供新增任务的表单' }],
      mustNot: [{ id: 'mn-1', text: '不新增需求之外的数据集合' }],
      acceptance: ['能新增一条任务'],
    },
    createdAt: FIXED_TIME,
  },
  {
    id: 'a3',
    type: 'verification',
    summary: '校验通过',
    payload: {
      ok: true,
      summary: '结构校验通过；渲染冒烟通过；契约 3 项全部通过',
      contract: { total: 3, passed: [{ id: 'md-1', text: '提供新增任务的表单' }], failed: [] },
      render: { errors: [], pagesChecked: 1, componentsChecked: 5 },
      unverified: [],
    },
    createdAt: FIXED_TIME,
  },
]

const PUSHED_EVENTS = [
  { eventId: 1, type: 'run.started', payload: {}, at: FIXED_TIME },
  { eventId: 2, type: 'agent.started', payload: { agent: 'Mike', label: '团队领导 · 计划' }, at: FIXED_TIME },
  {
    eventId: 3,
    type: 'agent.finished',
    payload: { agent: 'Mike', durationMs: 42, tokenUsage: 120, provider: 'mock' },
    at: FIXED_TIME,
  },
  {
    eventId: 4,
    type: 'contract.ready',
    payload: { mustDo: ['提供新增任务的表单'], mustNot: [], acceptance: ['能新增一条任务'] },
    at: FIXED_TIME,
  },
]

async function fakeFetch(input: unknown, init?: RequestInit): Promise<Response> {
  const url = String(input)
  const method = (init?.method ?? 'GET').toUpperCase()
  let body: unknown = null
  if (typeof init?.body === 'string') {
    try {
      body = JSON.parse(init.body)
    } catch {
      body = init.body
    }
  }
  calls.push({ url, method, body })

  if (url.includes('/spec')) {
    return jsonResponse({
      version: specAvailable ? 2 : null,
      spec: specAvailable ? SPEC : null,
      changeSummary: specAvailable ? '迭代' : '',
      versions: specAvailable
        ? [
            {
              version: 2,
              parentVersion: 1,
              changeSummary: '增量修改：新增负责人字段',
              createdAt: FIXED_TIME,
              isCurrent: true,
            },
            { version: 1, parentVersion: null, changeSummary: '生成', createdAt: FIXED_TIME, isCurrent: false },
          ]
        : [],
      verification: specAvailable ? ARTIFACTS[2].payload : null,
    })
  }
  if (url.includes('/diff')) {
    return jsonResponse({
      from: 1,
      to: 2,
      summary: '新增 1 项 · 修改 1 项',
      changes: [
        {
          path: '数据集合「任务」› 字段「负责人」',
          kind: 'added',
          description: '新增：数据集合「任务」› 字段「负责人」',
        },
        {
          path: '主题 › primary',
          kind: 'changed',
          before: '#4f46e5',
          after: '#0ea5e9',
          description: '修改：主题 › primary（#4f46e5 → #0ea5e9）',
        },
      ],
    })
  }
  if (url.includes('/preview-token')) {
    return jsonResponse({ token: 'preview-token-abc', expiresInSec: 1800, mode: 'rw' })
  }
  if (/\/api\/runs$/.test(url) && method === 'POST') {
    return jsonResponse({ runId: 'run_wb_1', sessionId: 's1', mode: 'create', status: 'pending', stage: 'created' })
  }
  if (url.includes('/messages')) {
    return jsonResponse({
      sessionId: 's1',
      messages: [
        { id: 'm1', role: 'user', content: '做一个待办清单', runId: 'run_wb_1', createdAt: FIXED_TIME },
        { id: 'm2', role: 'agent', content: 'Mike（团队领导 · 计划）已完成：120 tokens · 42ms', runId: 'run_wb_1', createdAt: FIXED_TIME },
      ],
    })
  }
  if (url.includes('/cancel') && method === 'POST') {
    return jsonResponse({
      run: { id: 'run_wb_1', status: 'cancelled', stage: 'cancelled', mode: 'create', errorCode: null, errorMessage: null, tokenUsage: 0, callCount: 1 },
    })
  }
  if (/\/api\/projects\/proj_wb$/.test(url)) {
    return jsonResponse({
      project: { id: 'proj_wb', name: '工作台测试项目' },
      sessions: [],
      runs: resumeRun ? [resumeRun] : [],
      hasSpec: specAvailable,
    })
  }
  if (url.includes('/contract') && method === 'POST') {
    return jsonResponse({ data: { ok: true } })
  }
  if (url.includes('/rollback') && method === 'POST') {
    const m = /versions\/(\d+)\/rollback/.exec(url)
    return jsonResponse({ data: { version: Number(m?.[1] ?? 0) + 3 } })
  }
  if (url.includes('/api/runs/run_wb_1') && !url.includes('/step')) {
    return jsonResponse({
      run: {
        id: 'run_wb_1',
        status: awaitingGate ? 'awaiting_confirm' : 'running',
        stage: awaitingGate ? 'gate' : 'planned',
        mode: 'create',
        errorMessage: null,
        tokenUsage: 120,
        callCount: 1,
      },
      nextStep: 'contract',
      artifacts: ARTIFACTS,
      events: [],
    })
  }
  if (url.includes('/step')) {
    if (stepResponses === 'hang') return new Promise<Response>(() => {})
    const done = stepResponses.length > 0 ? (stepResponses.shift() as boolean) : true
    return jsonResponse({
      run: {
        id: 'run_wb_1',
        status: awaitingGate ? 'awaiting_confirm' : done ? 'succeeded' : 'running',
        stage: awaitingGate ? 'gate' : done ? 'finished' : 'paged',
        mode: 'create',
        errorCode: null,
        errorMessage: null,
        tokenUsage: 400,
        callCount: 3,
      },
      done: awaitingGate ? true : done,
      payload: null,
    })
  }
  return jsonResponse({})
}

class FakeEventSource {
  static instances: FakeEventSource[] = []
  url: string
  listeners = new Map<string, Array<(e: { data: string }) => void>>()
  closed = false

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }
  addEventListener(type: string, cb: (e: { data: string }) => void) {
    const list = this.listeners.get(type) ?? []
    list.push(cb)
    this.listeners.set(type, list)
  }
  close() {
    this.closed = true
  }
  push(event: unknown) {
    const type = (event as { type: string }).type
    for (const cb of this.listeners.get(type) ?? []) cb({ data: JSON.stringify(event) })
  }
}

/**
 * ⚠️ fetch / EventSource 的替身只在**本文件的测试期间**生效。
 * 原因：本项目用 --test-isolation=none 让所有测试跑在同一进程（沙箱禁止派生子进程），
 * 若在模块加载时就覆盖全局 fetch，会污染同进程的其它测试
 * ——例如 Turso 协议测试需要真实 fetch 去访问本地模拟服务。
 */
const realFetch = globalThis.fetch
const realEventSource = (globalThis as unknown as Record<string, unknown>).EventSource

before(() => {
  setGlobal('fetch', fakeFetch)
  setGlobal('EventSource', FakeEventSource)
  ;(dom.window as unknown as Record<string, unknown>).fetch = fakeFetch
  ;(dom.window as unknown as Record<string, unknown>).EventSource = FakeEventSource
})

after(() => {
  setGlobal('fetch', realFetch)
  setGlobal('EventSource', realEventSource)
  ;(dom.window as unknown as Record<string, unknown>).fetch = realFetch
  ;(dom.window as unknown as Record<string, unknown>).EventSource = realEventSource
})

// 环境就绪后再导入 React 与组件
const React = await import('react')
const { createRoot } = await import('react-dom/client')
const { Workbench } = await import('@/components/workbench')

// ─────────── 工具 ───────────

async function flush(times = 8) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

function container(): HTMLElement {
  return dom.window.document.getElementById('root') as HTMLElement
}

interface MountOptions {
  spec?: boolean
  steps?: boolean[] | 'hang'
  gate?: boolean
  /** 项目详情接口里返回的"进行中的 Run" */
  resume?: Record<string, unknown> | null
}

async function mount(options: MountOptions = {}) {
  resetStubs(options)
  calls.length = 0
  FakeEventSource.instances = []
  const el = container()
  el.innerHTML = ''
  const root = createRoot(el)
  await React.act(async () => {
    root.render(React.createElement(Workbench, { projectId: 'proj_wb', projectName: '工作台测试项目' }))
  })
  await React.act(async () => {
    await flush()
  })
  return root
}

/** 重置所有可变桩状态，避免测试互相污染 */
function resetStubs(options: MountOptions = {}) {
  specAvailable = options.spec ?? true
  stepResponses = options.steps ?? [true]
  awaitingGate = options.gate ?? false
  resumeRun = options.resume ?? null
}

function findButton(text: string): HTMLButtonElement | null {
  const buttons = Array.from(container().querySelectorAll('button')) as HTMLButtonElement[]
  return buttons.find((b) => b.textContent?.includes(text)) ?? null
}

/**
 * 精确匹配按钮文案。
 * ⚠️ 必须用它来点页签：像「需求契约」这样的页签名，也是
 * 「确认计划与需求契约，继续生成」的子串，用模糊匹配会误点到确认按钮。
 */
function findButtonExact(text: string): HTMLButtonElement | null {
  const buttons = Array.from(container().querySelectorAll('button')) as HTMLButtonElement[]
  return buttons.find((b) => (b.textContent ?? '').trim() === text) ?? null
}

/**
 * 生成按钮的文案会随状态变化：
 *   无 Spec → 「开始生成」；已有 Spec → 「提交迭代」；生成中 → 「生成中…」
 */
function findGenerateButton(): HTMLButtonElement | null {
  for (const label of ['开始生成', '提交迭代']) {
    const hit = findButton(label)
    if (hit) return hit
  }
  return null
}

function callsTo(fragment: string) {
  return calls.filter((c) => c.url.includes(fragment))
}

async function typeRequirement(text: string) {
  const textarea = container().querySelector('textarea') as HTMLTextAreaElement
  await React.act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(textarea, text)
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}

// ─────────── 测试 ───────────

test('工作台：挂载时加载 Spec 与预览令牌，并渲染三栏骨架', async () => {
  await mount()
  assert.ok(callsTo('/spec').length > 0, '应请求项目 Spec')
  assert.ok(callsTo('/preview-token').length > 0, '应请求预览令牌')

  const text = container().textContent ?? ''
  assert.ok(text.includes('工作台测试项目'), '应显示项目名')
  assert.ok(text.includes('智能体时间线'), '应渲染左栏时间线')
  assert.ok(text.includes('实时预览'), '应渲染右栏预览区')
  assert.ok(findGenerateButton(), '应渲染生成按钮')
})

test('工作台：生成按钮文案反映当前状态（首次生成 vs 迭代已有应用）', async () => {
  // ① 项目还没有 Spec → 「开始生成」
  await mount({ spec: false })
  assert.ok(findButton('开始生成'), '无 Spec 时应显示「开始生成」')
  assert.equal(findButton('提交迭代'), null, '无 Spec 时不应出现「提交迭代」')

  // ② 项目已有 Spec → 「提交迭代」（因为生成会产出新版本，而不是从零开始）
  await mount({ spec: true })
  assert.ok(findButton('提交迭代'), '已有 Spec 时应显示「提交迭代」')
  assert.equal(findButton('开始生成'), null, '已有 Spec 时不应再显示「开始生成」')
})

test('工作台：预览 iframe 使用严格沙箱，并用令牌鉴权（不依赖 Cookie）', async () => {
  await mount()
  const iframe = container().querySelector('iframe')
  assert.ok(iframe, '应渲染预览 iframe')

  const sandbox = iframe?.getAttribute('sandbox') ?? ''
  assert.ok(sandbox.includes('allow-scripts'), '应允许脚本（否则生成的应用无法运行）')
  assert.ok(
    !sandbox.includes('allow-same-origin'),
    '⚠️ 绝不能授予同源权限——否则沙箱形同虚设（docs/00 §11.1 A4）',
  )
  const src = iframe?.getAttribute('src') ?? ''
  assert.ok(src.includes('/preview/proj_wb'), 'iframe 应指向预览页')
  assert.ok(src.includes('pt=preview-token-abc'), 'iframe 应携带预览令牌')
})

test('工作台：提交需求会创建 Run，并驱动短步骤循环直到完成', async () => {
  await mount({ steps: [false, false, true] })
  await typeRequirement('做一个个人待办清单：能新增任务、标记完成、按状态筛选、删除。')

  const submit = findGenerateButton()
  assert.ok(submit, '应存在开始生成按钮')
  await React.act(async () => {
    submit.click()
    await flush(24)
  })

  const createRun = callsTo('/api/runs').find((c) => c.method === 'POST')
  assert.ok(createRun, '应调用创建 Run 接口')
  assert.equal(
    (createRun?.body as { userInput?: string })?.userInput,
    '做一个个人待办清单：能新增任务、标记完成、按状态筛选、删除。',
    '应把用户输入作为需求提交',
  )

  const steps = callsTo('/step')
  assert.equal(steps.length, 3, `应循环推进 3 步（实际 ${steps.length} 次）`)
  assert.ok(callsTo('/spec').length >= 2, '生成结束后应重新拉取 Spec（产物落库 → 界面同步）')
})

test('工作台：SSE 事件驱动时间线，且显示智能体与耗时', async () => {
  await mount()
  await typeRequirement('待办清单')

  await React.act(async () => {
    findGenerateButton()?.click()
    await flush(20)
  })

  const es = FakeEventSource.instances[0]
  assert.ok(es, '应建立 SSE 订阅')
  assert.ok(es.url.includes('/api/runs/run_wb_1/events'), `订阅地址应指向事件流，实际：${es.url}`)

  await React.act(async () => {
    for (const evt of PUSHED_EVENTS) es.push(evt)
    await flush(8)
  })

  const text = container().textContent ?? ''
  assert.ok(text.includes('Mike'), '时间线应显示智能体名称')
  assert.ok(text.includes('团队领导 · 计划'), '时间线应显示角色标签')
  assert.ok(text.includes('42ms'), '时间线应显示耗时')

  const contractTab = findButton('需求契约')
  assert.ok(contractTab, '应存在需求契约页签')
  await React.act(async () => {
    contractTab?.click()
    await flush(4)
  })
  assert.ok(container().textContent?.includes('提供新增任务的表单'), '契约页签应显示必做项')
})

test('工作台：产物归约正确——计划与校验报告都能在对应页签看到', async () => {
  await mount()
  await typeRequirement('做一个待办清单')
  await React.act(async () => {
    findGenerateButton()?.click()
    await flush(20)
  })

  await React.act(async () => {
    findButton('执行计划')?.click()
    await flush(4)
  })
  assert.ok(container().textContent?.includes('交付一个待办清单'), '执行计划页签应显示目标')

  await React.act(async () => {
    findButton('校验报告')?.click()
    await flush(4)
  })
  assert.ok(container().textContent?.includes('校验全部通过'), '校验报告页签应显示结论')
})

test('工作台：预览内运行时错误会回传到宿主并显示（绝不静默白屏）', async () => {
  await mount()

  // 模拟 iframe 内的渲染运行时通过 postMessage 上报错误
  await React.act(async () => {
    dom.window.dispatchEvent(
      new dom.window.MessageEvent('message', {
        data: {
          source: 'atoms-preview',
          type: 'error',
          payload: { scope: '渲染 table', message: '模拟的运行时错误' },
        },
      }),
    )
    await flush(6)
  })

  const text = container().textContent ?? ''
  assert.ok(text.includes('预览内捕获到运行时错误'), '宿主应显示错误横幅')
  assert.ok(text.includes('模拟的运行时错误'), '横幅应包含真实错误信息与来源')
})

test('工作台：非预览来源的消息不应触发错误横幅', async () => {
  await mount()
  await React.act(async () => {
    dom.window.dispatchEvent(
      new dom.window.MessageEvent('message', {
        data: { source: 'some-extension', type: 'error', payload: { message: '无关消息' } },
      }),
    )
    await flush(4)
  })
  assert.equal(container().textContent?.includes('预览内捕获到运行时错误'), false, '不应被无关消息干扰')
})

test('工作台：从预览点选元素后，输入框预填一条指向性修改诉求（点选式迭代）', async () => {
  await mount()

  await React.act(async () => {
    dom.window.dispatchEvent(
      new dom.window.MessageEvent('message', {
        data: {
          source: 'atoms-preview',
          type: 'element-selected',
          payload: {
            componentId: 'tasks--c-table',
            componentType: 'table',
            summary: '表格',
            pageTitle: '任务清单',
          },
        },
      }),
    )
    await flush(6)
  })

  const textarea = container().querySelector('textarea') as HTMLTextAreaElement
  assert.ok(textarea.value.includes('表格'), `输入框应预填诉求，实际："${textarea.value}"`)
  assert.ok(textarea.value.includes('任务清单'), '预填内容应带上所在页面')
  assert.ok(textarea.value.trim().endsWith('改为：'), '应留出补全位置')

  const text = container().textContent ?? ''
  assert.ok(text.includes('已选中：表格'), '应显示已选中提示')
  assert.ok(text.includes('取消选择'), '应可取消选择')

  // 取消后提示消失
  await React.act(async () => {
    findButton('取消选择')?.click()
    await flush(4)
  })
  assert.equal(container().textContent?.includes('已选中：'), false, '取消后不应再显示已选中提示')
})

test('工作台：空需求不会被提交（客户端就拦住，不浪费一次生成额度）', async () => {
  await mount()
  await React.act(async () => {
    findGenerateButton()?.click()
    await flush(12)
  })

  assert.equal(callsTo('/api/runs').length, 0, '空需求不应创建 Run')
  assert.ok(container().textContent?.includes('请先描述你想要的应用'), '应就地给出提示')
})

test('工作台：版本页签区分当前/历史版本，历史版本才提供回滚与对比', async () => {
  await mount()
  const versionTab = findButton('版本与迭代')
  assert.ok(versionTab, '应存在版本与迭代页签')
  await React.act(async () => {
    versionTab?.click()
    await flush(4)
  })

  const text = container().textContent ?? ''
  assert.ok(text.includes('v1') && text.includes('v2'), '应显示两个版本')
  assert.ok(text.includes('当前'), '应标注当前版本')
  assert.ok(text.includes('增量修改：新增负责人字段'), '应显示版本变更说明')

  // 历史版本提供回滚与对比入口
  assert.ok(findButton('回滚到此版本'), '历史版本应提供回滚入口')
  assert.ok(findButton('与当前对比'), '历史版本应提供差异对比入口')
})

test('工作台：点击「与当前对比」会拉取并展示结构差异（让"只改目标片段"可见）', async () => {
  await mount()
  await React.act(async () => {
    findButton('版本与迭代')?.click()
    await flush(4)
  })

  await React.act(async () => {
    findButton('与当前对比')?.click()
    await flush(12)
  })

  assert.ok(callsTo('/diff').length > 0, '应请求差异接口')
  const text = container().textContent ?? ''
  assert.ok(text.includes('版本差异 v1 → v2'), '应显示对比区间')
  assert.ok(text.includes('新增 1 项 · 修改 1 项'), '应显示变更摘要')
  assert.ok(text.includes('负责人'), '应列出新增的字段')
  assert.ok(text.includes('主题 › primary'), '应列出被修改的主题项')
})

test('工作台：等待确认时可修订契约并重新锁定（生成前的需求锁可干预）', async () => {
  await mount({ gate: true })
  await typeRequirement('做一个待办清单：能新增任务')
  await React.act(async () => {
    findGenerateButton()?.click()
    await flush(24)
  })

  await React.act(async () => {
    findButtonExact('需求契约')?.click()
    await flush(4)
  })
  assert.ok(
    container().textContent?.includes('生成尚未开始，你可以先修订契约再继续'),
    'Gate 阶段应提示可以先行修订契约（可干预窗口）',
  )

  await React.act(async () => {
    findButton('编辑契约')?.click()
    await flush(4)
  })
  assert.ok(findButton('保存并重新锁定'), '应打开契约编辑器')

  // ① 改验收点；② 关掉一条禁做项（说明"不想要的约束可以去掉"）
  const acceptance = Array.from(container().querySelectorAll('textarea')).find((t) =>
    (t as HTMLTextAreaElement).value.includes('能新增一条任务'),
  ) as HTMLTextAreaElement | undefined
  assert.ok(acceptance, '编辑器应带出原有验收点')
  await React.act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(acceptance, '能新增一条任务\n能按状态筛选')
    acceptance?.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })

  // 只取契约编辑器里的勾选框（左栏还有「跳过人工确认」的开关，不能用全局顺序）
  const boxes = Array.from(
    container().querySelectorAll('li input[type="checkbox"]'),
  ) as HTMLInputElement[]
  assert.equal(boxes.length, 2, '必做项与禁做项各有一个可勾选项')
  await React.act(async () => {
    boxes[1]?.click() // 取消「禁做项」
    await flush(4)
  })

  await React.act(async () => {
    findButton('保存并重新锁定')?.click()
    await flush(16)
  })

  const posted = callsTo('/contract').find((c) => c.method === 'POST')
  assert.ok(posted, '应提交契约修订')
  const payload = posted?.body as {
    mustDo: Array<{ enabled: boolean }>
    mustNot: Array<{ enabled: boolean }>
    acceptance: string[]
  }
  assert.equal(payload.mustDo[0]?.enabled, true, '必做项应保持启用')
  assert.equal(payload.mustNot[0]?.enabled, false, '被取消勾选的禁做项应传成 enabled=false')
  assert.deepEqual(payload.acceptance, ['能新增一条任务', '能按状态筛选'], '验收点应逐行提交')
  assert.ok(
    container().textContent?.includes('契约已更新并重新锁定'),
    '保存后应明确告知"重新锁定"已生效（校验将按新契约执行）',
  )
  assert.equal(findButton('保存并重新锁定'), null, '保存成功后编辑器应关闭')
})

test('工作台：回滚必须二次确认，未确认前不得触碰历史版本', async () => {
  await mount()
  await React.act(async () => {
    findButton('版本与迭代')?.click()
    await flush(4)
  })

  await React.act(async () => {
    findButton('回滚到此版本')?.click()
    await flush(6)
  })

  assert.equal(callsTo('/rollback').length, 0, '只是点了入口，不应立刻发起回滚')
  const text = container().textContent ?? ''
  assert.ok(text.includes('确认回滚到'), '应弹出确认条，说明回滚以新版本追加')
  assert.ok(text.includes('历史版本不会被删除'), '确认条应讲清回滚的语义')

  // 取消 → 什么也不发生
  await React.act(async () => {
    findButton('取消')?.click()
    await flush(4)
  })
  assert.equal(callsTo('/rollback').length, 0, '取消后仍不应发起回滚')
  assert.equal(container().textContent?.includes('确认回滚到'), false, '取消后确认条应消失')

  // 再来一次并确认
  await React.act(async () => {
    findButton('回滚到此版本')?.click()
    await flush(6)
  })
  await React.act(async () => {
    findButton('确认回滚')?.click()
    await flush(16)
  })

  const rollback = callsTo('/rollback').find((c) => c.method === 'POST')
  assert.ok(rollback, '确认后应发起回滚')
  assert.ok(rollback?.url.includes('/versions/1/rollback'), `应回滚到被点的那一版，实际：${rollback?.url}`)
  assert.ok(container().textContent?.includes('已回滚到 v1'), '应给出回滚结果反馈')
})

test('工作台：取消生成后本地状态立即更新（不能一直显示"生成中…"）', async () => {
  // step 一直挂起：模拟"服务端正卡在某一步"，此时用户点取消
  await mount({ steps: 'hang' })
  await typeRequirement('待办清单')
  await React.act(async () => {
    findGenerateButton()?.click()
    await flush(20)
  })

  const cancel = findButton('取消')
  assert.ok(cancel, '生成中应提供取消入口')
  assert.ok(container().textContent?.includes('生成中'), '顶栏应显示生成中')

  await React.act(async () => {
    cancel?.click()
    await flush(12)
  })

  assert.ok(callsTo('/cancel').length > 0, '应调用取消接口')
  assert.ok(container().textContent?.includes('已取消本次生成'), '应给出取消反馈')
  // 关键：本地状态必须马上跟后端一致，否则界面会一直"转圈"
  assert.ok(
    container().textContent?.includes('已取消'),
    `取消后应立即显示已取消状态，实际：${container().textContent?.slice(0, 200)}`,
  )
})

test('工作台：刷新后能恢复未完成的生成任务，并续上事件流（F-M2-6 / IT-6）', async () => {
  // 服务端有一个"进行中"的 Run（模拟：用户刷新前正在生成）
  await mount({
    steps: [true],
    resume: { id: 'run_wb_1', status: 'running', stage: 'paged', mode: 'create', errorMessage: null, tokenUsage: 300, callCount: 2 },
  })
  await flush(10)

  assert.ok(callsTo('/api/projects/proj_wb').length > 0, '挂载时应拉一次项目详情以恢复状态')
  assert.ok(
    container().textContent?.includes('已恢复上次未完成的生成任务'),
    `应提示已恢复，实际：${container().textContent?.slice(0, 200)}`,
  )
  const es = FakeEventSource.instances[0]
  assert.ok(es?.url.includes('/api/runs/run_wb_1/events'), '恢复后应重新订阅该 Run 的事件流')
  assert.ok(callsTo('/step').length > 0, '恢复后应继续推进（而不是让任务僵住）')
})

test('工作台：恢复停在 Gate 的任务时不自动推进，而是等用户确认', async () => {
  await mount({
    gate: true,
    resume: {
      id: 'run_wb_1',
      status: 'awaiting_confirm',
      stage: 'gate',
      mode: 'create',
      errorMessage: null,
      tokenUsage: 120,
      callCount: 1,
    },
  })
  await flush(10)

  assert.ok(container().textContent?.includes('已恢复上次未确认的生成任务'), '应提示等待确认')
  assert.equal(callsTo('/step').length, 0, 'Gate 状态不应自动推进生成')
  assert.ok(findButton('确认计划与需求契约，继续生成'), '应给出确认入口')
})

test('工作台：超长需求在输入时就被拦住（不浪费一次生成额度）', async () => {
  await mount()
  const textarea = container().querySelector('textarea') as HTMLTextAreaElement

  await React.act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(textarea, 'x'.repeat(4001))
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    await flush(4)
  })

  assert.ok(container().textContent?.includes('上限 4000 字'), '应显示长度上限')
  assert.ok(container().textContent?.includes('超出上限'), '超限时应就地给出提示')

  await React.act(async () => {
    findGenerateButton()?.click()
    await flush(8)
  })
  assert.equal(callsTo('/api/runs').length, 0, '超长输入不应发起生成')
})

test('工作台：会话记录可见且区分"我 / 智能体"（F-M2-2）', async () => {
  await mount()
  await flush(6)

  assert.ok(callsTo('/messages').length > 0, '应拉取会话消息历史')
  const text = container().textContent ?? ''
  assert.ok(text.includes('会话记录'), '应有会话记录区块')
  assert.ok(text.includes('做一个待办清单'), '应显示用户说过的话')
  assert.ok(text.includes('Mike'), '应显示智能体的产出记录')
  assert.ok(text.includes('我'), '应区分"我"与智能体')
})

test('工作台：预览错误横幅带出位置与建议（F-M6-4）', async () => {
  await mount()
  await React.act(async () => {
    dom.window.dispatchEvent(
      new dom.window.MessageEvent('message', {
        data: {
          source: 'atoms-preview',
          type: 'error',
          payload: {
            scope: '渲染 chart',
            message: 'yField 指向不存在的字段',
            pageTitle: '数据看板',
            componentId: 'c-chart',
            componentType: 'chart',
            suggestion: '该组件的结构可能不合法，可让智能体重做这个组件',
          },
        },
      }),
    )
    await flush(6)
  })

  const text = container().textContent ?? ''
  assert.ok(text.includes('预览内捕获到运行时错误'), '宿主应显示错误横幅')
  assert.ok(text.includes('数据看板'), '应指出出错页面')
  assert.ok(text.includes('c-chart'), '应指出出错组件')
  assert.ok(text.includes('建议：'), '应给出可执行建议而不是只有一句报错')
})
