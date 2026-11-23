// 覆盖层状态机的单元测试 —— 只测 `resolve` 生命周期（谁结算、何时关、重复按会不会炸）
//
// 探针按 `Chat` 的方式使用 hook：命令层负责 `setPickerState`，
// 覆盖层组件负责 `resolvePicker`。
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Text, useInput } from "ink";
import { useChatOverlays } from "./use-overlays.js";

/**
 * 等到 `check()` 成立就返回；超时抛错，错误里说清等的是什么。
 *
 * **别用「睡够 4ms」代替它**：那是赌「够久」，而这里要的是「真的发生了」。上限 1000ms 是
 * **失败上限**，不是等待时长。
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
 * 同一拍里排在画帧**之后**（React 的 Scheduler 在 Node 下走 `setImmediate`）。所以「探针已经
 * 画出来了」还不等于「按键有人接」：这一刻塞进去的键会被直接**丢掉**，不是延后处理，是永远不到。
 */
const settle = async (turns = 2) => {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

/** `log` 记录 settlement 顺序；按键模拟「命令层弹窗」与「用户作答」 */
function Probe({ log }: { log: string[] }) {
  const o = useChatOverlays();
  useInput((char) => {
    if (char === "p") {
      o.setPickerState({
        title: "选一个",
        items: [
          { label: "A", value: "a" },
          { label: "B", value: "b" },
        ],
        resolve: (v) => log.push(`picker:${v}`),
      });
      return;
    }
    if (char === "1") return o.resolvePicker("a");
    if (char === "x") return o.resolvePicker(null);
  });
  return <Text>{`picker=${o.pickerState?.title ?? "null"}`}</Text>;
}

async function probe() {
  const log: string[] = [];
  const { stdin, lastFrame, unmount } = render(<Probe log={log} />);
  const frame = () => (lastFrame() ?? "").trim();
  await until(() => frame() === "picker=null", "探针画出来");
  // 画出来 ≠ 有人接键：`useInput` 的订阅在这之后一拍才写进 messages
  await settle();
  const press = async (char: string) => {
    await settle();
    stdin.write(char);
    await settle();
  };
  return { log, press, frame, unmount };
}

describe("useChatOverlays", () => {
  it("初始没有选择器", async () => {
    const p = await probe();
    expect(p.frame()).toBe("picker=null");
    p.unmount();
  });

  it("选中与取消分别结算值 / null，并关掉选择器", async () => {
    const p = await probe();
    await p.press("p");
    expect(p.frame()).toBe("picker=选一个");
    await p.press("1");
    // 等的是**结算**（`resolve` 真的被调到），不是「睡一下大概就结算了」
    await until(() => p.log.length > 0, "选中被结算");
    expect(p.log).toEqual(["picker:a"]);

    await p.press("p");
    expect(p.frame()).toBe("picker=选一个");
    await p.press("x");
    await until(() => p.log.length > 1, "取消被结算成 null");
    expect(p.log).toEqual(["picker:a", "picker:null"]);
    expect(p.frame()).toBe("picker=null");
    p.unmount();
  });

  it("已经关掉之后再作答是空操作（Esc 连按不会重复结算）", async () => {
    const p = await probe();
    await p.press("p");
    expect(p.frame()).toBe("picker=选一个");
    await p.press("1");
    await until(() => p.log.length > 0, "第一次作答被结算");
    expect(p.frame()).toBe("picker=null");

    // 这一条是**负向断言**：多按的那两下不该再结算一次。但「什么都没发生」也可能是
    // 「键被吞了」，所以下面必须给出「键真的被处理过」的证据。
    await p.press("1");
    await p.press("x");
    expect(p.log).toEqual(["picker:a"]);

    // 证据：同一个订阅里，`p` 按下就当场重新弹出选择器 —— 说明输入通道一直活着，
    // 上面那两下确实是被处理过的空操作（而不是丢键让这条用例误绿）。
    await p.press("p");
    expect(p.frame()).toBe("picker=选一个");
    p.unmount();
  });
});
