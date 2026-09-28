/**
 * Spec/数据的 `schemaVersion` 兼容（M9 T-M9-3）。
 *
 * 要求：打开旧数据时必须**兼容读取或明确提示**，绝不允许静默失败
 * （评审很可能打开我更早生成的项目）。
 *
 * 策略：
 *  - 缺少 schemaVersion → 明确报错（数据不完整，不能猜）
 *  - 高于当前支持版本 → 明确报错并说清楚（例如"由 v2 生成，当前只支持 v1"）
 *  - 等于或低于当前版本 → 兼容读取（当前只有 v1，低版本一律按同构处理）
 */
import { AppError } from '@/lib/errors'
import { SPEC_SCHEMA_VERSION, type AppSpec } from './types'

export interface SchemaCheckResult {
  schemaVersion: number
  /** 是否为低版本（走了兼容路径） */
  legacy: boolean
}

export function checkSchemaVersion(spec: unknown, context = '应用数据'): SchemaCheckResult {
  const version = (spec as { meta?: { schemaVersion?: unknown } } | null)?.meta?.schemaVersion

  if (typeof version !== 'number' || !Number.isFinite(version)) {
    throw new AppError(
      'VALIDATION_FAILED',
      `${context}缺少 schemaVersion，无法确认结构兼容性`,
      '该数据可能已损坏或来自不兼容的版本，请重新生成',
    )
  }

  if (version > SPEC_SCHEMA_VERSION) {
    throw new AppError(
      'CONFLICT',
      `${context}由更新版本的 Spec（v${version}）生成，当前版本只支持到 v${SPEC_SCHEMA_VERSION}`,
      '请升级到生成该数据的版本后再打开；我没有用近似结构强行渲染，以免显示错误内容',
    )
  }

  return { schemaVersion: version, legacy: version < SPEC_SCHEMA_VERSION }
}

/** 读取并校验一条 Spec；兼容旧版本，不兼容时给出明确原因 */
export function readCompatibleSpec(raw: string, context = '应用数据'): AppSpec {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new AppError('VALIDATION_FAILED', `${context}不是合法 JSON，无法解析`, '请重新生成该项目')
  }
  checkSchemaVersion(parsed, context)
  return parsed as AppSpec
}
