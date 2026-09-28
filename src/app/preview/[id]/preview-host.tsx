'use client'

import { useEffect, useRef, useState } from 'react'
import type { AppSpec } from '@/lib/spec/types'

interface AtomsRuntimeApi {
  renderApp: (
    root: HTMLElement,
    spec: AppSpec,
    options: Record<string, unknown>,
  ) => { destroy: () => void; refresh: () => Promise<void>; getErrors: () => unknown[] }
}

declare global {
  interface Window {
    AtomsRuntime?: AtomsRuntimeApi
  }
}

/** 在沙箱 iframe 内启动生成物渲染运行时 */
export function PreviewHost({
  spec,
  projectId,
  token,
  readOnly,
  version,
}: {
  spec: AppSpec
  projectId: string
  token: string
  readOnly: boolean
  version: number
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [message, setMessage] = useState('')

  useEffect(() => {
    let app: { destroy: () => void } | null = null
    let disposed = false

    const boot = () => {
      if (disposed) return
      const runtime = window.AtomsRuntime
      const root = rootRef.current
      if (!runtime || !root) {
        setStatus('failed')
        setMessage('渲染运行时未能加载（/app-runtime.js）')
        return
      }
      root.innerHTML = ''
      try {
        app = runtime.renderApp(root, spec, {
          apiBase: '',
          projectId,
          token,
          readOnly,
          onError: (e: { scope: string; message: string }) => {
            try {
              window.parent?.postMessage({ source: 'atoms-preview-host', type: 'error', payload: e }, '*')
            } catch {
              /* 跨源失败不影响渲染 */
            }
          },
        })
        setStatus('ready')
      } catch (err) {
        setStatus('failed')
        setMessage(err instanceof Error ? err.message : String(err))
      }
    }

    if (window.AtomsRuntime) {
      boot()
    } else {
      const script = document.createElement('script')
      script.src = '/app-runtime.js'
      script.async = true
      script.onload = boot
      script.onerror = () => {
        setStatus('failed')
        setMessage('无法加载 /app-runtime.js')
      }
      document.head.appendChild(script)
    }

    return () => {
      disposed = true
      if (app) {
        try {
          app.destroy()
        } catch {
          /* 忽略卸载异常 */
        }
      }
    }
  }, [spec, projectId, token, readOnly, version])

  return (
    <div className="min-h-screen">
      {status === 'failed' && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800">
          预览运行时启动失败：{message}
        </div>
      )}
      <div ref={rootRef} />
    </div>
  )
}
