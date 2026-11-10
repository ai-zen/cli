/**
 * TUI 入口 —— 屏幕循环与终端状态安全
 *
 * 流程：启动界面 → 端点凭据预检（缺 API Key 时先引导输入）→ 对话屏
 * （未带 `--new` 时把「接着上次」的意图交给会话层，由它去问服务端）。
 * 对话屏内 `/clear`、`/back`、`/load` 通过重挂载（新 Ink 实例 + 原生清屏）实现；
 * 对话屏退出即结束进程。
 *
 * 终端安全：SIGINT / SIGTERM / 未捕获异常均卸载 Ink，恢复 raw mode 与光标。
 */

import { render, useApp, type Instance } from "ink";
import { resolveModel, type AppConfig } from "@ai-zen/agents-sdk";
import { createConfigPort } from "../server-client/index.js";
// 类型从 `agents-store.ts` 转出（那里只剩词汇表）：首启凭据屏要把**服务端那**一份定义快照递下去
import type { AgentStore } from "../agents-store.js";
import { resolveCredential } from "../config-editor.js";
import { ConfigWizard, type WizardCloseResult } from "./config-wizard/index.js";
import { Chat } from "./screens/index.js";
import { keyDebugStart } from "./key-debug.js";
import { disableMouseTracking, enableMouseTracking } from "./mouse.js";
import { installSdkLogger } from "../sdk-log.js";
import { initLocale } from "../i18n/preferences.js";
import { t } from "../i18n/index.js";
import type { AgentNS } from "@ai-zen/agents-core";

/** ANSI：清屏 + 光标归位 + 显示光标（屏幕间切换时从头绘制，避免行偏移） */
const CLEAR_SCREEN = "\x1b[2J\x1b[H\x1b[?25h";

/**
 * 进程级配置面（**全文件复用这一个**）。
 *
 * 为什么全局一个而不是每次调用新建：远程端口是懒连接的，一次 `modelOf` / `resolveTarget`
 * / 凭据预检各建一个，启动阶段就会为同一件事重复握手；而它本来就是进程级共享的资源。
 *
 * 为什么是远程实现：启动预检读的是「**服务端**用哪份配置、Agent 绑的哪个模型」。
 * 读本机磁盘在两端不同机时必然错误 —— 预检通过、实际请求仍然缺 Key（或反之）。
 */
const configPort = createConfigPort();

/**
 * 告别并终止进程。
 *
 * Ink 卸载后，进程仍可能被残留句柄（TTY stdin 处于 flowing、SDK 的 Timeout/Immediate 等）
 * 挂住，导致「返回 shell 却不退出、终端不归还」。这里显式恢复终端、暂停 stdin 并 exit，
 * 保证退出即干净交还 shell（Windows 下 TTY 写为异步，用回调 + 兜底定时器双保险）。
 */
function farewell(): void {
  // 先关鼠标上报：不关的话，回到 shell 后每次滚轮都会在提示符前吐一串 `^[[<64;…M`
  try {
    disableMouseTracking();
  } catch {
    /* ignore */
  }
  try {
    (process.stdin as { setRawMode?: (v: boolean) => void }).setRawMode?.(false);
  } catch {
    /* ignore */
  }
  try {
    process.stdin.pause();
  } catch {
    /* ignore */
  }
  const finish = () => process.exit(0);
  process.stdout.write(`\x1b[?25h${t("app.goodbye")}`, finish);
  setTimeout(finish, 250);
}

/** 当前活动的 Ink 实例（用于信号处理时兜底卸载） */
let activeInstance: Instance | null = null;

/**
 * Ink 渲染选项（集中声明，便于单测锁定关键决策）。
 *
 * `kittyKeyboard` 刻意取 `disabled`，关闭 Kitty 键盘协议的「自动查询」：
 *
 * - Ink 的 `auto` 模式会在**每个实例创建时**发送一次 `CSI ? u` 查询，终端则回
 *   `CSI ? 0 u`（flags=0，不支持）。本 TUI 会反复挂载（启动界面 → 对话 →
 *   配置向导 …），于是应答源源不断；
 * - 应答一旦被**拆包**（前导 ESC 被 Ink 的「待定转义刷新定时器」当作一次独立的
 *   Escape 键消费），残留在后一个 chunk 里的 `[?0u` 会退化成普通文本被当作输入
 *   插入输入框（已实测重现）；
 * - 而该协议的收益（Ctrl / Alt / Shift + Enter 换行）在本环境本就不生效——
 *   换行由不依赖终端协议的 `Ctrl+N` / `Ctrl+J` 承担。
 */
export const RENDER_OPTIONS = {
  exitOnCtrlC: false,
  alternateScreen: false,
  // 只重绘「变化的行」，而不是每帧擦除 + 重写整屏（Ink 默认 false，走 createStandard）。
  // 流式高频下把每帧输出量从 O(屏幕大小) 降到 O(变化量)，显著减轻 SSH 带宽 / 背压压力。
  incrementalRendering: true,
  kittyKeyboard: { mode: "disabled" },
} as const;

function mount(node: Parameters<typeof render>[0]): Promise<unknown> {
  process.stdout.write(CLEAR_SCREEN);
  // 鼠标上报随实例生命周期开关：本 TUI 会反复挂载（启动屏 → 对话 → 配置向导），
  // 每个实例结束时都关掉，避免「已卸载却仍在收鼠标事件」。
  enableMouseTracking();
  const instance = render(node, RENDER_OPTIONS);
  activeInstance = instance;
  return instance.waitUntilExit().finally(() => {
    disableMouseTracking();
    if (activeInstance === instance) activeInstance = null;
  });
}

// ==================== 端点凭据预检 ====================

/**
 * 首启凭据门 —— 所选模型绑定的端点缺 API Key 时，先弹出 Ink 原生输入屏。
 *
 * 输入完成（或放弃）后退出该屏，把结果回传给 `mount()` 的返回值。
 *
 * ## 为什么它必须注入 `agentStore`
 *
 * 这个屏也能按 `a` 走进 Agent 定义编辑，而「定义写到哪里」由 `agentStore` 决定。
 * 不传的后果不是报错，是**写到错的地方**：`config-wizard/engine.ts` 曾经的缺省是
 * `createAgentStore([], [])` → `AgentRepository(AGENTS_DIR)`，而 `AGENTS_DIR` 是**客户端**
 * 本机的 `~/.ai-zen/agents/`；后端 Agent 用的是服务端那份，于是「改好了」是假的。
 * 现在缺省换成一个会报错的只读空快照（宁可写不进去，不要写错地方），而这里就是
 * 那个「必须传真的」的挂载点之一。
 */
function CredentialGate({
  config,
  configPath,
  endpointId,
  agentStore,
}: {
  config: AppConfig;
  configPath: string;
  endpointId: string;
  /** Agent / Sub-agent 定义快照（服务端那一份，`configPort.readAgentStore()`） */
  agentStore: AgentStore;
}) {
  const { exit } = useApp();
  return (
    <ConfigWizard
      config={config}
      configPath={configPath}
      // 定义从服务端读、写到服务端：这个屏上的「Agent 定义」不是本机文件
      agentStore={agentStore}
      onboarding
      closeOnSave
      initialStep={{ kind: "edit", field: "apiKey", endpointId }}
      onSave={(config) => configPort.saveConfig(config)}
      // 首启凭据屏不碰 MCP：这里给一个明确的空实现，而不是让组件去写本机 mcp.json
      onSaveMcp={async () => {}}
      onClose={(result) => exit(result)}
    />
  );
}

/**
 * 端点凭据预检：返回 `false` 表示用户放弃配置（调用方应退出）。
 *
 * 配置本身残缺（模型 / 端点不存在）时不在此拦截 —— 交给对话屏报错，
 * 那里可按 `k` 打开配置中心自行修配置。
 */
async function ensureCredential(modelId: string): Promise<boolean> {
  // 凭据要从**实际会用它的那一份配置**里取：在服务端，不是本机磁盘。
  // 顺带拿那份文件的路径 —— 凭据屏是同一个 `ConfigWizard`，它要知道自己改的是哪个文件。
  const { config, path } = await configPort.readConfigFile();
  const credential = resolveCredential(config, modelId);
  if (!credential || credential.configured) return true;

  // 定义快照也来自**服务端**（它只有真要开屏时才读一次）：凭据屏里可以进 Agent 定义编辑，
  // 而那条路的写入必须落在 Agent 实际用的那一份上。
  const agentStore = await configPort.readAgentStore();

  const result = (await mount(
    <CredentialGate
      config={config}
      configPath={path}
      endpointId={credential.endpointId}
      agentStore={agentStore}
    />,
  )) as WizardCloseResult | undefined;
  return Boolean(result?.dirty);
}

// ==================== 目标解析 ====================

interface ChatTarget {
  agentId?: string;
  messages?: AgentNS.Message[];
  sessionId?: string;
  /**
   * 「接着该工作区的上一轮会话」—— 只是**意图**，不带任何数据。
   *
   * 为什么不再由这里读盘：会话执行已经搬到服务端，那段对话根本不在本机磁盘上，
   * 读本地存档只会得出「永远没有上次」。哪一段算上一轮，交给会话实现去问
   * （`session.last`）。
   */
  resume?: boolean;
}

/**
 * 启动预检：这个 Agent 实际会用哪个模型。
 *
 * 走 **SDK 的 `resolveModel`（唯一实现的三级解析）**，只喂「Agent 定义 + 全局兜底」两级
 * —— 启动这一刻还没有会话，会话级覆盖不存在。客户端自己推 `??` 链就会出现「预检说不可用、
 * 服务端其实能跑」（或者反过来），而那种分叉正是「状态栏显示 A、实发请求 B」的起点。
 *
 * 解析不出来就直接报错，绝不做任何隐式回退：静默挑一个模型，用户会以为在用配置里那个。
 */
async function modelOf(agentId: string | undefined): Promise<string> {
  const id = agentId || "default";
  // 历史 Agent 缺 `modelId` 的补齐（迁移 / bootstrap）发生在**持有定义的那一侧**
  // （服务端）。客户端只负责读快照，不自己重做一遍迁移
  // （在这里补写会让「谁改的配置」变得说不清）；读到的定义若仍无 modelId 且没有兜底，
  // 就是真缺。
  const [config, store] = await Promise.all([configPort.readConfig(), configPort.readAgentStore()]);
  const definition = store.agents.find((agent) => agent.id === id);
  const resolved = resolveModel({
    agentModelId: definition?.modelId,
    defaultModel: config.defaultModel,
  });
  if (!resolved) {
    throw new Error(t("app.agentNoModel", { id }));
  }
  if (!config.models.some((model) => model.id === resolved.modelId)) {
    throw new Error(t("app.agentModelGone", { id, model: resolved.modelId }));
  }
  return resolved.modelId;
}

async function resolveTarget(): Promise<ChatTarget> {
  // 默认 Agent 与可用 Agent 列表都在配置面里（远程时以服务端为准），
  // 「本机有没有装 Agent」与「服务端能不能跑」是两回事。
  const [config, store] = await Promise.all([configPort.readConfig(), configPort.readAgentStore()]);
  const agents = store.agents;

  const agentId = config.defaultAgent ?? agents[0]?.id;
  if (!agentId) throw new Error(t("app.noAgents"));

  // 校验模型可用（缺失时抛出可读错误，交给启动屏展示）
  await modelOf(agentId);
  return { agentId };
}

/**
 * 「接着上次」的意图。
 *
 * 这里**只有意图、没有数据**：上一轮是哪一段只有会话实现的那一侧知道（服务端存档 /
 * 本地指针），客户端自己去读一遍就是又一份会漂的真相。窗口层说「接着上次」，
 * 会话层负责找出接哪一段；找不到就当新会话开。
 */
function resumeLastSession(): ChatTarget {
  return { resume: true };
}

// ==================== 对话屏 ====================

/**
 * 运行对话屏；`/clear`、`/back`、`/load` 通过重挂载（新 Ink 实例 + 原生清屏）实现，
 * 其余退出（退出）直接结束。
 */
async function runChat(target: ChatTarget, options: RunTuiOptions = {}): Promise<void> {
  let current = target;
  let messages = target.messages;
  let initialInput: string | undefined;
  /** 重挂载后要展示一次的系统提示（如 `/model` 的写入结果，旧实例已卸载，只能传给新屏） */
  let initialNotice: string | undefined;
  /**
   * shell 钩子（`ai --tui --new "$@"`）带来的首条消息。
   * **只发一次**：挂载后置空，否则重挂载（切模型 / `/lang` 等）会反复重发。
   */
  let initialPrompt = options.initialPrompt;
  /**
   * 「接着上次」是**一次性**意图：只对首屏有效。
   *
   * 重挂载（`/load`、/model 重启）带的是已经拿到手的 `messages` / `sessionId`，
   * 若让 resume 一直跟着，第二次挂载会一边给 id 一边让会话「再找一次上次」，
   * 两者指向不同会话时就成了「以为在接着聊、其实换了段对话」。
   */
  let resume = target.resume;

  while (true) {
    const result = await mount(
      <Chat
        agentId={current.agentId}
        messages={messages}
        sessionId={current.sessionId}
        resume={resume}
        // 把**同一个**配置面实例交给对话屏：端口是懒连接的，不传的话对话屏会自己再建一个，
        // 一个 TUI 进程就变成两条到服务端的连接（启动预检一条、对话屏一条）。
        deps={{ config: configPort }}
        initialInput={initialInput}
        initialNotice={initialNotice}
        initialPrompt={initialPrompt}
      />,
    );
    initialPrompt = undefined;
    resume = false;

    if (result && typeof result === "object") {
      const value = result as {
        restart?: boolean;
        load?: {
          agentId?: string;
          messages?: AgentNS.Message[];
          sessionId?: string;
        };
        messages?: AgentNS.Message[];
        initialInput?: string;
        sessionId?: string;
        /** 重挂载后展示一次的系统提示 */
        notice?: string;
      };
      if (value.load) {
        // /load：整体切换到另一段已保存对话（含 Agent），重挂载对话屏
        current = {
          agentId: value.load.agentId,
          sessionId: value.load.sessionId,
        };
        messages = value.load.messages;
        initialInput = undefined;
        initialNotice = undefined;
        continue;
      }
      if (value.restart) {
        messages = value.messages ?? messages;
        initialInput = value.initialInput;
        initialNotice = value.notice;
        /**
         * 会话 id 跟着一起换：会话侧可能已经换过 id（`/new` 开了新的、自动迁移搬了家、
         * `/save <名字>` 改了名字），而这里手上那个还是首次挂载时的。带旧 id 重挂载会
         * 接回另一段对话，或撞 `session-missing`。
         */
        if (value.sessionId) {
          current = {
            ...current,
            sessionId: value.sessionId,
          };
        }
        continue;
      }
    }
    return;
  }
}

// ==================== 入口 ====================

/** `runTui()` 的可选参数 */
export interface RunTuiOptions {
  /**
   * 进入对话屏后**自动作为首条消息发送**的内容。
   *
   * 来源只有一处：shell 兜底钩子 `ai --tui --new "$@"`（命令不存在时把原命令带进来）。
   * 不预填到输入框——钩子的语义就是「这条命令跑不了，你帮我处理」，等用户再敲一次回车没有意义。
   */
  initialPrompt?: string;
  /**
   * `--new`：**开一条新会话**，跳过「接着该目录的上一轮对话」。
   *
   * 默认（不带 `--new`）保持续接意图：`ai` 回到上次的对话是常用预期。
   * 具体接哪一段由会话实现问服务端，客户端不读本地存档。
   */
  newSession?: boolean;
}

export async function runTui(options: RunTuiOptions = {}): Promise<void> {
  const uninstallSignals = installSignalSafety();
  // 接管 SDK 全局日志：关掉库自带的 console 兜底。必须在任何 Ink 渲染之前——
  // SDK 的 logger 默认是 console.log，直写 stdout 会把界面撕坏
  // （`load_mcp` 甚至会把整份 manifest 打出来）。AIZ_DEBUG_SDK=1 可改为落盘。
  installSdkLogger();
  // 界面语言必须在任何渲染之前定下来：首次启动按系统语言识别并落盘，
  // 之后以 preferences.json 为准（`/lang` 可随时改）。
  await initLocale();
  // 按键诊断：AIZ_DEBUG_KEYS=1 时把终端环境 + 每次按键写进日志（默认关闭，零开销）
  keyDebugStart();

  try {
    // 直达对话：Agent 身份与它绑的模型都由配置面给（服务端那份配置）；
    // 「接不接上次」只在这里定 —— 不带 `--new` 就带上 resume 意图，带上就一定是新会话。
    let target: ChatTarget | null = null;
    try {
      target = await resolveTarget();
    } catch (error: any) {
      process.stderr.write(`\n${t("app.bootFailed", { error: error?.message ?? error })}\n`);
    }
    if (!target) {
      farewell();
      return;
    }
    // 顺序很重要：`--new` 是「我不要上次」的明确表态，绝不能在这一步又把 resume 加回来
    if (!options.newSession) target = { ...target, ...resumeLastSession() };

    // 端点凭据预检：未配置 API Key 时先弹出输入屏，而不是「报错即退出」
    // 模型从 Agent 定义读 —— 与实发请求用的是同一个值
    let modelId: string | null = null;
    try {
      modelId = await modelOf(target.agentId);
    } catch (error: any) {
      process.stderr.write(`\n${t("app.bootFailed", { error: error?.message ?? error })}\n`);
      farewell();
      return;
    }
    if (!(await ensureCredential(modelId))) {
      farewell();
      return;
    }

    await runChat(target, options);
    farewell();
  } finally {
    uninstallSignals();
    activeInstance = null;
  }
}

/** 安装信号与异常兜底：任何异常退出路径都先卸载 Ink，避免「花屏终端」 */
function installSignalSafety(): () => void {
  const restore = () => {
    try {
      activeInstance?.unmount();
    } catch {
      /* 忽略 */
    }
    // 任何异常退出路径都要把终端鼠标上报关掉，否则终端会持续把滚轮写成转义序列
    try {
      disableMouseTracking();
    } catch {
      /* 忽略 */
    }
    activeInstance = null;
  };
  const onSigint = () => {
    restore();
    process.exit(130);
  };
  const onSigterm = () => {
    restore();
    process.exit(143);
  };
  const onFatal = (error: unknown) => {
    restore();
    process.stderr.write(`\n${t("app.unexpected", { error: (error as any)?.message ?? error })}\n`);
    process.exit(1);
  };

  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", onFatal);

  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("uncaughtException", onFatal);
    process.off("unhandledRejection", onFatal);
  };
}
