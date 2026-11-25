# Agy Board (`agy-board`)

[English](README.md) | **简体中文**

面向 **Antigravity** 的多工作区联动看板、焦点与待办插件（原生支持右侧辅助面板 `SIDECAR_UI_ENTRYPOINT_AUX_PANE` 与左侧栏入口 `SIDECAR_UI_ENTRYPOINT_SIDEBAR`），基于 TypeScript、React、`@dnd-kit` 与 Node 22+ 内置 `node:sqlite` 构建。

[![Agy Board 演示预览](https://github.com/Fona1347/agy-board/releases/download/v0.1.0/agy-board-preview.gif)](https://github.com/Fona1347/agy-board/releases/download/v0.1.0/agy-board-promo-45s.mp4)

> 点击上方动图（或直接下载 [`agy-board-promo-45s.mp4`](https://github.com/Fona1347/agy-board/releases/download/v0.1.0/agy-board-promo-45s.mp4)）即可观看完整 45 秒高清宣传演示。

开箱即用：发布包为独立编译产物，**无需在插件目录安装 `node_modules`**；同时完整兼容 `agy-kit` **方案 B 空间隔离规范**（零 DOM 注入、零页脚/快捷键冲突）。

## 快速安装（Antigravity 原生插件）

需要 **Node.js 22.13+**（依赖内置 `node:sqlite`）。

1. 前往 [GitHub Releases](https://github.com/Fona1347/agy-board/releases) 下载 `agy-board-v0.1.0.zip`。
2. 解压到 Antigravity 插件目录 `~/.gemini/config/plugins/agy-board/`（Windows：`%USERPROFILE%\.gemini\config\plugins\agy-board\`）。
3. 在 Antigravity 打开 **Customizations → Plugins** 确认 **Agy Board** 已启用，之后点击左侧 `Plugins` 栏的 **Agy Board** 或在右侧辅助面板点击 `+` 即可打开。

> 想在不影响真实待办的前提下体验所有状态？点击看板右上角 **筛选与设置 → 演示沙箱（Demo Sandbox）** 即可进入纯内存全状态预览。

## 核心功能

- **三视图功能分化与四级语义色盘**：
  - **焦点（Focus）**：每日行动台，聚焦「需要你确认」「在做」「今日聚焦（紧急 / `★` 置顶 / 48 小时内截止 / 今日定时）」与「今日已完成」，支持一键星标、延后（Snooze），非紧急任务安静折叠在底部「待排期与远期池」与「已忽略」寻回箱。
  - **看板（Kanban）**：四层非对称执行看板（需要你确认 / 在做 & 停住了 / 没开始 / 按今日·昨日·近7天·更早分桶的已收尾），支持 `@dnd-kit` 拖放流转、实时并发监控胶囊，以及拖入执行列时的内联派发确认条。
  - **列表（List）**：主从分栏盘点台账，支持四维分组（按工作区 / 按状态 / 按定时 / 按标签）、多维度排序、一键切换 `Ready ↔ Backlog`、`Shift+Click` 多选批量操作栏及方向键快速巡检。
- **双 Tab 详情抽屉（我的视图 / Agent 控制面）**：
  - 将面向人的速览说明、子目标进度、优先级、截止与提醒配置，与面向 Agent 的执行提示词、关联会话、Worktree Diff、写闸门与运行记录彻底分离。
  - 支持 `[跟随 agy | 浅色 | 深色]` 三态主题与中/英文界面切换。
- **AI 暂存草稿闸门（Draft）与跨会话上下文胶囊**：
  - AI 通过 MCP `board_create` 顺手记下的待办自动落入 `todo/draft` 草稿态并保留来源溯源（`originConversationId`、`discoveredFromTaskId`、`originSummary`），须人工审校批准后才会进入 `ready` 允许派发。
  - 关联会话支持结论摘要与 `★ 纳入交接` 权重开关，派发新会话时自动组装提纯后的上下文胶囊，避免无脑续写膨胀的旧对话。
- **零 Cron 定时调度、提醒与多窗口防重（`SidecarOwner`）**：
  - 支持一次性提醒（`reminderAt`）、单次定时（`once`）、带时区与夏令时安全的 5 字段周期定时（`cron`）及验收后倒计时循环（`after_completion`）；支持仅提醒模式（`remind`）、`验收本轮`、设备休眠错峰后的补跑提示横幅（`立即补跑` / `跳过`），以及多窗口单主锁 `SidecarOwner`。
- **多工作区联动、Antigravity 2.35+ 桥接与 Git Worktree 隔离**：
  - 自动发现 Antigravity 多目录工作区（`~/.gemini/config/projects/*.json`），并通过 `window.sidecar.getWorkspaceUris()` / `onWorkspaceChange()` 实时联动当前工作区筛选。
  - 对接 Antigravity 2.35+ `product.v1.ConversationService`（Connect HTTP+JSON，内置 HTTPS TLS 回退与 `agentapi` CLI 兜底），支持拉起新会话、继续空闲会话、同会话返工、跳转与右侧分屏（`Split ↗`）。
  - 可选开启 Git Worktree 隔离（`.worktrees/agy-board-<taskId>`），支持在面板内查看 Diff 与一键清理。
- **15 个 MCP 工具、对话内联 MCP App 卡与双重写闸门钩子**：
  - **15 个 MCP 工具**（`mcp_config.json` → `dist/mcp.mjs`）：`board_list`、`board_get`、`board_card`、`board_workspaces`、`board_create`、`board_update`、`board_transition`、`board_plan_breakdown`、`plan_to_board`、`board_subgoal_update`、`board_comment_add`、`board_ref_add`、`board_dispatch`、`board_schedule`、`next_ready_task`（刻意不暴露 `confirm_permission`，提权必须由人工在 UI 确认）。
  - **对话内联 MCP App 卡片**：`ui://agy-board/card.html`（`text/html;profile=mcp-app`），自动关联于 `board_list` / `board_get` / `board_card`。
  - **生命周期钩子**（`hooks.json` → `dist/hook.mjs`）：`SessionStart` 上下文注入、`PreToolUse` 双重写闸门与 `ask_question` 暂停、`PostToolUse` 交付物自动登记与恢复、`Stop` 执行摘要结算。
  - **脱敏与数据防护**：`FreezeSnapshot` 自动拦截并脱敏密钥（`sk-`、`Bearer`、`ghp_`、`AIza`、`AKIA`、PEM 私钥等），并阻止任何脚本直接篡改 `board.db*`、`taskspace/*.md` 与只读引用文件。
- **纯内存演示沙箱（Demo Sandbox）**：
  - 内置覆盖全状态的示例数据，不发后端请求、不写数据库，支持随时重置与退出恢复真实看板。

## 架构概览

- **纯领域层（`src/core/`）**：零外部依赖的 TypeScript 核心逻辑（`types`、`freeze`、`handover`、`subgoals`、`schedule`、`session-reuse`、`workspace`）。
- **宿主引擎层（`src/host/`）**：
  - `db.ts`：`node:sqlite` WAL 数据库与版本迁移、并发派发锁 `dispatch.lock.<executionId>` 与异常孤儿恢复。
  - `board-service.ts`：Sidecar/HTTP、MCP、Hooks 与 CLI 共享的统一状态机、TaskSpace 投影、写闸门、派发与调度引擎。
  - `workspaces.ts` / `agent-bridge.ts`：Antigravity 项目与历史会话发现、`product.v1.ConversationService` 桥接与回环 CDP 跳转。
  - `worktree.ts` / `scheduler.ts` / `refs-guard.ts` / `launch-admission.ts`：Git Worktree 隔离、单主定时调度、白名单文件预览与公平并发队列。
- **入口层（`src/entry/`，构建输出至 `dist/*` 与 `sidecars/board/`）**：
  - `sidecar.ts` / `router.ts` / `server-core.ts`：双模式 `SidecarApp`（通过 `app.page('/')` 下发单文件内联前端包，并覆盖异步 `/_sidecar/*` 路由）与独立回环 HTTP+SSE 服务。
  - `mcp.ts`、`hook.ts`、`cli.ts`：面向 Node 22+ 的独立单文件运行时产物。

## 仓库目录结构

```text
agy-board/
├── plugin.json                 # Antigravity 原生插件清单
├── mcp_config.json             # MCP stdio 服务配置 (${PLUGIN_ROOT}/dist/mcp.mjs)
├── hooks.json                  # Antigravity 生命周期钩子配置 (dist/hook.mjs)
├── agy-kit.compat.json         # agy-kit 方案 B 隔离与 runtime_entries 清单
├── assets/logo.svg             # 插件图标
├── rules/AGENTS.md             # 面向 Agent 的看板操作规则
├── skills/agy-board/SKILL.md   # Agent 技能说明
├── sidecars/board/
│   ├── sidecar.json            # 辅助面板与侧栏入口配置
│   ├── server.mjs              # 编译后的 Sidecar 与独立服务端
│   └── public/index.html       # 单文件内联 React + @dnd-kit 前端产物
├── dist/
│   ├── mcp.mjs                 # 编译后的 MCP 服务（15 工具 + MCP App 卡片）
│   ├── hook.mjs                # 编译后的钩子入口
│   └── cli.mjs                 # 编译后的 CLI（serve/doctor/workspaces/list/create/dispatch）
├── src/                        # TypeScript 前后端源码
└── tests/                      # Vitest 全链路单元测试与集成测试
```

## CLI 用法

所有子命令均支持 `--db <path>`（覆盖 SQLite 路径，默认依次读取 `AGY_BOARD_DB_PATH`、`<AGY_BOARD_DATA_DIR>/board.db`、`<antigravityDataDir>/agy-board/board.db`）和 `-h` / `--help`；查询与操作子命令均支持 `--json` 输出。

```bash
node dist/cli.mjs serve [--port 17910] [--db <path>]
node dist/cli.mjs doctor [--db <path>] [--json]
node dist/cli.mjs workspaces [--db <path>] [--json]
node dist/cli.mjs list [--phase needs_you|active|on_hold|todo|closed] [--workspace <str>] [--include-archived|--archived|--all] [--db <path>] [--json]
node dist/cli.mjs create [--title "..."] [title...] [--description "..."] [--prompt "..."] [--workspace <path>] [--workspace-id <id>] [--priority urgent|high|normal|low] [--next-action "..."] [--mode <str>] [--model <str>] [--due <iso|ms>] [--reminder <iso|ms>] [--use-worktree] [--db <path>] [--json]
node dist/cli.mjs dispatch <taskId> [--task <id>] [--mode auto|new|resume|rework] [--rework "..."] [--subgoal <id>] [--model <str>] [--profile <str>] [--use-worktree] [--dry-run] [--db <path>] [--json]
```

可选环境变量：`AGY_BOARD_PORT`（默认 `17910`）、`AGY_BOARD_DB_PATH`、`AGY_BOARD_DATA_DIR`、`AGY_BOARD_GEMINI_CONFIG_DIR`、`AGY_BOARD_ANTIGRAVITY_DATA_DIR`、`AGY_BOARD_CDP_PORT`。

## 本地开发与独立预览

需要 **Node.js 22.13+**（已在 Node 24 原生 `node:sqlite` 下测试通过）。

```bash
npm install
npm run build   # 类型检查 (tsc --noEmit) + 构建单文件前端 + 打包服务端运行时
npm test        # 运行全量 Vitest 测试套件
npm run check   # 构建 + 全量测试
```

不部署插件直接浏览器预览：

```bash
node dist/cli.mjs serve --port 17910 --db ./.data/dev-board.db
```

启动后浏览器访问 `http://127.0.0.1:17910` 即可。

## 接入 `agy-kit`（可选）

本仓库默认**不执行任何全局部署**，开发构建不会改动 `~/.gemini/config/` 或外部 `agy-kit` 目录。如需在 `agy-kit` 中锁定版本集成：

1. 先执行 `npm run build && npm test` 确保产物与测试通过。
2. 仅拷贝或锁定 `agy-kit.compat.json` 中 `runtime_entries` 列出的 8 项独立运行产物（无需 `node_modules`）：
   - `assets`、`dist`、`hooks.json`、`mcp_config.json`、`plugin.json`、`rules`、`sidecars`、`skills`
3. 按 `plugin.json`、`mcp_config.json`、`hooks.json` 与 `sidecars/board/sidecar.json` 注册，保持方案 B 空间隔离不变量。

## 开源协议

[MIT](LICENSE)
