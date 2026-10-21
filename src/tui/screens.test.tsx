import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { StatusBar, SlashMenu, SelectList } from "./components.js";
import {
  Splash,
  displayWidth,
  wrapText,
  messageToLines,
  cachedMessageToLines,
  transcriptLines,
  inputLines,
  computeInputCursorPosition,
  usableFrameRows,
  wordLeft,
  wordRight,
  deleteWordLeft,
  deleteWordRight,
  deleteToLineEnd,
  deleteToLineStart,
  computeChatLayout,
  resolveSubmitText,
  stripCwdNote,
  type RLine,
} from "./screens/index.js";
import { getCommandHints, matchCommandHints } from "../conversation-commands/registry.js";
import { isTerminalReply } from "./text.js";
import { RENDER_OPTIONS } from "./index.js";
import { AgentNS } from "@ai-zen/agents-core";

const tick = () => new Promise((r) => setTimeout(r, 25));

let seq = 0;
function msg(partial: Partial<AgentNS.Message> & { role: AgentNS.Role }): AgentNS.Message {
  return { id: `m${++seq}`, ...partial } as AgentNS.Message;
}

describe("isTerminalReply（终端应答序列过滤）", () => {
  it("识别 Kitty 键盘协议应答 / 光标位置报告 / 设备状态报告", () => {
    expect(isTerminalReply("[?0u")).toBe(true);
    expect(isTerminalReply("[?1u")).toBe(true);
    expect(isTerminalReply("[?5u")).toBe(true);
    expect(isTerminalReply("[12;34R")).toBe(true);
    expect(isTerminalReply("[?25n")).toBe(true);
  });

  it("不误伤普通输入", () => {
    expect(isTerminalReply("")).toBe(false);
    expect(isTerminalReply("hello")).toBe(false);
    expect(isTerminalReply("[?")).toBe(false);
    expect(isTerminalReply("[?0")).toBe(false);
    expect(isTerminalReply("[?0u ")).toBe(false);
    expect(isTerminalReply("你看这个 [?0u 是不是很奇怪")).toBe(false);
  });
});

describe("RENDER_OPTIONS（终端协议决策锁定）", () => {
  it("锁定关键终端决策：Kitty 协议关闭 + 增量渲染开启", () => {
    expect(RENDER_OPTIONS.kittyKeyboard.mode).toBe("disabled");
    expect(RENDER_OPTIONS.exitOnCtrlC).toBe(false);
    expect(RENDER_OPTIONS.alternateScreen).toBe(false);
    expect(RENDER_OPTIONS.incrementalRendering).toBe(true);
  });
});

describe("StatusBar", () => {
  it("展示模型、Agent、本轮与累计 token", () => {
    const { lastFrame, unmount } = render(
      <StatusBar model="deepseek-v4-flash" agent="default" lastTokens={123} totalTokens={4567} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("deepseek-v4-flash");
    expect(frame).toContain("default");
    expect(frame).toContain("本轮 123");
    expect(frame).toContain("累计 4567");
    unmount();
  });
});

describe("SlashMenu", () => {
  it("渲染命令清单与说明", () => {
    const hints = getCommandHints();
    const { lastFrame, unmount } = render(<SlashMenu hints={hints} selected={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("/help");
    expect(frame).toContain("显示此帮助");
    unmount();
  });
});

describe("resolveSubmitText（回车执行高亮命令）", () => {
  it("仅输入 `/` 时回车执行高亮命令，而不是提交半截输入", () => {
    const hints = matchCommandHints("");
    expect(resolveSubmitText("/", hints, 0)).toBe(`/${hints[0]!.names[0]}`);
    expect(resolveSubmitText("/", hints, 2)).toBe(`/${hints[2]!.names[0]}`);
    expect(hints[hints.length - 1]!.names[0]).toBe("exit");
  });

  it("前缀匹配时执行高亮的那一条", () => {
    const hints = matchCommandHints("c");
    expect(hints.map((hint) => hint.names[0])).toEqual(["clear", "config"]);
    expect(resolveSubmitText("/c", hints, 0)).toBe("/clear");
    expect(resolveSubmitText("/c", hints, 1)).toBe("/config");
  });

  it("索引越界时回落到最后一项", () => {
    const hints = matchCommandHints("c");
    expect(resolveSubmitText("/c", hints, 99)).toBe("/config");
  });

  it("非斜杠输入原样返回", () => {
    expect(resolveSubmitText("hello", [], 0)).toBe("hello");
    expect(resolveSubmitText("/help now", matchCommandHints("help"), 0)).toBe("/help now");
  });
});

describe("SelectList", () => {
  it("方向键移动、回车确认", async () => {
    const onSelect = vi.fn();
    const { stdin, unmount } = render(
      <SelectList
        items={[
          { label: "第一项", value: "a" },
          { label: "第二项", value: "b" },
        ]}
        onSelect={onSelect}
      />,
    );
    stdin.write("\x1b[B");
    await tick();
    stdin.write("\r");
    await tick();
    expect(onSelect).toHaveBeenCalledWith("b");
    unmount();
  });
});

describe("Splash", () => {
  it("显示品牌标语与版本", () => {
    const { lastFrame, unmount } = render(<Splash />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("终端里的 AI 协作台");
    expect(frame).toContain("v");
    unmount();
  });
});

describe("stripCwdNote", () => {
  it("去除首次注入的工作目录后缀", () => {
    expect(stripCwdNote("你好\n当前工作目录: C:\\proj")).toBe("你好");
  });
  it("去除带变更标记的后缀", () => {
    expect(stripCwdNote("你好\n\n[工作目录变更]\n当前工作目录: /tmp/x")).toBe("你好");
  });
  it("无后缀时原样返回", () => {
    expect(stripCwdNote("纯文本")).toBe("纯文本");
  });
});

describe("messageToLines（直接按 messages 渲染）", () => {
  it("user 消息 → 空行 + 标题 + 缩进正文", () => {
    const lines = messageToLines(msg({ role: AgentNS.Role.User, content: "你好" }), 80);
    expect(lines[0].kind).toBe("gap");
    expect(lines[1].text).toBe("❯ 你");
    expect(lines[2].text).toBe("  你好");
  });

  it("user 消息剥离工作目录后缀", () => {
    const lines = messageToLines(
      msg({ role: AgentNS.Role.User, content: "你好\n当前工作目录: /tmp" }),
      80,
    );
    expect(lines[2].text).toBe("  你好");
  });

  it("assistant 按「思考 → 工具 → 正文」自然顺序", () => {
    const lines = messageToLines(
      msg({
        role: AgentNS.Role.Assistant,
        reasoning_content: "想一想",
        content: "最终答案",
        tool_calls: [
          { index: 0, id: "t", type: "function", function: { name: "read", arguments: "{}" } },
        ],
      } as Partial<AgentNS.Message> & { role: AgentNS.Role }),
      80,
    );
    const kinds = lines.map((l) => l.kind);
    expect(lines[1].text).toBe("✦ AI");
    const iReason = kinds.indexOf("reasoning");
    const iTool = kinds.indexOf("tool");
    const iContent = kinds.lastIndexOf("content");
    expect(iReason).toBeGreaterThanOrEqual(0);
    expect(iTool).toBeGreaterThan(iReason);
    expect(iContent).toBeGreaterThan(iTool);
  });

  it("思考与工具调用之间留一个空行", () => {
    const lines = messageToLines(
      msg({
        role: AgentNS.Role.Assistant,
        reasoning_content: "想一想",
        tool_calls: [
          { index: 0, id: "t", type: "function", function: { name: "read", arguments: "{}" } },
        ],
      } as Partial<AgentNS.Message> & { role: AgentNS.Role }),
      80,
    );
    const kinds = lines.map((l) => l.kind);
    const lastReason = kinds.lastIndexOf("reasoning");
    const firstTool = kinds.indexOf("tool");
    expect(lastReason).toBeGreaterThanOrEqual(0);
    expect(firstTool).toBe(lastReason + 2);
    expect(lines[lastReason + 1].kind).toBe("gap");
  });

  it("无思考时工具调用不留多余空行", () => {
    const lines = messageToLines(
      msg({
        role: AgentNS.Role.Assistant,
        tool_calls: [
          { index: 0, id: "t", type: "function", function: { name: "read", arguments: "{}" } },
        ],
      } as Partial<AgentNS.Message> & { role: AgentNS.Role }),
      80,
    );
    const kinds = lines.map((l) => l.kind);
    expect(kinds.indexOf("tool")).toBe(2); // gap + ai-header + tool
  });

  it("空 assistant / system / tool 不渲染", () => {
    expect(messageToLines(msg({ role: AgentNS.Role.Assistant }), 80)).toEqual([]);
    expect(messageToLines(msg({ role: AgentNS.Role.System, content: "s" }), 80)).toEqual([]);
    expect(messageToLines(msg({ role: AgentNS.Role.Tool, content: "r" }), 80)).toEqual([]);
  });

  it("hidden / omit 跳过", () => {
    expect(messageToLines(msg({ role: AgentNS.Role.User, content: "x", hidden: true }), 80)).toEqual([]);
    expect(messageToLines(msg({ role: AgentNS.Role.User, content: "x", omit: true }), 80)).toEqual([]);
  });

  it("内容数组中的图片 / 文件以占位文本呈现", () => {
    const lines = messageToLines(
      msg({
        role: AgentNS.Role.User,
        content: [{ type: "image_url", image_url: { url: "http://x/y.png" } }],
      } as unknown as Partial<AgentNS.Message> & { role: AgentNS.Role }),
      80,
    );
    expect(lines[2].text).toContain("[图片:");
  });
});

describe("transcriptLines（整段转录）", () => {
  it("串联多条消息并跳过不可渲染项", () => {
    const messages = [
      msg({ role: AgentNS.Role.System, content: "sys" }),
      msg({ role: AgentNS.Role.User, content: "你好" }),
      msg({ role: AgentNS.Role.Assistant, content: "你好呀" }),
    ];
    const lines = transcriptLines(messages, 80);
    expect(lines.some((l) => l.text === "❯ 你")).toBe(true);
    expect(lines.some((l) => l.text === "✦ AI")).toBe(true);
  });

  it("系统消息与空回复不产生行", () => {
    const messages = [
      msg({ role: AgentNS.Role.System, content: "sys" }),
      msg({ role: AgentNS.Role.Assistant, content: "" }),
    ];
    expect(transcriptLines(messages, 80)).toHaveLength(0);
  });
});

describe("cachedMessageToLines（缓存）", () => {
  it("同一消息 + 列宽 + 签名 → 命中缓存（同一引用）", () => {
    const m = msg({ role: AgentNS.Role.User, content: "hi" });
    expect(cachedMessageToLines(m, 80)).toBe(cachedMessageToLines(m, 80));
  });

  it("内容签名变化时重算（流式增长不拿陈旧结果）", () => {
    const m = msg({ role: AgentNS.Role.Assistant, content: "a" });
    const first = cachedMessageToLines(m, 80);
    (m as { content: AgentNS.MessageContent }).content = "abcdef";
    expect(cachedMessageToLines(m, 80)).not.toBe(first);
  });

  it("列宽变化时重算", () => {
    const m = msg({ role: AgentNS.Role.User, content: "hi" });
    expect(cachedMessageToLines(m, 80)).not.toBe(cachedMessageToLines(m, 40));
  });
});

describe("文本测量与折行", () => {
  it("displayWidth 将宽字符计为 2", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("中文")).toBe(4);
    expect(displayWidth("a中")).toBe(3);
  });

  it("wrapText 按显示宽度折行且不超宽", () => {
    expect(wrapText("", 10)).toEqual([""]);
    const lines = wrapText("a".repeat(21), 10);
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(10);
    expect(wrapText("中文中文中文", 4)).toEqual(["中文", "中文", "中文"]);
    expect(wrapText("a\nb", 10)).toEqual(["a", "b"]);
  });

  it("inputLines：空输入显示占位提示", () => {
    expect(inputLines("", 80)).toEqual(["输入消息，/ 查看命令…"]);
    expect(inputLines("hi", 80)).toEqual(["hi"]);
  });
});

describe("computeChatLayout（吸底 + 应用内翻页）", () => {
  const line = (i: number): RLine => ({ key: `k${i}`, kind: "content", text: `L${i}` });
  const base = {
    columns: 80,
    rows: 24,
    transcript: [] as RLine[],
    input: "",
    busy: false,
    hintCount: 0,
    overlay: "none" as const,
    pickerItems: 0,
  };

  it("空转录：对话区全部补齐，行数 = rows − 底部区域", () => {
    const layout = computeChatLayout(base);
    expect(layout.bottomLines).toBe(3);
    expect(layout.lines).toHaveLength(21);
    expect(layout.lines.every((l) => l.kind === "gap")).toBe(true);
  });

  it("内容超出时自底部截断，最新一条在最后", () => {
    const transcript = Array.from({ length: 30 }, (_, i) => line(i));
    const layout = computeChatLayout({ ...base, transcript });
    expect(layout.lines).toHaveLength(21);
    expect(layout.lines[20].text).toBe("L29");
  });

  it("通知栏抬高底部区域、压缩对话区", () => {
    const without = computeChatLayout(base);
    const withNotice = computeChatLayout({ ...base, noticeCount: 2 });
    expect(withNotice.bottomLines).toBe(without.bottomLines + 2);
  });

  it("确认 / 选择覆盖层替换输入区高度", () => {
    expect(computeChatLayout({ ...base, overlay: "confirm" }).bottomLines).toBe(7);
    expect(computeChatLayout({ ...base, overlay: "picker", pickerItems: 3 }).bottomLines).toBe(11);
  });

  it("viewTop 指定时显示对应窗口，越界钳制", () => {
    const transcript = Array.from({ length: 30 }, (_, i) => line(i));
    const top = computeChatLayout({ ...base, transcript, viewTop: 0 });
    expect(top.viewTop).toBe(0);
    expect(top.scrolled).toBe(true);
    expect(top.lines[0].text).toBe("L0");
    const high = computeChatLayout({ ...base, transcript, viewTop: 9999 });
    expect(high.viewTop).toBe(9);
    expect(high.scrolled).toBe(false);
  });

  it("多行输入抬高底部区域、压缩对话区", () => {
    const single = computeChatLayout({ ...base, input: "x" });
    const multi = computeChatLayout({ ...base, input: "x\ny\nz" });
    expect(multi.bottomLines).toBe(single.bottomLines + 2);
    expect(multi.lines.length).toBe(single.lines.length - 2);
  });
});

describe("computeInputCursorPosition（IME 光标定位）", () => {
  const base = {
    transcriptLines: 10,
    hintCount: 0,
    cursorRow: 0,
    cursorCol: 0,
    lineText: "",
    placeholder: false,
  };

  it("列 = 前缀宽度 + 光标前文本显示宽度", () => {
    expect(computeInputCursorPosition({ ...base, cursorCol: 3, lineText: "abc" })).toEqual({
      x: 6,
      y: 11,
    });
  });

  it("宽字符按显示宽度累计", () => {
    expect(computeInputCursorPosition({ ...base, cursorCol: 2, lineText: "中文" }).x).toBe(7);
  });

  it("占位状态光标停在前缀之后", () => {
    expect(computeInputCursorPosition({ ...base, placeholder: true }).x).toBe(3);
  });

  it("y 计入对话区 / 斜杠菜单 / 分隔线与输入行偏移", () => {
    expect(
      computeInputCursorPosition({ ...base, transcriptLines: 5, hintCount: 2, cursorRow: 1 }).y,
    ).toBe(9);
  });
});

describe("usableFrameRows（预留末行，避开 Ink 全屏分支）", () => {
  it("整帧高度 = 终端行数 − 1", () => {
    expect(usableFrameRows(24)).toBe(23);
    expect(usableFrameRows(80)).toBe(79);
  });
  it("退化场景下不小于 1", () => {
    expect(usableFrameRows(1)).toBe(1);
    expect(usableFrameRows(0)).toBe(1);
  });
});

describe("跨词移动（Ctrl/Alt + ← →）", () => {
  it("wordLeft / wordRight 跨词", () => {
    expect(wordLeft("hello world", 11)).toBe(6);
    expect(wordRight("hello world", 0)).toBe(5);
  });
  it("越界钳制", () => {
    expect(wordLeft("hi", 0)).toBe(0);
    expect(wordRight("hi", 2)).toBe(2);
  });
});

describe("按词删除（Ctrl+W / Alt+Backspace、Alt+D / Ctrl+Delete、Ctrl+K）", () => {
  it("deleteWordLeft 删掉光标前的分隔符与单词", () => {
    expect(deleteWordLeft("hello world", 11)).toEqual({ text: "hello ", cursor: 6 });
    // 词尾带空格时，空格也一并吃掉（与 readline 的 backward-kill-word 一致）
    expect(deleteWordLeft("hello world ", 12)).toEqual({ text: "hello ", cursor: 6 });
    // 光标已在词首时，吃掉的是前一个词与它后面的空格
    expect(deleteWordLeft("hello world", 6)).toEqual({ text: "world", cursor: 0 });
  });
  it("deleteWordLeft 在光标为 0 时为空操作", () => {
    expect(deleteWordLeft("hello", 0)).toEqual({ text: "hello", cursor: 0 });
  });
  it("deleteWordRight 删掉光标后到词尾（分隔符保留，与 readline M-d 一致）", () => {
    expect(deleteWordRight("hello world", 0)).toEqual({ text: " world", cursor: 0 });
    expect(deleteWordRight("hello world", 5)).toEqual({ text: "hello", cursor: 5 });
  });
  it("deleteWordRight 在行尾时为空操作", () => {
    expect(deleteWordRight("hello", 5)).toEqual({ text: "hello", cursor: 5 });
  });
  it("CJK 文本按「整段非空白」算一个词", () => {
    expect(deleteWordLeft("你好，世界", 5)).toEqual({ text: "", cursor: 0 });
    expect(deleteWordRight("你好，世界", 0)).toEqual({ text: "", cursor: 0 });
  });
  it("deleteToLineEnd 删到行尾（保留换行），行尾时吃掉换行", () => {
    expect(deleteToLineEnd("abc\ndef", 1)).toEqual({ text: "a\ndef", cursor: 1 });
    expect(deleteToLineEnd("abc\ndef", 3)).toEqual({ text: "abcdef", cursor: 3 });
    expect(deleteToLineEnd("abc", 3)).toEqual({ text: "abc", cursor: 3 });
  });
  it("deleteToLineStart 删到行首（Ctrl+U，macOS 的 ⌘⌫ 会落到这里）", () => {
    expect(deleteToLineStart("abc def", 7)).toEqual({ text: "", cursor: 0 });
    expect(deleteToLineStart("abc def", 4)).toEqual({ text: "def", cursor: 0 });
    // 多行：只影响当前行，上一行不受影响
    expect(deleteToLineStart("foo\nbar", 7)).toEqual({ text: "foo\n", cursor: 4 });
    expect(deleteToLineStart("foo\nbar", 4)).toEqual({ text: "foo\nbar", cursor: 4 });
  });
  it("跨行时只影响当前行", () => {
    expect(deleteWordLeft("foo\nbar baz", 11)).toEqual({ text: "foo\nbar ", cursor: 8 });
  });
});
