import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { NextRequest } from 'next/server'
import { requireUser } from '@/lib/auth/guard'
import { getStore, rowToJson } from '@/lib/db/store'
import { AppError } from '@/lib/errors'
import type { AppSpec } from '@/lib/spec/types'
import { buildExportHtml, slugify } from '@/lib/export/build-export-html'

/**
 * 导出（M13）：返回一个自包含、可离线运行的单文件 HTML。
 * 构建逻辑在 src/lib/export/build-export-html.ts（独立模块，便于直接测试"导出包真的能跑"）。
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const user = await requireUser()
    const { id } = await ctx.params
    const store = getStore()
    const project = await store.requireProjectForOwner(id, user.id)

    const latest = await store.getLatestSpecVersion(id)
    if (!latest) {
      throw new AppError('CONFLICT', '该项目还没有生成过应用，暂无内容可导出', '请先生成一次应用再导出')
    }

    const spec = rowToJson<AppSpec>(latest.spec)
    const runtimePath = path.join(process.cwd(), 'public', 'app-runtime.js')
    const runtimeSource = readFileSync(runtimePath, 'utf8')

    const html = buildExportHtml({
      appName: spec.meta?.name ?? project.name,
      projectName: project.name,
      version: latest.version,
      spec,
      runtimeSource,
      projectId: id,
      exportedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    })

    const filename = `${slugify(project.name)}.html`
    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    const status = err instanceof AppError ? err.status : 500
    const message = err instanceof AppError ? err.message : '导出失败'
    const hint = err instanceof AppError ? err.hint : undefined
    return new Response(
      JSON.stringify({ error: { code: err instanceof AppError ? err.code : 'INTERNAL', message, hint } }),
      { status, headers: { 'Content-Type': 'application/json' } },
    )
  }
}
