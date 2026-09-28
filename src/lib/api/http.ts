import { NextResponse, type NextRequest } from 'next/server'
import { toErrorResponse } from '@/lib/errors'

const TRACE_HEADER = 'x-atoms-trace'

export function traceId(): string {
  return Math.random().toString(36).slice(2, 10)
}

export function ok<T>(data: T, init?: { status?: number; headers?: Record<string, string> }): NextResponse {
  const res = NextResponse.json({ data, traceId: traceId() }, { status: init?.status ?? 200 })
  res.headers.set(TRACE_HEADER, traceId())
  for (const [k, v] of Object.entries(init?.headers ?? {})) res.headers.set(k, v)
  return res
}

/** 统一路由包装：把 AppError 转成约定错误码，避免任何未处理异常泄漏到客户端 */
export async function route(handler: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await handler()
  } catch (err) {
    const { status, body } = toErrorResponse(err)
    return NextResponse.json(body, { status })
  }
}

export async function readJson<T = Record<string, unknown>>(req: NextRequest): Promise<T> {
  try {
    return (await req.json()) as T
  } catch {
    return {} as T
  }
}

/** 限流键：IP + 可选用户标识 */
export function clientKey(req: NextRequest, userId?: string): string {
  const fwd = req.headers.get('x-forwarded-for') ?? ''
  const ip = fwd.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'local'
  return userId ? `${ip}:${userId}` : ip
}
