// 选择浮层的按键语义。
//
// 只测一件在生产里真的出过事的事：浮层弹出期间，`Chat` 的两个主输入处理器都
// 因为 `isActive` 带 `!pickerState` 而失活 —— 浮层自己若只认 Esc，那习惯按 Ctrl+C
// 的人在这段等待里就完全按不动（交接 / 迁移要先选执行者，正是最容易以为卡死的地方）。
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { PickerOverlay } from "./overlays.js";

/**
 * 等到 `check()` 成立就返回；超时抛错，错误里说清等的是什么。
 *
 * **别用「睡够多少毫秒」代替它**：那是赌「够久」，而这里要的是「真的发生了」。上限 1000ms
 * 是**失败上限**，不是等待时长。
 */
const until = async (check: () => boolean, what: string, timeoutMs = 1000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`等不到：${what}（上限 ${timeoutMs}ms）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/**
 * 让出几拍宏任务 —— 让这一拍里**排在后面**的活先跑完。让的是执行顺序，不是一个时长。
 *
 * 为什么敲键之前要它：帧是在 commit 里画的，而 `useInput` 的订阅落在 passive effect 里，
 * 同一拍里排在画帧**之后**（React 的 Scheduler 在 Node 下走 `setImmediate`）。所以「帧里已经
 * 有浮层」还不等于「按键有人接」：这一刻塞进去的键会被直接**丢掉**，之后再睡多久都没用。
 */
const settle = async (turns = 2) => {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

function mount() {
  const picked: (string | null)[] = [];
  const { stdin, lastFrame, unmount } = render(
    <PickerOverlay
      title="选一个"
      items={[
        { label: "A", value: "a" },
        { label: "B", value: "b" },
      ]}
      columns={80}
      maxRows={10}
      onPick={(value) => picked.push(value)}
    />,
  );
  return { picked, stdin, frame: () => lastFrame() ?? "", unmount };
}

/** 浮层画出来、并且「按键有人接」的状态 —— 敲任何键之前都要先到这个状态 */
async function mounted() {
  const p = mount();
  await until(() => p.frame().includes("选一个"), "选择浮层画出来");
  await settle();
  return p;
}

describe("PickerOverlay", () => {
  it("Esc 取消：结算 null", async () => {
    const p = await mounted();
    p.stdin.write("\u001b");
    // 单键 Esc 要等 ink 自己的序列判定（~20ms）才认成 Esc —— 等它认，不猜它多久
    await until(() => p.picked.length > 0, "Esc 被结算成取消");
    expect(p.picked).toEqual([null]);
    p.unmount();
  });

  it("Ctrl+C 与 Esc 同义：结算 null（否则选择阶段无法中断）", async () => {
    const p = await mounted();
    p.stdin.write("\u0003");
    await until(() => p.picked.length > 0, "Ctrl+C 被结算成取消");
    expect(p.picked).toEqual([null]);
    p.unmount();
  });

  it("回车选中高亮项（Ctrl+C 不误伤正常选择）", async () => {
    const p = await mounted();
    p.stdin.write("\r");
    await until(() => p.picked.length > 0, "回车被结算成选中");
    expect(p.picked).toEqual(["a"]);
    p.unmount();
  });

  /**
   * 标题**折行**而不是裁切。
   *
   * 破坏性动作之前那一问（`/shutdown`、`/upgrade`、`/delete`）说的就是代价：裁掉后半截等于
   * 少说一个事实，而「同机其他客户端也会断开」正好落在后半截。这里用一条长到装不下的标题，
   * 钉住末尾那一段真的画出来了。
   */
  it("长标题折行：末尾那一段不被裁掉", async () => {
    const tail = "TAIL";
    const { lastFrame, unmount } = render(
      <PickerOverlay
        title={`${"前提。".repeat(30)} ${tail}`}
        items={[{ label: "A", value: "a" }]}
        columns={80}
        maxRows={10}
        onPick={() => {}}
      />,
    );

    await until(() => (lastFrame() ?? "").includes(tail), "长标题的末尾画出来了");
    unmount();
  });
});
