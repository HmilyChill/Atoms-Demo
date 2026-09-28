# Atoms Demo

> 一个**智能体驱动**的应用生成平台原型：用一句自然语言需求，由多个智能体依次完成
> **需求契约 → 页面架构 → 数据模型 → App Spec → 质量校验**，
> 并把结果渲染成一个**可交互、数据真实持久化、可继续迭代**的网页应用，实时预览、可导出。

本项目是 ROOT「AI Native 研发岗位」笔试挑战的交付物。设计文档见 `docs/`。

---

## 1. 它解决什么问题（也是它与 Atoms/MGX 的差异）

公开评测显示，同类产品最常见的三类问题（见 `docs/00-问题解析.md` §5）：

| 同类产品常见问题 | 本项目的做法 |
|---|---|
| 预览报错却宣称"已完成" | **M8 质量校验与自愈**：结构校验 + 渲染冒烟 + 契约逐条机检，未通过项**如实上报**，修复上限 2 轮 |
| 输入明确需求却被擅自改动 | **需求契约**：生成前锁定「必做 / 禁做 / 验收点」，且每条都带**可机检断言**，生成后逐条核对 |
| 生成物是 mock，数据不落库 | 生成应用的数据写入**同一持久层**（`app_records`），刷新/换设备仍在 |

核心设计：**结构化 App Spec + 确定性渲染器**。智能体不自由编写整个工程，而是产出结构化规格，
由同一个渲染运行时确定性地渲染成真应用。这样换来三件事：**稳定、可校验、可增量修改**。
并额外提供「导出为自包含单文件 HTML」，满足"真的把代码带走"的诉求。

---

## 2. 快速开始

### 2.1 环境要求

- Node.js **>= 24**（使用内置 `node:sqlite`，**零原生依赖**，无需编译）
- pnpm（推荐）或 npm

### 2.2 本地运行（无需任何 API Key）

```bash
pnpm install
pnpm dev
# 打开 http://localhost:3000
```

默认使用**确定性 Mock provider**：不需要任何密钥即可完整跑通全流程，产出可复现。
首页点「一键体验（自动创建演示账号）」即可直接开始。

### 2.3 使用真实模型（可选，DeepSeek）

复制 `.env.example` 为 `.env.local` 并填入：

```bash
DEEPSEEK_API_KEY=sk-xxxxxxxx
# 以下可选
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
```

> ⚠️ `.env.local` 已在 `.gitignore` 中，**绝不要提交**。生产环境请把 Key 配到平台的
> 环境变量里（Vercel: Project → Settings → Environment Variables，Preview 与 Production 都要配）。

### 2.4 常用命令

```bash
pnpm dev          # 开发服务器
pnpm build        # 生产构建
pnpm start        # 启动生产服务
pnpm typecheck    # TypeScript 类型检查（tsc --noEmit）
pnpm test         # 单元测试（管线 / 契约 / 校验自愈 / 归属隔离 / 渲染运行时 / 导出包 / 工作台 UI / Turso 协议）
pnpm smoke        # 端到端冒烟测试（需先启动服务，见下）
pnpm smoke:provider   # 真实模型连通性与结构化输出验证（需 DEEPSEEK_API_KEY）
pnpm push:github      # 用 GitHub API 推送仓库（保留完整提交历史与 tag；先跑 --dry-run）
pnpm deploy:check <部署地址>   # 对已部署地址跑 21 项部署自检
```

> **受限沙箱下的说明**：若你的执行环境禁止 `child_process` 的管道 stdio（表现为 `spawn EPERM`），
> `pnpm dev` 会启动失败——因为 Next 开发 CLI 会 `fork()` 子进程启动服务器。
> 此时请改用 `pnpm build && pnpm start` 进行本地验证（已在本项目验证可用）。
> 这是环境限制，正常机器与 Vercel 上 `pnpm dev` 不受影响。
> 同理，`pnpm test` 已固定使用 `--test-isolation=none` 以避免派生测试子进程。

端到端冒烟测试（覆盖 70 项断言：生成、契约、预览、数据持久化、迭代、回滚、导出、越权）：

```bash
pnpm build && pnpm start            # 另开一个终端
BASE_URL=http://localhost:3000 node scripts/e2e-smoke.mjs
```

---

## 3. 五分钟走查路径（推荐给评审）

1. 打开首页 → 点 **一键体验**（无需注册流程）
2. 点示例卡片 **「个人待办清单」** → 自动创建项目并开始生成
3. 观察左栏 **智能体时间线**：Mike（计划）→ 契约 Gate → Emma（页面）→ Bob（数据模型）→ Alex（App Spec）→ QA（校验）
4. 在 **需求契约** 标签页看到「必做 / 禁做 / 验收点」→ 点 **确认** 继续
5. 右栏**实时预览**里直接新增一条任务、切换完成状态
6. **刷新页面** → 项目、会话、产物、以及你刚录入的数据都还在（真实持久化）
7. 左栏输入「给这个应用增加一个优先级字段」→ 提交 → 产生 **v2**，且只有目标片段被改动
8. **版本与迭代** 标签页 → 回滚到 v1 → 数据不丢
9. 点右上角 **导出单文件应用** → 下载一个 HTML，双击即可离线运行

---

## 4. 项目结构

```
src/
  app/
    page.tsx                 落地页 / 项目列表（含一键体验与示例）
    login, register/         最小可用身份
    projects/[id]/           工作台（三栏：会话与时间线 / 产物 / 预览）
    preview/[id]/            沙箱预览页（iframe 加载，令牌鉴权）
    api/                     全部 HTTP 接口（见 docs/03 §5）
  components/workbench.tsx   工作台主界面（客户端）
  lib/
    db/                      存储适配器（node:sqlite）+ 数据模型
    llm/                     LLM 适配器：Mock（确定性）/ DeepSeek + 角色与提示词
    spec/                    App Spec 类型、校验器、需求契约（含可机检断言）
    agents/                  编排状态机、5 类角色、质量校验与自愈
    events/                  事件协议（SSE 的数据源）
    quota/                   限流、单 Run 预算、每日熔断
    auth/                    口令哈希、会话签名、预览令牌
public/app-runtime.js        生成物渲染运行时（零依赖原生 JS，导出包复用同一份）
tests/                       单元与隔离测试
scripts/e2e-smoke.mjs        端到端冒烟测试
docs/                        问题解析、任务分解、流程 Spec、模块细则、执行记录
```

---

## 5. 关键设计取舍

| 取舍 | 选择了 | 为什么 | 代价 |
|---|---|---|---|
| 生成方式 | **结构化 Spec + 确定性渲染** | 稳定、可校验、可增量改；避免"白屏即失败" | 表达力有边界（组件白名单） |
| 渲染运行时 | **原生 JS，不用 React** | 可被沙箱 iframe 与导出包**共用同一份**，无构建步骤 | 手写 DOM |
| 长任务 | **前端驱动的短步骤**（每请求一步） | 规避 Serverless 函数超时，任何平台都能跑，进度天然可见 | 多几次往返 |
| 预览鉴权 | **短期预览令牌**，而非 Cookie | 沙箱 iframe 不授予同源权限 → 跨源不带 Cookie；令牌兼顾严格沙箱与可用性 | 令牌 30 分钟过期 |
| 质量校验 | **确定性机检**，而非再问一次模型 | 可断言、可回归、不会幻觉；"未校验"绝不计为通过 | 只能校验可结构化表达的要求 |
| 自愈修复 | **最小改动的确定性修复** | 避免 LLM 二次引入不确定性 | 复杂缺陷只能如实上报 |
| 导出 | **自包含单文件 HTML** | 双击即可离线运行，无需构建 | 未做多文件 ZIP 工程（列为后续） |

---

## 6. 已知限制（如实声明）

- **未做**：多文件 ZIP 工程导出、预览中"选中元素直接改"、模板市场、多模型切换、附件上传、分享链接手动吊销。
- **校验范围**：契约机检覆盖可结构化表达的要求（组件存在性、动作能力、字段类型、集合数量上限等）；
  语义类要求（如"交互要顺手"）无法机检，会在报告中列为**未校验**，不会计为通过。
- **限流状态**：限流与每日熔断计数是**进程内**状态，多实例部署时需换成共享存储（Redis 等）。
- **渲染冒烟**：目前是**结构性**渲染检查（字段绑定、图表轴、筛选字段、组件白名单等），
  未在真实浏览器中逐页断言（浏览器级 E2E 见 `docs/05-执行记录.md` 的说明）。
- **真实模型**：DeepSeek provider 已实现并通过单元级校验，但**未用真实 Key 跑过端到端**
  （交付时未提供 Key），首次接入请先运行 `pnpm smoke:provider`。

---

## 7. 部署

目标平台：**Vercel**（Git 直连）。

1. 把本仓库推到 GitHub（public）
   - 正常环境：`git remote add origin <url> && git push -u origin main --tags`
   - 若 `git` 走 HTTPS 不可用（部分受限环境会报 `schannel: SEC_E_NO_CREDENTIALS`）：
     用本仓库自带的 API 推送脚本，**完整保留提交历史与 tag**
     ```bash
     pnpm push:github --dry-run          # 先本地演练，不联网
     GITHUB_TOKEN=ghp_xxx pnpm push:github
     ```
2. Vercel → New Project → 选择该仓库 → 框架会自动识别 Next.js
3. 配置环境变量（**Preview 与 Production 都要配**）：
   - `AUTH_SECRET`（必填，任意长随机串；不配会退回开发默认值）
   - `DEEPSEEK_API_KEY`（可选；不配则自动运行在演示模式）
   - `DAILY_CALL_LIMIT`、`RUN_CALL_BUDGET`、`RATE_LIMIT_PER_MINUTE`（可选，配额保护）
4. 部署后访问首页自检：`/api/auth/me` 应返回 `provider.demoMode` 状态

> **✅ 线上持久化（已支持）**：Vercel 的文件系统是**只读**的，因此线上不能用本地 SQLite 文件。
> 本项目已内置 **Turso（SQL over HTTP）执行器**——只要配置下面两个环境变量，
> 存储层会**自动**从本地 SQLite 切换到远程库，**无需修改任何代码**：
>
> ```bash
> TURSO_DATABASE_URL=https://<db>-<org>.turso.io   # 或 libsql:// / turso://（会自动转 https）
> TURSO_AUTH_TOKEN=<token>
> ```
>
> 存储层的实现方式：`SqlExecutor` 抽象出"如何连数据库"，`SqlStore` 只写一次 SQL；
> 本地用 Node 内置 `node:sqlite`（零原生依赖），线上用 Turso 纯 `fetch`（零新依赖）。
> 协议实现有 9 项测试覆盖（含一个本地 Turso 协议模拟服务做端到端验证）。
>
> **另一条路径**：若不想引入托管库，也可部署到带持久卷的容器平台（Railway / Fly / VPS / Oracle Always Free），
> 那样**零配置**即可继续用 SQLite 文件。

---

## 8. 安全说明

- 密码使用 `scrypt` 加盐哈希，明文不落库、不进日志
- 登录失败**不区分**"用户不存在/密码错误"，避免账号枚举
- 所有资源访问强制归属校验（`requireProjectForOwner`），越权统一返回 404 不泄露存在性
- 预览沙箱 `sandbox="allow-scripts"`，**不授予同源权限**；数据访问使用 30 分钟短期令牌
- 只读分享令牌在数据接口处被强制拒绝写入
- API Key 只存在服务端环境变量，任何客户端响应与日志中都不出现
- 公网部署时自带限流 / 单 Run 预算 / 每日熔断，避免自备额度被滥用
