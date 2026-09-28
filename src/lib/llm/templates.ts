/**
 * 需求 → 结构化产物的**确定性**生成（Mock provider 的核心，也是无 key 演示的保险丝）。
 *
 * 设计原则：
 *  - 同一输入必须产出同一结果（可回归、可断言）
 *  - 模板覆盖 表单 / 列表 / 详情 / 看板 四类典型页面（docs/04 M5 的表达力边界）
 *  - 无法自动落地的变更请求必须**如实标注**，不做静默近似
 */
import type {
  AppSpec,
  SpecComponent,
  SpecDataModel,
  SpecField,
  SpecPage,
} from '@/lib/spec/types'
import { DEFAULT_THEME, SPEC_SCHEMA_VERSION } from '@/lib/spec/types'
import type { Contract } from '@/lib/spec/contract'

export type TemplateKind = 'tasks' | 'approval' | 'dashboard' | 'inventory' | 'content' | 'booking' | 'generic'

export interface RequirementAnalysis {
  kind: TemplateKind
  title: string
  /** 一句话概括，用于 plan/summary */
  summary: string
  entityLabel: string
  collectionName: string
  raw: string
}

export interface PlanArtifact {
  goal: string
  deliverable: string
  steps: Array<{ order: number; title: string; detail: string }>
  pageOutline: Array<{ id: string; title: string; purpose: string }>
}

export interface PagesArtifact {
  pages: Array<{ id: string; title: string; layout: string; components: string[]; purpose: string }>
}

export interface DataModelArtifact {
  models: SpecDataModel[]
}

const KEYWORDS: Record<Exclude<TemplateKind, 'generic'>, string[]> = {
  approval: ['审批', '审核', '申请', '报名', '驳回', '通过', '流转', '工单'],
  tasks: ['待办', '任务', 'todo', '清单', '打卡', '事项'],
  dashboard: ['销售', '看板', '统计', '图表', '报表', '趋势', '汇总', '分析', '数据'],
  inventory: ['库存', '进销存', '出入库', '入库', '出库', '仓库', '盘点', '采购', '物料'],
  content: ['文章', '内容', '博客', '笔记', '知识库', '文档管理', '发布稿', '选题'],
  booking: ['预约', '排班', '时段', '档期', '会议室', '挂号', '订场'],
}

const DEFAULT_TITLES: Record<TemplateKind, string> = {
  tasks: '任务清单',
  approval: '报名审批系统',
  dashboard: '数据看板',
  inventory: '库存管理',
  content: '内容管理',
  booking: '预约管理',
  generic: '数据管理应用',
}

const DEFAULT_ENTITY_LABELS: Record<TemplateKind, string> = {
  tasks: '任务',
  approval: '报名记录',
  dashboard: '销售记录',
  inventory: '物料',
  content: '内容',
  booking: '预约',
  generic: '记录',
}

const DEFAULT_COLLECTIONS: Record<TemplateKind, string> = {
  tasks: 'tasks',
  approval: 'applications',
  dashboard: 'sales',
  inventory: 'materials',
  content: 'articles',
  booking: 'bookings',
  generic: 'items',
}

/** 关键词优先级（越靠前越先匹配；approval 在 booking 之前，因为"活动报名"应归入审批流） */
const KIND_PRIORITY = ['approval', 'booking', 'inventory', 'content', 'tasks', 'dashboard'] as const

/** 从自然语言需求中抽取确定性特征（关键词驱动，无随机性） */
export function analyzeRequirement(input: string): RequirementAnalysis {
  const raw = (input ?? '').trim()
  const lower = raw.toLowerCase()

  let kind: TemplateKind = 'generic'
  for (const key of KIND_PRIORITY) {
    if (KEYWORDS[key].some((k) => lower.includes(k.toLowerCase()))) {
      kind = key
      break
    }
  }

  const head = raw.split(/[：:。.\n]/)[0]?.trim() ?? ''
  let title = head.length > 0 ? head : DEFAULT_TITLES[kind]
  title = title.replace(/(工具|系统|应用|平台|网站)$/u, '').trim()
  if (title.length === 0) title = DEFAULT_TITLES[kind]
  if (title.length > 24) title = title.slice(0, 24)

  return {
    kind,
    title,
    summary: raw.length > 0 ? raw.slice(0, 120) : DEFAULT_TITLES[kind],
    entityLabel: DEFAULT_ENTITY_LABELS[kind],
    collectionName: DEFAULT_COLLECTIONS[kind],
    raw,
  }
}

// ─────────────────────────────────────────────────────────────
// 模板：Data Models
// ─────────────────────────────────────────────────────────────

function tasksModels(): SpecDataModel[] {
  return [
    {
      name: 'tasks',
      label: '任务',
      fields: [
        { name: 'title', label: '任务内容', type: 'string', required: true, inList: true },
        { name: 'priority', label: '优先级', type: 'select', options: ['高', '中', '低'], defaultValue: '中', inList: true },
        { name: 'due', label: '截止日期', type: 'date', inList: true },
        { name: 'note', label: '备注', type: 'text' },
        { name: 'done', label: '已完成', type: 'boolean', defaultValue: false, inList: true },
      ],
    },
  ]
}

function approvalModels(): SpecDataModel[] {
  return [
    {
      name: 'applications',
      label: '报名记录',
      fields: [
        { name: 'student', label: '报名人', type: 'string', required: true, inList: true },
        { name: 'course', label: '选修学科', type: 'select', options: ['魔药学', '占卜学', '魔法史', '炼金术'], required: true, inList: true },
        { name: 'reason', label: '申请理由', type: 'text' },
        { name: 'status', label: '审批状态', type: 'select', options: ['待审批', '已通过', '已驳回'], defaultValue: '待审批', inList: true },
        { name: 'submittedAt', label: '提交时间', type: 'date', inList: true },
      ],
    },
  ]
}

function dashboardModels(): SpecDataModel[] {
  return [
    {
      name: 'sales',
      label: '销售记录',
      fields: [
        { name: 'product', label: '产品名称', type: 'string', required: true, inList: true },
        { name: 'amount', label: '销售额', type: 'number', required: true, inList: true },
        { name: 'channel', label: '渠道', type: 'select', options: ['线上', '线下'], defaultValue: '线上', inList: true },
        { name: 'date', label: '日期', type: 'date', inList: true },
      ],
    },
  ]
}

function genericModels(analysis: RequirementAnalysis): SpecDataModel[] {
  return [
    {
      name: analysis.collectionName,
      label: analysis.entityLabel,
      fields: [
        { name: 'title', label: `${analysis.entityLabel}名称`, type: 'string', required: true, inList: true },
        { name: 'detail', label: '说明', type: 'text' },
        { name: 'status', label: '状态', type: 'select', options: ['进行中', '已完成'], defaultValue: '进行中', inList: true },
        { name: 'recordedAt', label: '记录日期', type: 'date', inList: true },
      ],
    },
  ]
}

function inventoryModels(): SpecDataModel[] {
  return [
    {
      name: 'materials',
      label: '物料',
      fields: [
        { name: 'name', label: '物料名称', type: 'string', required: true, inList: true },
        { name: 'sku', label: '编码', type: 'string', inList: true },
        { name: 'quantity', label: '当前库存', type: 'number', required: true, inList: true },
        { name: 'safetyStock', label: '安全库存', type: 'number', inList: true },
        {
          name: 'category',
          label: '分类',
          type: 'select',
          options: ['电子', '办公', '耗材'],
          defaultValue: '耗材',
          inList: true,
        },
        { name: 'checkedAt', label: '盘点日期', type: 'date', inList: true },
      ],
    },
  ]
}

function contentModels(): SpecDataModel[] {
  return [
    {
      name: 'articles',
      label: '内容',
      fields: [
        { name: 'title', label: '标题', type: 'string', required: true, inList: true },
        {
          name: 'category',
          label: '栏目',
          type: 'select',
          options: ['技术', '产品', '随笔'],
          defaultValue: '技术',
          inList: true,
        },
        { name: 'author', label: '作者', type: 'string', inList: true },
        { name: 'summary', label: '摘要', type: 'text' },
        {
          name: 'status',
          label: '状态',
          type: 'select',
          options: ['草稿', '已发布'],
          defaultValue: '草稿',
          inList: true,
        },
        { name: 'publishedAt', label: '发布时间', type: 'date', inList: true },
      ],
    },
  ]
}

function bookingModels(): SpecDataModel[] {
  return [
    {
      name: 'bookings',
      label: '预约',
      fields: [
        { name: 'customer', label: '预约人', type: 'string', required: true, inList: true },
        {
          name: 'resource',
          label: '资源',
          type: 'select',
          options: ['会议室 A', '会议室 B', '研讨室'],
          defaultValue: '会议室 A',
          inList: true,
        },
        { name: 'date', label: '日期', type: 'date', required: true, inList: true },
        {
          name: 'slot',
          label: '时段',
          type: 'select',
          options: ['09:00-11:00', '11:00-13:00', '14:00-16:00', '16:00-18:00'],
          defaultValue: '09:00-11:00',
          inList: true,
        },
        {
          name: 'status',
          label: '状态',
          type: 'select',
          options: ['待确认', '已确认', '已取消'],
          defaultValue: '待确认',
          inList: true,
        },
      ],
    },
  ]
}

export function buildDataModels(analysis: RequirementAnalysis): SpecDataModel[] {
  switch (analysis.kind) {
    case 'tasks':
      return tasksModels()
    case 'approval':
      return approvalModels()
    case 'dashboard':
      return dashboardModels()
    case 'inventory':
      return inventoryModels()
    case 'content':
      return contentModels()
    case 'booking':
      return bookingModels()
    default:
      return genericModels(analysis)
  }
}

// ─────────────────────────────────────────────────────────────
// 模板：Pages
// ─────────────────────────────────────────────────────────────

function tasksPages(): SpecPage[] {
  return [
    {
      id: 'tasks',
      title: '任务清单',
      layout: 'single',
      components: [
        { id: 'c-heading', type: 'heading', text: '任务清单' },
        { id: 'c-stats', type: 'stats', model: 'tasks', metric: 'count', title: '任务总数' },
        { id: 'c-filter', type: 'filter', model: 'tasks', filterField: 'done', title: '按完成状态筛选' },
        {
          id: 'c-form',
          type: 'form',
          model: 'tasks',
          title: '新增任务',
          fields: ['title', 'priority', 'due', 'note'],
          submitLabel: '添加任务',
          action: { kind: 'create', label: '添加任务', model: 'tasks' },
        },
        {
          id: 'c-table',
          type: 'table',
          model: 'tasks',
          title: '全部任务',
          columns: [{ field: 'title' }, { field: 'priority' }, { field: 'due' }, { field: 'done' }],
          rowActions: [
            { kind: 'toggle', label: '切换完成', field: 'done' },
            { kind: 'delete', label: '删除' },
          ],
        },
      ],
    },
  ]
}

function approvalPages(): SpecPage[] {
  return [
    {
      id: 'submit',
      title: '提交报名',
      layout: 'single',
      components: [
        { id: 'c-heading', type: 'heading', text: '提交报名' },
        { id: 'c-callout', type: 'callout', text: '提交后状态为「待审批」，可在下方列表查看进度。' },
        {
          id: 'c-form',
          type: 'form',
          model: 'applications',
          title: '报名信息',
          fields: ['student', 'course', 'reason'],
          submitLabel: '提交报名',
          action: { kind: 'create', label: '提交报名', model: 'applications' },
        },
        {
          id: 'c-table',
          type: 'table',
          model: 'applications',
          title: '我的报名记录',
          columns: [{ field: 'student' }, { field: 'course' }, { field: 'status' }, { field: 'submittedAt' }],
          rowActions: [{ kind: 'delete', label: '撤销' }],
        },
      ],
    },
    {
      id: 'review',
      title: '审批管理',
      layout: 'single',
      components: [
        { id: 'c-heading', type: 'heading', text: '审批管理' },
        { id: 'c-stats', type: 'stats', model: 'applications', metric: 'count', title: '报名总数' },
        { id: 'c-filter', type: 'filter', model: 'applications', filterField: 'status', title: '按审批状态筛选' },
        {
          id: 'c-table',
          type: 'table',
          model: 'applications',
          title: '待处理报名',
          columns: [{ field: 'student' }, { field: 'course' }, { field: 'status' }],
          rowActions: [
            { kind: 'status', label: '通过', field: 'status', value: '已通过' },
            { kind: 'status', label: '驳回', field: 'status', value: '已驳回' },
          ],
        },
      ],
    },
  ]
}

function dashboardPages(): SpecPage[] {
  return [
    {
      id: 'entry',
      title: '录入数据',
      layout: 'single',
      components: [
        { id: 'c-heading', type: 'heading', text: '录入销售数据' },
        {
          id: 'c-form',
          type: 'form',
          model: 'sales',
          title: '新增销售记录',
          fields: ['product', 'amount', 'channel', 'date'],
          submitLabel: '保存记录',
          action: { kind: 'create', label: '保存记录', model: 'sales' },
        },
        {
          id: 'c-table',
          type: 'table',
          model: 'sales',
          title: '全部记录',
          columns: [{ field: 'product' }, { field: 'amount' }, { field: 'channel' }, { field: 'date' }],
          rowActions: [{ kind: 'delete', label: '删除' }],
        },
      ],
    },
    {
      id: 'overview',
      title: '数据看板',
      layout: 'dashboard',
      components: [
        { id: 'c-heading', type: 'heading', text: '数据看板' },
        { id: 'c-stats-count', type: 'stats', model: 'sales', metric: 'count', title: '记录总数' },
        { id: 'c-stats-sum', type: 'stats', model: 'sales', metric: 'sum', metricField: 'amount', title: '销售总额' },
        {
          id: 'c-chart',
          type: 'chart',
          model: 'sales',
          title: '各产品销售额',
          chart: 'bar',
          xField: 'product',
          yField: 'amount',
          aggregate: 'sum',
        },
      ],
    },
  ]
}

function genericPages(analysis: RequirementAnalysis): SpecPage[] {
  const m = analysis.collectionName
  return [
    {
      id: 'main',
      title: analysis.title,
      layout: 'single',
      components: [
        { id: 'c-heading', type: 'heading', text: analysis.title },
        { id: 'c-stats', type: 'stats', model: m, metric: 'count', title: `${analysis.entityLabel}总数` },
        {
          id: 'c-form',
          type: 'form',
          model: m,
          title: `新增${analysis.entityLabel}`,
          fields: ['title', 'detail', 'status', 'recordedAt'],
          submitLabel: `保存${analysis.entityLabel}`,
          action: { kind: 'create', label: `保存${analysis.entityLabel}`, model: m },
        },
        {
          id: 'c-table',
          type: 'table',
          model: m,
          title: `${analysis.entityLabel}列表`,
          columns: [{ field: 'title' }, { field: 'status' }, { field: 'recordedAt' }],
          rowActions: [{ kind: 'delete', label: '删除' }],
        },
      ],
    },
  ]
}

function inventoryPages(): SpecPage[] {
  return [
    {
      id: 'stock',
      title: '库存台账',
      layout: 'single',
      components: [
        { id: 'c-heading', type: 'heading', text: '库存台账' },
        { id: 'c-stats-count', type: 'stats', model: 'materials', metric: 'count', title: '物料种类' },
        { id: 'c-stats-sum', type: 'stats', model: 'materials', metric: 'sum', metricField: 'quantity', title: '库存总量' },
        { id: 'c-filter', type: 'filter', model: 'materials', filterField: 'category', title: '按分类筛选' },
        {
          id: 'c-form',
          type: 'form',
          model: 'materials',
          title: '新增物料',
          fields: ['name', 'sku', 'quantity', 'safetyStock', 'category', 'checkedAt'],
          submitLabel: '入库登记',
          action: { kind: 'create', label: '入库登记', model: 'materials' },
        },
        {
          id: 'c-table',
          type: 'table',
          model: 'materials',
          title: '全部物料',
          columns: [
            { field: 'name' },
            { field: 'sku' },
            { field: 'quantity' },
            { field: 'safetyStock' },
            { field: 'category' },
          ],
          rowActions: [{ kind: 'delete', label: '删除' }],
        },
      ],
    },
    {
      id: 'overview',
      title: '库存看板',
      layout: 'dashboard',
      components: [
        { id: 'c-heading', type: 'heading', text: '库存看板' },
        { id: 'c-stats', type: 'stats', model: 'materials', metric: 'sum', metricField: 'quantity', title: '库存总量' },
        {
          id: 'c-chart',
          type: 'chart',
          model: 'materials',
          title: '各分类库存量',
          chart: 'bar',
          xField: 'category',
          yField: 'quantity',
          aggregate: 'sum',
        },
      ],
    },
  ]
}

function contentPages(): SpecPage[] {
  return [
    {
      id: 'manage',
      title: '内容管理',
      layout: 'single',
      components: [
        { id: 'c-heading', type: 'heading', text: '内容管理' },
        { id: 'c-stats', type: 'stats', model: 'articles', metric: 'count', title: '内容总数' },
        { id: 'c-filter', type: 'filter', model: 'articles', filterField: 'status', title: '按状态筛选' },
        {
          id: 'c-form',
          type: 'form',
          model: 'articles',
          title: '新建内容',
          fields: ['title', 'category', 'author', 'summary', 'status', 'publishedAt'],
          submitLabel: '保存内容',
          action: { kind: 'create', label: '保存内容', model: 'articles' },
        },
        {
          id: 'c-table',
          type: 'table',
          model: 'articles',
          title: '内容列表',
          columns: [
            { field: 'title' },
            { field: 'category' },
            { field: 'author' },
            { field: 'status' },
            { field: 'publishedAt' },
          ],
          rowActions: [
            { kind: 'status', label: '发布', field: 'status', value: '已发布' },
            { kind: 'status', label: '退回草稿', field: 'status', value: '草稿' },
            { kind: 'delete', label: '删除' },
          ],
        },
      ],
    },
  ]
}

function bookingPages(): SpecPage[] {
  return [
    {
      id: 'book',
      title: '预约登记',
      layout: 'single',
      components: [
        { id: 'c-heading', type: 'heading', text: '预约登记' },
        { id: 'c-callout', type: 'callout', text: '提交后状态为「待确认」，管理员可在下方列表中确认或取消。' },
        {
          id: 'c-form',
          type: 'form',
          model: 'bookings',
          title: '新建预约',
          fields: ['customer', 'resource', 'date', 'slot'],
          submitLabel: '提交预约',
          action: { kind: 'create', label: '提交预约', model: 'bookings' },
        },
        {
          id: 'c-table',
          type: 'table',
          model: 'bookings',
          title: '我的预约',
          columns: [
            { field: 'customer' },
            { field: 'resource' },
            { field: 'date' },
            { field: 'slot' },
            { field: 'status' },
          ],
          rowActions: [
            { kind: 'status', label: '确认', field: 'status', value: '已确认' },
            { kind: 'status', label: '取消', field: 'status', value: '已取消' },
            { kind: 'delete', label: '删除' },
          ],
        },
      ],
    },
    {
      id: 'manage',
      title: '预约管理',
      layout: 'single',
      components: [
        { id: 'c-heading', type: 'heading', text: '预约管理' },
        { id: 'c-stats', type: 'stats', model: 'bookings', metric: 'count', title: '预约总数' },
        { id: 'c-filter', type: 'filter', model: 'bookings', filterField: 'resource', title: '按资源筛选' },
        {
          id: 'c-table',
          type: 'table',
          model: 'bookings',
          title: '全部预约',
          columns: [
            { field: 'customer' },
            { field: 'resource' },
            { field: 'date' },
            { field: 'slot' },
            { field: 'status' },
          ],
          rowActions: [
            { kind: 'status', label: '确认', field: 'status', value: '已确认' },
            { kind: 'status', label: '取消', field: 'status', value: '已取消' },
          ],
        },
      ],
    },
  ]
}

export function buildPages(analysis: RequirementAnalysis): SpecPage[] {
  switch (analysis.kind) {
    case 'tasks':
      return tasksPages()
    case 'approval':
      return approvalPages()
    case 'dashboard':
      return dashboardPages()
    case 'inventory':
      return inventoryPages()
    case 'content':
      return contentPages()
    case 'booking':
      return bookingPages()
    default:
      return genericPages(analysis)
  }
}

// ─────────────────────────────────────────────────────────────
// 组装 App Spec
// ─────────────────────────────────────────────────────────────

function normalizeComponentIds(c: SpecComponent, pageId: string): SpecComponent {
  const out: SpecComponent = { ...c, id: `${pageId}--${c.id}` }
  if (out.type === 'tabs' && Array.isArray(out.tabs)) {
    out.tabs = out.tabs.map((t) => ({ ...t, components: t.components.map((cc) => normalizeComponentIds(cc, pageId)) }))
  }
  return out
}

/** 组件 id 必须全局唯一：多页面模板里容易出现同名组件（渲染冒烟会拦截） */
function normalizePageIds(pages: SpecPage[]): SpecPage[] {
  return pages.map((p) => ({ ...p, components: p.components.map((c) => normalizeComponentIds(c, p.id)) }))
}

export function buildTemplateSpec(analysis: RequirementAnalysis, generatedAt: string): AppSpec {
  const pages = normalizePageIds(buildPages(analysis))
  return {
    meta: {
      schemaVersion: SPEC_SCHEMA_VERSION,
      name: analysis.title,
      description: analysis.summary,
      generatedAt,
    },
    theme: { ...DEFAULT_THEME },
    dataModels: buildDataModels(analysis),
    pages,
    navigation: pages.map((p) => ({ label: p.title, pageId: p.id })),
  }
}

export function buildPlan(analysis: RequirementAnalysis): PlanArtifact {
  const pages = buildPages(analysis)
  return {
    goal: `交付一个可运行的「${analysis.title}」，覆盖：${analysis.summary}`,
    deliverable: '一个可在浏览器中直接交互的网页应用，数据真实持久化，可继续迭代',
    steps: [
      { order: 1, title: '需求解析与契约锁定', detail: '把自然语言需求拆成必做项、禁做项与可验收的结果' },
      { order: 2, title: '页面与信息架构', detail: `设计 ${pages.length} 个页面及其组件构成` },
      { order: 3, title: '数据模型设计', detail: `定义 ${analysis.entityLabel}的字段、类型与校验规则` },
      { order: 4, title: '生成 App Spec', detail: '产出结构化规格，由确定性渲染器渲染为可交互应用' },
      { order: 5, title: '质量校验', detail: '结构校验 + 渲染冒烟 + 契约逐条核对，未通过则修复或如实上报' },
    ],
    pageOutline: pages.map((p) => ({
      id: p.id,
      title: p.title,
      purpose: p.components.map((c) => c.type).join(' + '),
    })),
  }
}

export function buildPagesArtifact(analysis: RequirementAnalysis): PagesArtifact {
  return {
    pages: buildPages(analysis).map((p) => ({
      id: p.id,
      title: p.title,
      layout: p.layout,
      components: p.components.map((c) => c.type),
      purpose: p.components.map((c) => c.title ?? c.text ?? c.type).join(' / '),
    })),
  }
}

// ─────────────────────────────────────────────────────────────
// 需求契约
// ─────────────────────────────────────────────────────────────

export function buildContract(analysis: RequirementAnalysis): Contract {
  switch (analysis.kind) {
    case 'tasks':
      return {
        mustDo: [
          { id: 'md-1', text: '提供新增任务的表单', check: { kind: 'component', type: 'form' } },
          { id: 'md-2', text: '展示任务列表', check: { kind: 'component', type: 'table' } },
          { id: 'md-3', text: '支持标记完成 / 未完成', check: { kind: 'action', action: 'toggle' } },
          { id: 'md-4', text: '支持按状态筛选', check: { kind: 'component', type: 'filter' } },
          { id: 'md-5', text: '支持删除任务', check: { kind: 'action', action: 'delete' } },
        ],
        mustNot: [
          { id: 'mn-1', text: '不新增需求之外的数据集合', check: { kind: 'maxModels', max: 1 } },
          { id: 'mn-2', text: '不引入需求之外的图表看板', check: { kind: 'forbidComponent', type: 'chart' } },
        ],
        acceptance: [
          '能新增一条任务，并立即出现在列表中',
          '点击可以切换任务的完成状态',
          '切换筛选条件后，列表只显示对应状态的任务',
          '删除后该任务不再出现在列表中',
          '刷新页面后，上述数据仍然存在',
        ],
      }
    case 'approval':
      return {
        mustDo: [
          { id: 'md-1', text: '提供报名提交表单', check: { kind: 'component', type: 'form' } },
          { id: 'md-2', text: '展示报名记录列表', check: { kind: 'component', type: 'table' } },
          { id: 'md-3', text: '支持审批通过', check: { kind: 'action', action: 'status' } },
          { id: 'md-4', text: '支持按审批状态筛选', check: { kind: 'component', type: 'filter' } },
          { id: 'md-5', text: '展示报名总数', check: { kind: 'component', type: 'stats' } },
        ],
        mustNot: [
          { id: 'mn-1', text: '不新增需求之外的数据集合', check: { kind: 'maxModels', max: 1 } },
        ],
        acceptance: [
          '能提交一条报名记录，状态默认为「待审批」',
          '管理员可以将记录标记为「已通过」',
          '管理员可以将记录标记为「已驳回」',
          '可以看到报名总数',
          '刷新页面后，报名记录与状态仍然存在',
        ],
      }
    case 'dashboard':
      return {
        mustDo: [
          { id: 'md-1', text: '提供数据录入表单', check: { kind: 'component', type: 'form' } },
          { id: 'md-2', text: '展示记录列表', check: { kind: 'component', type: 'table' } },
          { id: 'md-3', text: '提供汇总图表', check: { kind: 'component', type: 'chart' } },
          { id: 'md-4', text: '展示记录总数', check: { kind: 'component', type: 'stats' } },
          { id: 'md-5', text: '支持数值型字段参与汇总', check: { kind: 'fieldType', type: 'number' } },
        ],
        mustNot: [
          { id: 'mn-1', text: '不新增需求之外的数据集合', check: { kind: 'maxModels', max: 1 } },
        ],
        acceptance: [
          '能录入一条销售记录',
          '销售额参与总额汇总',
          '图表随录入的数据变化',
          '能看到记录总数',
          '刷新页面后，记录仍然存在',
        ],
      }
    case 'inventory':
      return {
        mustDo: [
          { id: 'md-1', text: '提供入库登记表单', check: { kind: 'component', type: 'form' } },
          { id: 'md-2', text: '展示库存台账列表', check: { kind: 'component', type: 'table' } },
          { id: 'md-3', text: '展示库存汇总', check: { kind: 'component', type: 'stats' } },
          { id: 'md-4', text: '提供分类库存图表', check: { kind: 'component', type: 'chart' } },
          { id: 'md-5', text: '库存量必须为数值型', check: { kind: 'fieldType', type: 'number' } },
        ],
        mustNot: [{ id: 'mn-1', text: '不新增需求之外的数据集合', check: { kind: 'maxModels', max: 1 } }],
        acceptance: [
          '能登记一条物料，并立即出现在台账中',
          '库存总量随登记的数据变化',
          '图表按分类汇总库存量',
          '刷新页面后，物料与数量仍然存在',
        ],
      }
    case 'content':
      return {
        mustDo: [
          { id: 'md-1', text: '提供内容录入表单', check: { kind: 'component', type: 'form' } },
          { id: 'md-2', text: '展示内容列表', check: { kind: 'component', type: 'table' } },
          { id: 'md-3', text: '支持按状态筛选', check: { kind: 'component', type: 'filter' } },
          { id: 'md-4', text: '支持发布 / 退回草稿', check: { kind: 'action', action: 'status' } },
          { id: 'md-5', text: '支持删除内容', check: { kind: 'action', action: 'delete' } },
        ],
        mustNot: [{ id: 'mn-1', text: '不新增需求之外的数据集合', check: { kind: 'maxModels', max: 1 } }],
        acceptance: [
          '能新建一条内容，默认状态为「草稿」',
          '能把内容改为「已发布」',
          '能按状态筛选列表',
          '刷新页面后，内容与状态仍然存在',
        ],
      }
    case 'booking':
      return {
        mustDo: [
          { id: 'md-1', text: '提供预约提交表单', check: { kind: 'component', type: 'form' } },
          { id: 'md-2', text: '展示预约列表', check: { kind: 'component', type: 'table' } },
          { id: 'md-3', text: '支持确认 / 取消预约', check: { kind: 'action', action: 'status' } },
          { id: 'md-4', text: '支持按资源筛选', check: { kind: 'component', type: 'filter' } },
          { id: 'md-5', text: '展示预约总数', check: { kind: 'component', type: 'stats' } },
        ],
        mustNot: [{ id: 'mn-1', text: '不新增需求之外的数据集合', check: { kind: 'maxModels', max: 1 } }],
        acceptance: [
          '能提交一条预约，状态默认为「待确认」',
          '管理员可以确认预约',
          '管理员可以取消预约',
          '刷新页面后，预约与状态仍然存在',
        ],
      }
    default:
      return {
        mustDo: [
          { id: 'md-1', text: '提供录入表单', check: { kind: 'component', type: 'form' } },
          { id: 'md-2', text: '展示记录列表', check: { kind: 'component', type: 'table' } },
          { id: 'md-3', text: '支持删除记录', check: { kind: 'action', action: 'delete' } },
        ],
        mustNot: [
          { id: 'mn-1', text: '不新增需求之外的数据集合', check: { kind: 'maxModels', max: 1 } },
        ],
        acceptance: [
          '能新增一条记录',
          '新记录出现在列表中',
          '能删除记录',
          '刷新页面后，记录仍然存在',
        ],
      }
  }
}

// ─────────────────────────────────────────────────────────────
// 迭代修改（M7）：只改目标片段，并在无法落地时如实标注
// ─────────────────────────────────────────────────────────────

export interface ChangeResult {
  spec: AppSpec
  changeSummary: string
  /** 是否真的落地为结构化改动（false 表示只能在界面上标注诉求） */
  applied: boolean
}

const FIELD_HINTS: Array<{ re: RegExp; field: SpecField }> = [
  {
    re: /优先级|重要程度|priority/i,
    field: { name: 'priority', label: '优先级', type: 'select', options: ['高', '中', '低'], defaultValue: '中', inList: true },
  },
  { re: /金额|价格|数额|amount|price/i, field: { name: 'amount', label: '金额', type: 'number', inList: true } },
  { re: /数量|个数|count|quantity/i, field: { name: 'quantity', label: '数量', type: 'number', inList: true } },
  { re: /截止|到期|日期|时间|date|due/i, field: { name: 'dueDate', label: '日期', type: 'date', inList: true } },
  { re: /备注|说明|描述|详情|note|remark/i, field: { name: 'note', label: '备注', type: 'text' } },
  { re: /负责人|经办人|owner|assignee/i, field: { name: 'owner', label: '负责人', type: 'string', inList: true } },
  { re: /分类|类别|类型|category/i, field: { name: 'category', label: '分类', type: 'select', options: ['默认', '重要', '其他'], inList: true } },
  { re: /是否|启用|开关|done|flag/i, field: { name: 'flag', label: '标记', type: 'boolean', defaultValue: false, inList: true } },
]

function clone<T>(v: T): T {
  return structuredClone(v)
}

function findNumericField(spec: AppSpec): { model: string; field: string } | null {
  for (const m of spec.dataModels) {
    const f = m.fields.find((x) => x.type === 'number')
    if (f) return { model: m.name, field: f.name }
  }
  return null
}

export function applyChangeRequest(current: AppSpec, request: string): ChangeResult {
  const spec = clone(current)
  const req = (request ?? '').trim()

  // 1) 主题 / 配色
  const colorMatch = req.match(/#([0-9a-fA-F]{6})/)
  if (/主题|配色|主色|颜色|色调/.test(req) || colorMatch) {
    spec.theme = { ...spec.theme, primary: colorMatch ? `#${colorMatch[1]}` : '#0ea5e9' }
    return { spec, changeSummary: `调整主题主色为 ${spec.theme.primary}`, applied: true }
  }

  // 2) 新增字段
  if (/增加|新增|添加|加一个|补充/.test(req) && /字段|列|项|属性/.test(req)) {
    const hint = FIELD_HINTS.find((h) => h.re.test(req))
    const model = spec.dataModels[0]
    if (model) {
      const field = hint ? hint.field : { name: 'extraInfo', label: '补充信息', type: 'text' as const }
      if (!model.fields.some((f) => f.name === field.name)) {
        model.fields.push(field)
        for (const page of spec.pages) {
          for (const c of page.components) {
            if (c.type === 'form' && c.model === model.name && Array.isArray(c.fields)) {
              c.fields = [...c.fields, field.name]
              break
            }
          }
          for (const c of page.components) {
            if (c.type === 'table' && c.model === model.name && Array.isArray(c.columns)) {
              c.columns = [...c.columns, { field: field.name }]
              break
            }
          }
        }
        return { spec, changeSummary: `为「${model.label}」新增字段：${field.label}`, applied: true }
      }
      return { spec, changeSummary: `字段「${field.label}」已存在，未重复添加`, applied: true }
    }
  }

  // 3) 图表 / 看板
  if (/图表|看板|趋势|统计图|可视化/.test(req)) {
    const hasChart = spec.pages.some((p) => p.components.some((c) => c.type === 'chart'))
    if (hasChart) return { spec, changeSummary: '图表组件已存在，未重复添加', applied: true }
    let numeric = findNumericField(spec)
    if (!numeric) {
      const model = spec.dataModels[0]
      const field: SpecField = { name: 'amount', label: '金额', type: 'number', inList: true }
      model.fields.push(field)
      numeric = { model: model.name, field: field.name }
      for (const page of spec.pages) {
        for (const c of page.components) {
          if (c.type === 'form' && c.model === model.name && Array.isArray(c.fields)) {
            c.fields = [...c.fields, field.name]
            break
          }
        }
      }
    }
    const target = spec.pages[0]
    const chart: SpecComponent = {
      id: `c-chart-${Date.now().toString(36)}`,
      type: 'chart',
      model: numeric.model,
      title: '数据汇总',
      chart: 'bar',
      xField: target.components.find((c) => c.type === 'table' && Array.isArray(c.columns))
        ? (target.components.find((c) => c.type === 'table')!.columns![0]?.field ?? numeric.field)
        : numeric.field,
      yField: numeric.field,
      aggregate: 'sum',
    }
    target.components.push(chart)
    return { spec, changeSummary: `新增图表组件（按 ${numeric.field} 汇总）`, applied: true }
  }

  // 4) 筛选
  if (/筛选|过滤|搜索|查找/.test(req)) {
    const model = spec.dataModels[0]
    const field = model.fields.find((f) => f.type === 'select' || f.type === 'boolean')
    if (field) {
      const hasFilter = spec.pages.some((p) => p.components.some((c) => c.type === 'filter' && c.model === model.name))
      if (hasFilter) return { spec, changeSummary: '筛选组件已存在，未重复添加', applied: true }
      spec.pages[0].components.splice(1, 0, {
        id: `c-filter-${Date.now().toString(36)}`,
        type: 'filter',
        model: model.name,
        filterField: field.name,
        title: `按${field.label}筛选`,
      })
      return { spec, changeSummary: `新增筛选组件（按${field.label}）`, applied: true }
    }
  }

  // 5) 删除能力
  if (/删除|移除|撤销/.test(req)) {
    let changed = false
    for (const page of spec.pages) {
      for (const c of page.components) {
        if (c.type === 'table') {
          const acts = c.rowActions ?? []
          if (!acts.some((a) => a.kind === 'delete')) {
            c.rowActions = [...acts, { kind: 'delete', label: '删除' }]
            changed = true
          }
        }
      }
    }
    if (changed) return { spec, changeSummary: '为列表补充删除操作', applied: true }
    return { spec, changeSummary: '删除操作已存在，未重复添加', applied: true }
  }

  // 6) 改名
  if (/改名为|重命名为|标题改/.test(req)) {
    const m = req.match(/(?:改名为|重命名为|标题改[成为])\s*[「"']?([^」"'\n]{1,24})/)
    if (m) {
      spec.meta = { ...spec.meta, name: m[1].trim() }
      return { spec, changeSummary: `应用名称改为「${spec.meta.name}」`, applied: true }
    }
  }

  // 7) 无法自动落地 —— 如实标注，不做静默近似
  const note: SpecComponent = {
    id: `c-callout-${Date.now().toString(36)}`,
    type: 'callout',
    text: `本轮变更诉求：${req}。该诉求暂未自动落地为结构化改动，已如实在此标注，等待人工确认或补充说明。`,
  }
  spec.pages[0].components.unshift(note)
  return {
    spec,
    changeSummary: `记录变更诉求（未能自动落地，已如实标注）：${req.slice(0, 40)}`,
    applied: false,
  }
}
