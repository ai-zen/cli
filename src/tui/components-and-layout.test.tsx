// 会话屏**非交互**部分的两类契约：
//
// 1. 渲染输出：`components.tsx` 的四个小组件（状态栏 / 斜杠菜单 / 选择列表 / 启动画面），
//    断言的是帧内容与「量出来的行数 == 渲染出来的行数」这类必须自洽的约束；
// 2. 数学：转录行生成（`screens/messages-view.ts`）、帧布局（`screens/layout.ts`）、
//    IME 光标位置（`screens/input.ts`）、按键词法（`text.ts`）。
//
// 交互相关（按键 → 状态迁移）在 `screens/*.test.tsx` 各自文件里，不在这里。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { Box } from "ink";
import { StatusBar, statusBarRows, BottomMenu, SelectList } from "./components.js";
import { truncate } from "../text.js";
import {
  displayWidth,
  messageToLines,
  cachedMessageToLines,
  transcriptLines,
  inputLines,
  inputWindow,
  INPUT_MAX_ROWS,
  computeInputCursorPosition,
  usableFrameRows,
  wordLeft,
  wordRight,
  deleteWordLeft,
  deleteWordRight,
  deleteToLineEnd,
  deleteToLineStart,
  computeChatLayout,
  pickerCapacity,
  moveCursorRow,
  AGENT_TABS_LINES,
  clampViewTop,
  resolveSubmitText,
  workingSpinnerLabel,
  stripCwdNote,
  type RLine,
} from "./screens/index.js";
import { matchCommandHints } from "../commands/registry.js";
import { isTerminalReply } from "./text.js";
import { RENDER_OPTIONS } from "./index.js";
import { AgentNS } from "@ai-zen/agents-core";
import { setLocale, t } from "../i18n/index.js";
import { statusBlocksOf } from "../status-blocks.js";

const tick = () => new Promise((r) => setTimeout(r, 25));

/** 状态栏把「数字 + 单位」用不换行空格绑定，断言前统一归一化 */
const normalize = (text: string): string => text.replace(/\u00a0/g, " ");

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

  it("识别鼠标上报（滚轮 / 点击 / 拖拽），避免落进输入框", () => {
    expect(isTerminalReply("[<64;10;5M")).toBe(true);
    expect(isTerminalReply("[<65;10;5M")).toBe(true);
    expect(isTerminalReply("[<0;10;5M")).toBe(true);
    expect(isTerminalReply("[<0;10;5m")).toBe(true);
    expect(isTerminalReply("[<35;7;2M")).toBe(true);
    expect(isTerminalReply("[<64;10;5")).toBe(false);
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
  // 状态栏文案已 i18n 化：这些用例断言的是中文文案，显式锁定语言，
  // 不依赖宿主环境的 LANG（CI 上通常是 C / en_US）
  beforeEach(() => setLocale("zh"));

  /**
   * 四块的事实：身份（模型 / 思考档）、用量（本次 / 累计 tok，会话层从消息的 `usage` 上算）、
   * 速率（客户端采样）、快捷键（无事实）。
   *
   * 这里**不直接写块数组**：块由 `statusBlocksOf` 现拼 —— 谁把已撤的块（上下文 / 目录 / 在跑的工具 /
   * 子 AgentDefinition）加回去，下面的用例会直接红，而不是“夹具里没写所以看不见”。
   */
  const factsOf = (
    overrides: {
      model?: string;
      lastTokens?: number | null;
      totalTokens?: number | null;
      rate?: { live: number | null; average: number | null; running: boolean } | null;
      working?: boolean;
      status?: "working" | "idle";
      inputPaused?: boolean;
      outputPaused?: boolean;
      alive?: boolean;
    } = {},
  ) => ({
    model: {
      modelId: overrides.model ?? "deepseek-v4-flash",
      name: overrides.model ?? "deepseek-v4-flash",
      vision: false,
      source: "agent" as const,
    },
    thinking: {
      preset: "reasoning",
      levels: ["off", "high"],
      selected: "high",
      source: "manual" as const,
      params: {},
    },
    // 默认给两个真实的数：用量块在这套用例里是“应该看得见”的东西
    lastTokens: overrides.lastTokens === undefined ? 1284 : overrides.lastTokens,
    totalTokens: overrides.totalTokens === undefined ? 20345 : overrides.totalTokens,
    rate: overrides.rate ?? { live: null, average: null, running: false },
    working: overrides.working ?? false,
    status: overrides.status ?? "idle",
    inputPaused: overrides.inputPaused ?? false,
    outputPaused: overrides.outputPaused ?? false,
    alive: overrides.alive ?? true,
  });

  const blocksOf = (overrides: Parameters<typeof factsOf>[0] = {}) =>
    statusBlocksOf(factsOf(overrides));

  const plainRows = (props: Parameters<typeof statusBarRows>[0], columns: number) =>
    statusBarRows(props, columns).map((row) => normalize(row.map((s) => s.text).join("")));

  it("身份块只有两段：◆ 模型 · 思考 档位（「当前助手」那一格已经从状态栏拿掉）", () => {
    // 内容断言走纯函数：`ink-testing-library` 的终端只有 100 列，超宽的行会被裁掉
    const rows = plainRows({ blocks: blocksOf() }, 400);
    const identity = rows.join("\n");
    expect(identity).toContain("◆ deepseek-v4-flash · 思考 高");
    // 助手那一格整段不存在（连标签带名字都没有）
    expect(identity).not.toContain("agent");
    expect(identity).not.toContain("default");
  });

  it("四件事上屏：忙 / 闲各一个字，闸关与死只在非默认时出现（PRD 4.4）", () => {
    // 正常：只说「闲」—— 两个开关开着、人活着，写出来是每帧三个词宽、零信息
    const idle = plainRows({ blocks: blocksOf() }, 400).join("\n");
    expect(idle).toContain("闲");
    expect(idle).not.toContain("不取件");
    expect(idle).not.toContain("不收话");
    expect(idle).not.toContain("已停止");

    // 中断之后（输出开关关）且正忙：两个事实各说各的，绝不压成一个「暂停」
    const paused = plainRows(
      { blocks: blocksOf({ status: "working", outputPaused: true }) },
      400,
    ).join("\n");
    expect(paused).toContain("忙");
    expect(paused).toContain("不取件");
    // 「闲」与「输出开关关」分得开：忙的那一帧不该出现「闲」
    expect(paused).not.toContain("闲");

    // 死了：说「已停止」并标红（别让它看着像「闲」）
    const dead = plainRows({ blocks: blocksOf({ alive: false }) }, 400).join("\n");
    expect(dead).toContain("已停止");
  });

  it("用量块：本次 / 累计 tok 各自一段（数字是会话层从消息的 `usage` 上算的）", () => {
    const plain = plainRows({ blocks: blocksOf() }, 400).join(" ");
    expect(plain).toContain("本次 1284 tok");
    expect(plain).toContain("累计 20345 tok");
  });

  it("用量块：只有一个数时只摆那一段（还没答过就不显示，不写 0 假装）", () => {
    const onlyTotal = plainRows({ blocks: blocksOf({ lastTokens: null }) }, 400).join(" ");
    expect(onlyTotal).toContain("累计 20345 tok");
    expect(onlyTotal).not.toContain("本次");

    const none = plainRows({ blocks: blocksOf({ lastTokens: null, totalTokens: null }) }, 400).join(
      " ",
    );
    expect(none).not.toContain("tok");
  });

  it("速率块只剩速率：token 数在用量块里，不在速率段重复", () => {
    const rows = plainRows(
      {
        blocks: blocksOf({ rate: { live: 42.4, average: null, running: true }, working: true }),
        hint: "Enter 发送",
      },
      400,
    );
    const plain = rows.join(" ");
    expect(plain).toContain("⚡ 42 tok/s");
    // 每一块各说各的：速率段里不再带 token 数（那会让同一个数字出现在两处）
    expect(plain).toContain("本次 1284 tok");
  });

  it("四块的顺序：身份 → 用量 → 速率 → 快捷键（提示永远在末尾）", () => {
    const flat = plainRows(
      {
        blocks: blocksOf({ rate: { live: 42.4, average: null, running: true }, working: true }),
        hint: "Enter 发送",
      },
      400,
    )
      .join(" ")
      .replace(/\s+/g, " ");
    const at = (needle: string) => flat.indexOf(needle);
    expect(at("◆ deepseek-v4-flash")).toBeGreaterThan(-1);
    expect(at("思考 高")).toBeGreaterThan(at("◆ deepseek-v4-flash"));
    expect(at("本次 1284 tok")).toBeGreaterThan(at("思考 高"));
    expect(at("累计 20345 tok")).toBeGreaterThan(at("本次 1284 tok"));
    expect(at("⚡ 42 tok/s")).toBeGreaterThan(at("累计 20345 tok"));
    // 状态栏不挂笼统的「生成中」（阶段信息归分割线之上那一行），这里只锁顺序
    expect(at("Enter 发送")).toBeGreaterThan(at("⚡"));
  });

  it("生成结束后展示这一批的平均速率（不显示实时段）", () => {
    const { lastFrame, unmount } = render(
      <StatusBar
        blocks={blocksOf({ rate: { live: null, average: 7.84, running: false }, working: false })}
      />,
    );
    const frame = normalize(lastFrame() ?? "");
    expect(frame).toContain("⚡ 均 7.8 tok/s");
    unmount();
  });

  it("无速率数据 / 不足跨度时不显示速率段", () => {
    const idle = render(<StatusBar blocks={blocksOf()} />);
    expect(idle.lastFrame() ?? "").not.toContain("tok/s");
    idle.unmount();
    const early = render(
      <StatusBar
        blocks={blocksOf({ rate: { live: null, average: null, running: true }, working: true })}
      />,
    );
    expect(early.lastFrame() ?? "").not.toContain("tok/s");
    early.unmount();
  });

  it("旧版撤掉的那四块不再出现（上下文 / 目录 / 在跑的工具 / 子助手）", () => {
    const frame = normalize(
      render(<StatusBar blocks={blocksOf()} hint="Enter 发送" />).lastFrame() ?? "",
    );
    for (const gone of ["上下文", "目录", "在跑的工具", "子助手"]) {
      expect(frame).not.toContain(gone);
    }
    // 用量那两块是另一回事：它们能算出来（消息上的 `usage`），所以在屏上
    expect(frame).toContain("本次");
    expect(frame).toContain("累计");
  });

  it("没有提示时快捷键块整块不占位（不会留一个空的分隔符）", () => {
    const rows = plainRows({ blocks: blocksOf() }, 400);
    // 没数据的那几块被 `packSegments` 跳过：行内不得以分隔符结尾
    expect(rows.join("\n")).not.toMatch(/·\s*$/);
    expect(rows.join("\n")).toContain("◆ deepseek-v4-flash");
  });

  it("窄屏（40 列）：块各自整块占一行，且行数与布局拿到的 statusBarLines 一致", () => {
    // 短一点的模型名与提示：让四块各自都装得进 40 列，于是“整块占一行”是可观测的
    const hint = "Enter 发送 · Ctrl+J 换行";
    const props = {
      blocks: blocksOf({
        model: "m1",
        rate: { live: 42.4, average: null, running: true },
        working: true,
      }),
      hint,
      columns: 40,
    };
    const rows = plainRows(props, 40);

    // 每行不得超宽（超了就说明装行算错，会把整帧顶高）
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(40);
    // 块是原子的：40 列放不下两块并排 → 一块一整行，块内不被劈开
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain("◆ m1");
    expect(rows[0]).toContain("思考 高");
    expect(rows[1]).toContain("本次 1284 tok");
    expect(rows[1]).toContain("累计 20345 tok");
    expect(rows[2]).toContain("⚡ 42 tok/s");
    expect(rows[3]).toContain("Enter 发送");

    // 布局拿到的行数与实测一致：差一行输入框就会整体位移（IME 候选框跟着偏）
    const layout = computeChatLayout({
      columns: 40,
      rows: 24,
      transcript: [],
      input: "",
      hintCount: 0,
      overlay: "none",
      pickerItems: 0,
      statusBarLines: rows.length,
    });
    expect(layout.bottomLines).toBe(1 /* 分隔线 */ + 1 /* 输入 */ + rows.length);
  });

  it("Ink 实际渲染的行数与 statusBarRows 量出的行数一致（否则整帧会高一行）", () => {
    const props = {
      blocks: blocksOf(),
      hint: "Enter 发送 · Ctrl+J 换行 · / 命令 · PgUp 看历史",
      columns: 40,
    };
    const expected = statusBarRows(props, 40).length;
    const { lastFrame, unmount } = render(<StatusBar {...props} />);
    const actual = normalize(lastFrame() ?? "")
      .split("\n")
      .filter((row) => row.trim() !== "").length;
    expect(actual).toBe(expected);
    unmount();
  });

  it("折行行数可由 statusBarRows 预先量出（供布局预留高度）", () => {
    const props = {
      blocks: blocksOf(),
      hint: "Enter 发送 · Ctrl+J 换行 · / 命令 · PgUp 看历史",
    };
    const wide = statusBarRows(props, 400).length;
    const narrow = statusBarRows(props, 60).length;
    expect(wide).toBe(1);
    expect(narrow).toBeGreaterThan(wide);
  });
});

describe("BottomMenu（底部锚定菜单：`/` 与 `@` 共用）", () => {
  const mk = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ key: `k${i}`, label: `item${i}`, hint: `hint${i}` }));
  /** 只取非空行：ink 会把尾部空行也拼进 lastFrame */
  const rowsOf = (frame: string) => frame.split("\n").filter((row) => row.trim().length > 0);

  it("第一项紧贴输入框（渲染在最底行），往上依次生长", () => {
    const { lastFrame, unmount } = render(
      <BottomMenu items={mk(3)} selected={0} maxRows={3} columns={100} />,
    );
    const rows = rowsOf(lastFrame() ?? "");
    expect(rows).toHaveLength(3);
    // 数据顺序 item0 → item2；视觉顺序自下而上，所以末行是 item0、首行是 item2
    expect(rows[2]).toContain("item0");
    expect(rows[1]).toContain("item1");
    expect(rows[0]).toContain("item2");
    unmount();
  });

  it("默认高亮最底部那一项（`hints[0]`）", () => {
    const { lastFrame, unmount } = render(
      <BottomMenu items={mk(3)} selected={0} maxRows={3} columns={100} />,
    );
    const rows = rowsOf(lastFrame() ?? "");
    expect(rows[2]).toContain("❯");
    expect(rows[0]).not.toContain("❯");
    expect(rows[1]).not.toContain("❯");
    unmount();
  });

  it("放不下的从顶部丢弃：只保留前 maxRows 项，最远的候选先消失", () => {
    const { lastFrame, unmount } = render(
      <BottomMenu items={mk(10)} selected={0} maxRows={4} columns={100} />,
    );
    const frame = lastFrame() ?? "";
    const rows = rowsOf(frame);
    expect(rows).toHaveLength(4);
    expect(rows[3]).toContain("item0"); // 仍然贴着输入框
    expect(frame).toContain("item3");
    expect(frame).not.toContain("item4");
    expect(frame).not.toContain("item9");
    unmount();
  });

  it("选中项越过窗口后连续滚动，且始终可见", () => {
    const { lastFrame, unmount } = render(
      <BottomMenu items={mk(30)} selected={12} maxRows={8} columns={100} />,
    );
    const rows = rowsOf(lastFrame() ?? "");
    expect(rows).toHaveLength(8);
    // from = 12 − 8 + 1 = 5 → 可见 5..12，选中项（最高索引）落在窗口最上一行
    expect(rows[0]).toContain("item12");
    expect(rows[0]).toContain("❯");
    expect(rows[7]).toContain("item5");
    expect(rowsOf(lastFrame() ?? "").join()).not.toContain("item4");
    unmount();
  });

  it("副标题行（`@` 的「扫描中…」）占用同一份高度预算，且位于菜单顶端", () => {
    const { lastFrame, unmount } = render(
      <BottomMenu items={mk(10)} selected={0} maxRows={4} columns={100} topLine="扫描中…" />,
    );
    const rows = rowsOf(lastFrame() ?? "");
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain("扫描中");
    expect(rows[3]).toContain("item0");
    expect(rowsOf(lastFrame() ?? "").join()).not.toContain("item3"); // 只剩 3 行给候选
    unmount();
  });

  it("布局没给高度（maxRows 0）时一行都不渲染", () => {
    const { lastFrame, unmount } = render(
      <BottomMenu items={mk(5)} selected={0} maxRows={0} columns={100} />,
    );
    expect(rowsOf(lastFrame() ?? "")).toHaveLength(0);
    unmount();
  });

  it("命令占满自己的宽度，描述只能吃剩下的（窄屏下先裁描述）", () => {
    const items = [
      { key: "config", label: "/config", hint: "打开配置中心（模型 / 端点 / 思考强度）" },
    ];
    const { lastFrame, unmount } = render(
      <Box width={40}>
        <BottomMenu items={items} selected={0} maxRows={1} columns={40} />
      </Box>,
    );
    const row = (lastFrame() ?? "").split("\n")[0] ?? "";
    // label 与描述若是两个并列 flex 子节点，描述更长就抢走宽度，命令被裁成 `/confi`
    expect(row).toContain("/config");
    expect(row).toContain("❯ /config"); // 标记也不允许被挤掉
    expect(row).toContain("打开配置"); // 描述仍有开头，只是被截断
    expect(displayWidth(row)).toBeLessThanOrEqual(40);
    unmount();
  });

  it("剩余宽度不够时整条描述不显示（不留半个省略号）", () => {
    const items = [{ key: "handoff", label: "/handoff", hint: "生成交接文档（不切换会话）" }];
    const { lastFrame, unmount } = render(
      <Box width={16}>
        <BottomMenu items={items} selected={0} maxRows={1} columns={16} />
      </Box>,
    );
    const row = (lastFrame() ?? "").split("\n")[0] ?? "";
    expect(row).toContain("/handoff");
    expect(row).not.toContain("生成");
    expect(displayWidth(row)).toBeLessThanOrEqual(16);
    unmount();
  });

  it("命令自身超宽时才裁命令（并补省略号）", () => {
    const items = [{ key: "long", label: "/verylongcommand", hint: "说明" }];
    const { lastFrame, unmount } = render(
      <Box width={14}>
        <BottomMenu items={items} selected={0} maxRows={1} columns={14} />
      </Box>,
    );
    const row = (lastFrame() ?? "").split("\n")[0] ?? "";
    expect(row).toContain("…");
    expect(displayWidth(row)).toBeLessThanOrEqual(14);
    unmount();
  });

  it("描述再长也不会折行（每项恒占一行，否则输入框被顶出屏幕）", () => {
    const items = Array.from({ length: 3 }, (_, i) => ({
      key: `k${i}`,
      label: `/cmd${i}`,
      hint: "这是一段特别长的说明文字，长到在任何窄屏上都放不下，必须被裁掉而不是换行",
    }));
    const { lastFrame, unmount } = render(
      <Box width={30}>
        <BottomMenu items={items} selected={0} maxRows={3} columns={30} />
      </Box>,
    );
    expect(rowsOf(lastFrame() ?? "")).toHaveLength(3);
    unmount();
  });

  it("渲染行数恒等于布局放行的行数（min(候选数, maxRows)，扫描行计入）", () => {
    for (const [total, maxRows, scanning] of [
      [0, 5, false],
      [3, 5, false],
      [30, 8, false],
      [30, 8, true],
      [30, 0, true],
    ] as const) {
      const { lastFrame, unmount } = render(
        <BottomMenu
          items={mk(total)}
          selected={0}
          maxRows={maxRows}
          columns={100}
          topLine={scanning ? "扫描中…" : undefined}
        />,
      );
      const expected = Math.min(total + (scanning ? 1 : 0), maxRows);
      expect(rowsOf(lastFrame() ?? "")).toHaveLength(expected);
      unmount();
    }
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

describe("truncate（单行化 + 截断）", () => {
  /**
   * 回归：用 `.length` / `.slice` 按 UTF-16 code unit 切，截断点落在 emoji
   * 中间时会留下孤立代理项 —— 屏幕上是一个方框（或直接乱码）。`/back` 的列表项标签、
   * `/load` 的预览都过这个函数。
   */
  it("按字素簇截断：不拆 emoji / ZWJ 序列，补一个省略号", () => {
    expect(truncate("👍👍👍", 2)).toBe("👍…");
    expect(truncate("👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦", 2)).toBe("👨‍👩‍👧‍👦…");
    expect(truncate("✌️✌️✌️", 2)).toBe("✌️…");
    // 不超长时原样返回，且不补省略号
    expect(truncate("👍👍", 2)).toBe("👍👍");
    // 空白折叠/裁剪仍然生效
    expect(truncate("  a  \n b  ", 10)).toBe("a b");
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

  /**
   * 回归：`index` 只在挂载时算一次（`useState(min(initialIndex, …))`），
   * 列表变短后不重置，而回车用 `items[index].value` —— 越界就抛 TypeError。
   * 这里让 items 由 3 项变 1 项（光标原本停在末项）。
   */
  it("items 变短后回车不崩，且选中的是钳制后的项", async () => {
    const onSelect = vi.fn();
    const { stdin, rerender, unmount } = render(
      <SelectList
        items={[
          { label: "甲", value: "a" },
          { label: "乙", value: "b" },
          { label: "丙", value: "c" },
        ]}
        onSelect={onSelect}
      />,
    );
    stdin.write("\x1b[B");
    await tick();
    stdin.write("\x1b[B"); // 光标到末项（index 2）
    await tick();

    rerender(<SelectList items={[{ label: "甲", value: "a" }]} onSelect={onSelect} />);
    await tick();
    stdin.write("\r");
    await tick();
    expect(onSelect).toHaveBeenCalledWith("a");
    unmount();
  });
});

// 空会话的品牌区由 `welcome.ts` 生成，用例分别在 `welcome.test.ts`（纯函数）与
// `screens/chat.test.tsx`（接入会话区）里。

describe("stripCwdNote", () => {
  it("去除首次注入的工作目录后缀", () => {
    expect(stripCwdNote("你好\n当前工作目录: C:\\proj")).toBe("你好");
  });
  it("去除带变更标记的后缀", () => {
    expect(stripCwdNote("你好\n\n[工作目录变更]\n当前工作目录: /tmp/x")).toBe("你好");
  });
  it("去除新一代英文注入后缀（带 system-injected 标记）", () => {
    expect(
      stripCwdNote(
        "你好\n\n[system-injected: working directory changed — not written by the user]\nCurrent working directory: /tmp/x",
      ),
    ).toBe("你好");
    expect(
      stripCwdNote(
        "你好\n\n[system-injected: current working directory — not written by the user]\nCurrent working directory: /tmp/x",
      ),
    ).toBe("你好");
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

  it("hidden 跳过渲染", () => {
    expect(
      messageToLines(msg({ role: AgentNS.Role.User, content: "x", hidden: true }), 80),
    ).toEqual([]);
  });

  it("不进上下文的消息划删除线（status 非 undefined/Completed）", () => {
    // 中断后按 drop 结算 / 出错的 assistant：会渲染，但整行划掉
    for (const status of [AgentNS.MessageStatus.Aborted, AgentNS.MessageStatus.Error]) {
      const lines = messageToLines(msg({ role: AgentNS.Role.User, content: "x", status }), 80);
      expect(lines.length, status).toBeGreaterThan(0);
      expect(
        lines.filter((l) => l.kind !== "gap").every((l) => l.struck === true),
        status,
      ).toBe(true);
      // 空行不划
      expect(lines.filter((l) => l.kind === "gap").every((l) => l.struck === undefined)).toBe(true);
    }
  });

  it("进上下文的消息不划线：undefined / Completed / 流式中（Pending・Writing）", () => {
    const statuses = [
      undefined,
      AgentNS.MessageStatus.Completed,
      AgentNS.MessageStatus.Pending,
      AgentNS.MessageStatus.Writing,
    ];
    for (const status of statuses) {
      const lines = messageToLines(msg({ role: AgentNS.Role.User, content: "x", status }), 80);
      expect(
        lines.some((l) => l.struck),
        String(status),
      ).toBe(false);
    }
  });

  it("状态翻转后缓存必须失效（删除线不能沿用旧结果）", () => {
    const message = msg({ role: AgentNS.Role.User, content: "x" });
    expect(cachedMessageToLines(message, 80).some((l) => l.struck)).toBe(false);
    message.status = AgentNS.MessageStatus.Aborted;
    expect(cachedMessageToLines(message, 80).some((l) => l.struck)).toBe(true);
  });

  it("内容数组中的图片 / 文件以占位文本呈现", () => {
    const lines = messageToLines(
      msg({
        role: AgentNS.Role.User,
        content: [{ type: "image_url", image_url: { url: "http://x/y.png" } }],
      } as unknown as Partial<AgentNS.Message> & { role: AgentNS.Role }),
      80,
    );
    expect(lines[2].text).toContain("[图片：");
  });

  it("图片占位在转录里是真的几行：第几张 / 尺寸 / 文件名各一行", () => {
    const lines = messageToLines(
      msg({
        role: AgentNS.Role.User,
        content: [
          { type: "text", text: "看这张" },
          { type: "image_url", image_url: { url: "" }, __asset_id: "a-1", width: 4, height: 5 },
        ],
      } as unknown as Partial<AgentNS.Message> & { role: AgentNS.Role }),
      80,
    );
    const texts = lines.map((line) => line.text);
    expect(texts).toContain("  看这张");
    expect(texts.some((text) => text.includes("图片 1") && text.includes("Ctrl+O"))).toBe(true);
    expect(texts).toContain("  尺寸：4 × 5");
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

describe("inputLines", () => {
  it("空输入显示占位提示", () => {
    expect(inputLines("", 80)).toEqual(["输入消息，/ 命令，@ 文件…"]);
    expect(inputLines("hi", 80)).toEqual(["hi"]);
  });
});

describe("inputWindow（输入区限高 8 行、窗口跟随光标）", () => {
  it("不超过上限时窗口就是全部（不预留空白）", () => {
    expect(inputWindow(3, 0)).toEqual({ from: 0, to: 3 });
    expect(inputWindow(INPUT_MAX_ROWS, INPUT_MAX_ROWS - 1)).toEqual({
      from: 0,
      to: INPUT_MAX_ROWS,
    });
  });

  it("光标在第一行时窗口贴顶（不是固定显示末尾几行）", () => {
    expect(inputWindow(20, 0)).toEqual({ from: 0, to: INPUT_MAX_ROWS });
  });

  it("光标在末行时窗口贴底", () => {
    expect(inputWindow(20, 19)).toEqual({ from: 12, to: 20 });
  });

  it("光标在中间时落在窗口最后一行，向上连续滚动", () => {
    expect(inputWindow(20, 10)).toEqual({ from: 3, to: 11 });
    expect(inputWindow(20, 8)).toEqual({ from: 1, to: 9 });
  });
});

describe("computeChatLayout（吸底 + 应用内翻页）", () => {
  const line = (i: number): RLine => ({ key: `k${i}`, kind: "content", text: `L${i}` });
  const base = {
    columns: 80,
    rows: 24,
    transcript: [] as RLine[],
    input: "",
    hintCount: 0,
    overlay: "none" as const,
    pickerItems: 0,
  };

  it("空转录：会话区全部补齐，行数 = rows − 底部区域", () => {
    const layout = computeChatLayout(base);
    // 通知栏 0 + 分隔线 1 + 斜杠菜单 0 + 输入 1 + 两行状态栏 2
    expect(layout.bottomLines).toBe(4);
    expect(layout.lines).toHaveLength(20);
    expect(layout.lines.every((l) => l.kind === "gap")).toBe(true);
  });

  it("anchor: center 时余量上下均分（空会话的品牌块居中）", () => {
    const layout = computeChatLayout({ ...base, transcript: [line(0)], anchor: "center" });
    expect(layout.lines).toHaveLength(20);
    // 会话区 20 行、内容 1 行 → 余量 19：上 9 下 10（多的一行留给下方）
    expect(layout.lines[9].text).toBe("L0");
    expect(layout.lines.slice(0, 9).every((l) => l.kind === "gap")).toBe(true);
    expect(layout.lines.slice(10).every((l) => l.kind === "gap")).toBe(true);
  });

  it("内容超出时自底部截断，最新一条在最后", () => {
    const transcript = Array.from({ length: 30 }, (_, i) => line(i));
    const layout = computeChatLayout({ ...base, transcript });
    expect(layout.lines).toHaveLength(20);
    expect(layout.lines[19].text).toBe("L29");
  });

  it("通知栏抬高底部区域、压缩会话区", () => {
    const without = computeChatLayout(base);
    const withNotice = computeChatLayout({ ...base, noticeCount: 2 });
    expect(withNotice.bottomLines).toBe(without.bottomLines + 2);
  });

  it("选择覆盖层替换输入区高度", () => {
    expect(computeChatLayout({ ...base, overlay: "picker", pickerItems: 3 }).bottomLines).toBe(12);
  });

  it("viewTop 指定时显示对应窗口，越界钳制", () => {
    const transcript = Array.from({ length: 30 }, (_, i) => line(i));
    const top = computeChatLayout({ ...base, transcript, viewTop: 0 });
    expect(top.viewTop).toBe(0);
    expect(top.scrolled).toBe(true);
    expect(top.lines[0].text).toBe("L0");
    const high = computeChatLayout({ ...base, transcript, viewTop: 9999 });
    expect(high.viewTop).toBe(10);
    expect(high.scrolled).toBe(false);
  });

  it("阶段行（分隔线之上那一行）单独占一行：不抢输入框的位置", () => {
    const without = computeChatLayout(base);
    const withPhase = computeChatLayout({ ...base, phaseLines: 1 });
    expect(withPhase.bottomLines).toBe(without.bottomLines + 1);
    // 输入区照旧按草稿行数算（生成中不再把它压成 1 行）：两行草稿 + 阶段行 = 两行草稿 + 1
    const twoLineInput = "a\nb";
    expect(computeChatLayout({ ...base, input: twoLineInput, phaseLines: 1 }).bottomLines).toBe(
      computeChatLayout({ ...base, input: twoLineInput }).bottomLines + 1,
    );
    // 不传 = 0 行（不 busy 时这一行不存在）
    expect(without.bottomLines).toBe(computeChatLayout({ ...base, phaseLines: 0 }).bottomLines);
  });

  it("状态栏折行时按实测行数预留高度", () => {
    const two = computeChatLayout({ ...base, statusBarLines: 2 });
    const three = computeChatLayout({ ...base, statusBarLines: 3 });
    expect(three.bottomLines).toBe(two.bottomLines + 1);
    expect(three.lines).toHaveLength(two.lines.length - 1);
    // 不传时按下限 2 行算（与改动前一致）
    expect(computeChatLayout(base).bottomLines).toBe(two.bottomLines);
  });

  it("多行输入抬高底部区域、压缩会话区（最多抬高到 8 行）", () => {
    const single = computeChatLayout({ ...base, input: "x" });
    const multi = computeChatLayout({ ...base, input: "x\ny\nz" });
    expect(multi.bottomLines).toBe(single.bottomLines + 2);
    expect(multi.lines.length).toBe(single.lines.length - 2);
    // 上限 8 行：第 9 行起输入区不再变高（否则长草稿会把会话区挤没）
    const nine = Array.from({ length: 9 }, () => "x").join("\n");
    const twenty = Array.from({ length: 20 }, () => "x").join("\n");
    expect(computeChatLayout({ ...base, input: nine }).bottomLines).toBe(single.bottomLines + 7);
    expect(computeChatLayout({ ...base, input: twenty }).bottomLines).toBe(single.bottomLines + 7);
  });

  it("菜单想吃的行数由布局按剩余空间放行，不设固定行数上限（L14/L16）", () => {
    // rows 24 的固定底部：分隔线 1 + 输入 1 + 状态栏 2 = 4 → 菜单最多能拿到 20 行
    const many = computeChatLayout({ ...base, hintCount: 30 });
    expect(many.hintRows).toBe(20);
    expect(many.bottomLines).toBe(24);
    expect(many.lines).toHaveLength(0);

    // 候选不多时按实际条数占位，不预留空白
    const few = computeChatLayout({ ...base, hintCount: 3 });
    expect(few.hintRows).toBe(3);
    expect(few.bottomLines).toBe(7);
  });

  it("覆盖层打开时菜单不占行（hintRows 归零）", () => {
    expect(
      computeChatLayout({ ...base, hintCount: 5, overlay: "picker", pickerItems: 3 }).hintRows,
    ).toBe(0);
  });

  it("Agent 栏目占一行底部高度、压缩会话区（无子 Agent 时为 0）", () => {
    const without = computeChatLayout(base);
    const withTabs = computeChatLayout({ ...base, agentTabLines: AGENT_TABS_LINES });
    expect(withTabs.bottomLines).toBe(without.bottomLines + 1);
    expect(withTabs.lines).toHaveLength(without.lines.length - 1);
    // 缺省 0：没有子 Agent 时不开销任何高度
    expect(computeChatLayout({ ...base, agentTabLines: 0 }).bottomLines).toBe(without.bottomLines);
  });
});

describe("clampViewTop（翻页 / 按行 / 滚轮共用的滚动钳制）", () => {
  // totalLines=100、budget=20 → maxTop=80，贴着底部时 viewTop 记为 null
  it("贴底与越过底部都返回 null（视口重新跟随最新）", () => {
    expect(clampViewTop(100, 20, 80)).toBeNull();
    expect(clampViewTop(100, 20, 9999)).toBeNull();
  });

  it("向上滚动到区间内时返回具体顶行", () => {
    expect(clampViewTop(100, 20, 0)).toBe(0);
    expect(clampViewTop(100, 20, 77)).toBe(77);
  });

  it("越过顶部钳到 0（滚过头不会变成负值）", () => {
    expect(clampViewTop(100, 20, -50)).toBe(0);
  });

  it("内容不足一屏时恒为 null（无可滚动区间）", () => {
    expect(clampViewTop(5, 20, 0)).toBeNull();
    expect(clampViewTop(0, 20, -3)).toBeNull();
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

  it("y 计入会话区 / 斜杠菜单 / 分隔线与输入行偏移", () => {
    expect(
      computeInputCursorPosition({ ...base, transcriptLines: 5, hintCount: 2, cursorRow: 1 }).y,
    ).toBe(9);
  });

  it("y 计入通知栏行数（否则多行通知一出现，IME 候选框就浮到输入行上方）", () => {
    // 会话区 5 + 通知 3 + 菜单 0 + 分隔线 1 + 行内 1
    expect(
      computeInputCursorPosition({ ...base, transcriptLines: 5, noticeCount: 3, cursorRow: 1 }).y,
    ).toBe(10);
  });

  it("通知与菜单同时存在时按渲染顺序累加（通知在上、菜单在下）", () => {
    expect(
      computeInputCursorPosition({
        ...base,
        transcriptLines: 2,
        noticeCount: 4,
        hintCount: 3,
        cursorRow: 0,
      }).y,
    ).toBe(10);
  });

  it("不传 noticeCount 时视为 0（与旧行为一致）", () => {
    expect(computeInputCursorPosition({ ...base, transcriptLines: 7 }).y).toBe(8);
  });

  it("y 计入 Agent 栏目行数（否则硬件光标与 IME 候选框整体偏上）", () => {
    // 会话区 5 + 栏目 1 + 菜单 0 + 分隔线 1 + 行内 1 = 8
    expect(
      computeInputCursorPosition({ ...base, transcriptLines: 5, agentTabCount: 1, cursorRow: 1 }).y,
    ).toBe(8);
    // 与菜单叠加时按渲染顺序累加（栏目在菜单之上）
    expect(
      computeInputCursorPosition({
        ...base,
        transcriptLines: 5,
        agentTabCount: 1,
        hintCount: 2,
        cursorRow: 1,
      }).y,
    ).toBe(10);
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

/**
 * `pickerCapacity` —— 「终端能放下几条选择器候选」的唯一实现。
 *
 * 它是这个换算的唯一实现（命令层只收结果），所以"装得下"必须在这里被**量**住：用
 * `computeChatLayout` 把那个条数摆上去，看整帧高度是不是真的不超。
 */
describe("pickerCapacity（选择器条数上限）", () => {
  const fits = (terminalRows: number, pickerItems: number): boolean =>
    computeChatLayout({
      columns: 80,
      rows: terminalRows,
      transcript: [],
      input: "",
      hintCount: 0,
      overlay: "picker",
      pickerItems,
    }).bottomLines <= usableFrameRows(terminalRows);

  it("给多少条就刚好装得下，多一条就装不下", () => {
    // 从 16 行起：再矮就轮到下面那条「不小于 1」的退化分支（容不下也要能选一个）
    for (const rows of [16, 24, 40]) {
      const capacity = pickerCapacity(rows);
      expect(capacity).toBeGreaterThanOrEqual(2);
      expect(fits(rows, capacity)).toBe(true);
      expect(fits(rows, capacity + 1)).toBe(false);
    }
  });

  it("24 行终端：14 条（23 帧高 − 7 覆盖层固定行 − 2 状态栏）", () => {
    expect(pickerCapacity(24)).toBe(14);
  });

  it("退化场景下不小于 1（再小也得能选一个）", () => {
    expect(pickerCapacity(1)).toBe(1);
    expect(pickerCapacity(0)).toBe(1);
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

describe("多行光标上下移动（↑ / ↓ 在行间移动）", () => {
  it("按折行后的同列上下移动", () => {
    // "aa\nbb" 光标 5 = 第 2 行行尾（row1 col2）→ 上一行同列 = 下标 2
    expect(moveCursorRow("aa\nbb", 5, 80, -1)).toBe(2);
    expect(moveCursorRow("aa\nbb", 2, 80, 1)).toBe(5);
  });

  it("目标行更短时落到行尾（不越到下一行）", () => {
    expect(moveCursorRow("ab\ncdef", 6, 80, -1)).toBe(2);
  });

  it("首行按 ↑ / 末行按 ↓ 返回 null（交给历史）", () => {
    expect(moveCursorRow("aa\nbb", 1, 80, -1)).toBeNull();
    expect(moveCursorRow("aa\nbb", 5, 80, 1)).toBeNull();
    // 单行输入上下都不动
    expect(moveCursorRow("hello", 3, 80, -1)).toBeNull();
    expect(moveCursorRow("hello", 3, 80, 1)).toBeNull();
  });

  it("软折行也算一行（宽度决定，不是只有 \\n 才算行）", () => {
    // 宽度 4："abcdefgh" 折成 "abcd" / "efgh"
    expect(moveCursorRow("abcdefgh", 6, 4, -1)).toBe(2);
    expect(moveCursorRow("abcdefgh", 2, 4, 1)).toBe(6);
  });

  it("宽字符按显示宽度折行", () => {
    // 宽度 4："中文字符" 折成 "中文" / "字符"
    expect(moveCursorRow("中文字符", 2, 4, 1)).toBe(4);
    expect(moveCursorRow("中文字符", 4, 4, -1)).toBe(2);
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

describe("workingSpinnerLabel（忙碌期 spinner 文案）", () => {
  const userTurn = (overrides: Partial<AgentNS.Message> = {}): AgentNS.Message => ({
    id: "m1",
    // `createdAt` 是 core 的必填格（夹具补齐，断言一个字不动）
    createdAt: overrides.createdAt ?? 1,
    role: AgentNS.Role.Assistant,
    status: AgentNS.MessageStatus.Writing,
    ...overrides,
  });

  it("在忙时：由契约事实推（忙闲 + 那条消息的思考 / 正文 / 工具调用）", () => {
    // 没有阶段值可读 —— 那一句话是 `phaseLine` 从事实推出来的
    expect(
      workingSpinnerLabel(
        {
          status: "working",
          messages: [userTurn({ reasoning_content: "x" })],
          inboxPending: 0,
          handingOff: false,
        },
        null,
      ),
    ).toBe(t("phase.thinking"));
    expect(
      workingSpinnerLabel(
        {
          status: "working",
          messages: [userTurn({ content: "答案" })],
          inboxPending: 0,
          handingOff: false,
        },
        "upgrade",
      ),
    ).toBe(t("phase.streaming"));
    // 正在等工具：把工具名念出来（并行时全部念）
    expect(
      workingSpinnerLabel(
        {
          status: "working",
          messages: [
            userTurn({
              tool_calls: [{ id: "c1", function: { name: "read_file" } }],
              finish_reason: AgentNS.FinishReason.ToolCalls,
            }),
          ],
          inboxPending: 0,
          handingOff: false,
        },
        null,
      ),
    ).toBe(t("phase.toolWaitingWith", { name: "read_file" }));
  });

  it("阻塞命令执行中（没有「在忙」那一格）：显示命令名，不是笼统的「处理中」", () => {
    const label = workingSpinnerLabel(
      { status: "idle", messages: [], inboxPending: 0, handingOff: false },
      "update",
    );
    expect(label).toBe(t("cmd.running", { name: "update" }));
    // 回归守卫：这正是「光转圈」的病根——命令期间回落成「处理中…」
    expect(label).not.toBe(t("phase.working"));
    expect(label).toContain("update");
  });

  it("两者都没有：才回落到通用的「处理中」", () => {
    expect(workingSpinnerLabel(null, null)).toBe(t("phase.working"));
  });
});
