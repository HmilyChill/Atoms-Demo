/**
 * App Spec：对"要生成的应用"的结构化描述（见 docs/03-项目流程Spec.md §8）。
 *
 * 设计要点：
 *  - Spec 是唯一可执行真源，由确定性渲染器解释（禁止渲染器读宿主内部状态）
 *  - 组件必须在白名单内，超范围必须明确报错，禁止静默近似
 *  - Spec 不可变：修改产生新版本
 */

export const SPEC_SCHEMA_VERSION = 1

export type FieldType = 'string' | 'text' | 'number' | 'boolean' | 'date' | 'select'

export interface SpecField {
  name: string
  label: string
  type: FieldType
  required?: boolean
  /** type=select 时必填 */
  options?: string[]
  defaultValue?: string | number | boolean | null
  /** 展示在列表列中 */
  inList?: boolean
}

export interface SpecDataModel {
  /** 集合键，同时是 AppRecord.collection */
  name: string
  label: string
  fields: SpecField[]
}

export interface SpecTableColumn {
  field: string
  label?: string
}

export type SpecComponentType =
  | 'heading'
  | 'text'
  | 'callout'
  | 'form'
  | 'table'
  | 'list'
  | 'detail'
  | 'stats'
  | 'chart'
  | 'filter'
  | 'tabs'

export interface SpecAction {
  kind: 'create' | 'update' | 'delete' | 'navigate' | 'status' | 'toggle'
  label: string
  model?: string
  targetPageId?: string
  /** kind=status 时：把 field 设为 value；kind=toggle 时：翻转 field 的布尔值 */
  field?: string
  value?: string
}

export interface SpecComponent {
  id: string
  type: SpecComponentType
  title?: string
  text?: string

  /** form / table / list / detail / stats / chart / filter 关联的数据集合 */
  model?: string

  /** form：要编辑的字段 */
  fields?: string[]
  submitLabel?: string
  /** form：提交动作（默认 create） */
  action?: SpecAction

  /** table：列定义 */
  columns?: SpecTableColumn[]
  /** table / list / detail：行内动作 */
  rowActions?: SpecAction[]

  /** list：标题字段与副标题字段 */
  itemTitle?: string
  itemSubtitle?: string

  /** stats */
  metric?: 'count' | 'sum' | 'avg'
  metricField?: string

  /** chart */
  chart?: 'bar' | 'line' | 'pie'
  xField?: string
  yField?: string
  aggregate?: 'count' | 'sum'

  /** filter */
  filterField?: string

  /** tabs */
  tabs?: Array<{ label: string; components: SpecComponent[] }>
}

export interface SpecPage {
  id: string
  title: string
  layout: 'single' | 'two-column' | 'dashboard'
  components: SpecComponent[]
}

export interface SpecTheme {
  primary: string
  radius: 'sm' | 'md' | 'lg'
  density: 'compact' | 'cozy' | 'comfortable'
}

export interface AppSpec {
  meta: {
    schemaVersion: number
    name: string
    description: string
    generatedAt: string
  }
  theme: SpecTheme
  dataModels: SpecDataModel[]
  pages: SpecPage[]
  navigation: Array<{ label: string; pageId: string }>
}

/** 组件白名单（P0 表达力边界） */
export const COMPONENT_WHITELIST: readonly SpecComponentType[] = [
  'heading',
  'text',
  'callout',
  'form',
  'table',
  'list',
  'detail',
  'stats',
  'chart',
  'filter',
  'tabs',
] as const

export const FIELD_TYPE_WHITELIST: readonly FieldType[] = [
  'string',
  'text',
  'number',
  'boolean',
  'date',
  'select',
] as const

export const DEFAULT_THEME: SpecTheme = {
  primary: '#4f46e5',
  radius: 'md',
  density: 'cozy',
}
