import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TaskMigrationService } from "@ai-zen/agents-sdk";
import type { SendContext } from "@ai-zen/agents-sdk";
import {
  AutoMigrateConfirmPlugin,
  canPromptUser,
  confirmAutoMigrate,
} from "./auto-migrate-confirm-plugin.js";

// Mock inquirer（与 src/conversation-commands/back.test.ts 一致的做法）
vi.mock("inquirer", () => ({
  default: {
    prompt: vi.fn(),
  },
}));

import inquirer from "inquirer";

const MAX_TOKENS = 100;

interface PluginFixture {
  plugin: AutoMigrateConfirmPlugin;
  ctx: SendContext;
  migrateSpy: ReturnType<typeof vi.spyOn>;
  confirm: ReturnType<typeof vi.fn>;
  shouldConfirm: ReturnType<typeof vi.fn>;
  logSpy: ReturnType<typeof vi.spyOn>;
}

/**
 * 构造被测插件与其上下文。
 * @param promptTokens 当前用量（undefined 表示无 usage 数据）
 * @param confirmed 用户在确认框中的选择
 * @param interactive 是否存在确认通道（非交互环境为 false）
 */
function createFixture(options: {
  promptTokens?: number;
  confirmed?: boolean;
  interactive?: boolean;
}): PluginFixture {
  const { promptTokens, confirmed = true, interactive = true } = options;

  // 真实迁移服务实例（无钩子、不重建 Agent）；用 spy 观察是否被调用，避免真实模型请求
  const service = new TaskMigrationService();
  const migrateSpy = vi
    .spyOn(service, "migrate")
    .mockResolvedValue({} as never);

  const confirm = vi.fn(async () => confirmed);
  const shouldConfirm = vi.fn(() => interactive);
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

  const plugin = new AutoMigrateConfirmPlugin({
    service,
    maxTokens: MAX_TOKENS,
    confirm,
    shouldConfirm,
  });

  const ctx = {
    agent: {
      lastUsage:
        promptTokens == null ? undefined : { prompt_tokens: promptTokens },
    },
    content: "",
    messages: [],
  } as unknown as SendContext;

  return { plugin, ctx, migrateSpy, confirm, shouldConfirm, logSpy };
}

describe("AutoMigrateConfirmPlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("未超阈值时不询问、不迁移", async () => {
    const { plugin, ctx, migrateSpy, confirm } = createFixture({
      promptTokens: MAX_TOKENS,
    });

    await plugin.onAfterSend(ctx);

    expect(confirm).not.toHaveBeenCalled();
    expect(migrateSpy).not.toHaveBeenCalled();
  });

  it("没有 token 用量（lastUsage 缺失）时不询问、不迁移", async () => {
    const { plugin, ctx, migrateSpy, confirm } = createFixture({});

    await plugin.onAfterSend(ctx);

    expect(confirm).not.toHaveBeenCalled();
    expect(migrateSpy).not.toHaveBeenCalled();
  });

  it("超阈值且用户确认时，询问一次并执行迁移（透传用量信息）", async () => {
    const { plugin, ctx, migrateSpy, confirm, shouldConfirm } = createFixture({
      promptTokens: 150,
      confirmed: true,
    });

    await plugin.onAfterSend(ctx);

    expect(shouldConfirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith({
      promptTokens: 150,
      maxTokens: MAX_TOKENS,
    });
    expect(migrateSpy).toHaveBeenCalledTimes(1);
    expect(migrateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ promptTokens: 150, maxTokens: MAX_TOKENS }),
    );
  });

  it("超阈值但用户拒绝时，跳过本次迁移并给出提示", async () => {
    const { plugin, ctx, migrateSpy, confirm, logSpy } = createFixture({
      promptTokens: 150,
      confirmed: false,
    });

    await plugin.onAfterSend(ctx);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(migrateSpy).not.toHaveBeenCalled();

    const output = logSpy.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .join("\n");
    expect(output).toContain("已跳过本次任务迁移");
    expect(output).toContain("/migrate");
  });

  it("非交互环境（无 TTY）不询问，保持既有自动迁移行为", async () => {
    const { plugin, ctx, migrateSpy, confirm, shouldConfirm } = createFixture({
      promptTokens: 150,
      interactive: false,
    });

    await plugin.onAfterSend(ctx);

    expect(shouldConfirm).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(migrateSpy).toHaveBeenCalledTimes(1);
  });
});

describe("canPromptUser", () => {
  const originalStdinIsTTY = Object.getOwnPropertyDescriptor(
    process.stdin,
    "isTTY",
  );
  const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(
    process.stdout,
    "isTTY",
  );

  function setTTY(target: NodeJS.WriteStream | NodeJS.ReadStream, value: boolean) {
    Object.defineProperty(target, "isTTY", {
      value,
      configurable: true,
    });
  }

  afterEach(() => {
    if (originalStdinIsTTY)
      Object.defineProperty(process.stdin, "isTTY", originalStdinIsTTY);
    if (originalStdoutIsTTY)
      Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTTY);
  });

  it("stdin 与 stdout 均为 TTY 时可询问", () => {
    setTTY(process.stdin, true);
    setTTY(process.stdout, true);

    expect(canPromptUser()).toBe(true);
  });

  it("stdin 或 stdout 非 TTY 时不可询问", () => {
    setTTY(process.stdin, false);
    setTTY(process.stdout, true);
    expect(canPromptUser()).toBe(false);

    setTTY(process.stdin, true);
    setTTY(process.stdout, false);
    expect(canPromptUser()).toBe(false);
  });
});

describe("confirmAutoMigrate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("默认「是」，回车即迁移，并在文案中展示用量", async () => {
    vi.mocked(inquirer.prompt).mockResolvedValueOnce({ confirmed: true });

    const result = await confirmAutoMigrate({
      promptTokens: 260000,
      maxTokens: 250000,
    });

    expect(result).toBe(true);
    const [questions] = vi.mocked(inquirer.prompt).mock.calls[0];
    const question = (questions as any[])[0];
    expect(question.type).toBe("confirm");
    expect(question.default).toBe(true);
    expect(question.message).toContain("260000/250000");
  });

  it("用户选择「否」时返回 false", async () => {
    vi.mocked(inquirer.prompt).mockResolvedValueOnce({ confirmed: false });

    const result = await confirmAutoMigrate({
      promptTokens: 260000,
      maxTokens: 250000,
    });

    expect(result).toBe(false);
  });
});
