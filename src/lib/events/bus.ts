/**
 * 事件协议（docs/03 §6）：事件可丢，状态不可丢。
 *
 * 约定：
 *  - eventId 单调递增，支持 Last-Event-ID 断线续传
 *  - 每个 agent.started 必须有配对的 agent.finished 或 run.failed（禁止幽灵进度）
 *  - payload 中绝不允许出现任何密钥
 *
 * ⚠️ 事件要落库，而存储层是异步的（远程库走 HTTP），因此本模块全部为 async。
 */
import { getStore } from '@/lib/db/store'

export type RunEventType =
  | 'run.started'
  | 'plan.ready'
  | 'contract.ready'
  | 'agent.started'
  | 'agent.delta'
  | 'agent.finished'
  | 'spec.ready'
  | 'preview.updated'
  | 'verify.started'
  | 'verify.result'
  | 'repair.attempt'
  | 'run.finished'
  | 'run.failed'
  | 'run.cancelled'

export interface RunEvent {
  eventId: number
  runId: string
  type: RunEventType
  payload: Record<string, unknown>
  at: string
}

export const TERMINAL_RUN_EVENTS: readonly RunEventType[] = ['run.finished', 'run.failed', 'run.cancelled']

export async function emit(
  runId: string,
  type: RunEventType,
  payload: Record<string, unknown> = {},
): Promise<RunEvent> {
  const row = await getStore().appendEvent(runId, type, payload)
  return { eventId: row.event_id, runId: row.run_id, type: row.type as RunEventType, payload, at: row.created_at }
}

interface EventLogLike {
  event_id: number
  run_id: string
  type: string
  payload: string
  created_at: string
}

function toEvent(row: EventLogLike): RunEvent {
  let payload: Record<string, unknown> = {}
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>
  } catch {
    payload = {}
  }
  return {
    eventId: row.event_id,
    runId: row.run_id,
    type: row.type as RunEventType,
    payload,
    at: row.created_at,
  }
}

export async function eventsSince(runId: string, afterEventId: number, limit = 200): Promise<RunEvent[]> {
  const rows = await getStore().listEventsSince(runId, afterEventId, limit)
  return rows.map(toEvent)
}

export async function allEvents(runId: string): Promise<RunEvent[]> {
  const rows = await getStore().listEvents(runId)
  return rows.map(toEvent)
}
