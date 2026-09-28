/**
 * 导出构建器（M13）。
 *
 * 提供两种导出形态：
 *  1. `buildExportHtml`        —— **单文件** HTML：运行时与 Spec 全部内联，双击即可离线运行（默认）
 *  2. `buildExportProjectFiles` —— **多文件工程**：index.html + app-runtime.js + spec.json + README.md
 *     打包成 ZIP，结构更接近"真实源码工程"，方便二次开发
 *
 * 独立成模块的原因：这是"导出包真的能跑"这一交付承诺的实现体，
 * 必须可以被测试直接调用（端到端字符串断言不足以证明它能运行）。
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

/** 导出包使用的 localStorage 键（按项目隔离，避免多个导出包互相污染） */
export function exportStorageKey(projectId: string): string {
  return `atoms-export-${projectId}`
}

const FOOT_STYLE = `
  html,body{margin:0;padding:0;background:#f8fafc}
  #atoms-export-root{min-height:100vh}
  .atoms-export-foot{border-top:1px solid #e2e8f0;background:#fff;padding:14px 20px;font-size:12px;color:#64748b;display:flex;gap:14px;flex-wrap:wrap;align-items:center}
  .atoms-export-foot code{background:#f1f5f9;padding:1px 5px;border-radius:4px}
  .atoms-export-foot button{border:1px solid #cbd5e1;background:#fff;border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer;color:#334155}`

/** 生成整页外壳；runtimeTag 决定运行时是内联还是外链（单文件 vs 多文件工程） */
function buildShell(params: ExportParams, runtimeTag: string): string {
  const specJson = escapeForInlineScript(JSON.stringify(params.spec, null, 2))
  const title = `${params.appName} · 导出包`

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>${FOOT_STYLE}
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

${runtimeTag}

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

/** 单文件导出：运行时内联，零外部依赖 */
export function buildExportHtml(params: ExportParams): string {
  return buildShell(params, `<script>\n${escapeForInlineScript(params.runtimeSource)}\n</script>`)
}

function projectReadme(params: ExportParams): string {
  const name = params.appName
  return `# ${name}

由 **Atoms Demo** 导出的可运行工程（生成于 ${params.exportedAt}，Spec 版本 v${params.version}）。
原始项目名：${params.projectName}

## 如何运行

**直接双击 \`index.html\`** 即可。无需安装依赖、无需构建、无需联网。

> 数据保存在浏览器的 \`localStorage\`（键：\`${exportStorageKey(params.projectId)}\`），
> 因此刷新页面数据不会丢，但换浏览器会各自独立。

## 目录结构

| 文件 | 说明 |
|---|---|
| \`index.html\` | 入口页面：内联了 App Spec，并引入 \`app-runtime.js\` |
| \`app-runtime.js\` | 渲染运行时：把 App Spec 渲染成可交互应用（原生 JS，零依赖） |
| \`spec.json\` | App Spec 原文：页面对应组件、数据模型、动作与校验规则 |
| \`README.md\` | 本说明 |

## 关于 App Spec

界面的"结构"完全由 \`spec.json\` 描述（页面 / 组件 / 数据模型 / 动作 / 主题）。
你可以直接编辑它来调整应用——运行时只渲染组件白名单内的组件，
遇到不支持的组件会**明确报错**，而不会静默降级成近似物。

## 说明

- 导出包是**静态**的：没有后端，数据存在浏览器本地
- 如果需要后端持久化与多人协作，请回到 Atoms Demo 工作台继续迭代
`
}

export interface ExportProjectFile {
  name: string
  content: string
}

/**
 * 多文件工程导出。
 * index.html 通过 \`./app-runtime.js\` 外链运行时 —— 经典 script 在 file:// 下可正常加载，
 * 因此解压后依然可以双击运行，同时结构上更接近"真实源码工程"。
 */
export function buildExportProjectFiles(params: ExportParams): ExportProjectFile[] {
  return [
    { name: 'index.html', content: buildShell(params, '<script src="./app-runtime.js"></script>') },
    { name: 'app-runtime.js', content: params.runtimeSource },
    { name: 'spec.json', content: JSON.stringify(params.spec, null, 2) },
    { name: 'README.md', content: projectReadme(params) },
  ]
}
