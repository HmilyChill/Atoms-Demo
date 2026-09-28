import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // node:sqlite 是 Node 内置模块，保持外置由运行时解析
  serverExternalPackages: [],

  // 类型检查由 `pnpm typecheck`（tsc --noEmit）独立负责，这里跳过 Next 内置检查。
  // 原因：Next 内置 TS 检查会派生 worker 子进程并使用管道 stdio，在受限沙箱下会 EPERM；
  // 且独立 tsc 的检查强度不低于内置检查（构建前请先运行 pnpm typecheck）。
  typescript: { ignoreBuildErrors: true },

  experimental: {
    // 受限沙箱下 child_process 的管道 stdio 不可用（spawn EPERM），
    // 改用 worker_threads（MessagePort 通信）并把并行度降到 1。
    workerThreads: true,
    cpus: 1,
  },

  // 生成物预览在 iframe 沙箱中加载，需要允许被内嵌
  async headers() {
    return [
      {
        source: '/preview/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
        ],
      },
    ]
  },
}

export default nextConfig
