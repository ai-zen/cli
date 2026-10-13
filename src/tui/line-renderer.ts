/**
 * 行式渲染器 —— 把「正在生成的 assistant 消息」增量追加到输出，**只追加、不重绘**。
 *
 * 用于 SSH / 弱网：Ink 每帧会 erase + 整屏重写，流式高频下会填满 pty 缓冲、拖断连接；
 * 这里改为纯 append 的文本流，输出量正比于文本量（而非帧率 × 屏幕大小）。
 *
 * 数据源与 TUI 一致：读取 SDK 的 `agent.messages`（当前那条正在增长的 message），
 * 按 `reasoning_content → tool_calls → content` 的固定顺序增量打印。
 *
 * ⚠️ 已停用（2026-10 定案）：Ink 开启 `incrementalRendering` 后，弱网流式已稳定，
 * 不再需要「挂起 Ink + 行式直播」。本模块保留备查，未接入主流程。
 */
import { AgentNS } from "@ai-zen/agents-core";
import { messageText } from "./screens/messages-view.js";

export class LineRenderer {
  private reasoningShown = 0;
  private contentShown = 0;
  private toolsShown = 0;
  private headerShown = false;
  private messageId: string | null = null;

  constructor(private readonly write: (text: string) => void = (t) => process.stdout.write(t)) {}

  /** 用当前（可能仍在增长的）消息刷新输出；重复调用只打印新增部分 */
  update(message: AgentNS.Message): void {
    if (message.role !== AgentNS.Role.Assistant) return;
    if (message.id !== this.messageId) {
      // 新的一轮 assistant（多轮工具调用）：重置游标
      this.messageId = message.id;
      this.reasoningShown = 0;
      this.contentShown = 0;
      this.toolsShown = 0;
      this.headerShown = false;
    }

    const reasoning = message.reasoning_content ?? "";
    const content = messageText(message.content);
    const tools = message.tool_calls ?? [];

    if (!this.headerShown && (reasoning || content || tools.length > 0)) {
      this.write("\n✦ AI\n");
      this.headerShown = true;
    }
    if (reasoning.length > this.reasoningShown) {
      this.write(reasoning.slice(this.reasoningShown));
      this.reasoningShown = reasoning.length;
    }
    while (this.toolsShown < tools.length) {
      const tool = tools[this.toolsShown]!;
      this.write(`\n  ⚙ ${tool.function?.name ?? ""}`);
      this.toolsShown += 1;
    }
    if (content.length > this.contentShown) {
      this.write(content.slice(this.contentShown));
      this.contentShown = content.length;
    }
  }
}
