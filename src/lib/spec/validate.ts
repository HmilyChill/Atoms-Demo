import {
  COMPONENT_WHITELIST,
  FIELD_TYPE_WHITELIST,
  SPEC_SCHEMA_VERSION,
  type AppSpec,
  type SpecComponent,
  type SpecDataModel,
  type SpecField,
} from './types'

export interface ValidationIssue {
  path: string
  message: string
  severity: 'error' | 'warning'
}

export interface ValidationResult {
  ok: boolean
  issues: ValidationIssue[]
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const REQUIRED_MODEL_COMPONENTS: ReadonlyArray<SpecComponent['type']> = [
  'form',
  'table',
  'list',
  'detail',
  'stats',
  'chart',
  'filter',
]

/**
 * Spec 校验（I-10）：结构校验 + 语义校验（引用完整性）。
 * 约定：超范围必须报错，绝不静默近似（见 docs/03 §8 诚实原则）。
 */
export function validateSpec(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = []

  if (!isPlainObject(input)) {
    return { ok: false, issues: [{ path: '$', message: 'Spec 必须是一个对象', severity: 'error' }] }
  }

  const spec = input as Partial<AppSpec>

  // meta
  if (!isPlainObject(spec.meta)) {
    issues.push({ path: '$.meta', message: '缺少 meta', severity: 'error' })
  } else {
    if (typeof spec.meta.name !== 'string' || spec.meta.name.trim() === '') {
      issues.push({ path: '$.meta.name', message: '应用名称为空', severity: 'error' })
    }
    if (typeof spec.meta.schemaVersion !== 'number') {
      issues.push({ path: '$.meta.schemaVersion', message: '缺少 schemaVersion', severity: 'error' })
    }
  }

  // dataModels
  const modelNames = new Set<string>()
  if (!Array.isArray(spec.dataModels) || spec.dataModels.length === 0) {
    issues.push({ path: '$.dataModels', message: '至少需要一个数据集合', severity: 'error' })
  } else {
    spec.dataModels.forEach((m, mi) => {
      const p = `$.dataModels[${mi}]`
      if (!isPlainObject(m)) {
        issues.push({ path: p, message: '集合定义必须是对象', severity: 'error' })
        return
      }
      const model = m as unknown as SpecDataModel
      if (typeof model.name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(model.name)) {
        issues.push({ path: `${p}.name`, message: '集合名必须是字母开头的标识符', severity: 'error' })
      } else if (modelNames.has(model.name)) {
        issues.push({ path: `${p}.name`, message: `集合名重复：${model.name}`, severity: 'error' })
      } else {
        modelNames.add(model.name)
      }
      if (typeof model.label !== 'string' || model.label.trim() === '') {
        issues.push({ path: `${p}.label`, message: '集合缺少中文名', severity: 'warning' })
      }
      if (!Array.isArray(model.fields) || model.fields.length === 0) {
        issues.push({ path: `${p}.fields`, message: '集合至少需要一个字段', severity: 'error' })
      } else {
        const fieldNames = new Set<string>()
        model.fields.forEach((f, fi) => {
          const fp = `${p}.fields[${fi}]`
          const field = f as SpecField
          if (!isPlainObject(f)) {
            issues.push({ path: fp, message: '字段定义必须是对象', severity: 'error' })
            return
          }
          if (typeof field.name !== 'string' || field.name.trim() === '') {
            issues.push({ path: `${fp}.name`, message: '字段名不能为空', severity: 'error' })
          } else if (fieldNames.has(field.name)) {
            issues.push({ path: `${fp}.name`, message: `字段名重复：${field.name}`, severity: 'error' })
          } else {
            fieldNames.add(field.name)
          }
          if (!FIELD_TYPE_WHITELIST.includes(field.type)) {
            issues.push({
              path: `${fp}.type`,
              message: `不支持的字段类型「${String(field.type)}」，当前支持：${FIELD_TYPE_WHITELIST.join(' / ')}`,
              severity: 'error',
            })
          }
          if (field.type === 'select' && (!Array.isArray(field.options) || field.options.length === 0)) {
            issues.push({ path: `${fp}.options`, message: 'select 字段必须提供可选项', severity: 'error' })
          }
        })
      }
    })
  }

  // pages
  const pageIds = new Set<string>()
  if (!Array.isArray(spec.pages) || spec.pages.length === 0) {
    issues.push({ path: '$.pages', message: '至少需要一个页面', severity: 'error' })
  } else {
    spec.pages.forEach((pg, pi) => {
      const p = `$.pages[${pi}]`
      if (!isPlainObject(pg)) {
        issues.push({ path: p, message: '页面定义必须是对象', severity: 'error' })
        return
      }
      if (typeof pg.id !== 'string' || pg.id.trim() === '') {
        issues.push({ path: `${p}.id`, message: '页面 id 不能为空', severity: 'error' })
      } else if (pageIds.has(pg.id)) {
        issues.push({ path: `${p}.id`, message: `页面 id 重复：${pg.id}`, severity: 'error' })
      } else {
        pageIds.add(pg.id)
      }
      if (typeof pg.title !== 'string' || pg.title.trim() === '') {
        issues.push({ path: `${p}.title`, message: '页面标题不能为空', severity: 'error' })
      }
      if (!Array.isArray(pg.components) || pg.components.length === 0) {
        issues.push({ path: `${p}.components`, message: '页面至少需要一个组件', severity: 'error' })
        return
      }
      pg.components.forEach((c, ci) => validateComponent(c, `${p}.components[${ci}]`, modelNames, issues))
    })
  }

  // navigation 引用完整性
  if (!Array.isArray(spec.navigation)) {
    issues.push({ path: '$.navigation', message: '缺少 navigation', severity: 'error' })
  } else {
    spec.navigation.forEach((n, ni) => {
      const p = `$.navigation[${ni}]`
      if (!isPlainObject(n) || typeof n.pageId !== 'string') {
        issues.push({ path: p, message: '导航项缺少 pageId', severity: 'error' })
        return
      }
      if (!pageIds.has(n.pageId)) {
        issues.push({ path: `${p}.pageId`, message: `导航指向了不存在的页面：${n.pageId}`, severity: 'error' })
      }
    })
    for (const id of pageIds) {
      if (!spec.navigation.some((n) => isPlainObject(n) && n.pageId === id)) {
        issues.push({ path: '$.navigation', message: `页面 ${id} 未出现在导航中`, severity: 'warning' })
      }
    }
  }

  // theme
  if (!isPlainObject(spec.theme)) {
    issues.push({ path: '$.theme', message: '缺少 theme', severity: 'warning' })
  }

  return { ok: !issues.some((i) => i.severity === 'error'), issues }
}

function validateComponent(
  c: unknown,
  path: string,
  modelNames: Set<string>,
  issues: ValidationIssue[],
): void {
  if (!isPlainObject(c)) {
    issues.push({ path, message: '组件必须是对象', severity: 'error' })
    return
  }
  const comp = c as unknown as SpecComponent
  if (typeof comp.id !== 'string' || comp.id.trim() === '') {
    issues.push({ path: `${path}.id`, message: '组件 id 不能为空', severity: 'error' })
  }
  if (!COMPONENT_WHITELIST.includes(comp.type)) {
    issues.push({
      path: `${path}.type`,
      message: `不支持的组件类型「${String(comp.type)}」。当前白名单：${COMPONENT_WHITELIST.join(' / ')}`,
      severity: 'error',
    })
    return
  }

  if (comp.type === 'tabs') {
    if (!Array.isArray(comp.tabs) || comp.tabs.length === 0) {
      issues.push({ path: `${path}.tabs`, message: 'tabs 组件需要至少一个标签页', severity: 'error' })
    } else {
      comp.tabs.forEach((t, ti) => {
        if (!Array.isArray(t.components) || t.components.length === 0) {
          issues.push({ path: `${path}.tabs[${ti}]`, message: '标签页内至少需要一个组件', severity: 'error' })
          return
        }
        t.components.forEach((cc, ci) =>
          validateComponent(cc, `${path}.tabs[${ti}].components[${ci}]`, modelNames, issues),
        )
      })
    }
  }

  if (REQUIRED_MODEL_COMPONENTS.includes(comp.type)) {
    if (typeof comp.model !== 'string' || comp.model.trim() === '') {
      issues.push({ path: `${path}.model`, message: `${comp.type} 组件必须绑定一个数据集合`, severity: 'error' })
    } else if (!modelNames.has(comp.model)) {
      issues.push({
        path: `${path}.model`,
        message: `组件引用了不存在的数据集合：${comp.model}`,
        severity: 'error',
      })
    }
  }
}

/** 便捷入口：非法时返回问题列表，供 Verifier 与 API 复用 */
export function assertValidSpec(input: unknown): AppSpec {
  const res = validateSpec(input)
  if (!res.ok) {
    const first = res.issues.find((i) => i.severity === 'error')
    throw new Error(`Spec 校验未通过：${first ? `${first.path} ${first.message}` : '未知问题'}`)
  }
  return input as AppSpec
}

export function defaultSpecMeta(name: string, description: string, generatedAt: string) {
  return { schemaVersion: SPEC_SCHEMA_VERSION, name, description, generatedAt }
}
