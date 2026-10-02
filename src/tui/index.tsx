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
import { AGENTS_DIR, readConfig, saveConfig } from "../config.js";
import { resolveCredential } from "../config-editor.js";
import { ConfigWizard, type WizardCloseResult } from "./config-wizard/index.js";
import { conversationRepository } from "../conversation-repository.js";
import { readLastSession } from "../session-pointer.js";
import { Splash, Chat } from "./screens/index.js";
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
  kittyKeyboard: { mode: "disabled" },
} as const;

function mount(node: Parameters<typeof render>[0]): Promise<unknown> {
  process.stdout.write(CLEAR_SCREEN);
  const instance = render(node, RENDER_OPTIONS);
  activeInstance = instance;
  return instance.waitUntilExit().finally(() => {
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
  modelId: string;
  agentId?: string;
  messages?: AgentNS.Message[];
  conversationId?: string;
  conversationName?: string;
}

async function resolveTarget(): Promise<ChatTarget> {
  const config = await readConfig();
  const repository = new AgentRepository(AGENTS_DIR);
  const agents = await repository.list();

  const agentId = config.defaultAgent ?? agents[0]?.id;
  let modelId: string | undefined;
  if (agentId) {
    const agent = await repository.read(agentId);
    modelId = agent?.modelId;
  }
  modelId = modelId ?? config.defaultModel ?? config.models[0]?.id;

  if (!modelId) {
    throw new Error("没有可用的模型，请先在配置中添加端点与模型（配置文件 config.json）");
  }
  return { modelId, agentId };
}

/** 目标模型是否仍在配置中（续接的会话可能引用了已删除的模型） */
async function modelExists(modelId: string): Promise<boolean> {
  const config = await readConfig();
  return config.models.some((model) => model.id === modelId);
}

/** 读取「上一轮会话 id」指针，续接该会话（指针缺失或会话不存在时返回 null） */
async function resumeLastSession(): Promise<ChatTarget | null> {
  const pointer = await readLastSession();
  if (!pointer) return null;
  const conversation = await conversationRepository.read(pointer.id);
  if (!conversation) return null;
  return targetFromMessages({
    modelId: conversation.modelId,
    agentId: conversation.agentId,
    messages: conversation.messages,
    conversationId: conversation.id,
    conversationName: conversation.id,
  });
}

/** 从已保存对话构造对话目标 */
function targetFromMessages(input: {
  modelId: string;
  agentId?: string;
  messages: AgentNS.Message[];
  conversationId?: string;
  conversationName?: string;
}): ChatTarget {
  return {
    modelId: input.modelId,
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
  let clearTranscript = false;

  while (true) {
    const result = await mount(
      <Chat
        modelId={current.modelId}
        agentId={current.agentId}
        messages={messages}
        conversationId={current.conversationId}
        conversationName={current.conversationName}
        initialInput={initialInput}
        clearTranscript={clearTranscript}
      />,
    );

    if (result && typeof result === "object") {
      const value = result as {
        restart?: boolean;
        load?: {
          modelId: string;
          agentId?: string;
          messages?: AgentNS.Message[];
          conversationId?: string;
          conversationName?: string;
        };
        messages?: AgentNS.Message[];
        initialInput?: string;
        clearTranscript?: boolean;
        conversationId?: string;
        conversationName?: string;
      };
      if (value.load) {
        // /load：整体切换到另一段已保存对话（含模型 / Agent），重挂载对话屏
        current = {
          modelId: value.load.modelId,
          agentId: value.load.agentId,
          conversationId: value.load.conversationId,
          conversationName: value.load.conversationName,
        };
        messages = value.load.messages;
        initialInput = undefined;
        clearTranscript = false;
        continue;
      }
      if (value.restart) {
        messages = value.messages ?? messages;
        initialInput = value.initialInput;
        clearTranscript = Boolean(value.clearTranscript);
        continue;
      }
    }
    return;
  }
}

// ==================== 入口 ====================

export async function runTui(): Promise<void> {
  const uninstallSignals = installSignalSafety();

  try {
    // 启动界面（一次性）
    await mount(<Splash />);

    // 直达对话：优先续接「上一轮会话」，否则新建对话
    let target: ChatTarget | null = await resumeLastSession();
    if (target && !(await modelExists(target.modelId))) {
      // 续接目标引用了已从配置中删除的模型：退回默认模型但保留历史，
      // 避免卡在「模型不存在」的报错屏而无处可走
      const fallback = await resolveTarget().catch(() => null);
      target = fallback
        ? {
            ...fallback,
            messages: target.messages,
            conversationId: target.conversationId,
            conversationName: target.conversationName,
          }
        : null;
    } else if (!target) {
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
    if (!(await ensureCredential(target.modelId))) {
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
