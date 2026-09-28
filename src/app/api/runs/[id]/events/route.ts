import type { NextRequest } from 'next/server'
import { getCurrentUser } from '@/lib/auth/guard'
import { getStore } from '@/lib/db/store'
import { eventsSince } from '@/lib/events/bus'

/**
 * SSE 事件流（docs/03 §6）。
 *
 * 实现说明：事件**持久化在数据库**，本接口按 eventId 轮询增量推送。
 * 好处是天然支持断线续传（Last-Event-ID）与多标签页，且不依赖进程内状态。
 */
const POLL_MS = 350
const TERMINAL = ['succeeded', 'failed', 'cancelled']

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params

  const user = await getCurrentUser()
  const store = getStore()
  const run = store.getRun(id)
  if (!user || !run || !store.getProjectForOwner(run.project_id, user.id)) {
    return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: '没有权限订阅该任务的事件' } }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const headerLastId = Number.parseInt(req.headers.get('last-event-id') ?? '', 10)
  const urlLastId = Number.parseInt(new URL(req.url).searchParams.get('after') ?? '', 10)
  let lastId = Number.isFinite(headerLastId) ? headerLastId : Number.isFinite(urlLastId) ? urlLastId : 0

  const encoder = new TextEncoder()
  let timer: ReturnType<typeof setTimeout> | null = null
  let closed = false

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const cleanup = () => {
        if (closed) return
        closed = true
        if (timer) clearTimeout(timer)
        try {
          controller.close()
        } catch {
          /* 已关闭 */
        }
      }

      const write = (text: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(text))
        } catch {
          cleanup()
        }
      }

      write(`retry: 2000\n\n`)
      write(`event: stream.open\ndata: ${JSON.stringify({ runId: id, after: lastId })}\n\n`)

      let idleAfterTerminal = 0

      const tick = () => {
        if (closed) return
        try {
          const batch = eventsSince(id, lastId)
          for (const evt of batch) {
            lastId = evt.eventId
            write(`id: ${evt.eventId}\nevent: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`)
          }
          const current = store.getRun(id)
          const isTerminal = !!current && TERMINAL.includes(current.status)
          if (isTerminal) {
            idleAfterTerminal += 1
            if (idleAfterTerminal >= 2 && batch.length === 0) {
              write(`event: stream.end\ndata: ${JSON.stringify({ status: current?.status })}\n\n`)
              cleanup()
              return
            }
          } else {
            idleAfterTerminal = 0
          }
        } catch {
          cleanup()
          return
        }
        timer = setTimeout(tick, POLL_MS)
      }

      req.signal.addEventListener('abort', cleanup)
      tick()
    },
    cancel() {
      closed = true
      if (timer) clearTimeout(timer)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
