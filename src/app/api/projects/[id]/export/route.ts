import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { NextRequest } from 'next/server'
import { requireUser } from '@/lib/auth/guard'
import { getStore, rowToJson } from '@/lib/db/store'
import { AppError } from '@/lib/errors'
import { toErrorResponse } from '@/lib/errors'
import type { AppSpec } from '@/lib/spec/types'
import { buildExportHtml, buildExportProjectFiles, slugify, type ExportParams } from '@/lib/export/build-export-html'
import { createZip } from '@/lib/export/zip'

/**
 * 导出（M13）。支持两种形态：
 *  - 默认：**单文件 HTML**（运行时与 Spec 内联，双击即可离线运行）
 *  - `?format=zip`：**多文件工程 ZIP**（index.html + app-runtime.js + spec.json + README.md）
 *
 * 构建逻辑在 src/lib/export/ 下（独立模块，便于直接测试"导出包真的能跑"）。
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const user = await requireUser()
    const { id } = await ctx.params
    const store = getStore()
    const project = await store.requireProjectForOwner(id, user.id)

    const latest = await store.getLatestSpecVersion(id)
    if (!latest) {
      throw new AppError('CONFLICT', '该项目还没有生成过应用，暂无内容可导出', '请先生成一次应用再导出')
    }

    const format = new URL(req.url).searchParams.get('format') === 'zip' ? 'zip' : 'html'
    const spec = rowToJson<AppSpec>(latest.spec)
    const runtimeSource = readFileSync(path.join(process.cwd(), 'public', 'app-runtime.js'), 'utf8')

    const params: ExportParams = {
      appName: spec.meta?.name ?? project.name,
      projectName: project.name,
      version: latest.version,
      spec,
      runtimeSource,
      projectId: id,
      exportedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    }

    const base = slugify(project.name)

    if (format === 'zip') {
      const zip = createZip(buildExportProjectFiles(params))
      // HTTP 头必须是 Latin-1：中文项目名不能直接进 Content-Disposition，需按 RFC 5987 编码
      const zipName = `${base}-project.zip`
      return new Response(new Uint8Array(zip), {
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(zipName)}"; filename*=UTF-8''${encodeURIComponent(zipName)}`,
          'Content-Length': String(zip.length),
          'Cache-Control': 'no-store',
        },
      })
    }

    const html = buildExportHtml(params)
    const filename = `${base}.html`
    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    // 用统一的错误映射：非预期错误会把真实原因放进 hint，便于部署后排查（否则只剩一句"导出失败"）
    const { status, body } = toErrorResponse(err)
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
