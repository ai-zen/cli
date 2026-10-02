import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { StatusBar, SlashMenu, SelectList } from "./components.js";
import { syntax } from "./theme.js";
import {
  Splash,
  chatReducer,
  messagesToBlocks,
  displayWidth,
  wrapText,
  blockToLines,
  liveToLines,
  inputLines,
  layoutInput,
  computeInputCursorPosition,
  usableFrameRows,
  wordLeft,
  wordRight,
  computeChatLayout,
  resolveSubmitText,
  type ChatState,
  type Block,
} from "./screens/index.js";
import { getCommandHints, matchCommandHints } from "../conversation-commands/registry.js";
import { stripCwdNote } from "./chat-session.js";
import { isTerminalReply } from "./text.js";
import { RENDER_OPTIONS } from "./index.js";
import { AgentNS } from "@ai-zen/agents-core";

const tick = () => new Promise((r) => setTimeout(r, 25));

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
  it("关闭 Kitty 键盘协议自动查询：避免 CSI ? u 应答漏进输入框", () => {
    // 背景：Ink 的 auto 模式每次挂载都发 `CSI ? u`，终端回 `CSI ? 0 u`；
    // 应答被拆包时残留的 `[?0u` 会被当成用户输入插入输入框（已实测重现）。
    expect(RENDER_OPTIONS.kittyKeyboard.mode).toBe("disabled");
    expect(RENDER_OPTIONS.exitOnCtrlC).toBe(false);
    expect(RENDER_OPTIONS.alternateScreen).toBe(false);
  });
});

describe("StatusBar", () => {
  it("展示模型、Agent 与 token", () => {
    const { lastFrame, unmount } = render(
      <StatusBar model="deepseek-v4-flash" agent="default" tokens={123} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("deepseek-v4-flash");
    expect(frame).toContain("default");
    expect(frame).toContain("123");
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
    // exit 已移到末尾：只输入 `/` 回车不会误退出（高亮项是首项）
    expect(hints[hints.length - 1]!.names[0]).toBe("exit");
  });

  it("前缀匹配时执行高亮的那一条", () => {
    const hints = matchCommandHints("c"); // clear / config
    expect(hints.map((hint) => hint.names[0])).toEqual(["clear", "config"]);
    expect(resolveSubmitText("/c", hints, 0)).toBe("/clear");
    expect(resolveSubmitText("/c", hints, 1)).toBe("/config");
  });

  it("索引越界时回落到最后一项（避免菜单看似选中却回车落空）", () => {
    const hints = matchCommandHints("c");
    expect(resolveSubmitText("/c", hints, 99)).toBe("/config");
  });

  it("非斜杠输入原样返回", () => {
    expect(resolveSubmitText("hello", [], 0)).toBe("hello");
    // 含空格视为「已带参数」，不再当作候选选择
    expect(resolveSubmitText("/help now", matchCommandHints("help"), 0)).toBe("/help now");
  });

  it("无候选（未知命令）时原样返回，交由 runCommand 报错", () => {
    expect(resolveSubmitText("/zzz", [], 0)).toBe("/zzz");
  });
});

describe("SelectList", () => {
  it("方向键移动、回车确认", async () => {
    const onSelect = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      <SelectList
        items={[
          { label: "第一项", value: "a" },
          { label: "第二项", value: "b" },
        ]}
        onSelect={onSelect}
      />,
    );
    expect(lastFrame()).toContain("第一项");
    stdin.write("\x1b[B"); // ↓
    await tick();
    stdin.write("\r"); // Enter
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

describe("chatReducer 流式拼接", () => {
  const initial: ChatState = { blocks: [], live: null };

  it("累积 content/reasoning 并在 done 时归档", () => {
    let s = chatReducer(initial, { type: "user", text: "你好" });
    expect(s.blocks).toHaveLength(1);
    expect(s.live).not.toBeNull();

    s = chatReducer(s, { type: "assistant-start" });
    s = chatReducer(s, { type: "reasoning", text: "思考" });
    s = chatReducer(s, { type: "content", text: "Hello" });
    s = chatReducer(s, { type: "content", text: " world" });
    expect(s.live?.content).toBe("Hello world");
    expect(s.live?.reasoning).toBe("思考");

    s = chatReducer(s, { type: "done" });
    expect(s.live).toBeNull();
    expect(s.blocks).toHaveLength(2);
    expect(s.blocks[1]).toMatchObject({ kind: "assistant", content: "Hello world" });
  });

  it("请求失败（空回复）不产生空白的 AI 块", () => {
    let s = chatReducer(initial, { type: "user", text: "hi" });
    s = chatReducer(s, { type: "error", text: "Connection error." });
    s = chatReducer(s, { type: "done" });
    expect(s.live).toBeNull();
    // 仅 user + error 两个块，无空 assistant 块
    expect(s.blocks).toHaveLength(2);
    expect(s.blocks.some((b) => b.kind === "assistant")).toBe(false);
  });

  it("工具调用按 index 归并", () => {
    let s = chatReducer(initial, { type: "user", text: "x" });
    s = chatReducer(s, { type: "tool", index: 0, name: "read" });
    s = chatReducer(s, { type: "tool", index: 0, name: "File" });
    s = chatReducer(s, { type: "tool", index: 0, args: "{}" });
    expect(s.live?.tools[0]).toEqual({ name: "readFile", args: "{}" });
  });

  it("多轮工具调用按轮分段：新一轮 index 从 0 起，不与上一轮拼接", () => {
    let s = chatReducer(initial, { type: "user", text: "x" });
    s = chatReducer(s, { type: "assistant-start" });
    // 第一轮：并行两个工具（index 0 / 1）
    s = chatReducer(s, { type: "tool", index: 0, name: "read" });
    s = chatReducer(s, { type: "tool", index: 1, name: "grep" });
    // 第二轮：index 又从 0 重新计数
    s = chatReducer(s, { type: "assistant-start" });
    s = chatReducer(s, { type: "tool", index: 0, name: "edit" });
    s = chatReducer(s, { type: "tool", index: 1, name: "write" });
    expect(s.live?.tools.map((t) => t.name)).toEqual(["read", "grep", "edit", "write"]);
  });

  it("clear 清空全部", () => {
    let s = chatReducer(initial, { type: "user", text: "x" });
    s = chatReducer(s, { type: "clear" });
    expect(s.blocks).toHaveLength(0);
    expect(s.live).toBeNull();
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

describe("messagesToBlocks（重建历史）", () => {
  it("从消息数组还原 user / assistant 块", () => {
    const messages = [
      { id: "s", role: AgentNS.Role.System, content: "系统" },
      { id: "u", role: AgentNS.Role.User, content: "你好" },
      { id: "a", role: AgentNS.Role.Assistant, content: "你好呀" },
    ] as unknown as AgentNS.Message[];
    const blocks = messagesToBlocks(messages);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: "user", text: "你好" });
    expect(blocks[1]).toMatchObject({ kind: "assistant", content: "你好呀" });
  });

  it("跳过系统消息与空回复", () => {
    const messages = [
      { id: "s", role: AgentNS.Role.System, content: "系统" },
      { id: "a", role: AgentNS.Role.Assistant, content: "" },
    ] as unknown as AgentNS.Message[];
    expect(messagesToBlocks(messages)).toHaveLength(0);
  });
});

describe("吸底布局：文本测量与折行", () => {
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
});

describe("吸底布局：块 → 行", () => {
  it("user 块含前导空行、标题与缩进正文", () => {
    const lines = blockToLines({ id: 1, kind: "user", text: "你好" }, 80);
    expect(lines[0].kind).toBe("gap");
    expect(lines[1]).toEqual({ key: "b1-h", kind: "user-header", text: "❯ 你" });
    expect(lines[2]).toMatchObject({ kind: "user-text", text: "  你好" });
  });

  it("assistant 块按 思考 / 工具 / 正文 分行", () => {
    const lines = blockToLines(
      { id: 2, kind: "assistant", reasoning: "想", content: "答", tools: [{ name: "read", args: "{}" }] },
      80,
    );
    const kinds = lines.map((line) => line.kind);
    expect(kinds).toContain("reasoning");
    expect(kinds).toContain("tool");
    expect(kinds).toContain("content");
    expect(lines.find((line) => line.kind === "tool")?.text).toBe("  ⚙ read({})");
  });

  it("工具调用行内联展示参数：折叠空白、超宽裁剪为单行", () => {
    const line = blockToLines(
      {
        id: 8,
        kind: "assistant",
        reasoning: "",
        content: "",
        tools: [{ name: "exec", args: '{\n  "command": "npm test"\n}' }],
      },
      80,
    ).find((l) => l.kind === "tool");
    expect(line?.text).toBe('  ⚙ exec({ "command": "npm test" })');

    const narrow = blockToLines(
      {
        id: 9,
        kind: "assistant",
        reasoning: "",
        content: "",
        tools: [{ name: "exec", args: `{"command":"${"x".repeat(200)}"}` }],
      },
      20,
    ).find((l) => l.kind === "tool");
    expect(displayWidth(narrow?.text ?? "")).toBeLessThanOrEqual(18);
    expect(narrow?.text.endsWith("…")).toBe(true);
  });

  it("工具调用行的参数带 JSON 高亮分段", () => {
    const line = blockToLines(
      {
        id: 10,
        kind: "assistant",
        reasoning: "",
        content: "",
        tools: [{ name: "exec", args: '{"n":1}' }],
      },
      80,
    ).find((l) => l.kind === "tool");
    expect(line?.text).toBe('  ⚙ exec({"n":1})');
    expect(line?.spans?.some((s) => s.text === '"n"' && s.color === syntax.attr?.color)).toBe(true);
    expect(line?.spans?.some((s) => s.text === "1" && s.color === syntax.number?.color)).toBe(true);
  });

  it("正文里的围栏代码块按语言高亮，且不显示裸围栏", () => {
    const lines = blockToLines(
      {
        id: 11,
        kind: "assistant",
        reasoning: "",
        content: "看：\n```typescript\nconst a = 1;\n```\n完",
        tools: [],
      },
      80,
    );
    const texts = lines.map((l) => l.text);
    expect(texts).toContain("  const a = 1;");
    expect(texts.some((t) => t.includes("```"))).toBe(false);
    const codeLine = lines.find((l) => l.text === "  const a = 1;");
    expect(codeLine?.spans?.some((s) => s.text === "const" && s.color === syntax.keyword?.color)).toBe(true);
  });

  it("思考 / 工具与正文之间有空行（完成态与流式一致）", () => {
    const completed = blockToLines(
      { id: 7, kind: "assistant", reasoning: "想", content: "答", tools: [] },
      80,
    ).map((line) => line.kind);
    const live = liveToLines(
      { reasoning: "想", content: "答", tools: [], sub: null },
      80,
    ).map((line) => line.kind);
    for (const kinds of [completed, live]) {
      const r = kinds.indexOf("reasoning");
      const c = kinds.indexOf("content");
      expect(kinds[r + 1]).toBe("gap");
      expect(c).toBe(r + 2);
    }
  });

  it("notice 块无前导空行", () => {
    const lines = blockToLines({ id: 3, kind: "notice", tone: "error", text: "boom" }, 80);
    expect(lines[0].kind).toBe("error");
    expect(lines[0].text).toBe("  ✖ boom");
  });
});

describe("computeChatLayout（吸底）", () => {
  const base = {
    columns: 80,
    rows: 24,
    blocks: [] as Block[],
    live: null,
    input: "",
    busy: false,
    hintCount: 0,
    overlay: "none" as const,
    pickerItems: 0,
  };

  it("对话区行数恒为「总行数 − 底部区域」，空对话时全部补齐", () => {
    const layout = computeChatLayout(base);
    expect(layout.bottomLines).toBe(3);
    expect(layout.lines).toHaveLength(21);
    expect(layout.lines.every((line) => line.kind === "gap")).toBe(true);
  });

  it("内容超出时自底部截断、不再补齐，最新一条在最后", () => {
    const blocks: Block[] = Array.from({ length: 20 }, (_, i) => ({
      id: i,
      kind: "user" as const,
      text: `m${i}`,
    }));
    const layout = computeChatLayout({ ...base, blocks });
    expect(layout.lines).toHaveLength(21);
    expect(layout.lines[20].text).toBe("  m19");
  });

  it("确认覆盖层替换输入区", () => {
    expect(computeChatLayout({ ...base, overlay: "confirm" }).bottomLines).toBe(7);
  });

  it("选择覆盖层随条目数增高", () => {
    expect(computeChatLayout({ ...base, overlay: "picker", pickerItems: 3 }).bottomLines).toBe(11);
  });

  it("多行输入抬高底部区域、压缩对话区", () => {
    const single = computeChatLayout({ ...base, input: "x" });
    const multi = computeChatLayout({ ...base, input: "x\ny\nz" });
    expect(multi.bottomLines).toBe(single.bottomLines + 2);
    expect(multi.lines.length).toBe(single.lines.length - 2);
  });

  it("inputLines：空输入显示占位提示", () => {
    expect(inputLines("", 80)).toEqual(["输入消息，/ 查看命令…"]);
    expect(inputLines("hi", 80)).toEqual(["hi"]);
  });
});

describe("computeChatLayout（应用内翻页）", () => {
  const base = {
    columns: 80,
    rows: 24,
    blocks: [] as Block[],
    live: null,
    input: "",
    busy: false,
    hintCount: 0,
    overlay: "none" as const,
    pickerItems: 0,
  };
  // 每个 user 块 = 空行 + 标题 + 正文 = 3 行；20 条 → 60 行
  const blocks: Block[] = Array.from({ length: 20 }, (_, i) => ({
    id: i,
    kind: "user" as const,
    text: `m${i}`,
  }));

  it("viewTop 省略 / null 时贴底，scrolled=false", () => {
    const layout = computeChatLayout({ ...base, blocks });
    expect(layout.totalLines).toBe(60);
    expect(layout.budget).toBe(21);
    expect(layout.scrolled).toBe(false);
    expect(layout.viewTop).toBe(39);
    expect(layout.lines[layout.lines.length - 1].text).toBe("  m19");
  });

  it("viewTop 指定时显示对应窗口，scrolled=true", () => {
    const layout = computeChatLayout({ ...base, blocks, viewTop: 0 });
    expect(layout.viewTop).toBe(0);
    expect(layout.scrolled).toBe(true);
    // 首个块三行：空行 / 标题 / 正文
    expect(layout.lines[0].kind).toBe("gap");
    expect(layout.lines[1].text).toBe("❯ 你");
    expect(layout.lines[2].text).toBe("  m0");
  });

  it("viewTop 越界被钳制到 [0, totalLines - budget]", () => {
    const high = computeChatLayout({ ...base, blocks, viewTop: 9999 });
    expect(high.viewTop).toBe(39);
    expect(high.scrolled).toBe(false);
    const low = computeChatLayout({ ...base, blocks, viewTop: -5 });
    expect(low.viewTop).toBe(0);
    expect(low.scrolled).toBe(true);
  });

  it("内容不足一屏时不留滚动，顶部补齐至满高", () => {
    const few: Block[] = [{ id: 1, kind: "user" as const, text: "hi" }];
    const layout = computeChatLayout({ ...base, blocks: few, viewTop: 3 });
    expect(layout.viewTop).toBe(0);
    expect(layout.scrolled).toBe(false);
    expect(layout.lines).toHaveLength(21);
  });

  it("滚动视口在追加内容后锚定不变（内容冻结）", () => {
    const layout = computeChatLayout({ ...base, blocks, viewTop: 0 });
    const grown = computeChatLayout({
      ...base,
      blocks: [...blocks, { id: 99, kind: "user" as const, text: "new" }],
      viewTop: 0,
    });
    expect(grown.viewTop).toBe(0);
    expect(grown.lines[2].text).toBe(layout.lines[2].text);
  });
});

describe("layoutInput（输入光标定位）", () => {
  it("单行：光标在中间 / 末尾", () => {
    expect(layoutInput("hello", 2, 80)).toMatchObject({
      lines: ["hello"],
      cursorRow: 0,
      cursorCol: 2,
    });
    expect(layoutInput("hello", 5, 80)).toMatchObject({
      lines: ["hello"],
      cursorRow: 0,
      cursorCol: 5,
    });
  });

  it("显式换行：光标落到第二行", () => {
    const r = layoutInput("ab\ncd", 4, 80);
    expect(r.lines).toEqual(["ab", "cd"]);
    expect(r.cursorRow).toBe(1);
    expect(r.cursorCol).toBe(1);
  });

  it("软折行：光标停在断点所在行末", () => {
    const r = layoutInput("abcd", 3, 3);
    expect(r.lines).toEqual(["abc", "d"]);
    expect(r.cursorRow).toBe(0);
    expect(r.cursorCol).toBe(3);
  });

  it("宽字符按显示宽度折行、光标定位", () => {
    const r = layoutInput("中文中文", 4, 4);
    expect(r.lines).toEqual(["中文", "中文"]);
    expect(r.cursorRow).toBe(1);
    expect(r.cursorCol).toBe(2);
  });

  it("空文本：一个空行、光标在原点", () => {
    expect(layoutInput("", 0, 80)).toMatchObject({
      lines: [""],
      cursorRow: 0,
      cursorCol: 0,
    });
  });

  it("光标越界被钳制到 [0, len]", () => {
    expect(layoutInput("hi", 99, 80).cursorCol).toBe(2);
    expect(layoutInput("hi", -3, 80).cursorCol).toBe(0);
  });
});

describe("跨词移动（Ctrl+← →）", () => {
  it("英文：左移到词首、右移到词尾", () => {
    expect(wordLeft("hello world", 11)).toBe(6);
    expect(wordLeft("hello world", 6)).toBe(0);
    expect(wordLeft("hello world", 3)).toBe(0);
    expect(wordRight("hello world", 0)).toBe(5);
    expect(wordRight("hello world", 6)).toBe(11);
  });

  it("标点作为分隔", () => {
    expect(wordLeft("foo.bar", 7)).toBe(4);
    expect(wordRight("foo.bar", 0)).toBe(3);
  });

  it("中文以空白为界", () => {
    expect(wordLeft("你好 世界", 5)).toBe(3);
    expect(wordRight("你好 世界", 0)).toBe(2);
  });

  it("越界钳制", () => {
    expect(wordLeft("hi", 0)).toBe(0);
    expect(wordRight("hi", 2)).toBe(2);
  });
});

describe("liveToLines（流式 AI 块）", () => {
  it("与完成态一致：前置空行 + AI 头", () => {
    const lines = liveToLines({ reasoning: "", content: "hi", tools: [], sub: null }, 80);
    expect(lines[0].kind).toBe("gap");
    expect(lines[1]).toEqual({ key: "live-h", kind: "ai-header", text: "✦ AI" });
    expect(lines.some((line) => line.kind === "content")).toBe(true);
  });

  it("流式块与完成块的头部结构一致（gap + ai-header）", () => {
    const live = liveToLines({ reasoning: "", content: "x", tools: [], sub: null }, 80);
    const block = blockToLines(
      { id: 1, kind: "assistant", reasoning: "", content: "x", tools: [] },
      80,
    );
    expect(live[0].kind).toBe("gap");
    expect(block[0].kind).toBe("gap");
    expect(live[1].kind).toBe("ai-header");
    expect(block[1].kind).toBe("ai-header");
  });

  it("并行 / 多轮工具调用各占一行，不拼接", () => {
    const tools = [
      { name: "read", args: "" },
      { name: "grep", args: "" },
      { name: "edit", args: "" },
      { name: "write", args: "" },
    ];
    const lines = liveToLines({ reasoning: "", content: "", tools, sub: null }, 80);
    const toolTexts = lines.filter((line) => line.kind === "tool").map((line) => line.text);
    expect(toolTexts).toEqual(["  ⚙ read", "  ⚙ grep", "  ⚙ edit", "  ⚙ write"]);
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
