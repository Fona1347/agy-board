<div align="center">

<img src="assets/logo.svg" alt="Agy Board Logo" width="72" height="72" />

# Agy Board

**嵌在 Antigravity 侧边栏的多工作区 AI 任务看板、草稿审校闸门与跨会话交接台**

[![Release](https://img.shields.io/badge/release-v0.1.0-B45309?style=flat-square)](https://github.com/Fona1347/agy-board/releases/latest)
[![Node](https://img.shields.io/badge/node-22.13%2B-339933?style=flat-square)](#快速安装)
[![Antigravity](https://img.shields.io/badge/Antigravity-2.34%2B%20(2.35%2B%20原生桥接)-2563EB?style=flat-square)](#快速安装)
[![License](https://img.shields.io/badge/license-MIT-555555?style=flat-square)](LICENSE)

[English](README.md) | **简体中文**

[核心工作流](#为什么用-agy-board) · [快速安装](#快速安装) · [三视图与能力](#三视图与核心能力) · [MCP 与防护](#mcp-工具生命周期钩子与安全防护) · [CLI 与开发](#cli独立预览与本地开发) · [致谢](#致谢与灵感来源)

</div>

<p align="center">
  <a href="https://github.com/Fona1347/agy-board/releases/download/v0.1.0/antigravity-board-promo-60s.mp4">
    <img src="https://github.com/Fona1347/agy-board/releases/download/v0.1.0/antigravity-board-preview.gif" alt="Antigravity Board 演示预览" />
  </a>
</p>

<p align="center">
  <sub>点击上方动图（或下载 <a href="https://github.com/Fona1347/agy-board/releases/download/v0.1.0/antigravity-board-promo-60s.mp4"><code>antigravity-board-promo-60s.mp4</code></a>）观看 60 秒高清解说宣传演示。插件内置中/英文与浅色/深色主题一键切换。</sub>
</p>

---

## 为什么用 Agy Board？

当你在多个工程之间跨天、跨周驱动 AI Agent 并行干活时，普通待办清单很快会失效：

- **AI 随手记的待办和自己拍板的混在一起**——排查问题时顺手记下的跟进项，容易在未经审校的情况下被遗忘或误执行。
- **盲目续写臃肿旧会话导致上下文腐烂**——隔几天继续做一件事，硬续老聊天框会拖进大量无关试错，而不是提炼后的关键结论。
- **定时巡检既难配又容易翻车**——手写 Cron 门槛高，电脑休眠后要么静默丢单，要么在上一轮还没验收时直接覆盖现场。

Agy Board 直接住在 Antigravity 侧边栏里，跑通一套 **4 步人机闭环**：

1. **AI 暂存草稿** — 对话中途发现衍生任务时，Agent 通过 `board_create` 把任务暂存进 `todo/draft` 草稿箱，自动记录来源会话、衍生血缘（`discoveredFromTaskId`）、拆解子目标与关键文件引用；草稿态无法自动派发。
2. **人类审校放行** — 在双 Tab 详情页里检查或微调目标、子目标与权限，确认后一键 **审校通过 → Ready**（涉及提权的操作强制只能由人在 UI 点击确认）。
3. **带提纯胶囊开干净新会话** — 派发时默认拉起干净新对话，自动注入你标星（`★ 纳入交接`）的历史会话结论、Freeze 交接快照与关键文件，可选在独立 Git Worktree 中隔离执行。
4. **自动回弹验收** — 生命周期钩子监听到任务结束或触发 `ask_question` 提问时，自动把卡片弹回 **待处理 / 需要你确认**，由你一键 **验收通过**、**验收本轮**（周期任务）或发送 **同会话返工**。

---

## 快速安装

前置要求：**Node.js 22.13+**（依赖内置 `node:sqlite`）。发布包自带全部编译产物，插件目录**无需安装 `node_modules`**。

1. 前往 [GitHub Releases](https://github.com/Fona1347/agy-board/releases/latest) 下载最新的 `agy-board-v*.zip`。
2. 解压至 `~/.gemini/config/plugins/agy-board/`（Windows：`%USERPROFILE%\.gemini\config\plugins\agy-board\`）。
3. 在 Antigravity 打开 **Customizations → Plugins** 确认 **Agy Board** 已启用，之后点击左侧 `Plugins` 栏或右侧辅助面板顶部的 `+` 即可打开。两个入口共享同一套看板并记住你上次停留在哪个视图（首次默认 **焦点**）。

> **零风险试用**：点开看板右上角 **筛选与设置 → 演示沙箱模式（Demo Sandbox）**，即可在纯内存里体验全部状态与交互，不读写你的真实数据库。

<details>
<summary>装好后可以直接对 Agent 说什么？</summary>

插件已内置工作区协作规则（`rules/AGENTS.md`）与技能说明（`skills/agy-board/SKILL.md`），装完即可直接对话调用：

- 「帮我看下 Agy Board 上各个工作区正在跑和待处理的任务」
- 「把刚才查出来的几个遗留问题先作为草稿记到 Agy Board，补上子目标和相关文件」
- 「把这个需求的必达验收项拆进 Agy Board，并写一份 Freeze 交接快照方便下次接着做」

</details>

---

## 三视图与核心能力

### 三个视图，各自只干一件事

| 视图 | 回答什么问题 | 展示范围 | 高频专属操作 |
| :--- | :--- | :--- | :--- |
| **焦点（Focus）** | 此刻和今天该盯什么？ | `待处理`、`在做 & 停住了`、`今日聚焦`（紧急、`★` 置顶、48 小时内截止、今日提醒或定时）与 `今日已完成`；其余任务安静折叠在底部 `待排期与远期池` 与 `已忽略`。 | 左侧 DDL / 定时时间轴、`★` 置顶、一键延后（`+2h` / 今晚 / 明早 / 下周一）、已忽略寻回。 |
| **看板（Kanban）** | AI 正在跑哪些、谁卡住了？ | 四层看板：`需要你确认`、`在做` & `停住了`（系统托管）、`待启动 Ready`、`近 7 天已收尾`（更早历史一键跳转列表；Backlog 与远期定时不打扰看板）。 | 拖入「在做」弹出内联派发确认条、实时并发计数 `并发 N/3`、运行计时器与 Git Worktree 标记。 |
| **列表（List）** | 全盘存量、草稿和定时怎么批量盘点？ | 100% 全量任务（含 `AI 草稿`、`想法池 Backlog`、全部历史与可选 `显示归档`），宽屏主从分栏、窄屏自动钻取。 | 四维分组（按工作区 / 按状态 / 按定时 / 按标签）、多维排序、一键草稿转 Ready 或 `Ready ↔ Backlog` 切换、`Shift+Click` 多选批量操作栏、`↑/↓` 键盘巡检。 |

### 核心能力一览

| 模块 | 关键特性 |
| :--- | :--- |
| **双 Tab 详情抽屉** | 将 **我的视图**（人看的速览说明、子目标进度、优先级、截止与提醒）与 **Agent 控制面**（执行提示词、关联会话、Worktree Diff、写闸门与运行记录）彻底分开；支持 `[跟随 agy \| 浅色 \| 深色]` 主题与中/英文实时切换。 |
| **AI 草稿闸门与交接胶囊** | MCP 新建任务默认落入 `todo/draft` 并记录血缘溯源（未转正的 `/btw` 临时支线自动回溯父会话，防止跳转死链）；给重要会话点亮 `★ 纳入交接`，新开干净会话时自动打包提纯结论。 |
| **零 Cron 定时调度** | 可视化配置一次性提醒、单次定时（`once`）、带时区/夏令时安全的周期定时（`cron`）和验收后倒计时循环（`after_completion`）；支持仅提醒模式（`remind`）、`验收本轮`、设备休眠错峰后的补跑横幅（`立即补跑` / `跳过本次`）与多窗口单主锁 `SidecarOwner`。 |
| **多工作区、2.34+/2.35+ 桥接与 Worktree** | 自动发现 `~/.gemini/config/projects/*.json` 多目录工作区并实时同步当前工作区筛选；兼容 Antigravity **2.34+**（`agentapi` 回退）并在 **2.35+** 自动启用原生 `product.v1.ConversationService`；支持可选 Git Worktree 隔离（`.worktrees/agy-board-<taskId>`）与面板内查看 Diff 和清理。 |

---

## MCP 工具、生命周期钩子与安全防护

Agy Board 内置 **15 个 stdio MCP 工具**、对话内联 **MCP App 任务卡**（`ui://agy-board/card.html`）以及 **4 段生命周期钩子**，在运行时落地人工审校与数据安全边界。

<details>
<summary>15 个 MCP 工具与内联 MCP App 卡片</summary>

| 分组 | 工具名 | 说明 |
| :--- | :--- | :--- |
| **查询与内联卡** | `board_list`、`board_get`、`board_card`、`board_workspaces`、`next_ready_task` | `board_list`、`board_get`、`board_card` 关联 `ui://agy-board/card.html`，可在对话内直接渲染任务卡片。 |
| **暂存与更新** | `board_create`、`board_update`、`board_transition`、`board_comment_add`、`board_ref_add` | `board_create` 默认进入 `todo/draft` 草稿态；刻意不暴露 `confirm_permission`，提权与草稿放行均由人工确认。 |
| **拆解与调度** | `board_plan_breakdown`、`plan_to_board`、`board_subgoal_update`、`board_dispatch`、`board_schedule` | 支持必达/可选子目标、依赖环路校验、Worktree 隔离派发与定时调度配置。 |

</details>

<details>
<summary>生命周期钩子、双重写闸门与脱敏防护</summary>

| 机制 | 行为说明 |
| :--- | :--- |
| **生命周期钩子（`hooks.json` → `dist/hook.mjs`）** | `SessionStart` 注入任务上下文；`PreToolUse` 执行双重写闸门并在 `ask_question` 时暂停任务；`PostToolUse` 自动登记产出文件并在提问后恢复；`Stop` 提取总结并结算运行记录。若看板尚未初始化则直接返回 `{"decision":"allow"}`，不会凭空建库。 |
| **双重写闸门（Dual Write Gate）** | 在 Antigravity `PreToolUse` 钩子与 MCP 工具层双重生效。任务处于 `locked` 时拦截文件/命令改动及危险状态流转；即便处于 `unlocked`，也会拦截通过 Agent 工具或命令直接篡改 `board.db*`、`taskspace/` 目录及关联任务只读 `handover.references` 的操作（对 `on_hold`/`closed` 关联任务会弹出确认）。 |
| **Freeze 与交接脱敏** | `FreezeSnapshot` 自动脱敏密钥（`sk-`、`Bearer`、`ghp_`、`gho_`、`github_pat_`、`glpat-`、`xox[bpars]-`、`AKIA`、`AIza`、PEM 私钥），拦截 `/` 开头命令注入，并限制单字段不超过 8 KiB UTF-8。 |

</details>

---

## CLI、独立预览与本地开发

需要 **Node.js 22.13+**（已在 Node 24 原生 `node:sqlite` 下通过全量测试）。

```bash
npm install
npm run check                                           # 类型检查 + 单文件前端 + 服务端打包 + 全量 Vitest
npm run dev                                             # Vite 开发服务（:5179 代理至 :17910）
node dist/cli.mjs serve --port 17910 --db ./.data/dev.db # 不装插件直接在浏览器预览（http://127.0.0.1:17910）
```

<details>
<summary>CLI 子命令与环境变量速查</summary>

| 命令 | 用途 |
| :--- | :--- |
| `node dist/cli.mjs serve [--port 17910] [--db <path>]` | 启动回环 HTTP+SSE 服务，直接访问编译后的前端与 API。 |
| `node dist/cli.mjs doctor [--db <path>] [--json]` | 检查数据库状态、已发现工作区与宿主路径。 |
| `node dist/cli.mjs workspaces [--db <path>] [--json]` | 列出自动发现的 Antigravity 项目与自定义工作区。 |
| `node dist/cli.mjs list [--phase ...] [--workspace ...] [--all\|--archived] [--json]` | 按阶段/工作区筛选列出任务（`needs_you`、`active`、`on_hold`、`todo`、`closed`）。 |
| `node dist/cli.mjs create --title "..." [--priority ...] [--due ...] [--reminder ...] [--use-worktree] [--json]` | 从命令行创建任务（另支持 `--description`、`--prompt`、`--workspace`、`--workspace-id`、`--next-action`、`--mode`、`--model`、`--due-at`/`--dueAt`、`--reminder-at`/`--reminderAt`）。 |
| `node dist/cli.mjs dispatch <taskId> [--mode auto\|new\|resume\|rework] [--rework "..."] [--use-worktree] [--dry-run] [--json]` | 从命令行派发或返工任务会话（另支持 `--task`、`--subgoal`、`--model`、`--profile`）。 |

| 环境变量 | 默认值与作用 |
| :--- | :--- |
| `AGY_BOARD_PORT` | 默认 `17910`；在 `cli.mjs serve`（未传 `--port` 时）与独立运行 `server.mjs` 时均生效。 |
| `AGY_BOARD_DB_PATH` / `AGY_BOARD_DATA_DIR` / `AGY_BOARD_PLUGIN_DATA` | 覆盖 SQLite 数据库路径或数据目录（默认 `<antigravityDataDir>/agy-board/board.db`）。 |
| `AGY_BOARD_GEMINI_CONFIG_DIR` / `AGY_BOARD_ANTIGRAVITY_DATA_DIR` | 覆盖 `~/.gemini/config` 或 `~/.gemini/antigravity` 发现根目录。 |
| `AGY_BOARD_CDP_PORT` / `AGY_BOARD_DEVTOOLS_PORT_FILE` | 独立浏览器预览模式下的回环 CDP 端口或端口文件覆盖。 |
| `ANTIGRAVITY_LS_ADDRESS` / `ANTIGRAVITY_CSRF_TOKEN` / `ANTIGRAVITY_AGENTAPI_EXE` / `ANTIGRAVITY_SIDECAR_SDK_PATH` | 运行在 Antigravity 插件宿主内时由宿主自动注入的运行时变量。 |

</details>

<details>
<summary>架构分层与仓库目录</summary>

| 分层 | 目录 | 职责 |
| :--- | :--- | :--- |
| **纯领域层** | `src/core/` | 零外部依赖的核心业务逻辑（`types`、`freeze`、`handover`、`subgoals`、`schedule`、`session-reuse`、`workspace`）。 |
| **宿主引擎层** | `src/host/` | `node:sqlite` WAL 数据库与迁移、`BoardService`、工作区与会话发现、`ConversationService`/`agentapi` 桥接、Git Worktree、`BoardScheduler`/`SidecarOwner`、白名单文件预览与公平并发队列。 |
| **入口与打包** | `src/entry/` | 双模式 `SidecarApp`（通过 `app.page('/')` 下发单文件内联 HTML 并覆盖异步 `/_sidecar/*` 路由）与回环 HTTP+SSE 服务，以及 MCP、Hook、CLI 入口。 |
| **前端界面** | `src/client/` | React 19 + `@dnd-kit` 界面（焦点 / 看板 / 列表 / 双 Tab 抽屉 / 零 Cron 调度器 / 纯内存演示沙箱）。 |

```text
agy-board/
├── plugin.json                 # Antigravity 原生插件清单
├── mcp_config.json             # MCP stdio 服务配置 (${PLUGIN_ROOT}/dist/mcp.mjs)
├── hooks.json                  # Antigravity 生命周期钩子配置 (dist/hook.mjs)
├── agy-kit.compat.json         # agy-kit 方案 B 隔离与 runtime_entries 清单
├── assets/logo.svg             # 插件图标
├── rules/AGENTS.md             # 面向 Agent 的看板操作规则
├── skills/agy-board/SKILL.md   # Agent 技能说明
├── sidecars/board/             # sidecar.json、编译后的 server.mjs 与单文件 public/index.html
├── dist/                       # 编译后的 Node 22+ 独立产物 (mcp.mjs / hook.mjs / cli.mjs)
├── src/                        # TypeScript 源码 (core / host / entry / client)
└── tests/                      # Vitest 单元测试、宿主集成、MCP/Hook E2E、HTTP/CLI 与 React UI 测试
```

</details>

---

## 接入 `agy-kit`（可选）

本仓库默认不改动 `~/.gemini/config/` 或外部 `agy-kit` 目录。如需将 `agy-board` 锁定集成进 [agy-kit](https://github.com/Fona1347/agy-kit)：

1. 先运行 `npm run check` 确保产物与全部测试通过。
2. 仅拷贝或锁定 [agy-kit.compat.json](agy-kit.compat.json) 中 `runtime_entries` 列出的 8 项独立产物（`assets`、`dist`、`hooks.json`、`mcp_config.json`、`plugin.json`、`rules`、`sidecars`、`skills`）以及 `LICENSE` 和 `THIRD_PARTY_NOTICES.md`。
3. 通过 `plugin.json`、`mcp_config.json`、`hooks.json`（`agy-board-lifecycle`）和 `sidecars/board/sidecar.json` 注册插件。
4. 保持 [agy-kit.compat.json](agy-kit.compat.json) 声明的方案 B 空间隔离不变量（零 DOM 注入、零底栏侵入、零快捷键篡改）。

---

## 致谢与灵感来源

`agy-board` 源码均为 MIT 协议下的原生实现，其工程稳定性模式与 Agent 协作范式深受以下开源项目与社区生态启发：

### Antigravity 生态工程参考与共存伙伴

| 项目仓库 | 协议 | 借鉴 / 互操作说明 |
| :--- | :--- | :--- |
| [ATtacK030130/antigrative-dashboard](https://github.com/ATtacK030130/antigrative-dashboard) | MIT | 率先沉淀了 Antigravity 原生 Sidecar 工程实践，包括 `SidecarOwner` 单主锁、Windows 更新前释放 CWD 句柄、多路径 `sidecar_sdk` 加载、宿主主题读取与 `daemon/*.json` 校验发现思路。 |
| [Fona1347/agy-kit](https://github.com/Fona1347/agy-kit) | MIT | 协同制定方案 B 空间隔离规范（[agy-kit.compat.json](agy-kit.compat.json)），共享暖纸白 / 暖炭黑焦糖琥珀宿主配色变量体系。 |
| [0DNANCY/agy-claude-style](https://github.com/0DNANCY/agy-claude-style) | MIT | 通过 `data-ag-no-i18n="true"` 约定与零 DOM 注入实现双语界面与视觉样式无冲突共存。 |
| [Lumidarin/agy-capsule](https://github.com/Lumidarin/agy-capsule) | MIT | 在方案 B（`composer_footer: false`）下各守其位，底栏遥测胶囊与右侧任务看板互不干扰。 |

### Agent 工作流与交互设计灵感

| 项目仓库 | 协议 | 启发的核心机制 |
| :--- | :--- | :--- |
| [gastownhall/beads](https://github.com/gastownhall/beads) | MIT | 跨会话记忆血缘与 `discovered-from` 任务衍生溯源（`discoveredFromTaskId`）。 |
| [MrLesk/Backlog.md](https://github.com/MrLesk/Backlog.md) | MIT | 结构化交接工单与「1 任务 = 1 干净上下文窗口」的交接胶囊思路。 |
| [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) | Apache-2.0 | 「看板即调度台」范式、Git Worktree 隔离、面板内 Diff 审查与返工闭环。 |
| [Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec) · [github/spec-kit](https://github.com/github/spec-kit) · [coleam00/Archon](https://github.com/coleam00/Archon) | MIT | 审核左移与 `todo/draft` 人类审校门禁。 |
| [johannesjo/super-productivity](https://github.com/johannesjo/super-productivity) | MIT | 严格分离「推迟/调度（Snooze）」与「硬截止（DDL）」，以及桌面休眠唤醒后最多补跑 1 次防轰炸。 |
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | MIT | 折叠详情分区与克制低噪的信息层级设计。 |

交互细节亦受 Linear、Things 3、Raycast 与 Claude Cowork 启发；底层构建依托 [React](https://react.dev/)、[@dnd-kit](https://dndkit.com/)、[@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)、[Lucide](https://lucide.dev/)、[Zod](https://zod.dev/)、[Vite](https://vite.dev/)、[esbuild](https://esbuild.github.io/)、[Vitest](https://vitest.dev/) 与 Node.js 内置 `node:sqlite`。

---

## 更新日志

### Unreleased（`v0.1.0` 之后）

- **三层任务拆分与非阻断派发快照**：拆分为任务简述（`description`）、人类专属永不锁备注（`userNotes`，下轮派发最高优先级生效）与 Agent 执行合同（`prompt`），以每轮不可变快照替代阻断式冻结。
- **对话内可编辑 MCP App 任务卡与精准定位**：为 `board_create` / `board_get` / `board_card` / `board_list` 升级仿看板交互卡片，支持行内编辑与子目标勾选，并可一键精准聚焦右侧看板对应任务抽屉。
- **Antigravity 2.35+ 侧栏会话治理**：派发会话自动加 `[Board]` 前缀、打标与归组折叠，任务完结/归档自动同步归档会话，并在设置弹层提供一键清理已完结会话。
- **审校快捷键与完整历史会话检索**：新增 `A` / `F` / `S` / `D` 审校快捷键（带输入框与中文输入法防误触）、待验收横幅一键查看 Worktree Diff，以及解除历史会话 50 条截断的按工作区搜索分页。
- **主题与滚动体验修复**：从宿主主题变量派生表面与语义配色，修复窄栏、列表、抽屉与弹窗的纵向滚动问题。

### `v0.1.0`

- 首个公开版本：焦点 / 看板 / 列表三视图、双写门禁、零 Cron 定时调度、Git Worktree 隔离、内存演示沙箱与单文件内联 Antigravity Sidecar 运行时。

---

## 开源协议

[MIT](LICENSE) · 打包内联的第三方开源组件声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
