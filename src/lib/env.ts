/**
 * 环境变量集中出入口。
 * 约定（见 docs/03-项目流程Spec.md §10）：
 *  - 只有 NEXT_PUBLIC_* 可以出现在客户端
 *  - DEEPSEEK_API_KEY 为最高敏感项，绝不落库、绝不入仓、绝不出现在日志
 */

function str(name: string, fallback = ''): string {
  const v = process.env[name]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback
}

function int(name: string, fallback: number): number {
  const v = Number.parseInt(str(name), 10)
  return Number.isFinite(v) && v > 0 ? v : fallback
}

function bool(name: string, fallback = false): boolean {
  const v = str(name).toLowerCase()
  if (v === '') return fallback
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

export const env = {
  get dataDir(): string {
    return str('ATOMS_DATA_DIR', '.data')
  },
  get dbFile(): string {
    const explicit = str('ATOMS_DB_FILE')
    return explicit !== '' ? explicit : `${str('ATOMS_DATA_DIR', '.data')}/atoms.db`
  },

  get authSecret(): string {
    return str('AUTH_SECRET', 'dev-only-insecure-secret-please-override')
  },

  /** 演示模式：强制使用 Mock provider（无 key 也能完整演示） */
  get demoMode(): boolean {
    return bool('DEMO_MODE', false)
  },

  get deepseekApiKey(): string {
    return str('DEEPSEEK_API_KEY')
  },
  get deepseekBaseUrl(): string {
    return str('DEEPSEEK_BASE_URL', 'https://api.deepseek.com')
  },
  get deepseekModel(): string {
    return str('DEEPSEEK_MODEL', 'deepseek-chat')
  },
  get llmTimeoutMs(): number {
    return int('LLM_TIMEOUT_MS', 60_000)
  },

  /** 单次 Run 的 LLM 调用次数上限（预算熔断） */
  get runCallBudget(): number {
    return int('RUN_CALL_BUDGET', 12)
  },
  /** 全局每日调用上限，超出自动切 Mock */
  get dailyCallLimit(): number {
    return int('DAILY_CALL_LIMIT', 300)
  },
  /** 速率限制：每窗口允许的生成类请求数 */
  get rateLimitPerMinute(): number {
    return int('RATE_LIMIT_PER_MINUTE', 20)
  },
  /** 单次 Run 允许的最大输入长度 */
  get maxInputLength(): number {
    return int('MAX_INPUT_LENGTH', 4000)
  },
  /** 是否允许在 UI 中跳过人工确认（一键演示） */
  get allowAutoConfirm(): boolean {
    return bool('ALLOW_AUTO_CONFIRM', true)
  },
} as const

/** provider 选择结果：真实 provider 只有在「有 key 且非演示模式」时才启用 */
export function resolveProviderKind(): 'mock' | 'deepseek' {
  if (env.demoMode) return 'mock'
  return env.deepseekApiKey !== '' ? 'deepseek' : 'mock'
}
