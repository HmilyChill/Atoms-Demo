import type { NextRequest } from 'next/server'
import { getStore } from '@/lib/db/store'
import { AppError } from '@/lib/errors'
import { getCurrentUser } from '@/lib/auth/guard'
import { PREVIEW_TOKEN_HEADER, verifyPreviewToken } from '@/lib/auth/preview-token'
import { ok, readJson, route } from '@/lib/api/http'

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Atoms-Preview-Token',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Cache-Control': 'no-store',
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}

async function requireWritable(req: NextRequest, projectId: string): Promise<void> {
  const raw = req.headers.get(PREVIEW_TOKEN_HEADER) ?? new URL(req.url).searchParams.get('pt') ?? ''
  const claims = verifyPreviewToken(raw)
  if (claims && claims.projectId === projectId) {
    if (claims.mode === 'ro') {
      throw new AppError('FORBIDDEN', '这是只读分享链接，无法修改数据', '如需编辑请在工作台中打开')
    }
    return
  }
  const user = await getCurrentUser()
  if (user) {
    if (await getStore().getProjectForOwner(projectId, user.id)) return
    // 已认证但无权访问 → 404（与其它接口保持一致，且不泄露存在性）
    throw new AppError('NOT_FOUND', '项目不存在或你没有访问权限', '返回项目列表重新选择')
  }
  throw new AppError('UNAUTHORIZED', '没有修改该应用数据的权限', '请返回工作台重新打开预览')
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; collection: string; recordId: string }> },
): Promise<Response> {
  return route(async () => {
    const { id, collection, recordId } = await ctx.params
    await requireWritable(req, id)
    const body = await readJson<{ patch?: Record<string, unknown> }>(req)
    const patch = body.patch ?? {}
    const row = await getStore().updateRecord(id, collection, recordId, patch)
    if (!row) {
      throw new AppError('NOT_FOUND', '记录不存在或已被删除', '请刷新页面查看最新数据')
    }
    return ok({ id: row.id }, { headers: CORS_HEADERS })
  })
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; collection: string; recordId: string }> },
): Promise<Response> {
  return route(async () => {
    const { id, collection, recordId } = await ctx.params
    await requireWritable(req, id)
    const removed = await getStore().deleteRecord(id, collection, recordId)
    if (!removed) {
      throw new AppError('NOT_FOUND', '记录不存在或已被删除', '请刷新页面查看最新数据')
    }
    return ok({ removed: true }, { headers: CORS_HEADERS })
  })
}
