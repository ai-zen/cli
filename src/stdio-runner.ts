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
  AgentRepository,
  AutoRefreshToolsPlugin,
  ContextGuardPlugin,
  setLogger,
} from "@ai-zen/agents-sdk";
import { createAgent } from "./agent-creator.js";
import { AGENTS_DIR, readConfig } from "./config.js";
import { CwdTrackerPlugin } from "./cwd-tracker-plugin.js";
import { SubAgentGuardInstallerPlugin } from "./sub-agent-guard-plugin.js";
import type { TokenThresholds } from "@ai-zen/agents-sdk";
import { generateConversationId, persistConversation } from "./conversation-repository.js";

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
    else if (section.type === "image_url") parts.push(`[Image: ${section.image_url.url}]`);
    else if (section.type === "file")
      parts.push(`[File: ${section.file_id ?? section.filename ?? "inline file"}]`);
  }
  return parts.join("\n");
}

interface ResolvedTarget {
  modelId: string;
  agentId: string;
  /** 当前模型的上下文阈值（交接软线 + 阻断硬线） */
  tokenThresholds?: TokenThresholds;
}

/**
 * 无交互地确定 model / agent / 上下文阈值。
 * 与 TUI 路径不同：这里**绝不弹出选择框**，缺失即视为配置错误。
 */
async function resolveTarget(): Promise<ResolvedTarget> {
  const config = await readConfig();

  const agentId = config.defaultAgent ?? "default";
  const definition = await new AgentRepository(AGENTS_DIR).read(agentId);
  const modelId = definition?.modelId;
  if (!modelId) {
    throw new Error(
      `Agent "${agentId}" has no model bound — run \`ai\` and pick one under /config`,
    );
  }

  const model = config.models.find((m) => m.id === modelId);
  if (!model) throw new Error(`The model "${modelId}" bound to the agent does not exist`);

  const endpoint = config.endpoints.find((e) => e.id === model.endpointId);
  if (!endpoint) throw new Error(`Model "${modelId}" references endpoint "${model.endpointId}", which does not exist`);
  if (!endpoint.apiKey) {
    throw new Error(
      `Endpoint "${endpoint.name}" has no API key yet — run \`ai\` to configure it in the interactive UI`,
    );
  }

  // 阈值由配置直接给出（旧字段已在 SDK 的 ConfigManager.read() 里迁移过）
  return { modelId, agentId, tokenThresholds: model.tokenThresholds };
}

/** 运行一次纯 stdio 对话，返回进程退出码 */
export async function runStdio(options: StdioRunOptions): Promise<number> {
  const { instruction, save } = options;

  const stdinText = await readStdin();
  const prompt = mergePrompt(instruction, stdinText);

  if (!prompt.trim()) {
    logStderr("ai: no input (pass an argument or pipe text in)");
    return 2;
  }

  // 保持 stdout 纯净：SDK 全局日志走 setLogger 改道，
  // 但 SDK（及第三方依赖）内部仍有**直接调用 console.log** 的地方，不经我们的 logger；
  // 管道模式下那会把日志混进模型输出，所以这里连 console.log 一起改道。
  const stderrLogger = (message: string): void => logStderr(message);
  setLogger({ info: stderrLogger, warn: stderrLogger, error: stderrLogger });
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logStderr(args.map((a) => String(a)).join(" "));

  try {
    const { modelId, agentId, tokenThresholds } = await resolveTarget();

    const agent = await createAgent({ agentId });
    agent.use(new CwdTrackerPlugin());
    agent.use(new AutoRefreshToolsPlugin());
    if (tokenThresholds) {
      agent.use(new ContextGuardPlugin({ guardTokens: tokenThresholds.guard }));
      agent.use(new SubAgentGuardInstallerPlugin({ guardTokens: tokenThresholds.guard }));
    }
    await agent.init();

    const messages = await agent.send(prompt);

    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === AgentNS.Role.Assistant);

    if (!lastAssistant || lastAssistant.status === AgentNS.MessageStatus.Error) {
      logStderr("ai: the model returned an error");
      return 1;
    }

    if (save) {
      // 会话名与 TUI 同源（避免两处拼接各自漂移）
      const name = await persistConversation({
        id: generateConversationId(),
        agentId,
        messages: agent.messages,
        // 一次性管道调用只归档，不改「本目录上一轮会话」指针：
        // 否则连跑几条 `cat … | ai --save` 后，下次 `ai` 会续接到最后一条管道结果上
        setAsLastSession: false,
      });
      logStderr(`Saved conversation: ${name}`);
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
