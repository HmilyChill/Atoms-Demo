import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { NextRequest } from 'next/server'
import { requireUser } from '@/lib/auth/guard'
import { getStore, rowToJson } from '@/lib/db/store'
import { AppError } from '@/lib/errors'
import type { AppSpec } from '@/lib/spec/types'

/**
 * 导出（M13）：生成一个**自包含、可离线运行**的单文件 HTML。
 *
 * 设计取舍（docs/03 §9 S8 的降级路径）：
 *  - 单文件 HTML 内联了**同一份**渲染运行时 + App Spec，双击即可运行，无需构建、无需联网
 *  - 数据使用 localStorage 适配器（导出包没有后端）
 *  - 多文件 ZIP 工程导出列为 P2（未做，已在说明文档中如实标注）
 */
function slugify(name: string): string {
  const s = name
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return s.length > 0 ? s : 'atoms-app'
}

function escapeForInlineScript(text: string): string {
  return text.replace(/<\/script/gi, '<\\/script')
}

function buildHtml(params: {
  appName: string
  projectName: string
  version: number
  spec: AppSpec
  runtimeSource: string
  projectId: string
  exportedAt: string
}): string {
  const specJson = escapeForInlineScript(JSON.stringify(params.spec, null, 2))
  const runtime = escapeForInlineScript(params.runtimeSource)
  const title = `${params.appName} · 导出包`

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  html,body{margin:0;padding:0;background:#f8fafc}
  #atoms-export-root{min-height:100vh}
  .atoms-export-foot{border-top:1px solid #e2e8f0;background:#fff;padding:14px 20px;font-size:12px;color:#64748b;display:flex;gap:14px;flex-wrap:wrap;align-items:center}
  .atoms-export-foot code{background:#f1f5f9;padding:1px 5px;border-radius:4px}
  .atoms-export-foot button{border:1px solid #cbd5e1;background:#fff;border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer;color:#334155}
</style>
</head>
<body>
<div id="atoms-export-root"></div>
<div class="atoms-export-foot">
  <span>由 <strong>Atoms Demo</strong> 于 ${params.exportedAt} 导出</span>
  <span>项目：<code>${params.projectName}</code></span>
  <span>Spec 版本：<code>v${params.version}</code></span>
  <span>数据存储：浏览器 localStorage（离线可用）</span>
  <button id="atoms-download-spec" type="button">下载 spec.json</button>
</div>

<script>
${runtime}
</script>

<script>
(function () {
  var SPEC = ${specJson};
  var root = document.getElementById('atoms-export-root');
  var errors = [];
  var app = window.AtomsRuntime.renderApp(root, SPEC, {
    dataAdapter: window.AtomsRuntime.createLocalAdapter({ storageKey: 'atoms-export-${params.projectId}' }),
    readOnly: false,
    onError: function (e) { errors.push(e); try { console.error('[atoms-export]', e); } catch (_) {} }
  });

  document.getElementById('atoms-download-spec').addEventListener('click', function () {
    var blob = new Blob([JSON.stringify(SPEC, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'spec.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  });

  window.__atomsExport = { app: app, errors: errors, spec: SPEC };
})();
</script>
</body>
</html>`
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const user = await requireUser()
    const { id } = await ctx.params
    const store = getStore()
    const project = store.getProjectForOwner(id, user.id)
    if (!project) throw new AppError('NOT_FOUND', '项目不存在或你没有访问权限', '返回项目列表重新选择')

    const latest = store.getLatestSpecVersion(id)
    if (!latest) {
      throw new AppError('CONFLICT', '该项目还没有生成过应用，暂无内容可导出', '请先生成一次应用再导出')
    }

    const spec = rowToJson<AppSpec>(latest.spec)
    const runtimePath = path.join(process.cwd(), 'public', 'app-runtime.js')
    const runtimeSource = readFileSync(runtimePath, 'utf8')

    const html = buildHtml({
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
    return new Response(JSON.stringify({ error: { code: err instanceof AppError ? err.code : 'INTERNAL', message, hint } }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
