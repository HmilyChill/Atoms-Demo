import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth/guard'
import { getStore } from '@/lib/db/store'
import { Workbench } from '@/components/workbench'

export const dynamic = 'force-dynamic'

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const project = await getStore().getProjectForOwner(id, user.id)
  if (!project) {
    return (
      <div className="mx-auto max-w-md p-10 text-sm text-slate-600">
        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <h1 className="text-base font-semibold">项目不存在或你没有访问权限</h1>
          <p className="mt-2 leading-relaxed">请返回项目列表重新选择。</p>
          <a href="/" className="mt-4 inline-block text-indigo-600 hover:underline">
            ← 返回项目列表
          </a>
        </div>
      </div>
    )
  }

  return <Workbench projectId={project.id} projectName={project.name} />
}
