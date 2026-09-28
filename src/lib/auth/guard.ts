import { cookies } from 'next/headers'
import { getStore, type ProjectRow, type UserRow } from '@/lib/db/store'
import { SESSION_COOKIE, verifySessionToken } from './session'
import { AppError } from '@/lib/errors'

/** 读取当前登录用户；未登录返回 null（不抛错，供页面判断） */
export async function getCurrentUser(): Promise<UserRow | null> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  const userId = verifySessionToken(token)
  if (!userId) return null
  return getStore().findUserById(userId)
}

/** 需要登录的 API 入口使用；未登录抛 401 */
export async function requireUser(): Promise<UserRow> {
  const user = await getCurrentUser()
  if (!user) {
    throw new AppError('UNAUTHORIZED', '请先登录后再继续', '前往登录页完成登录')
  }
  return user
}

/**
 * 归属校验（I-01）。
 * 不属于当前用户时统一返回 NOT_FOUND，避免通过错误码枚举他人资源是否存在。
 * 直接委托给存储层的 requireProjectForOwner，保证"检查"与"抛错"是同一处实现。
 */
export async function requireProject(projectId: string, ownerId: string): Promise<ProjectRow> {
  return getStore().requireProjectForOwner(projectId, ownerId)
}
