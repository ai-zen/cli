import { describe, it, expect, beforeEach } from "vitest";
import {
  COMMAND_LABEL_WIDTH,
  COMMAND_REGISTRY,
  canonicalCommandName,
  commandBlocksInput,
  findCommand,
  getCommandHints,
  getCommandNames,
  matchCommandHints,
  parseCommandArgs,
  parseCommandInput,
} from "./registry.js";
import { setLocale } from "../i18n/index.js";
import { displayWidth } from "../tui/text.js";

// 命令说明已 i18n 化：这些用例断言中文文案，显式锁定语言（不依赖宿主 LANG）
beforeEach(() => setLocale("zh"));

describe("对话命令元数据", () => {
  it("展示条目折叠别名（exit/quit 折叠为一条），且 exit 置于末尾", () => {
    const hints = getCommandHints();
    expect(hints[0]!.names).toEqual(["save"]); // exit 不再打头，避免误回车直接退出
    expect(hints[hints.length - 1]).toEqual({
      names: ["exit", "quit"],
      label: "/exit /quit",
      description: "退出对话（提示保存）",
    });
  });

  it("每个命令均有非空说明", () => {
    for (const hint of getCommandHints()) {
      expect(hint.description.trim().length).toBeGreaterThan(0);
    }
  });

  it("说明保持简洁：中文 ≤ 36、英文 ≤ 52 显示宽度", () => {
    // 斜杠菜单与 /help 都是一行一条，说明过长会把行塞满（宽度只算到「不折行」
    // 就太宽松了 —— 菜单要的是一眼能扫完）。上限紧贴当前最长条目：
    // 中文 /reload=34、英文 /config 与 /mcp=49，没余量，改啰嗦了就会红。
    const LIMIT = { zh: 36, en: 52 } as const;
    for (const locale of ["zh", "en"] as const) {
      setLocale(locale);
      for (const hint of getCommandHints()) {
        const width = displayWidth(hint.description);
        expect(width, `${locale} ${hint.label}：${hint.description}`).toBeLessThanOrEqual(
          LIMIT[locale],
        );
      }
    }
    setLocale("zh");
  });

  it("命令说明跟随界面语言（key 存表、渲染时取词）", () => {
    setLocale("en");
    const exitHint = getCommandHints().at(-1)!;
    expect(exitHint.description).toBe("Exit the conversation (offers to save)");
    setLocale("zh");
    expect(getCommandHints().at(-1)!.description).toBe("退出对话（提示保存）");
  });

  it("展示宽度按最长命令串对齐", () => {
    const longest = Math.max(...getCommandHints().map((hint) => hint.label.length));
    expect(COMMAND_LABEL_WIDTH).toBeGreaterThan(longest);
  });

  it("命令名（含别名）不重复且升序", () => {
    const names = getCommandNames();
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([...names].sort());
  });

  it("registry 中的每个名称均被 getCommandNames 覆盖", () => {
    const names = new Set(getCommandNames());
    for (const command of COMMAND_REGISTRY) {
      expect(names.has(command.name)).toBe(true);
      for (const alias of command.aliases ?? []) expect(names.has(alias)).toBe(true);
    }
  });
});

describe("命令前缀匹配", () => {
  it("空关键词返回全部命令", () => {
    expect(matchCommandHints("")).toHaveLength(getCommandHints().length);
    expect(matchCommandHints("   ")).toHaveLength(getCommandHints().length);
  });

  it("按前缀过滤并保留说明", () => {
    expect(matchCommandHints("sav")).toEqual([
      { names: ["save"], label: "/save", description: "保存对话" },
    ]);
  });

  it("别名同样参与匹配且大小写不敏感", () => {
    expect(matchCommandHints("Q").map((hint) => hint.label)).toEqual(["/exit /quit"]);
    expect(matchCommandHints("QUIT").map((hint) => hint.label)).toEqual(["/exit /quit"]);
  });

  it("无匹配时返回空数组", () => {
    expect(matchCommandHints("zzz")).toEqual([]);
  });

  it("/agent 已注册：能在菜单里前缀匹配到，且说明不是空的", () => {
    expect(matchCommandHints("age")).toEqual([
      { names: ["agent"], label: "/agent", description: "切换主 Agent（重建会话）" },
    ]);
    expect(getCommandNames()).toContain("agent");
  });
});

describe("命令名解析与元数据", () => {
  it("canonicalCommandName 把别名归一到主名（大小写不敏感）", () => {
    expect(canonicalCommandName("think")).toBe("think");
    expect(canonicalCommandName("EFFORT")).toBe("think");
    expect(canonicalCommandName("quit")).toBe("exit");
    expect(canonicalCommandName("nope")).toBeUndefined();
  });

  it("parseCommandInput 拆出命令名与参数；只打一个 `/` 也算命令", () => {
    expect(parseCommandInput("/migrate")).toEqual({ name: "migrate", args: [] });
    expect(parseCommandInput("  /MIGRATE  self ")).toEqual({ name: "migrate", args: ["self"] });
    expect(parseCommandInput("/")).toEqual({ name: "", args: [] });
    // 非斜杠输入不是命令（宿主会把它当普通消息发出去）
    expect(parseCommandInput("hello")).toBeNull();
    expect(parseCommandInput("")).toBeNull();
  });

  it("parseCommandArgs 与 parseCommandInput 的 args 同源（同一把尺子）", () => {
    for (const raw of ["/migrate", "/migrate self", "  /MIGRATE  self ", "/handoff", "/"]) {
      expect(parseCommandArgs(raw)).toEqual(parseCommandInput(raw)?.args ?? []);
    }
    expect(parseCommandArgs("/migrate summary extra")).toEqual(["summary", "extra"]);
  });

  it("blocksInput 只有「会调用模型」的命令为真（别名同样生效）", () => {
    expect(commandBlocksInput("migrate")).toBe(true);
    expect(commandBlocksInput("handoff")).toBe(true);
    // 别名归一到主名后仍应命中
    expect(commandBlocksInput("MIGRATE")).toBe(true);
    expect(commandBlocksInput("help")).toBe(false);
    expect(commandBlocksInput("think")).toBe(false);
    expect(commandBlocksInput("nope")).toBe(false);
  });

  it("每个命令的主名都能在表里查到自己的元数据", () => {
    for (const command of COMMAND_REGISTRY) {
      expect(findCommand(command.name)?.name).toBe(command.name);
      for (const alias of command.aliases ?? []) {
        expect(findCommand(alias)?.name).toBe(command.name);
      }
    }
  });
});
