/**
 * 真实 provider 连通性与结构化输出验证（对应 docs/04 M0 的 T-M0-4）。
 *
 * 这不是"锦上添花"，而是 M0 的 Gate：
 * 整套编排建立在「智能体产出结构化 JSON」之上，如果 provider 的结构化输出不稳定，
 * 架构假设会当场落空。因此拿到 Key 之后**第一件事**就是跑这个脚本。
 *
 * 用法：
 *   DEEPSEEK_API_KEY=sk-xxx node scripts/provider-smoke.mjs
 *
 * 也支持直接从 `.env.local` 读取（Next.js 会自动读它，但这个脚本是纯 node，
 * 不自动读 —— 不补这一步的话，用户填好 .env.local 再跑会误以为"Key 没配"）。
 */
try {
  process.loadEnvFile('.env.local')
} catch {
  /* 没有 .env.local 就按环境变量来 */
}

const key = process.env.DEEPSEEK_API_KEY ?? ''
const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'

if (!key) {
  console.log('⚠️  未配置 DEEPSEEK_API_KEY')
  console.log('   → 应用当前会自动运行在「确定性 Mock provider」模式，功能完整、结果可复现。')
  console.log('   → 如需验证真实模型，请配置 Key 后重新运行本脚本。')
  process.exit(0)
}

console.log(`provider 验证开始：baseUrl=${baseUrl} model=${model} key=${key.slice(0, 4)}***${key.slice(-4)}`)

const CASES = [
  {
    name: '结构化的需求契约（contract）',
    system: '你是一个严谨的产品工程智能体，只输出符合要求的 JSON。',
    user: `【期望输出格式】输出 JSON：{"mustDo":[{"id":string,"text":string,"check":{"kind":"component","type":"form|table|filter"}}],"mustNot":[{"id":string,"text":string,"check":{"kind":"maxModels","max":number}}],"acceptance":[string]}
【用户需求】做一个个人待办清单：能新增任务、标记完成、按状态筛选、删除。
只输出 JSON，不要输出任何解释文字或 Markdown 代码块。`,
    validate: (v) => Array.isArray(v?.mustDo) && Array.isArray(v?.mustNot) && Array.isArray(v?.acceptance),
  },
  {
    name: '结构化的数据模型（dataModel）',
    system: '你是一个严谨的产品工程智能体，只输出符合要求的 JSON。',
    user: `【期望输出格式】输出 JSON：{"models":[{"name":string,"label":string,"fields":[{"name":string,"label":string,"type":"string|text|number|boolean|date|select","options":[string]}]}]}
【用户需求】做一个销售记录工具：录入每日销售额与产品，用图表展示汇总趋势。
只输出 JSON，不要输出任何解释文字或 Markdown 代码块。`,
    validate: (v) => Array.isArray(v?.models) && v.models.length > 0 && Array.isArray(v.models[0]?.fields),
  },
  {
    name: 'AI 端到端链路（极简版）',
    system: '你是一个严谨的产品工程智能体，只输出符合要求的 JSON。',
    user: `【期望输出格式】输出 JSON：{"text":string}
【用户需求】用一句话说明你会如何为"活动报名与审批系统"设计数据模型。
只输出 JSON，不要输出任何解释文字或 Markdown 代码块。`,
    validate: (v) => typeof v?.text === 'string' && v.text.length > 0,
  },
]

let passed = 0
for (const c of CASES) {
  const startedAt = Date.now()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60000)
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: c.system },
          { role: 'user', content: c.user },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        stream: false,
      }),
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (!res.ok) {
      console.log(`  ✗ ${c.name} — HTTP ${res.status} ${(await res.text()).slice(0, 160)}`)
      continue
    }
    const json = await res.json()
    const content = json?.choices?.[0]?.message?.content ?? ''
    let parsed = null
    try {
      parsed = JSON.parse(content)
    } catch {
      console.log(`  ✗ ${c.name} — 返回内容不是合法 JSON：${content.slice(0, 160)}`)
      continue
    }
    const ok = c.validate(parsed)
    const usage = json?.usage?.total_tokens ?? 0
    console.log(`  ${ok ? '✓' : '✗'} ${c.name} — ${Date.now() - startedAt}ms · ${usage} tokens${ok ? '' : '（结构不符合预期）'}`)
    if (ok) passed += 1
  } catch (err) {
    console.log(`  ✗ ${c.name} — ${err instanceof Error ? err.message : String(err)}`)
  }
}

console.log(`\n结果：${passed}/${CASES.length} 项通过`)
if (passed === CASES.length) {
  console.log('✅ 结构化输出稳定，可以安全地把 provider 切到真实模型。')
  process.exit(0)
}
console.log('⚠️  结构化输出不稳定。建议：')
console.log('   1) 保持 Mock provider 作为默认（应用会自动这样做）')
console.log('   2) 若使用真实模型，请确认产物仍通过 Spec 校验与契约核对（校验不通过会如实上报，不会谎报成功）')
process.exit(1)
