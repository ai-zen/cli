/**
 * TUI 入口 —— 屏幕循环与终端状态安全
 *
 * 流程：启动界面 → 端点凭据预检（缺 API Key 时先引导输入）→ 对话屏
 * （优先续接「上一轮会话」，否则新建对话）。
 * 对话屏内 `/clear`、`/back`、`/load` 通过重挂载（新 Ink 实例 + 原生清屏）实现；
 * 对话屏退出即结束进程。
 *
 * 终端安全：SIGINT / SIGTERM / 未捕获异常均卸载 Ink，恢复 raw mode 与光标。
 */

import { render, useApp, type Instance } from "ink";
import { AgentRepository } from "@ai-zen/agents-sdk";
import type { AppConfig } from "@ai-zen/agents-sdk";
import { AGENTS_DIR, ensureConfigDir, readConfig, saveConfig } from "../config.js";
import { resolveCredential } from "../config-editor.js";
import { ConfigWizard, type WizardCloseResult } from "./config-wizard/index.js";
import { conversationRepository } from "../conversation-repository.js";
import { readLastSession } from "../session-pointer.js";
import { Splash, Chat } from "./screens/index.js";
import { keyDebugStart } from "./key-debug.js";
import { disableMouseTracking, enableMouseTracking } from "./mouse.js";
import { installSdkLogger } from "../sdk-log.js";
import type { AgentNS } from "@ai-zen/agents-core";

/** ANSI：清屏 + 光标归位 + 显示光标（屏幕间切换时从头绘制，避免行偏移） */
const CLEAR_SCREEN = "\x1b[2J\x1b[H\x1b[?25h";

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
  process.stdout.write("\x1b[?25h\n再见 👋\n", finish);
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
 */
function CredentialGate({ config, endpointId }: { config: AppConfig; endpointId: string }) {
  const { exit } = useApp();
  return (
    <ConfigWizard
      config={config}
      onboarding
      closeOnSave
      initialStep={{ kind: "edit", field: "apiKey", endpointId }}
      onSave={saveConfig}
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
  const config = await readConfig();
  const credential = resolveCredential(config, modelId);
  if (!credential || credential.configured) return true;

  const result = (await mount(
    <CredentialGate config={config} endpointId={credential.endpointId} />,
  )) as WizardCloseResult | undefined;
  return Boolean(result?.dirty);
}

// ==================== 目标解析 ====================

interface ChatTarget {
  agentId?: string;
  messages?: AgentNS.Message[];
  conversationId?: string;
  conversationName?: string;
}

/**
 * 解析某个 Agent 绑定模型（**唯一真相源**）。
 *
 * 配置层已无 `defaultModel`、会话存档也不再记模型，所以这里缺失就直接报错，
 * 绝不做任何隐式回退——回退正是「状态栏显示 A、实发请求 B」的根源。
 */
async function modelOf(agentId: string | undefined): Promise<string> {
  const id = agentId || "default";
  // 先跑一次配置初始化：bootstrap 会为缺 modelId 的历史 Agent 补上并落盘。
  // 不做这一步就会读到“未绑定模型”的旧定义，把一次正常的升级变成启动错误。
  const config = await readConfig();
  const agent = await new AgentRepository(AGENTS_DIR).read(id);
  const modelId = agent?.modelId;
  if (!modelId) {
    throw new Error(`Agent「${id}」未绑定模型，请用 /config 为它选择模型`);
  }
  if (!config.models.some((model) => model.id === modelId)) {
    throw new Error(
      `Agent「${id}」绑定的模型“${modelId}”已不在配置中，请用 /config 重新选择`,
    );
  }
  return modelId;
}

async function resolveTarget(): Promise<ChatTarget> {
  const config = await readConfig();
  const repository = new AgentRepository(AGENTS_DIR);
  const agents = await repository.list();

  const agentId = config.defaultAgent ?? agents[0]?.id;
  if (!agentId) throw new Error("没有可用的 Agent，请先在配置中创建（配置文件 config.json）");

  // 校验模型可用（缺失时抛出可读错误，交给启动屏展示）
  await modelOf(agentId);
  return { agentId };
}

/** 读取「上一轮会话 id」指针，续接该会话（指针缺失或会话不存在时返回 null） */
async function resumeLastSession(): Promise<ChatTarget | null> {
  const pointer = await readLastSession(process.cwd());
  if (!pointer) return null;
  const conversation = await conversationRepository.read(pointer.id);
  if (!conversation) return null;
  // 模型由 Agent 定义决定（旧存档里的 modelId 一律忽略）
  return targetFromMessages({
    agentId: conversation.agentId,
    messages: conversation.messages,
    conversationId: conversation.id,
    conversationName: conversation.id,
  });
}

/** 从已保存对话构造对话目标 */
function targetFromMessages(input: {
  agentId?: string;
  messages: AgentNS.Message[];
  conversationId?: string;
  conversationName?: string;
}): ChatTarget {
  return {
    agentId: input.agentId,
    messages: input.messages,
    conversationId: input.conversationId,
    conversationName: input.conversationName,
  };
}

// ==================== 对话屏 ====================

/**
 * 运行对话屏；`/clear`、`/back`、`/load` 通过重挂载（新 Ink 实例 + 原生清屏）实现，
 * 其余退出（退出）直接结束。
 */
async function runChat(target: ChatTarget): Promise<void> {
  let current = target;
  let messages = target.messages;
  let initialInput: string | undefined;
  /** 重挂载后要展示一次的系统提示（如 `/model` 的写入结果，旧实例已卸载，只能传给新屏） */
  let initialNotice: string | undefined;

  while (true) {
    const result = await mount(
      <Chat
        agentId={current.agentId}
        messages={messages}
        conversationId={current.conversationId}
        conversationName={current.conversationName}
        initialInput={initialInput}
        initialNotice={initialNotice}
      />,
    );

    if (result && typeof result === "object") {
      const value = result as {
        restart?: boolean;
        load?: {
          agentId?: string;
          messages?: AgentNS.Message[];
          conversationId?: string;
          conversationName?: string;
        };
        messages?: AgentNS.Message[];
        initialInput?: string;
        conversationId?: string;
        conversationName?: string;
        /** `/model` 切换后重挂载：Agent 变了（模型由 Agent 定义承载） */
        agentId?: string;
        /** 重挂载后展示一次的系统提示 */
        notice?: string;
      };
      if (value.load) {
        // /load：整体切换到另一段已保存对话（含 Agent），重挂载对话屏
        current = {
          agentId: value.load.agentId,
          conversationId: value.load.conversationId,
          conversationName: value.load.conversationName,
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
        // `/model` 换模型：Agent 定义里的 modelId 已变，需重建会话（阈值、工具集跟着变）
        if (value.agentId) {
          current = { ...current, agentId: value.agentId };
        }
        continue;
      }
    }
    return;
  }
}

// ==================== 入口 ====================

export async function runTui(): Promise<void> {
  const uninstallSignals = installSignalSafety();
  // 接管 SDK 全局日志：关掉库自带的 console 兜底。必须在任何 Ink 渲染之前——
  // SDK 的 logger 默认是 console.log，直写 stdout 会把界面撕坏
  // （`load_mcp` 甚至会把整份 manifest 打出来）。AIZ_DEBUG_SDK=1 可改为落盘。
  installSdkLogger();
  // 按键诊断：AIZ_DEBUG_KEYS=1 时把终端环境 + 每次按键写进日志（默认关闭，零开销）
  keyDebugStart();

  try {
    // 配置初始化必须早于任何 Agent 读取：
    //   - 目录 / config.json / 默认 Agent / 出厂策略表都在这里释放；
    //   - 历史 Agent 缺 `modelId` 的补齐也在这里（`ensureDefaultAgent`）。
    // 而「续接上一轮会话」这条路径不会经过 `resolveTarget()`，少了这一步，
    // 升级后第一次启动会直接报「Agent 未绑定模型」。
    await ensureConfigDir();

    // 启动界面（一次性）
    await mount(<Splash />);

    // 直达对话：优先续接「上一轮会话」，否则新建对话
    let target: ChatTarget | null = await resumeLastSession();
    if (!target) {
      try {
        target = await resolveTarget();
      } catch (error: any) {
        process.stderr.write(`\n✖ 无法启动对话：${error?.message ?? error}\n`);
      }
    }
    if (!target) {
      farewell();
      return;
    }

    // 端点凭据预检：未配置 API Key 时先弹出输入屏，而不是「报错即退出」
    // 模型从 Agent 定义读 —— 与 SDK 实发请求用的是同一个值
    let modelId: string | null = null;
    try {
      modelId = await modelOf(target.agentId);
    } catch (error: any) {
      process.stderr.write(`\n✖ 无法启动对话：${error?.message ?? error}\n`);
      farewell();
      return;
    }
    if (!(await ensureCredential(modelId))) {
      farewell();
      return;
    }

    await runChat(target);
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
    process.stderr.write(`\n✖ 意外错误: ${(error as any)?.message ?? error}\n`);
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
