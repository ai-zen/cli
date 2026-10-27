import { describe, it, expect, vi, beforeEach } from "vitest";
import { canPromptUser, createAutoMigratePlugin } from "./auto-migrate-confirm.js";
import type { HandoffService } from "@ai-zen/agents-sdk";
import { setLocale } from "./i18n/index.js";

// 跳过迁移的提示已 i18n 化：用例断言中文，显式锁定语言（不依赖宿主 LANG）
beforeEach(() => setLocale("zh"));

const MAX_TOKENS = 100;

function stubService() {
  const migrate = vi.fn(async (_params: any) => ({}) as any);
  const service = { busy: false, migrate } as unknown as HandoffService;
  return { service, migrate };
}

function buildCtx(promptTokens?: number): any {
  return {
    agent: {
      lastUsage:
        promptTokens == null ? undefined : { prompt_tokens: promptTokens },
    },
    content: "",
    messages: [],
  };
}

describe("canPromptUser", () => {
  it("测试环境（非 TTY）返回 false", () => {
    expect(canPromptUser()).toBe(false);
  });
});

describe("createAutoMigratePlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("未超阈值时不询问、不迁移", async () => {
    const { service, migrate } = stubService();
    const choose = vi.fn(async () => "self" as const);
    const plugin = createAutoMigratePlugin({ service, handoffTokens: MAX_TOKENS, choose, shouldConfirm: () => true });

    await plugin.onAfterSend!(buildCtx(MAX_TOKENS));

    expect(choose).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
  });

  it("非交互环境：不询问，按默认执行者（self）迁移", async () => {
    const { service, migrate } = stubService();
    const choose = vi.fn(async () => "summary" as const);
    const plugin = createAutoMigratePlugin({
      service,
      handoffTokens: MAX_TOKENS,
      choose,
      shouldConfirm: () => false,
    });

    await plugin.onAfterSend!(buildCtx(MAX_TOKENS + 1));

    expect(choose).not.toHaveBeenCalled();
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(migrate.mock.calls[0][0].mode).toBe("self");
  });

  it("交互环境：把用户的执行者选择透传给 migrate", async () => {
    const { service, migrate } = stubService();
    const choose = vi.fn(async () => "summary" as const);
    const plugin = createAutoMigratePlugin({ service, handoffTokens: MAX_TOKENS, choose, shouldConfirm: () => true });

    await plugin.onAfterSend!(buildCtx(MAX_TOKENS + 1));

    expect(choose).toHaveBeenCalledWith({ promptTokens: MAX_TOKENS + 1, handoffTokens: MAX_TOKENS });
    expect(migrate.mock.calls[0][0].mode).toBe("summary");
  });

  it("交互环境：用户取消（choose 返回 null）→ 跳过本次迁移并提示", async () => {
    const { service, migrate } = stubService();
    const logs: string[] = [];
    const plugin = createAutoMigratePlugin({
      service,
      handoffTokens: MAX_TOKENS,
      choose: async () => null,
      shouldConfirm: () => true,
      log: (text) => logs.push(text),
    });

    await plugin.onAfterSend!(buildCtx(MAX_TOKENS + 1));

    expect(migrate).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("已跳过本次任务迁移");
    expect(logs.join("\n")).toContain("/migrate");
  });

  it("defaultMode 可配置（非交互环境生效）", async () => {
    const { service, migrate } = stubService();
    const plugin = createAutoMigratePlugin({
      service,
      handoffTokens: MAX_TOKENS,
      choose: async () => null,
      shouldConfirm: () => false,
      defaultMode: "summary",
    });

    await plugin.onAfterSend!(buildCtx(MAX_TOKENS + 1));

    expect(migrate.mock.calls[0][0].mode).toBe("summary");
  });

  it("交接进行中（busy）时让行", async () => {
    const migrate = vi.fn(async (_params: any) => ({}) as any);
    const service = { busy: true, migrate } as unknown as HandoffService;
    const choose = vi.fn(async () => "self" as const);
    const plugin = createAutoMigratePlugin({ service, handoffTokens: MAX_TOKENS, choose, shouldConfirm: () => true });

    await plugin.onAfterSend!(buildCtx(MAX_TOKENS + 1));

    expect(choose).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
  });
});
