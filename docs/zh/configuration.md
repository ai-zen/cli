---
title: 配置
description: @ai-zen/cli 的配置文件路径、目录布局、环境变量、预设端点与模型，以及交互式配置管理。
outline: deep
---

# 配置

## 配置文件路径

配置存在**数据根**下（`AI_ZEN_DIR`，缺省 `~/.ai-zen`）：`$AI_ZEN_DIR/config.json` —— 端点、模型、图片模型、默认项都在这一份里。**这一份归宿主写**：CLI 只经契约（`config.get` / `config.patch` / `config.setDefaults` …）读写，不在本地拼一份「整个配置」再整体写回。

> 数据根与桌面端 **共享**：配置、会话库、附件、日志、助手定义都在同一个根下；`~/.ai-zen/cli/` 只放 CLI 自己那四份小文件（见下面的布局）。**会话属于工作区，存在宿主的库 `<数据根>/ai-zen.db` 里** —— 不是「一段会话一个文件」。

`src/config.ts` 里**一条路径都不推导**（宿主与客户端可能不是同一台机器，算出来的第二份答案会在两机部署时安静地错）：它是「界面要用的形状」的词汇表，字段全部按宿主的方法表取回（`ConfigView` / `ModelView` / `DiscoveryView` …）。文件头注释列出数据根布局，与宿主的 `HostPaths`（`agents/packages/host/src/config.ts`）一致：

| 名字 | 路径 | 说明 |
|------|------|------|
| `AI_ZEN_DIR` | `~/.ai-zen`（或 `$AI_ZEN_DIR`） | 数据根：宿主与所有客户端共享（本进程从 `cliEnv()` 取） |

其余位置（`config.json`、`host.json`、`run/host.json`、`ai-zen.db`、`assets/`、`logs/`、`agents/`、`skills/`、`tools/`、`mcp.json` …）都由宿主与 SDK 决定，本进程不持常量。想知道某一层现在是什么状态（存在 / 坏了 / 不存在），问 `config.getDiscovery`；想知道数据根在哪，用 `config.get` 回来的 `configDir`。

「连哪台宿主 / 拿什么进门」分**三层**，各有各的主人：

| 层 | 谁给的 | 记不记 |
|----|--------|--------|
| `--server` / `AI_ZEN_SERVER_URL` / `AI_ZEN_SERVER_TOKEN` | 这一次的命令行 / 环境 | 不记（这一次的表态） |
| `$AI_ZEN_DIR/cli/connection.json` | 用户在连接屏上选过的那一份 | 记（唯一会写盘的一层） |
| `$AI_ZEN_DIR/run/host.json` + `run/token` | 那台机器上正在跑的宿主 | 不归 CLI（连接层自己读） |

解析点只有一处（`src/connection.ts` 的 `readConnectPlan`），落盘只有一处（同一文件的 `saveConnectPlan` → 包里 `connection-settings.ts`，`0600` + 原子写）。地址与凭证的优先级、缺省路、`unauthorized` 的措辞全归 `@ai-zen/agents-client` 的 `resolve-target.ts`。宿主缺省只绑回环（`agents-host serve` → `127.0.0.1:8790`），跨机器访问靠隧道或反向代理，详见 `agents/docs/zh/deploy.md`。

### 连接屏与「记住上次」

`ai`（交互界面）每次启动先看一眼上次连的是哪台：

- **连得上** → 直接进对话（不弹屏）；
- **连不上 / 第一次启动** → 连接屏：`本机`（在这台电脑上用 `npx` 拉起宿主）/ `远程`（地址 + 凭证）/ `重试` / `退出`。屏上提交 = **先验证再落盘**：连不上就不写，不把一个已知是错的配置留在盘上。
- 命令行的 `--server` / `AI_ZEN_SERVER_URL` **压过**盘上那份，而且**不会被记住**（临时连一下同事的机器不该改掉你的默认）。

`ai "…"`（管道 / 一次性调用）**没有人可以问**：没配过就**直接失败**（退出码 2，一句指路的话），**绝不**替用户拉起一个本机宿主。已经选过 `本机` 之后，一次性调用会照旧（需要时用 `npx` 现下现起一个宿主）。


### 环境变量

- **`AI_ZEN_DIR`**：覆盖数据根（默认 `~/.ai-zen`）。CLI 自己的四份小文件写在 `$AI_ZEN_DIR/cli/`；配置、库、附件、日志、助手定义等共享资源都在 `$AI_ZEN_DIR/` 下（由宿主与 SDK 读写）。
- **`AI_ZEN_SERVER_URL`**：显式宿主地址，与 `--server <url>` 同义（两者都给时 `--server` 胜）；不给就走发现文件 `$AI_ZEN_DIR/run/host.json`。
- **`AI_ZEN_SERVER_TOKEN`**：显式宿主的凭证，优先于 `$AI_ZEN_DIR/run/token`。**故意没有** `--token` 参数：argv 会被 `ps` 与 shell 历史留下。

## config.json 结构

```jsonc
{
  "endpoints": [
    {
      "id": "openai",
      "name": "OpenAI",
      "apiKey": "sk-xxx",
      "baseUrl": "https://api.openai.com/v1"
    }
  ],
  "models": [
    {
      "id": "gpt-6.1-sol",
      "name": "GPT-6.1 Sol",
      "endpointId": "openai",
      "modelName": "gpt-6.1-sol",
      "tokenThresholds": { "handoff": 250000, "guard": 375000 },
      "reasoningPreset": "openai",
      "custom": true
    }
  ],
  "imageModels": [
    {
      "id": "cogview-4",
      "name": "CogView-4",
      "endpointId": "bigmodelcn",
      "modelName": "cogview-4",
      "defaultSize": "1024x1024"
    }
  ],
  "defaultImageModel": "cogview-4",
  "defaultAgent": "default",
  "defaultMigrationModel": "deepseek-flash",
  "maxToolOutput": 32768,
  "abortedMessageStrategy": "keep",
  "abortedToolRoundStrategy": "fill",
  "autoRefreshTools": "inner-loop-start"
}
```

字段（与 SDK 的 `AppConfig` 类型对齐）：

- `endpoints`：API 端点列表（`id`、`name`、`baseUrl`、`apiKey`、`description`）。
- `models`：对话模型列表。其中 `tokenThresholds` 设定两条用量线：`handoff`（交接软线，`prompt_tokens` 超过它触发任务交接）与 `guard`（强行阻断硬线，请求前超过它中断本轮）；两者都是**绝对值**，建议 `guard ≈ handoff × 1.5`。`reasoningPreset` 引用 `reasoning-presets.json` 里的策略名（决定 `/think` 能选哪几档），缺省 = 不可调。`vision` 表示是否支持图片输入（决定 `view_image` 是否启用）。
- `imageModels`：图片生成模型列表（`id`、`name`、`endpointId`、`modelName`、`defaultSize`、`defaultQuality`）。
- `models` / `imageModels` 中未标 `custom: true` 的条目属于**出厂托管**：每次启动会与 SDK 出厂清单对齐并被替换为最新定义；自建条目请加 `"custom": true`（悬空的 `defaultMigrationModel` 会回退到出厂默认）。`endpoints` 始终保留用户配置。
- 旧字段 `maxContextTokens` / `maxContextChars` / `reasoning` 会在启动时自动迁移（前两者折成 `tokenThresholds`，`reasoning` 换成 `reasoningPreset`），无需手改；迁移只在检测到差异时写盘一次。
- `defaultImageModel` / `defaultAgent` / `defaultMigrationModel`：其余默认项。
- `abortedMessageStrategy`（`keep` / `drop`）与 `abortedToolRoundStrategy`（`fill` / `drop`）：**中断策略**。前者决定被中断时模型已输出的思考 / 正文是否留在上下文（出厂 `keep`：下一轮接着半截往下说；`drop` 则不发给模型）；后者决定被中断 / 结果不完整的工具轮次怎么归一（出厂 `fill`：整轮保留并给未完成结果补原因，`tool_calls` 与结果必须配对；`drop` 则整轮出列）。缺字段或写了非法值时，启动会补成出厂默认。配置中心「默认项」里可直接切换；它只在**建 Agent** 时读取，改完关掉配置中心会自动重建会话生效（也可手动 `/reload`）。
- `autoRefreshTools`（`inner-loop-start` / `outer-loop-start` / `off`）：**工具清单刷新时机**。一次刷新会重新发现 MCP server、Skill 与用户工具，所以这是「开销 / 时效」的取舍：`inner-loop-start`（出厂）在**每次请求前**刷，会话中新装的能力下一次请求就能用（旧版即如此）；`outer-loop-start` 整个回合开头刷一次，开销最小，新能力下一轮生效；`off` 不自动刷，只有 `/reload` 生效。同样在配置中心「默认项」里切换，也是建 Agent 时才读。
- **模型按三级解析**（会话级覆盖 > Agent 定义 > `defaultModel`）：日常在用的写在 Agent 定义的 `modelId` 上（见下节）；`config.defaultModel` 是**兜底**，只在 Agent 没绑模型时生效，默认不写。`/model <id>` 改当前会话、`/model -a <id>` 改定义、`/model -g <id>` 改兜底。

## Agent 定义（`agents/<id>.json`）

每个 Agent 在自己的定义文件里绑定模型 —— 这是三级解析的**第二级**（也是最常生效的那一级）：解析结果（会话级覆盖 > 本字段 > `config.defaultModel`）决定状态栏、凭据预检、上下文阈值与发给 API 的请求；`/model -a` 写的才是本字段。

```json
{
  "id": "default",
  "name": "默认助手",
  "modelId": "deepseek-flash",
  "messages": [ ... ],
  "modelParams": { "thinking": { "type": "enabled" }, "reasoning_effort": "high" }
}
```

- `modelId`：绑定模型。**必填**——缺失时启动会直接报错并提示用 `/config` 为该 Agent 选择模型。
- `modelParams`：Agent 级参数覆盖，浅合并进模型的 `defaultParams`（`/think` 写的就是它）。**切换模型时会被清空**，让目标模型走自己的默认参数：思考参数与模型强相关，把 DeepSeek 的 `thinking.type: "disabled"` 带到 GLM-5.3 上会被直接拒绝。

## 文件系统布局

```
~/.ai-zen/                    ← 数据根（AI_ZEN_DIR），宿主与桌面端共用
├── ai-zen.db                 ← 库：工作区、会话、消息、通知、问题、凭证（没有「一段会话一个文件」）
├── assets/                   ← 附件与素材（库里只存引用）
├── config.json               ← SDK 的配置：端点 / 模型 / 图片模型 / 默认项 / 上限 / 行为开关
├── host.json                 ← 宿主自己的设置（目前只有 port）
├── run/                      ← 宿主写、客户端读：这台机器上谁在服务
│   ├── host.json             ← 发现文件（进程 id、监听的地址与端口）
│   └── token                 ← 本地凭证（宿主启动时读或生成，0600）
├── logs/                     ← 一个进程一格，每格只归一个进程写
│   ├── host/
│   │   └── host.log          ← 宿主日志（按大小轮转：host.log.1 …）
│   └── cli/
│       ├── cli.log           ← CLI 日志（2MB 轮转；warn / error 同时上通知栏，发送消息那一刻清掉）
│       ├── launch.log        ← 拉起宿主时那个子进程的输出（每次拉起重写：失败原因是这一回的）
│       └── keys.log          ← 按键诊断（AIZ_DEBUG_KEYS=1 才写；AIZ_KEYS_FILE 可改）
├── agents/                   ← 助手定义（一实体一文件；只有这一处，与项目无关）
│   ├── default.json
│   └── my-custom-agent.json
├── sub-agents/               ← 子 Agent 定义
├── skills/                   ← 用户级 Skill
│   └── my-skill/SKILL.md
├── tools/                    ← 用户级工具
├── mcp.json                  ← 用户级 MCP（五层链里的一层）
├── mcp-oauth/                ← MCP OAuth 令牌（目录由 SDK 建好，授权流程尚未实现）
└── cli/                      ← CLI 自己的四份小文件（宿主不读）
    ├── connection.json       ← 上次连的宿主（本地 / 远程 + 地址凭证，0600）
    ├── preferences.json      ← 界面语言等本地偏好
    ├── last-workspace.json   ← 这台机器上次进入的那个工作区
    └── last-conversation.json ← 上次那段对话（下次启动据此续接）

/path/to/project/             ← 工作区：项目里会被宿主读到的东西
├── .mcp.json                 ← 项目共享 MCP（可提交，只读）
├── .agents/                  ← 业界通用目录（Cursor / Windsurf / Cline 那一套）
│   ├── mcp.json              ← 只读
│   ├── skills/               ← 项目 Skill
│   ├── tools/                ← 项目工具
│   └── sub-agents/           ← 项目子 Agent
└── .ai-zen/
    ├── mcp.json              ← 项目侧唯一可写的 MCP 层（scope = workspace）
    ├── skills/               ← 项目 Skill
    └── handoffs/             ← 交接文档（<YYYYMMDD-HHmmss>.md）
```

业界通用规范目录：`~/.agents/` 与 `<project>/.agents/`（`skills/`、`tools/`、`sub-agents/`、`mcp.json`），这两层宿主只读。

## 预设端点

| ID | 名称 | 默认 Base URL |
|----|------|---------------|
| `openai` | OpenAI | `https://api.openai.com/v1` |
| `bigmodelcn` | BigModelCN (ZhipuAI) | `https://open.bigmodel.cn/api/paas/v4` |
| `deepseek` | DeepSeek | `https://api.deepseek.com/v1` |

## 预设模型

| ID | 名称 | 端点 |
|----|------|------|
| `gpt-6-astra` | GPT-6 Astra | OpenAI |
| `gpt-6.1-sol` | GPT-6.1 Sol | OpenAI |
| `gpt-6-luna` | GPT-6 Luna | OpenAI |
| `glm-5.3` | GLM-5.3 | ZhipuAI |
| `glm-5.3-flash` | GLM-5.3-Flash（视觉） | ZhipuAI |
| `glm-5.3-flashx` | GLM-5.3-FlashX（视觉） | ZhipuAI |
| `glm-4.7-flash` | GLM-4.7-Flash | ZhipuAI |
| `deepseek-flash` | DeepSeek-V4.1-Flash（视觉） | DeepSeek（**默认**） |

> 预设端点/模型来自 SDK（`@ai-zen/agents-sdk`）的 `config/constants`；CLI 不维护自己的预置列表（`src/config.ts` 直接复用 SDK 的出厂默认）。上表与 README 的「预置模型」表一致。

## 配置管理

TUI 内可用 `/config` 打开**配置中心**交互式编辑常用项，无需手改 JSON：

- 配置文件路径：`~/.ai-zen/config.json`（或 `$AI_ZEN_DIR/config.json`）。
- 可设置：**端点**（名称 / Base URL / API Key / 描述，增删改）、**模型**（名称 / 端点 / 模型名 / 思考策略 / 交接阈值 / 阻断阈值 / 视觉 / 描述，增删改）、**图片模型**（名称 / 端点 / 模型名 / 尺寸 / 质量，增删改）、**MCP 服务器**（作用域可屏内切换：用户级 `$AI_ZEN_DIR/mcp.json` / 工作区 `<cwd>/.ai-zen/mcp.json` —— MCP 五层链里只有这两层可写；名称 / 传输 stdio·http·sse / 启用·禁用 / 描述 / 命令 / 参数 / 环境变量 / URL / 请求头，增删改）、**Agent 定义**（顶层 `agents/*.json` 与子 `sub-agents/*.json`；名称 / 标识 / 描述 / 模型 / 提示词【系统编辑器】/ 四维权限 `tools`·`skills`·`mcps`·`subagents` / 自定义，Sub-agent 另含 `function`，均支持增删改）、**默认项**（默认模型 / 默认图片模型 / 默认 Agent / 默认迁移模型 / 中断策略两项）、**工具输出上限**。
- 列表 = [＋ 新建…] + 各条目；选中条目进入**详情屏**就地编辑（`↑ ↓` 移动、`Enter` 编辑/切换/选择、危险动作二次确认）。编辑「出厂托管」的模型时会自动标记 `custom: true`；详情屏不再暴露 `custom` 开关，改用底部「恢复出厂设置」（出厂模型 / 图片模型整条替换回出厂定义，随后重新归 SDK 托管；自建条目没有该动作）。删除端点会先校验是否仍被模型引用。
- **MCP 服务器**：传输方式为枚举选择（stdio / http / sse）、启用·禁用为即时切换；参数按 shell 风格（引号 / 转义）切分为 argv；环境变量与请求头进入**键值编辑子屏**（`KEY=VALUE`，可增 / 改 / 删）。改动即时写入对应作用域的 `mcp.json`；关闭配置中心后会话会重建，使新服务器 / 工具生效。
- **Agent 定义**：列表区分顶层 Agent 与 Sub-agent（各带「＋ 新建」）；详情屏编辑名称 / 标识（改标识即重命名文件）/ 描述 / 模型（枚举自 `config.models`）/ 四维权限（紧凑语法 `allow: a, b` 或 `deny: x`，留空清除该维）；默认 Agent 另有底部「恢复出厂设置」（只把提示词换回出厂，名称 / 模型 / 权限保留）；Sub-agent 另有 `function`（函数名 / 说明 / 参数 schema JSON）。**多行内容**（提示词 / 函数说明 / 参数 schema）按 `Enter` 调起**系统编辑器**（`$EDITOR`，Windows 默认 `notepad`）：提示词回写首条 system 消息；参数 schema 以 `.json` 打开、保存后即时校验（非法 JSON 被拒且**保留改动**便于重试），内容未改动则不写盘。编辑「出厂托管」的 `default` Agent 会自动标记 `custom: true`，避免改动被 SDK 同步覆盖。
- 首次启动若模型绑定的端点缺 API Key，会先弹出凭据设置屏；对话内 `/key` 可改当前端点的 Key（保存后自动重建会话）。
- Skill（`skills/SKILL.md`）与用户工具（`tools/*.js`）仍以文件为准。

> 说明：CLI 入口只实现了 `hook` 子命令（`ai hook install|uninstall`）；**没有 `config` 子命令**。若端点缺少 API Key，纯 stdio 模式会直接报错退出（非 0），TUI 模式会在启动对话时提示。
