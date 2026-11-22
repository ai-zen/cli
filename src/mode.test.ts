import { describe, it, expect } from "vitest";
import { decideMode, resolveInvocation, type TtyState } from "./mode.js";

const TTY: TtyState = { stdinIsTTY: true, stdoutIsTTY: true };
const PIPE_IN: TtyState = { stdinIsTTY: false, stdoutIsTTY: true };
const PIPE_OUT: TtyState = { stdinIsTTY: true, stdoutIsTTY: false };

describe("decideMode", () => {
  it("有位置参数 → stdio（即使全 TTY，绝不进 TUI）", () => {
    expect(decideMode(TTY, true)).toBe("stdio");
  });

  it("无参数 + 全 TTY → tui", () => {
    expect(decideMode(TTY, false)).toBe("tui");
  });

  it("无参数 + stdin 非 TTY → stdio", () => {
    expect(decideMode(PIPE_IN, false)).toBe("stdio");
  });

  it("无参数 + stdout 非 TTY → stdio", () => {
    expect(decideMode(PIPE_OUT, false)).toBe("stdio");
  });
});

describe("resolveInvocation", () => {
  it("无参数 + 全 TTY → tui", () => {
    expect(resolveInvocation([], TTY)).toEqual({ kind: "tui" });
  });

  it("位置参数拼接为指令 → stdio", () => {
    expect(resolveInvocation(["总结", "要点"], TTY)).toEqual({
      kind: "stdio",
      instruction: "总结 要点",
      save: false,
    });
  });

  it("无参数 + 管道 → stdio（指令为空，内容来自 stdin）", () => {
    expect(resolveInvocation([], PIPE_IN)).toEqual({
      kind: "stdio",
      instruction: "",
      save: false,
    });
  });

  it("--save 透传到 stdio", () => {
    expect(resolveInvocation(["--save", "你好"], TTY)).toEqual({
      kind: "stdio",
      instruction: "你好",
      save: true,
    });
  });

  it("hook 子命令短路", () => {
    expect(resolveInvocation(["hook", "install"], TTY)).toEqual({
      kind: "hook",
      action: "install",
    });
    expect(resolveInvocation(["hook", "uninstall"], PIPE_IN)).toEqual({
      kind: "hook",
      action: "uninstall",
    });
  });

  it("hook 缺参数 → usage（只是要看用法，不是错误）", () => {
    expect(resolveInvocation(["hook"], TTY)).toEqual({ kind: "hook", action: "usage" });
    // `ai hook --help` 与 `ai hook` 等价：--help 被当选项吃掉，不该以非零码退出
    expect(resolveInvocation(["hook", "--help"], TTY)).toEqual({ kind: "hook", action: "usage" });
  });

  it("hook 非法子动作 → usage 并带上那个动作（调用方据此报错 + 非零退出码）", () => {
    expect(resolveInvocation(["hook", "boom"], TTY)).toEqual({
      kind: "hook",
      action: "usage",
      invalidAction: "boom",
    });
  });

  it("`ai help` / `ai version` 单词形式等价于 `--help` / `--version`", () => {
    expect(resolveInvocation(["help"], TTY)).toEqual({ kind: "help" });
    expect(resolveInvocation(["version"], PIPE_IN)).toEqual({ kind: "version" });
  });

  it("但 `help` 只是句首词时仍是在提问（不当子命令）", () => {
    expect(resolveInvocation(["help", "me", "refactor", "this"], TTY)).toEqual({
      kind: "stdio",
      instruction: "help me refactor this",
      save: false,
    });
  });

  it("--help / --version 短路", () => {
    expect(resolveInvocation(["--help"], TTY)).toEqual({ kind: "help" });
    expect(resolveInvocation(["-h"], TTY)).toEqual({ kind: "help" });
    expect(resolveInvocation(["--version"], PIPE_IN)).toEqual({ kind: "version" });
    expect(resolveInvocation(["-v"], PIPE_IN)).toEqual({ kind: "version" });
  });

  it("--server-status 短路为诊断动作：即使带位置参数也不当提问", () => {
    expect(resolveInvocation(["--server-status"], TTY)).toEqual({ kind: "server-status" });
    expect(resolveInvocation(["--server-status", "随便说点什么"], TTY)).toEqual({
      kind: "server-status",
    });
    // 管道场景下同样是诊断动作（不该因为没有 TTY 就退化成 stdio 提问）
    expect(resolveInvocation(["--server-status"], PIPE_OUT)).toEqual({ kind: "server-status" });
  });

  it("`--` 之后的内容视为位置参数", () => {
    expect(resolveInvocation(["--", "--save"], TTY)).toEqual({
      kind: "stdio",
      instruction: "--save",
      save: false,
    });
  });

  it("未知的短横线选项按位置参数处理（不误伤以 - 开头的提问）", () => {
    expect(resolveInvocation(["-3", "+", "5", "等于几"], TTY)).toEqual({
      kind: "stdio",
      instruction: "-3 + 5 等于几",
      save: false,
    });
  });

  it("首个位置参数不是 hook 时，不会误判为子命令", () => {
    expect(resolveInvocation(["hook 是什么"], TTY)).toEqual({
      kind: "stdio",
      instruction: "hook 是什么",
      save: false,
    });
  });
});

/**
 * `--tui`：显式覆盖「有参数 → stdio」的规则。shell 钩子（`ai --tui --new "$@"`）靠它进 TUI，
 * 把敲错的命令当首条消息发给模型——而不是落到管道模式吐一段字就退出。
 */
describe("resolveInvocation / --tui（shell 钩子路径）", () => {
  it("全 TTY + 有参数 → tui，参数作为待发送的首条消息", () => {
    expect(resolveInvocation(["--tui", "gti", "status"], TTY)).toEqual({
      kind: "tui",
      initialPrompt: "gti status",
    });
  });

  it("全 TTY + 无参数 → tui（与不带 --tui 一致）", () => {
    expect(resolveInvocation(["--tui"], TTY)).toEqual({ kind: "tui", initialPrompt: undefined });
  });

  it("以 / 开头的命令仍当消息内容，不被当成选项/子命令", () => {
    expect(resolveInvocation(["--tui", "/opt/bin/foo", "--bar"], TTY)).toEqual({
      kind: "tui",
      initialPrompt: "/opt/bin/foo --bar",
    });
  });

  it("--tui + --help → help 优先（帮助是即时动作，不该拉界面）", () => {
    expect(resolveInvocation(["--tui", "--help"], TTY)).toEqual({ kind: "help" });
  });

  it("非 TTY 时拒绝而不是降级为 stdio（界面内容不能写进管道）", () => {
    expect(resolveInvocation(["--tui", "gti"], PIPE_IN)).toEqual({ kind: "tui-rejected" });
    expect(resolveInvocation(["--tui", "gti"], PIPE_OUT)).toEqual({ kind: "tui-rejected" });
  });

  it("`--` 之后的 --tui 是普通参数，不触发 TUI", () => {
    expect(resolveInvocation(["--", "--tui"], TTY)).toEqual({
      kind: "stdio",
      instruction: "--tui",
      save: false,
    });
  });
});

/**
 * `--new`：只影响 TUI 路径的「是否续接上一轮会话」，不改变模式判定本身。
 */
describe("resolveInvocation / --new（强制新会话）", () => {
  it("全 TTY + 无参数 → tui + newSession", () => {
    expect(resolveInvocation(["--new"], TTY)).toEqual({ kind: "tui", newSession: true });
  });

  it("--tui --new <命令> → tui + 首条消息 + newSession（钩子带 --new 的形态）", () => {
    expect(resolveInvocation(["--tui", "--new", "gti", "status"], TTY)).toEqual({
      kind: "tui",
      initialPrompt: "gti status",
      newSession: true,
    });
  });

  it("与顺序无关（--new 在 --tui 之前）", () => {
    expect(resolveInvocation(["--new", "--tui", "gti status"], TTY)).toEqual({
      kind: "tui",
      initialPrompt: "gti status",
      newSession: true,
    });
  });

  it("不在 TUI 路径时被忽略：有参数 → stdio", () => {
    expect(resolveInvocation(["--new", "总结要点"], TTY)).toEqual({
      kind: "stdio",
      instruction: "总结要点",
      save: false,
    });
  });

  it("不在 TUI 路径时被忽略：非 TTY → stdio", () => {
    expect(resolveInvocation(["--new"], PIPE_IN)).toEqual({
      kind: "stdio",
      instruction: "",
      save: false,
    });
  });

  it("--tui --new 非 TTY → tui-rejected（不降级为 stdio）", () => {
    expect(resolveInvocation(["--tui", "--new", "gti"], PIPE_OUT)).toEqual({
      kind: "tui-rejected",
    });
  });

  it("--new + --help → help 优先", () => {
    expect(resolveInvocation(["--new", "--help"], TTY)).toEqual({ kind: "help" });
  });

  it("`--` 之后的 --new 是普通参数", () => {
    expect(resolveInvocation(["--", "--new"], TTY)).toEqual({
      kind: "stdio",
      instruction: "--new",
      save: false,
    });
  });
});

/**
 * `--server <url>`：显式服务端地址（D11 / D12）。
 *
 * 本模块只负责**认出**它并原样带在结果上：合法性由 `config.ts` 的早期校验判（两条命令不该
 * 对同一个拼写错误说两种话），优先级（`--server` > `AI_ZEN_SERVER_URL`）也在那边。
 * 所以这里断言的全是「这个值有没有跟着走」，不是「它对不对」。
 */
describe("resolveInvocation / --server（显式地址）", () => {
  const URL_ = "wss://example.com/ai-zen";

  it("stdio 路径：地址跟着指令一起出来", () => {
    expect(resolveInvocation(["--server", URL_, "总结", "要点"], TTY)).toEqual({
      kind: "stdio",
      instruction: "总结 要点",
      save: false,
      serverUrl: URL_,
    });
  });

  it("顺序无关：地址放在位置参数之后也一样（且不会被当成提问内容）", () => {
    expect(resolveInvocation(["总结", "--server", URL_], TTY)).toEqual({
      kind: "stdio",
      instruction: "总结",
      save: false,
      serverUrl: URL_,
    });
  });

  it("不给 --server：结果里没有这个字段（地址交给环境变量 / 发现文件）", () => {
    expect(resolveInvocation(["你好"], TTY)).toEqual({
      kind: "stdio",
      instruction: "你好",
      save: false,
    });
  });

  it("TUI 路径同样带着它（`ai --server … ` 空参数时进界面）", () => {
    expect(resolveInvocation(["--server", URL_], TTY)).toEqual({
      kind: "tui",
      initialPrompt: undefined,
      newSession: undefined,
      serverUrl: URL_,
    });
  });

  it("--server-status 也带着它（远程诊断走同一个地址）", () => {
    expect(resolveInvocation(["--server-status", "--server", URL_], PIPE_OUT)).toEqual({
      kind: "server-status",
      serverUrl: URL_,
    });
  });

  it("`--server` 结尾没给值 → 空串（不是「没给」：静默连回本机会掩盖拼错）", () => {
    // 无位置参数 + 全 TTY 时模式仍是 TUI，但地址照样得带着（拼接错误不分模式）
    expect(resolveInvocation(["--server"], TTY)).toEqual({
      kind: "tui",
      initialPrompt: undefined,
      newSession: undefined,
      serverUrl: "",
    });
    expect(resolveInvocation(["你好", "--server"], TTY)).toEqual({
      kind: "stdio",
      instruction: "你好",
      save: false,
      serverUrl: "",
    });
  });

  it("`--` 之后的 --server 是普通参数（地址不能从分隔符后面长出来）", () => {
    expect(resolveInvocation(["--", "--server", URL_], TTY)).toEqual({
      kind: "stdio",
      instruction: `--server ${URL_}`,
      save: false,
    });
  });
});
