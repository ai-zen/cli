import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  COMMAND_LABEL_WIDTH,
  COMMAND_REGISTRY,
  getCommandHints,
  getCommandNames,
  matchCommandHints,
} from "./registry.js";
import { dispatchCommand } from "./index.js";
import type { ConversationContext } from "../types.js";

function createCtx(input: string): ConversationContext {
  return {
    input,
    agent: { messages: [] },
    currentName: "test",
    modelId: "test-model",
    currentId: undefined,
    agentId: undefined,
    running: true,
  } as unknown as ConversationContext;
}

describe("对话命令元数据", () => {
  it("展示条目折叠别名，首项为主命令名", () => {
    const exit = getCommandHints()[0];
    expect(exit).toEqual({
      names: ["exit", "quit"],
      label: "/exit /quit",
      description: "退出对话（会提示是否保存）",
    });
  });

  it("每个命令均有非空说明", () => {
    for (const hint of getCommandHints()) {
      expect(hint.description.trim().length).toBeGreaterThan(0);
    }
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
      { names: ["save"], label: "/save", description: "保存当前对话" },
    ]);
  });

  it("别名同样参与匹配且大小写不敏感", () => {
    expect(matchCommandHints("Q").map((hint) => hint.label)).toEqual(["/exit /quit"]);
    expect(matchCommandHints("QUIT").map((hint) => hint.label)).toEqual(["/exit /quit"]);
  });

  it("无匹配时返回空数组", () => {
    expect(matchCommandHints("zzz")).toEqual([]);
  });
});

describe("命令分发", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("未知命令给出提示并清空输入", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = createCtx("/zzz");

    expect(await dispatchCommand(ctx)).toBe(true);
    expect(ctx.input).toBe("");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("未知命令"));
  });

  it("别名与主命令分发到同一处理函数", async () => {
    const exitCtx = createCtx("/exit");
    const quitCtx = createCtx("/quit");

    await dispatchCommand(exitCtx);
    await dispatchCommand(quitCtx);

    expect(exitCtx.running).toBe(false);
    expect(quitCtx.running).toBe(false);
  });

  it("非命令输入不拦截", async () => {
    const ctx = createCtx("你好");
    expect(await dispatchCommand(ctx)).toBe(false);
    expect(ctx.input).toBe("你好");
  });
});
