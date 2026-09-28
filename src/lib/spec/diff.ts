/**
 * App Spec 结构差异（M7 的版本 Diff 视图）。
 *
 * 目的：让"增量修改只动目标片段"这件事**看得见**，而不是只靠一句声明。
 * 输出是人类可读的中文路径 + 变更类型，便于在版本面板里直接展示。
 */
import type { AppSpec, SpecComponent, SpecDataModel, SpecField, SpecPage } from './types'

export type DiffKind = 'added' | 'removed' | 'changed'

export interface SpecChange {
  /** 人类可读路径，例如：页面「任务清单」› 组件 table › 列 */
  path: string
  kind: DiffKind
  before?: unknown
  after?: unknown
}

export interface SpecDiffResult {
  changes: SpecChange[]
  /** 一句话总结，例如："新增 1 项 · 修改 2 项" */
  summary: string
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 值可能很长，截断后用于展示 */
function brief(v: unknown): string {
  if (v === undefined) return '（无）'
  if (v === null) return 'null'
  if (typeof v === 'string') return v.length > 40 ? `${v.slice(0, 40)}…` : v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  const json = JSON.stringify(v)
  return json.length > 60 ? `${json.slice(0, 60)}…` : json
}

function push(
  changes: SpecChange[],
  path: string,
  kind: DiffKind,
  before?: unknown,
  after?: unknown,
): void {
  changes.push({ path, kind, before: kind === 'added' ? undefined : before, after: kind === 'removed' ? undefined : after })
}

/** 比较两个键值集合，按 key 匹配（用于数组元素，例如字段按 name、组件按 id） */
function diffKeyed<T>(
  changes: SpecChange[],
  basePath: string,
  beforeItems: T[],
  afterItems: T[],
  keyOf: (item: T) => string,
  labelOf: (item: T) => string,
  compare: (changes: SpecChange[], path: string, before: T, after: T) => void,
): void {
  const beforeMap = new Map(beforeItems.map((i) => [keyOf(i), i]))
  const afterMap = new Map(afterItems.map((i) => [keyOf(i), i]))

  for (const [key, item] of beforeMap) {
    if (!afterMap.has(key)) push(changes, `${basePath} › ${labelOf(item)}`, 'removed', item, undefined)
  }
  for (const [key, item] of afterMap) {
    if (!beforeMap.has(key)) {
      push(changes, `${basePath} › ${labelOf(item)}`, 'added', undefined, item)
    } else {
      compare(changes, `${basePath} › ${labelOf(item)}`, beforeMap.get(key) as T, item)
    }
  }
}

function fieldLabel(f: SpecField): string {
  return `字段「${f.label || f.name}」`
}

function componentLabel(c: SpecComponent): string {
  return `组件 ${c.type}${c.title ? `「${c.title}」` : ''}`
}

function compareField(
  changes: SpecChange[],
  path: string,
  before: SpecField,
  after: SpecField,
): void {
  const keys: Array<keyof SpecField> = ['label', 'type', 'required', 'options', 'inList', 'defaultValue']
  for (const key of keys) {
    const b = before[key]
    const a = after[key]
    const same = JSON.stringify(b ?? null) === JSON.stringify(a ?? null)
    if (!same) push(changes, `${path} › ${String(key)}`, 'changed', b, a)
  }
}

function compareComponent(
  changes: SpecChange[],
  path: string,
  before: SpecComponent,
  after: SpecComponent,
): void {
  const keys: Array<keyof SpecComponent> = [
    'title',
    'text',
    'model',
    'fields',
    'submitLabel',
    'columns',
    'rowActions',
    'itemTitle',
    'itemSubtitle',
    'metric',
    'filterField',
    'chart',
    'xField',
    'yField',
  ]
  for (const key of keys) {
    const b = before[key]
    const a = after[key]
    const same = JSON.stringify(b ?? null) === JSON.stringify(a ?? null)
    if (!same) {
      push(changes, `${path} › ${String(key)}`, 'changed', b, a)
    }
  }

  // 列/行内动作这类数组单独给一条更可读的摘要
  const countDelta = (a?: unknown[], b?: unknown[]) => (b?.length ?? 0) - (a?.length ?? 0)
  const colDelta = countDelta(before.columns, after.columns)
  if (colDelta !== 0) {
    push(
      changes,
      `${path} › 列数量`,
      colDelta > 0 ? 'added' : 'removed',
      before.columns?.length ?? 0,
      after.columns?.length ?? 0,
    )
  }
  const actionDelta = countDelta(before.rowActions, after.rowActions)
  if (actionDelta !== 0) {
    push(
      changes,
      `${path} › 行内操作数量`,
      actionDelta > 0 ? 'added' : 'removed',
      before.rowActions?.length ?? 0,
      after.rowActions?.length ?? 0,
    )
  }
}

function compareModel(
  changes: SpecChange[],
  path: string,
  before: SpecDataModel,
  after: SpecDataModel,
): void {
  diffKeyed(
    changes,
    path,
    before.fields ?? [],
    after.fields ?? [],
    (f) => f.name,
    fieldLabel,
    compareField,
  )
}

function comparePage(changes: SpecChange[], path: string, before: SpecPage, after: SpecPage): void {
  if (before.title !== after.title) push(changes, `${path} › 标题`, 'changed', before.title, after.title)
  if (before.layout !== after.layout) push(changes, `${path} › 布局`, 'changed', before.layout, after.layout)

  diffKeyed(
    changes,
    path,
    before.components ?? [],
    after.components ?? [],
    (c) => c.id,
    componentLabel,
    compareComponent,
  )
}

export function diffSpecs(beforeInput: AppSpec, afterInput: AppSpec): SpecDiffResult {
  const changes: SpecChange[] = []

  // meta
  if (beforeInput.meta?.name !== afterInput.meta?.name) {
    push(changes, '应用名称', 'changed', beforeInput.meta?.name, afterInput.meta?.name)
  }
  if (beforeInput.meta?.description !== afterInput.meta?.description) {
    push(changes, '应用描述', 'changed', beforeInput.meta?.description, afterInput.meta?.description)
  }
  if (beforeInput.meta?.schemaVersion !== afterInput.meta?.schemaVersion) {
    push(changes, 'Spec Schema 版本', 'changed', beforeInput.meta?.schemaVersion, afterInput.meta?.schemaVersion)
  }

  // theme
  const themeKeys: Array<keyof AppSpec['theme']> = ['primary', 'radius', 'density']
  for (const key of themeKeys) {
    const b = beforeInput.theme?.[key]
    const a = afterInput.theme?.[key]
    if (b !== a) push(changes, `主题 › ${String(key)}`, 'changed', b, a)
  }

  // dataModels
  diffKeyed(
    changes,
    '数据集合',
    beforeInput.dataModels ?? [],
    afterInput.dataModels ?? [],
    (m) => m.name,
    (m) => `「${m.label || m.name}」`,
    compareModel,
  )

  // pages
  diffKeyed(
    changes,
    '页面',
    beforeInput.pages ?? [],
    afterInput.pages ?? [],
    (p) => p.id,
    (p) => `「${p.title || p.id}」`,
    comparePage,
  )

  // navigation
  const nav = (s: AppSpec) => (s.navigation ?? []).map((n) => `${n.label}→${n.pageId}`).sort()
  const navBefore = nav(beforeInput)
  const navAfter = nav(afterInput)
  if (JSON.stringify(navBefore) !== JSON.stringify(navAfter)) {
    push(changes, '导航', 'changed', navBefore, navAfter)
  }

  const added = changes.filter((c) => c.kind === 'added').length
  const removed = changes.filter((c) => c.kind === 'removed').length
  const changed = changes.filter((c) => c.kind === 'changed').length
  const parts: string[] = []
  if (added > 0) parts.push(`新增 ${added} 项`)
  if (changed > 0) parts.push(`修改 ${changed} 项`)
  if (removed > 0) parts.push(`移除 ${removed} 项`)
  const summary = parts.length > 0 ? parts.join(' · ') : '两个版本完全一致'

  return { changes, summary }
}

/** 供 UI 展示：把变更渲染成一行中文描述 */
export function describeChange(change: SpecChange): string {
  switch (change.kind) {
    case 'added':
      return `新增：${change.path}`
    case 'removed':
      return `移除：${change.path}`
    default:
      return `修改：${change.path}（${brief(change.before)} → ${brief(change.after)}）`
  }
}

export { brief as briefValue }
