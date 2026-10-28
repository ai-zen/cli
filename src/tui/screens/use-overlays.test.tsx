// 覆盖层状态机的单元测试 —— 只测 `resolve` 生命周期（谁结算、何时关、重复按会不会炸）
//
// 探针按 `Chat` 的方式使用 hook：命令层负责 `setConfirmState` / `setPickerState`，
// 覆盖层组件负责 `resolveConfirm` / `resolvePicker`。
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Text, useInput } from "ink";
import { useChatOverlays } from "./use-overlays.js";

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 40));
};

/** `log` 记录 settlement 顺序；按键模拟「命令层弹窗」与「用户作答」 */
function Probe({ log }: { log: string[] }) {
  const o = useChatOverlays();
  useInput((char) => {
    if (char === "?") {
      o.setConfirmState({ question: "确定吗", resolve: (v) => log.push(`confirm:${v}`) });
      return;
    }
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
    if (char === "y") return o.resolveConfirm(true);
    if (char === "n") return o.resolveConfirm(false);
    if (char === "1") return o.resolvePicker("a");
    if (char === "x") return o.resolvePicker(null);
  });
  return (
    <Text>
      {`confirm=${o.confirmState?.question ?? "null"} picker=${o.pickerState?.title ?? "null"}`}
    </Text>
  );
}

async function probe() {
  const log: string[] = [];
  const { stdin, lastFrame, unmount } = render(<Probe log={log} />);
  await flush();
  const press = async (char: string) => {
    stdin.write(char);
    await flush();
  };
  return { log, press, frame: () => (lastFrame() ?? "").trim(), unmount };
}

describe("useChatOverlays", () => {
  it("初始两个覆盖层都为空", async () => {
    const p = await probe();
    expect(p.frame()).toBe("confirm=null picker=null");
    p.unmount();
  });

  it("确认框作答后结算 Promise，并关掉覆盖层", async () => {
    const p = await probe();
    await p.press("?");
    expect(p.frame()).toBe("confirm=确定吗 picker=null");
    await p.press("y");
    expect(p.log).toEqual(["confirm:true"]);
    expect(p.frame()).toBe("confirm=null picker=null");
    p.unmount();
  });

  it("「否」也走同一条路（结算 false）", async () => {
    const p = await probe();
    await p.press("?");
    await p.press("n");
    expect(p.log).toEqual(["confirm:false"]);
    expect(p.frame()).toBe("confirm=null picker=null");
    p.unmount();
  });

  it("选择器选中与取消分别结算值 / null", async () => {
    const p = await probe();
    await p.press("p");
    expect(p.frame()).toBe("confirm=null picker=选一个");
    await p.press("1");
    expect(p.log).toEqual(["picker:a"]);

    await p.press("p");
    await p.press("x");
    expect(p.log).toEqual(["picker:a", "picker:null"]);
    expect(p.frame()).toBe("confirm=null picker=null");
    p.unmount();
  });

  it("已经关掉之后再作答是空操作（Esc 连按不会重复结算）", async () => {
    const p = await probe();
    await p.press("?");
    await p.press("y");
    await p.press("y");
    await p.press("n");
    expect(p.log).toEqual(["confirm:true"]);
    p.unmount();
  });

  it("两种覆盖层互不影响（确认框与选择器各自结算）", async () => {
    const p = await probe();
    await p.press("p");
    await p.press("1");
    await p.press("?");
    await p.press("y");
    expect(p.log).toEqual(["picker:a", "confirm:true"]);
    p.unmount();
  });
});
