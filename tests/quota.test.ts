/**
 * QuotaGuard 测试（M11：限流 / 单 Run 预算 / 每日熔断）。
 *
 * 为什么必须有：这是"公网 + 服务端自备 key"场景下防止额度被陌生人烧光的唯一防线，
 * 而此前该模块**没有任何测试**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  canCallProvider,
  checkRateLimit,
  isCircuitOpen,
  quotaSnapshot,
  recordCall,
  resetQuota,
} from '@/lib/quota/guard'
import { env } from '@/lib/env'

const MINUTE = 60_000
const DAY = 24 * 60 * 60 * 1000

test('限流：同一 key 超过每分钟上限后被拒，并给出等待秒数', () => {
  resetQuota()
  const now = Date.now()
  const limit = env.rateLimitPerMinute

  for (let i = 0; i < limit; i += 1) {
    const r = checkRateLimit('ip:1.2.3.4', now)
    assert.equal(r.ok, true, `第 ${i + 1} 次不应被限流`)
  }

  const blocked = checkRateLimit('ip:1.2.3.4', now)
  assert.equal(blocked.ok, false, '超出上限后应被限流')
  assert.ok((blocked.retryAfterSec ?? 0) > 0, '应给出建议等待秒数')
  assert.equal(blocked.remaining, 0)
})

test('限流：不同 key 互不影响（不会误伤其他访问者）', () => {
  resetQuota()
  const now = Date.now()
  const limit = env.rateLimitPerMinute

  for (let i = 0; i < limit; i += 1) checkRateLimit('ip:a', now)
  assert.equal(checkRateLimit('ip:a', now).ok, false, 'a 应被限流')
  assert.equal(checkRateLimit('ip:b', now).ok, true, 'b 不应被 a 拖累')
})

test('限流：滑出时间窗口后恢复', () => {
  resetQuota()
  const now = Date.now()
  const limit = env.rateLimitPerMinute
  for (let i = 0; i <= limit; i += 1) checkRateLimit('ip:c', now)
  assert.equal(checkRateLimit('ip:c', now).ok, false)

  const later = now + MINUTE + 1
  assert.equal(checkRateLimit('ip:c', later).ok, true, '窗口过后应恢复')
})

test('每日熔断：达到每日上限后拒绝真实 provider，并给出降级原因', () => {
  resetQuota()
  const now = Date.now()
  assert.equal(canCallProvider(now).allowRealProvider, true, '初始应允许真实 provider')

  for (let i = 0; i < env.dailyCallLimit; i += 1) {
    recordCall(100, true, now)
  }

  const decision = canCallProvider(now)
  assert.equal(decision.allowRealProvider, false, '达到上限后不应再调用真实 provider')
  assert.equal(decision.degraded, true, '应标记为降级')
  assert.match(decision.reason ?? '', /额度已用尽|演示模式/, '应给出可读原因')
  assert.equal(isCircuitOpen(now), true, '熔断应置位')
  assert.equal(quotaSnapshot(now).circuitOpen, true)
})

test('每日熔断：跨天后自动恢复（不会永久锁死）', () => {
  resetQuota()
  const now = Date.now()
  for (let i = 0; i < env.dailyCallLimit; i += 1) recordCall(100, true, now)
  assert.equal(isCircuitOpen(now), true)

  const tomorrow = now + DAY
  assert.equal(isCircuitOpen(tomorrow), false, '新的一天应重置计数与熔断')
  assert.equal(canCallProvider(tomorrow).allowRealProvider, true)
  assert.equal(quotaSnapshot(tomorrow).dayCalls, 0)
})

test('配额快照：真实反映当日调用与 token 累计', () => {
  resetQuota()
  const now = Date.now()
  recordCall(120, true, now)
  recordCall(80, true, now)
  // 不计入每日额度的调用（例如 Mock provider）不应污染统计
  recordCall(999, false, now)

  const snapshot = quotaSnapshot(now)
  assert.equal(snapshot.dayCalls, 2, '只统计计入额度的调用')
  assert.equal(snapshot.dayTokens, 200, 'token 应累加')
  assert.equal(snapshot.dailyCallLimit, env.dailyCallLimit)
})

test('resetQuota：测试辅助函数可彻底清空状态', () => {
  resetQuota()
  const now = Date.now()
  for (let i = 0; i < env.dailyCallLimit; i += 1) recordCall(1, true, now)
  assert.equal(isCircuitOpen(now), true)

  resetQuota()
  assert.equal(isCircuitOpen(now), false, '重置后应开闸')
  assert.equal(quotaSnapshot(now).dayCalls, 0)
})
