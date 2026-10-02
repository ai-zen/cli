# 待办事项

> 本文件只记录**尚未完成**的工作；条目完成后即删除，不在本文件中保留历史（历史见 `CHANGELOG.md`）。

## 总目标：双模式改造 + 启动命令改名 + TUI 重写

最终形态为**两种互不混合**的运行模式，由启动参数与终端环境自动判定：

| 模式 | 触发条件 | 面向对象 | 核心行为 |
|------|----------|----------|----------|
| **纯 stdio 模式** | 带参数，**或** stdin/stdout 非 TTY（管道、重定向） | 脚本、管道、shell 兜底钩子 | **无任何额外交互**；读入文本，把**最终 content 以纯文本写出 stdout** |
| **TUI 模式** | **无参数且 stdin/stdout 均为 TTY** | 人类用户 | 全屏交互界面（Ink/React）；**启动直达对话** |

启动命令已由 `aiz` / `zen` 改为 **`ai`**。

## 已完成

- ✅ **纯 stdio 模式（0.10.0）**：`src/mode.ts` + `src/stdio-runner.ts`；stdout 零装饰、日志走 stderr、退出码语义、默认不落盘（`--save` 可选）。
- ✅ **启动命令改名 `ai`（0.10.0）**：`bin` 为 `{ ai, aiz, zen }`；shell 钩子 `ai "$@"` 并自动升级旧 `aiz` 钩子。
- ✅ **TUI 全屏界面（1.0.0-alpha.1）**：Ink/React 重写（`src/tui/`）——动画渐变 ASCII 启动界面、流式对话区、多行输入、内联 `/` 命令菜单、状态栏、确认框、`/back`+`/editor`、终端状态安全（信号/异常兜底）。
- ✅ **直达对话 + 底部固定输入（1.0.0-alpha.1）**：启动后直接进入对话；输入行/状态栏吸附终端底部（行级预折行 + 底部截取 + 顶部补齐，整帧高度恒小于终端行数）。
- ✅ **干净退出（1.0.0-alpha.1）**：Ink 卸载后显式暂停 stdin 并终止进程，避免残留句柄导致「返回 shell 却不退出」。
- ✅ **死代码清理（1.0.0-alpha.1）**：移除旧行式对话链路（`conversation-runner` / `slash-hint-prompt` / `delta-renderer` / `config-wizard` / `conversation-commands` 处理器），保留 `registry.ts` 作为命令清单唯一来源。（注：删除的是 **inquirer 版** `config-wizard`；同版本后续以**纯 Ink** 重写为 `src/tui/config-wizard.tsx`。）
- ✅ **首启凭据引导 + 配置中心（1.0.0-alpha.1）**：端点缺 API Key 时启动先弹出**凭据设置屏**（端点 / Base URL / 厂商申请链接 / 掩码输入，`Tab` 切明文）；对话内 `/key` 改当前端点 Key（保存后自动重建会话）；`/config` 配置中心（默认模型 / 端点管理：列表含「＋ 新建端点」+ 各端点，选中端点后一屏就地编辑 API Key / Base URL），改动即时写入 `config.json`。配置查询与不可变改写集中在纯函数层 `src/config-editor.ts`。
- ✅ **移除主菜单（1.0.0-alpha.1）**：删除 `MainMenu` 屏幕、`/menu` 命令、`ConversationPicker` 及整个 `src/menus/*`（inquirer 流程）；对话内 `/load` 所需的列表函数迁为 `conversation-repository.ts` 的 `listConversations()`。菜单功能转为 P1 待办（见下）。

## P1：主菜单（已移除，待重新实现）

原「主菜单」次级屏幕（对话内 `/menu`）及其 inquirer 流程已整体移除；以下功能待改用 **Ink 原生组件**重新实现（不再混用两套 raw-mode UI）：

- [ ] **主菜单屏幕**：对话内 `/menu` 唤起次级屏幕（Esc 返回对话）
- [ ] **继续上次会话**：列出「上一轮会话」并续接（当前启动已自动续接；`/load` 可手动切换）
- [ ] **开始新对话**（当前已有 `/new` 命令，可复用）
- [ ] **继续已保存的对话**（当前已有 `/load` 命令，可复用）
- [ ] **管理已保存的对话**：列出 / 查看详情 / 删除
- [x] **管理 Agents（已完成）**：`/config` →「Agent 定义」管理 `agents/*.json`（顶层 Agent）与 `sub-agents/*.json`（子 Agent）的列表 / 新建 / 编辑 / 删除（名称 / 标识 / 描述 / 模型绑定 / 提示词 · 函数说明 · 参数 schema【系统编辑器】/ 四维权限 / 自定义；Sub-agent 另含 function）。
- [x] **配置管理（已完成）**：`/config` 配置中心已全面管理 `config.json` 与 `mcp.json` —— 端点（增删改）、模型（增删改，自动 `custom: true`）、图片模型（增删改）、**MCP 服务器（全局 / 项目两作用域，增删改 + 启用·禁用 + stdio/http/sse 全部传输字段）**、默认项（模型 / 图片模型 / Agent / 迁移模型）、**Agent 定义（`agents/` + `sub-agents/`：增删改 + 提示词 · 参数 schema 系统编辑器 / 四维权限 / Sub-agent function）**、工具输出上限；`/key` 与首启引导负责端点凭据。
- [ ] **退出**

> 移除原因：原实现是 Ink 与 inquirer 混用 —— 进菜单需先卸载 Ink 再交给 inquirer，交互与样式割裂；统一到 Ink 原生组件后再回归。

## 1. TUI 后续能力（v2，未完成）

- [ ] `@` 文件引用补全
- [ ] 会话内搜索；`/back` 选择器增强（当前为整体回退，条目数超过一屏时仅展示最近 N 条）
- [ ] 工具调用折叠面板（当前为逐行展示）
- [ ] 图片 / 表格渲染
- [ ] 主题定制（亮/暗色）
- [ ] 备用屏幕（alternate screen）开关：当前采用内联渲染以保留终端滚动与复制（参考 Gemini CLI / Codex CLI）

## 2. 测试与工程化（未完成）

- [ ] TUI 的 pty 冒烟测试纳入 CI（当前依赖 `ink-testing-library` 的组件级测试 + 人工 pty 验证）
- [ ] `ink` / `react` 的版本范围与打包体积评估（当前固定随 CLI 一同发布）

## 3. 遗留开放问题

1. ✅ `/clear` 语义：清屏但保留上下文（已实现：重挂载对话屏且不重建历史）。
2. ⏳ 是否需要 `ai` 保留 `aiz` / `zen` 别名之外的迁移提示（如启动时向 stderr 打一次弃用提醒）？
3. ⏳ 覆盖层（确认框 / 选择器）显示时，状态栏提示语是否切换为对应操作键位（当前仍显示默认输入提示）。

## 非目标

- stdio 模式下不渲染任何 TUI 元素（含底栏提示、菜单、状态栏）
- 不改变 Agent / MCP / Skill / 子 Agent / 任务迁移的既有语义
- 不做 Web / 桌面端形态（本次仅 CLI 双模式）
