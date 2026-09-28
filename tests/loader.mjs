/**
 * Node ESM 解析/加载钩子（仅用于测试）：
 *  1. 把 `@/xxx` 映射到 `src/xxx`
 *  2. 为无扩展名的相对/别名导入补全 .ts / .tsx / index.ts
 *  3. 用 **TypeScript 编译器 API** 转换 .tsx（JSX）
 *
 * 为什么用 TypeScript 而不是 esbuild/sucrase：
 *  本环境禁止 child_process 的管道 stdio（spawn EPERM），而 esbuild 的 JS API
 *  必须通过管道与它的服务子进程通信 → 直接 EPERM。TypeScript 编译器 API 是纯 JS、
 *  完全在进程内运行，且 typescript 本来就是这个项目的 devDependency，无需引入新依赖。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const SRC = new URL('../src/', import.meta.url)

function isFile(url) {
  try {
    const p = fileURLToPath(url)
    return existsSync(p) && statSync(p).isFile()
  } catch {
    return false
  }
}

function pick(baseUrl) {
  // 注意：必须先判断"是文件"，否则同名**目录**会被当成模块，
  // 触发 ERR_UNSUPPORTED_DIR_IMPORT（例如 @/lib/llm 既有目录也有 index.ts）
  const candidates = [`${baseUrl}.ts`, `${baseUrl}.tsx`, `${baseUrl}/index.ts`, `${baseUrl}/index.tsx`]
  for (const c of candidates) {
    if (isFile(c)) return c
  }
  return null
}

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) {
    const hit = pick(new URL(specifier.slice(2), SRC).href)
    if (hit) return next(hit, context)
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z0-9]+$/i.test(specifier)) {
    const hit = pick(new URL(specifier, context.parentURL).href)
    if (hit) return next(hit, context)
  }
  return next(specifier, context)
}

export async function load(url, context, next) {
  if (url.endsWith('.tsx')) {
    const fileName = fileURLToPath(url)
    const source = readFileSync(fileName, 'utf8')
    const output = ts.transpileModule(source, {
      fileName,
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        esModuleInterop: true,
        isolatedModules: true,
      },
    })
    return { format: 'module', shortCircuit: true, source: output.outputText }
  }
  return next(url, context)
}
