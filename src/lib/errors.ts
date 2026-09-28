/**
 * 统一错误语义（见 docs/03-项目流程Spec.md §5 错误码约定）。
 * 面向用户的 message 必须是「人话 + 下一步动作」。
 */
export type AppErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION_FAILED'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'BUDGET_EXCEEDED'
  | 'INTERNAL'

const STATUS: Record<AppErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
  PROVIDER_UNAVAILABLE: 503,
  BUDGET_EXCEEDED: 429,
  INTERNAL: 500,
}

export class AppError extends Error {
  readonly code: AppErrorCode
  readonly status: number
  /** 给用户的下一步动作建议 */
  readonly hint?: string

  constructor(code: AppErrorCode, message: string, hint?: string) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.status = STATUS[code]
    this.hint = hint
  }
}

export function toErrorResponse(err: unknown): {
  status: number
  body: { error: { code: AppErrorCode; message: string; hint?: string; traceId: string } }
} {
  const traceId = Math.random().toString(36).slice(2, 10)
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: { error: { code: err.code, message: err.message, hint: err.hint, traceId } },
    }
  }
  const message = err instanceof Error ? err.message : '服务出现未预期的错误'
  return {
    status: 500,
    body: {
      error: {
        code: 'INTERNAL',
        message: '服务出现未预期的错误，请稍后重试',
        hint: message.slice(0, 300),
        traceId,
      },
    },
  }
}
