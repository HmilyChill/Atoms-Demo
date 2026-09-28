/**
 * QuotaGuard（I-17）：限流 + 单 Run 预算 + 每日全局熔断。
 *
 * 为什么必须有（docs/00 §11.1 A2 / R10）：
 *   方案 B 是「公网可访问 + 服务端持有自备 key」，不设防等于把自己的额度公开。
 *
 * 说明：计数为进程内状态，适合本项目规模；多点部署时需换成共享存储（已在 README 标注限制）。
 */
import { env } from '@/lib/env'

interface QuotaState {
  /** 滑动窗口限流：key -> { windowStart, count } */
  windows: Map<string, { windowStart: number; count: number }>
  dayKey: string
  dayCalls: number
  dayTokens: number
  /** 熔断：当日额度耗尽后置位，provider 层据此自动降级为 Mock */
  circuitOpen: boolean
}

const WINDOW_MS = 60_000

const g = globalThis as unknown as { __atomsQuota?: QuotaState }

function todayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10)
}

function state(now = Date.now()): QuotaState {
  if (!g.__atomsQuota) {
    g.__atomsQuota = { windows: new Map(), dayKey: todayKey(now), dayCalls: 0, dayTokens: 0, circuitOpen: false }
  }
  const s = g.__atomsQuota
  if (s.dayKey !== todayKey(now)) {
    s.dayKey = todayKey(now)
    s.dayCalls = 0
    s.dayTokens = 0
    s.circuitOpen = false
  }
  return s
}

export interface RateLimitResult {
  ok: boolean
  /** 被限流时建议的等待秒数 */
  retryAfterSec?: number
  remaining: number
}

export function checkRateLimit(key: string, now = Date.now(), limitOverride?: number): RateLimitResult {
  const s = state(now)
  const limit = limitOverride ?? env.rateLimitPerMinute
  const entry = s.windows.get(key)
  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    s.windows.set(key, { windowStart: now, count: 1 })
    return { ok: true, remaining: limit - 1 }
  }
  entry.count += 1
  if (entry.count > limit) {
    return { ok: false, retryAfterSec: Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000), remaining: 0 }
  }
  return { ok: true, remaining: Math.max(0, limit - entry.count) }
}

/**
 * 生成类请求的限流（F-M11-2）：比普通数据读写**更严格**。
 *
 * 为什么必须分级：一次生成会连带多次模型调用与落库，成本远高于一次记录读写；
 * 共用一个阈值等于"用读接口的宽松度去保护最贵的操作"。
 */
export function checkGenerateRateLimit(key: string, now = Date.now()): RateLimitResult {
  return checkRateLimit(`generate:${key}`, now, env.rateLimitGeneratePerMinute)
}

export interface QuotaDecision {
  /** 是否允许调用真实 provider */
  allowRealProvider: boolean
  /** 是否处于降级（熔断）状态 */
  degraded: boolean
  reason?: string
}

export function canCallProvider(now = Date.now()): QuotaDecision {
  const s = state(now)
  if (s.circuitOpen) {
    return { allowRealProvider: false, degraded: true, reason: '当日模型调用额度已用尽，已自动切换为演示模式' }
  }
  if (s.dayCalls >= env.dailyCallLimit) {
    s.circuitOpen = true
    return { allowRealProvider: false, degraded: true, reason: '当日模型调用额度已用尽，已自动切换为演示模式' }
  }
  return { allowRealProvider: true, degraded: false }
}

export function isCircuitOpen(now = Date.now()): boolean {
  return state(now).circuitOpen
}

/** 每次真实 provider 调用后记录用量（Mock 也应记录，用于展示） */
export function recordCall(tokens: number, countedAgainstDaily = true, now = Date.now()): void {
  const s = state(now)
  if (countedAgainstDaily) {
    s.dayCalls += 1
    s.dayTokens += tokens
  }
  if (s.dayCalls >= env.dailyCallLimit) {
    s.circuitOpen = true
  }
}

export interface QuotaSnapshot {
  dayKey: string
  dayCalls: number
  dayTokens: number
  dailyCallLimit: number
  circuitOpen: boolean
  activeWindows: number
}

export function quotaSnapshot(now = Date.now()): QuotaSnapshot {
  const s = state(now)
  return {
    dayKey: s.dayKey,
    dayCalls: s.dayCalls,
    dayTokens: s.dayTokens,
    dailyCallLimit: env.dailyCallLimit,
    circuitOpen: s.circuitOpen,
    activeWindows: s.windows.size,
  }
}

/** 仅用于测试 */
export function resetQuota(): void {
  g.__atomsQuota = undefined
}
