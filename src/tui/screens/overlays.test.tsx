// 选择浮层的按键语义。
//
// 只测一件在生产里真的出过事的事：浮层弹出期间，`Chat` 的两个主输入处理器都
// 因为 `isActive` 带 `!pickerState` 而失活 —— 浮层自己若只认 Esc，那习惯按 Ctrl+C
// 的人在这段等待里就完全按不动（交接 / 迁移要先选执行者，正是最容易以为卡死的地方）。
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { PickerOverlay } from "./overlays.js";

const flush = async (ms = 4) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
      onPick={(value) => picked.push(value)}
    />,
  );
  return { picked, stdin, frame: () => lastFrame() ?? "", unmount };
}

describe("PickerOverlay", () => {
  it("Esc 取消：结算 null", async () => {
    const p = mount();
    await flush();
    p.stdin.write("\u001b");
    await flush(30); // lone ESC 需 ~20ms（ink 序列判定）
    expect(p.picked).toEqual([null]);
    p.unmount();
  });

  it("Ctrl+C 与 Esc 同义：结算 null（否则选择阶段无法中断）", async () => {
    const p = mount();
    await flush();
    p.stdin.write("\u0003");
    await flush();
    expect(p.picked).toEqual([null]);
    p.unmount();
  });

  it("回车选中高亮项（Ctrl+C 不误伤正常选择）", async () => {
    const p = mount();
    await flush();
    p.stdin.write("\r");
    await flush();
    expect(p.picked).toEqual(["a"]);
    p.unmount();
  });
});
