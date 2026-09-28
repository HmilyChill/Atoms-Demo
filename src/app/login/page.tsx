'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error?.message ?? '登录失败')
      router.push('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="text-xl font-semibold">登录</h1>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <div>
          <label className="mb-1 block text-xs text-slate-600">邮箱</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            placeholder="you@example.com"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-slate-600">密码</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            placeholder="至少 6 位"
          />
        </div>
        {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
        >
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
      <div className="mt-4 flex justify-between text-xs text-slate-500">
        <a href="/" className="hover:underline">
          返回首页
        </a>
        <a href="/register" className="text-indigo-600 hover:underline">
          还没有账号？去注册
        </a>
      </div>
    </div>
  )
}
