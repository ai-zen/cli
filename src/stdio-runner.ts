/**
 * 纯 stdio 模式运行器
 *
 * 约定（见 TODO §1）：
 *   - 不进入交互循环、不显示横幅、不等待任何按键；
 *   - 仅把**最终 assistant 文本**写入 stdout（零 ANSI、零 emoji 前缀、零 spinner）；
 *   - 日志 / 进度 / SDK 输出一律走 stderr；
 *   - 成功退出码 0，失败非 0。
 *
 * 该模式不落盘（不写草稿 / 对话存档），仅当显式 `--save` 时保存对话存档。
 */

import { AgentNS } from "@ai-zen/agents-core";
import {
  AutoRefreshToolsPlugin,
  ContextGuardPlugin,
  setLogger,
} from "@ai-zen/agents-sdk";
import { createAgent } from "./agent-creator.js";
import { readConfig } from "./config.js";
import { CwdTrackerPlugin } from "./cwd-tracker-plugin.js";
import { SubAgentGuardInstallerPlugin } from "./sub-agent-guard-plugin.js";
import { conversationRepository } from "./conversation-repository.js";
import { formatShortTime } from "./format-time.js";

export interface StdioRunOptions {
  /** 位置参数拼接而成的指令（可空，此时全部内容来自 stdin） */
  instruction: string;
  /** 是否保存对话存档（默认 false，不落盘） */
  save: boolean;
}

/** 向 stderr 写一行（stdlib 日志统一出口） */
function logStderr(line: string): void {
  process.stderr.write(line.endsWith("\n") ? line : line + "\n");
}

/**
 * 读取全部 stdin 文本。
 * stdin 为 TTY（无管道）或读取失败时返回空串。
 */
export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    return Buffer.concat(chunks).toString("utf-8").replace(/\r\n/g, "\n");
  } catch {
    return "";
  }
}

/**
 * 合并「指令 + stdin 内容」（见 TODO §5 开放问题 2：参数为指令、stdin 为内容）。
 * - 两者都有：`指令\n\n内容`
 * - 仅其一：取该者
 */
export function mergePrompt(instruction: string, stdin: string): string {
  const inst = instruction.trim();
  const body = stdin.replace(/\r?\n$/, "");
  if (inst && body.trim()) return `${inst}\n\n${body}`;
  if (inst) return inst;
  return body;
}

/** 从内容块中提取纯文本；非文本块（图片/文件）以占位文本表示 */
export function extractText(content: AgentNS.MessageContent | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;

  const parts: string[] = [];
  for (const section of content) {
    if (section.type === "text") parts.push(section.text);
    else if (section.type === "image_url") parts.push(`[图片: ${section.image_url.url}]`);
    else if (section.type === "file")
      parts.push(`[文件: ${section.file_id ?? section.filename ?? "内联文件"}]`);
  }
  return parts.join("\n");
}

interface ResolvedTarget {
  modelId: string;
  agentId: string;
  maxTokens?: number;
}

/**
 * 无交互地确定 model / agent / 上下文阈值。
 * 与 TUI 路径不同：这里**绝不弹出选择框**，缺失即视为配置错误。
 */
async function resolveTarget(): Promise<ResolvedTarget> {
  const config = await readConfig();

  const modelId = config.defaultModel ?? config.models[0]?.id;
  if (!modelId) throw new Error("没有可用的模型，请先运行 `ai` 完成配置");

  const model = config.models.find((m) => m.id === modelId);
  if (!model) throw new Error(`默认模型 ${modelId} 不存在`);

  const endpoint = config.endpoints.find((e) => e.id === model.endpointId);
  if (!endpoint) throw new Error(`模型 ${modelId} 引用的端点 ${model.endpointId} 不存在`);
  if (!endpoint.apiKey) {
    throw new Error(
      `端点 "${endpoint.name}" 的 API Key 未设置，请先运行 \`ai\` 进入交互界面配置`,
    );
  }

  const maxTokens =
    model.maxContextTokens ??
    (model.maxContextChars ? Math.floor(model.maxContextChars / 4) : undefined);

  return { modelId, agentId: config.defaultAgent ?? "default", maxTokens };
}

/** 运行一次纯 stdio 对话，返回进程退出码 */
export async function runStdio(options: StdioRunOptions): Promise<number> {
  const { instruction, save } = options;

  const stdinText = await readStdin();
  const prompt = mergePrompt(instruction, stdinText);

  if (!prompt.trim()) {
    logStderr("ai: 没有输入内容（请提供参数，或通过管道传入文本）");
    return 2;
  }

  // 保持 stdout 纯净：SDK 全局日志与 console.log 统一改道 stderr
  const stderrLogger = (message: string): void => logStderr(message);
  setLogger({ info: stderrLogger, warn: stderrLogger, error: stderrLogger });
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logStderr(args.map((a) => String(a)).join(" "));

  try {
    const { modelId, agentId, maxTokens } = await resolveTarget();

    const agent = await createAgent({ agentId });
    agent.use(new CwdTrackerPlugin());
    agent.use(new AutoRefreshToolsPlugin());
    if (maxTokens && maxTokens > 0) {
      agent.use(new ContextGuardPlugin({ maxTokens }));
      agent.use(new SubAgentGuardInstallerPlugin({ maxTokens }));
    }
    await agent.init();

    const messages = await agent.send(prompt);

    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === AgentNS.Role.Assistant);

    if (!lastAssistant || lastAssistant.status === AgentNS.MessageStatus.Error) {
      logStderr("ai: 模型返回错误");
      return 1;
    }

    if (save) {
      const name = `对话_${formatShortTime(new Date().toISOString())}`;
      const now = new Date().toISOString();
      await conversationRepository.write({
        id: name.replace(/[\\/:*?"<>|]/g, "_"),
        agentId,
        modelId,
        messages: agent.messages,
        cwd: process.cwd(),
        createdAt: now,
        updatedAt: now,
      });
      logStderr(`已保存对话: ${name}`);
    }

    // 结果：仅此一处写入 stdout
    const text = extractText(lastAssistant.content);
    if (text) process.stdout.write(text.endsWith("\n") ? text : text + "\n");
    return 0;
  } catch (error: any) {
    logStderr(`ai: ${error?.message ?? error}`);
    return 1;
  } finally {
    // 恢复被改道的 console（进程通常随即退出，但保持副作用可逆）
    setLogger({
      info: originalLog,
      warn: console.warn,
      error: console.error,
    });
    console.log = originalLog;
  }
}
