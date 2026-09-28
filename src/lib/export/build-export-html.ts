/**
 * 导出构建器（M13）。
 *
 * 独立成模块的原因：这是"导出包真的能跑"这一交付承诺的实现体，
 * 必须可以被测试直接调用（端到端字符串断言不足以证明它能运行）。
 *
 * 设计取舍（docs/03 §9 S8 的降级路径）：
 *  - 单文件 HTML 内联**同一份**渲染运行时 + App Spec，双击即可运行，无需构建、无需联网
 *  - 数据使用 localStorage 适配器（导出包没有后端）
 *  - 多文件 ZIP 工程导出列为 P2（未做，已在说明文档中如实标注）
 */
import type { AppSpec } from '@/lib/spec/types'

export function slugify(name: string): string {
  const s = name
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return s.length > 0 ? s : 'atoms-app'
}

/** 内联进 <script> 时，必须拆开 </script 以免提前闭合脚本标签 */
export function escapeForInlineScript(text: string): string {
  return text.replace(/<\/script/gi, '<\\/script')
}

export interface ExportParams {
  appName: string
  projectName: string
  version: number
  spec: AppSpec
  runtimeSource: string
  projectId: string
  exportedAt: string
}

export function buildExportHtml(params: ExportParams): string {
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
    dataAdapter: window.AtomsRuntime.createLocalAdapter({ storageKey: '${exportStorageKey(params.projectId)}' }),
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

/** 导出包使用的 localStorage 键（按项目隔离，避免多个导出包互相污染） */
export function exportStorageKey(projectId: string): string {
  return `atoms-export-${projectId}`
}
