/**
 * 事件协议（docs/03 §6）：事件可丢，状态不可丢。
 *
 * 约定：
 *  - eventId 单调递增，支持 Last-Event-ID 断线续传
 *  - 每个 agent.started 必须有配对的 agent.finished 或 run.failed（禁止幽灵进度）
 *  - payload 中绝不允许出现任何密钥
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

export function emit(runId: string, type: RunEventType, payload: Record<string, unknown> = {}): RunEvent {
  const row = getStore().appendEvent(runId, type, payload)
  return { eventId: row.event_id, runId: row.run_id, type: row.type as RunEventType, payload, at: row.created_at }
}

function toEvent(row: { event_id: number; run_id: string; type: string; payload: string; created_at: string }): RunEvent {
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

export function eventsSince(runId: string, afterEventId: number, limit = 200): RunEvent[] {
  return getStore()
    .listEventsSince(runId, afterEventId, limit)
    .map(toEvent)
}

export function allEvents(runId: string): RunEvent[] {
  return getStore().listEvents(runId).map(toEvent)
}
