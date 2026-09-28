/**
 * Node ESM 解析钩子：
 *  1. 把 `@/xxx` 映射到 `src/xxx`
 *  2. 为无扩展名的相对/别名导入补全 .ts / .tsx / index.ts
 * 目的：让 `node --test` 能直接跑 TypeScript 源码，无需额外构建步骤或第三方依赖。
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = new URL('../src/', import.meta.url)

function pick(baseUrl) {
  const candidates = [baseUrl, `${baseUrl}.ts`, `${baseUrl}.tsx`, `${baseUrl}/index.ts`, `${baseUrl}/index.tsx`]
  for (const c of candidates) {
    try {
      if (existsSync(fileURLToPath(c))) return c
    } catch {
      /* 忽略非法 URL */
    }
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
