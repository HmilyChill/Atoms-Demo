'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

export interface ProjectSummary {
  id: string
  name: string
  description: string
  currentSpecVersion: number | null
  updatedAt: string
}

export interface ProviderInfoDto {
  kind: 'mock' | 'deepseek'
  model: string
  demoMode: boolean
  hasKey: boolean
}

interface MeResponse {
  user: { id: string; email: string; displayName: string } | null
  provider: ProviderInfoDto
  quota: { dayCalls: number; dailyCallLimit: number; circuitOpen: boolean }
}

const SAMPLES: Array<{ label: string; req: string }> = [
  { label: '个人待办清单', req: '做一个个人待办清单：能新增任务、标记完成、按状态筛选、删除。' },
  { label: '活动报名与审批', req: '做一个活动报名与审批系统：学生提交报名，管理员审批通过或驳回，能看到自己的报名状态。' },
  { label: '销售数据看板', req: '做一个销售记录工具：录入每日销售额与产品，用图表展示汇总趋势。' },
  { label: '库存管理', req: '做一个库存管理工具：登记物料入库，查看库存台账与分类汇总图表。' },
  { label: '内容管理', req: '做一个内容管理系统：新建文章、按状态筛选、发布或退回草稿。' },
  { label: '会议室预约', req: '做一个会议室预约系统：提交预约，管理员确认或取消，按资源筛选。' },
]

export default function HomePage() {
  const router = useRouter()
  const [me, setMe] = useState<MeResponse | null>(null)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const meRes = await fetch('/api/auth/me', { cache: 'no-store' }).then((r) => r.json())
      const data = meRes?.data as MeResponse | undefined
      setMe(data ?? null)
      if (data?.user) {
        const projRes = await fetch('/api/projects', { cache: 'no-store' }).then((r) => r.json())
        setProjects((projRes?.data?.projects ?? []) as ProjectSummary[])
      } else {
        setProjects([])
      }
    } catch {
      setError('无法加载数据，请刷新页面重试')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function createProject(name: string, requirement: string) {
    setBusy('create')
    setError('')
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: requirement.slice(0, 200) }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error?.message ?? '创建失败')
      const id = json.data.project.id as string
      const query = requirement ? `?req=${encodeURIComponent(requirement)}&autostart=1` : ''
      router.push(`/projects/${id}${query}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败')
      setBusy('')
    }
  }

  async function demoLogin() {
    setBusy('demo')
    setError('')
    try {
      const res = await fetch('/api/auth/demo', { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error?.message ?? '创建体验账号失败')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建体验账号失败')
    } finally {
      setBusy('')
    }
  }

  async function removeProject(id: string) {
    setBusy(id)
    try {
      await fetch(`/api/projects/${id}`, { method: 'DELETE' })
      await load()
    } finally {
      setBusy('')
    }
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    await load()
  }

  const user = me?.user ?? null
  const provider = me?.provider

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-6 py-4">
          <span className="text-lg font-semibold">Atoms Demo</span>
          <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700">
            智能体驱动的应用生成
          </span>
          {provider && (
            <span
              className={
                provider.demoMode
                  ? 'rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-800'
                  : 'rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-800'
              }
              title={
                provider.demoMode
                  ? '当前使用确定性 Mock provider：无需 API Key 即可完整演示，结果可复现'
                  : `真实模型：${provider.model}`
              }
            >
              {provider.demoMode ? '演示模式（Mock provider）' : `真实模型 · ${provider.model}`}
            </span>
          )}
          <div className="ml-auto flex items-center gap-3 text-sm">
            {user ? (
              <>
                <span className="text-slate-500">{user.displayName}</span>
                <button onClick={logout} className="rounded-md border border-slate-300 px-3 py-1 text-slate-600 hover:bg-slate-50">
                  退出
                </button>
              </>
            ) : (
              <>
                <a href="/login" className="rounded-md border border-slate-300 px-3 py-1 text-slate-600 hover:bg-slate-50">
                  登录
                </a>
                <a href="/register" className="rounded-md bg-indigo-600 px-3 py-1 text-white hover:bg-indigo-700">
                  注册
                </a>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        {error && (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>
        )}

        {loading ? (
          <div className="py-16 text-center text-sm text-slate-400">正在加载…</div>
        ) : !user ? (
          <section className="rounded-xl border border-slate-200 bg-white p-8">
            <h1 className="text-2xl font-semibold">用一句话，生成一个真的能用的网页应用</h1>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-600">
              描述你想要的工具，多个智能体会依次完成
              <strong>需求契约 → 页面架构 → 数据模型 → 应用规格 → 质量校验</strong>
              ，并把它渲染成一个可交互、数据真实持久化的网页应用，你可以继续迭代它。
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <button
                onClick={demoLogin}
                disabled={busy === 'demo'}
                className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
              >
                {busy === 'demo' ? '正在创建…' : '一键体验（自动创建演示账号）'}
              </button>
              <a href="/register" className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">
                用邮箱注册
              </a>
            </div>
            <p className="mt-3 text-xs text-slate-400">
              无需配置即可体验：默认使用确定性 Mock provider，无 API Key 也能完整跑通；数据与其他访问者完全隔离。
            </p>

            <div className="mt-8 grid gap-4 sm:grid-cols-3">
              {[
                { t: '过程可见', d: '5 个角色依次产出，每步状态与耗时都看得见，不是黑箱等待' },
                { t: '产物可验证', d: '契约逐条机检 + 渲染冒烟，未通过项如实上报，绝不谎报完成' },
                { t: '结果可带走', d: '导出为自包含单文件 HTML，离线双击即可运行' },
              ].map((x) => (
                <div key={x.t} className="rounded-lg border border-slate-200 p-4">
                  <div className="text-sm font-semibold">{x.t}</div>
                  <div className="mt-1 text-xs leading-relaxed text-slate-500">{x.d}</div>
                </div>
              ))}
            </div>
          </section>
        ) : (
          <>
            <section className="rounded-xl border border-slate-200 bg-white p-6">
              <h2 className="text-base font-semibold">一键试用示例（推荐先点这个）</h2>
              <p className="mt-1 text-xs text-slate-500">
                会自动创建项目并立即开始生成，你能完整看到多智能体的推进过程。
              </p>
              <div className="mt-4 flex flex-wrap gap-3">
                {SAMPLES.map((s) => (
                  <button
                    key={s.label}
                    onClick={() => createProject(s.label, s.req)}
                    disabled={busy === 'create'}
                    className="rounded-md border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm text-indigo-700 hover:bg-indigo-100 disabled:opacity-60"
                  >
                    {s.label}
                  </button>
                ))}
                <button
                  onClick={() => createProject(`空白项目 ${new Date().toLocaleTimeString('zh-CN')}`, '')}
                  disabled={busy === 'create'}
                  className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                >
                  新建空白项目
                </button>
              </div>
            </section>

            <section className="mt-6">
              <h2 className="mb-3 text-sm font-semibold text-slate-700">
                我的项目（{projects.length}）
              </h2>
              {projects.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-400">
                  还没有项目，点上面的示例按钮试试
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {projects.map((p) => (
                    <div key={p.id} className="rounded-xl border border-slate-200 bg-white p-4">
                      <div className="flex items-start justify-between gap-3">
                        <a href={`/projects/${p.id}`} className="text-sm font-semibold text-slate-900 hover:text-indigo-600">
                          {p.name}
                        </a>
                        {p.currentSpecVersion ? (
                          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">
                            Spec v{p.currentSpecVersion}
                          </span>
                        ) : (
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">未生成</span>
                        )}
                      </div>
                      <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-slate-500">
                        {p.description || '（暂无描述）'}
                      </p>
                      <div className="mt-3 flex items-center gap-3 text-xs">
                        <a href={`/projects/${p.id}`} className="text-indigo-600 hover:underline">
                          打开工作台
                        </a>
                        <button
                          onClick={() => removeProject(p.id)}
                          disabled={busy === p.id}
                          className="text-slate-400 hover:text-red-600 disabled:opacity-50"
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  )
}
