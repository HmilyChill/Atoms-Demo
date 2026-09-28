import type { NextRequest } from 'next/server'
import { getStore, rowToJson } from '@/lib/db/store'
import { AppError } from '@/lib/errors'
import { getCurrentUser } from '@/lib/auth/guard'
import { PREVIEW_TOKEN_HEADER, verifyPreviewToken, type PreviewClaims } from '@/lib/auth/preview-token'
import { clientKey, ok, readJson, route } from '@/lib/api/http'
import { checkRateLimit } from '@/lib/quota/guard'

/**
 * 生成应用的数据读写接口（I-13，GenApp 数据的唯一入口）。
 *
 * 鉴权二选一：
 *  1. 登录 Cookie（工作台内的普通调用）
 *  2. 预览令牌（沙箱预览 / 只读分享），令牌必须与 projectId 匹配
 *
 * 注意：只读令牌（mode=ro）只允许读取，写入一律拒绝。
 * CORS：预览运行在不透明源，需要允许跨源读取。
 */

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Atoms-Preview-Token',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Cache-Control': 'no-store',
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}

interface Access {
  projectId: string
  mode: 'rw' | 'ro'
  via: 'cookie' | 'preview-token'
}

async function resolveAccess(req: NextRequest, projectId: string): Promise<Access> {
  const raw = req.headers.get(PREVIEW_TOKEN_HEADER) ?? new URL(req.url).searchParams.get('pt') ?? ''
  const claims: PreviewClaims | null = verifyPreviewToken(raw)
  if (claims && claims.projectId === projectId) {
    return { projectId, mode: claims.mode, via: 'preview-token' }
  }
  const user = await getCurrentUser()
  if (user) {
    const project = getStore().getProjectForOwner(projectId, user.id)
    if (!project) {
      // 已认证但无权访问 → 统一 404，不通过错误码泄露资源是否存在
      throw new AppError('NOT_FOUND', '项目不存在或你没有访问权限', '返回项目列表重新选择')
    }
    return { projectId, mode: 'rw', via: 'cookie' }
  }
  throw new AppError('UNAUTHORIZED', '没有访问该应用数据的权限', '请返回工作台重新打开预览')
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; collection: string }> }): Promise<Response> {
  return route(async () => {
    const { id, collection } = await ctx.params
    const access = await resolveAccess(req, id)
    const rows = getStore().listRecords(id, collection)
    return ok(
      {
        collection,
        mode: access.mode,
        records: rows.map((r) => ({ id: r.id, ...rowToJson<Record<string, unknown>>(r.data), createdAt: r.created_at, updatedAt: r.updated_at })),
      },
      { headers: CORS_HEADERS },
    )
  })
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; collection: string }> }): Promise<Response> {
  return route(async () => {
    const { id, collection } = await ctx.params
    const access = await resolveAccess(req, id)
    if (access.mode === 'ro') {
      throw new AppError('FORBIDDEN', '这是只读分享链接，无法写入数据', '如需编辑请在工作台中打开')
    }
    const limit = checkRateLimit(`records:${clientKey(req)}:${id}`)
    if (!limit.ok) {
      throw new AppError('RATE_LIMITED', '操作过于频繁，请稍后再试', `请在 ${limit.retryAfterSec ?? 60} 秒后重试`)
    }

    const body = await readJson<{ record?: Record<string, unknown> }>(req)
    const record = body.record ?? {}
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
      throw new AppError('BAD_REQUEST', '写入的数据格式不正确', '请刷新页面后重试')
    }
    if (JSON.stringify(record).length > 20_000) {
      throw new AppError('BAD_REQUEST', '单条记录体积过大', '请精简内容后重试')
    }
    const row = getStore().createRecord(id, collection, record)
    return ok({ id: row.id }, { status: 201, headers: CORS_HEADERS })
  })
}
