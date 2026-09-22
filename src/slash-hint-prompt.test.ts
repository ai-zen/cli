import { describe, it, expect, afterEach } from "vitest";
import type { Interface } from "node:readline";
import { SlashHintPrompt, renderCommandHint } from "./slash-hint-prompt.js";

/** 剥离 ANSI 转义序列（inquirer 内部着色库不受 chalk 的测试环境降级影响） */
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;
function plain(text: string | undefined): string {
  return (text ?? "").replace(ANSI_PATTERN, "");
}

/** 构造一个仅满足渲染路径所需字段的 readline 替身 */
function createFakeRl(line: string): Interface {
  return { line } as unknown as Interface;
}

function createPrompt(line: string) {
  const calls: Array<{ content: string; bottomContent?: string }> = [];
  const prompt = new SlashHintPrompt(
    { name: "question", message: "你:", prefix: "💬" },
    createFakeRl(line),
    {},
  );
  prompt.screen = {
    render: (content: string, bottomContent?: string) => {
      calls.push({ content, bottomContent });
    },
  };
  return { prompt, calls };
}

const originalIsTTY = process.stdout.isTTY;

function stubIsTTY(value: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", {
    value,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  stubIsTTY(originalIsTTY as boolean);
});

describe("renderCommandHint", () => {
  it("普通聊天内容不产生提示", () => {
    expect(renderCommandHint("")).toBe("");
    expect(renderCommandHint("你好，介绍一下项目")).toBe("");
    expect(renderCommandHint("12345")).toBe("");
  });

  it("仅输入 / 时列出全部命令及其说明", () => {
    const hint = renderCommandHint("/");
    expect(hint).toContain("/exit /quit");
    expect(hint).toContain("退出对话（会提示是否保存）");
    expect(hint).toContain("/save");
    expect(hint).toContain("/migrate");
    expect(hint.split("\n")).toHaveLength(8);
  });

  it("按前缀收敛候选", () => {
    const hint = renderCommandHint("/sav");
    expect(hint).toContain("/save");
    expect(hint).not.toContain("/back");
    expect(hint.split("\n")).toHaveLength(1);
  });

  it("别名参与匹配", () => {
    expect(renderCommandHint("/q")).toContain("/exit /quit");
  });

  it("无匹配时给出提示", () => {
    expect(renderCommandHint("/zzz")).toContain("无匹配命令");
  });
});

describe("SlashHintPrompt 渲染", () => {
  it("TTY 下输入 / 时在底栏渲染候选命令", () => {
    stubIsTTY(true);
    const { prompt, calls } = createPrompt("/");
    prompt.status = "touched";

    prompt.render();

    expect(calls).toHaveLength(1);
    expect(plain(calls[0].content)).toBe("💬 你: /");
    expect(calls[0].bottomContent).toContain("/exit /quit");
  });

  it("TTY 下普通输入不渲染底栏", () => {
    stubIsTTY(true);
    const { prompt, calls } = createPrompt("你好");

    prompt.render();

    expect(plain(calls[0].content)).toBe("💬 你: 你好");
    expect(calls[0].bottomContent).toBe("");
  });

  it("非 TTY（重定向/脚本）下不渲染底栏", () => {
    stubIsTTY(false);
    const { prompt, calls } = createPrompt("/");

    prompt.render();

    expect(calls[0].bottomContent).toBe("");
  });

  it("提交后不再渲染底栏", () => {
    stubIsTTY(true);
    const { prompt, calls } = createPrompt("/save");
    prompt.status = "answered";
    prompt.answer = "/save";

    prompt.render();

    expect(plain(calls[0].content)).toBe("💬 你: /save");
    expect(calls[0].bottomContent).toBe("");
  });

  it("错误行优先于命令提示展示", () => {
    stubIsTTY(true);
    const { prompt, calls } = createPrompt("/");

    prompt.render("校验失败");

    expect(calls[0].bottomContent).toContain("校验失败");
    expect(calls[0].bottomContent).toContain("/exit /quit");
  });
});
