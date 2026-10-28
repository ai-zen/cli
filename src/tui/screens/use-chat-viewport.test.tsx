// 视口 hook 的单元测试 —— 只测「滚动算术 + 钳制 + 回底」这一层
//
// 用一个探针组件按 `Chat` 的方式使用 hook（布局在渲染期写入 `layoutRef`，键盘回调
// 读它），从真 stdin 发键，再断言 `viewTop` 的值 —— 这样测的是 hook 的**实际行为**，
// 而不是把内部实现抄一遍。
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Text, useInput } from "ink";
import { useChatViewport } from "./use-chat-viewport.js";
import { WHEEL_STEP } from "../mouse.js";

/** 模拟 `Chat`：布局随渲染写入 ref（`viewTop` 为 null 时布局自己算成贴底） */
function Probe({ totalLines, budget }: { totalLines: number; budget: number }) {
  const vp = useChatViewport();
  const effectiveTop = vp.viewTop ?? Math.max(0, totalLines - budget);
  vp.layoutRef.current = {
    lines: [],
    bottomLines: 0,
    totalLines,
    budget,
    viewTop: effectiveTop,
    scrolled: vp.viewTop != null,
  };
  useInput((char, key) => {
    if (key.pageUp) return vp.scrollByPage(-1);
    if (key.pageDown) return vp.scrollByPage(1);
    if (key.escape) return vp.scrollToBottom();
    if (key.upArrow) return vp.scrollByLine(-1);
    if (key.downArrow) return vp.scrollByLine(1);
    // 滚轮上滚的 SGR 上报（与 pty 实测形态一致：ESC 已剥掉）
    if (char === "[<64;10;5M") return vp.scrollByWheel(-1);
  });
  return <Text>top={vp.viewTop === null ? "null" : String(vp.viewTop)}</Text>;
}

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 40));
};

/** 挂载探针，返回「发键 + 读当前 top」的小工具 */
async function probe(totalLines: number, budget: number) {
  const { stdin, lastFrame, unmount } = render(<Probe totalLines={totalLines} budget={budget} />);
  await flush();
  const top = () => (lastFrame() ?? "").trim();
  const press = async (seq: string) => {
    stdin.write(seq);
    await flush();
  };
  return { top, press, unmount };
}

describe("useChatViewport", () => {
  it("初始贴底（viewTop 为 null）", async () => {
    const p = await probe(100, 10);
    expect(p.top()).toBe("top=null");
    p.unmount();
  });

  it("PgUp 从贴底往上翻一页（视口高 - 1 行，留一行上下文）", async () => {
    const p = await probe(100, 10);
    await p.press("\u001b[5~");
    // 贴底时布局顶部 = 100 - 10 = 90，往上翻 9 行
    expect(p.top()).toBe("top=81");
    p.unmount();
  });

  it("连续 PgUp 到顶后停在第 0 行（越界方向被吃掉）", async () => {
    const p = await probe(100, 10);
    for (let i = 0; i < 30; i++) await p.press("\u001b[5~");
    expect(p.top()).toBe("top=0");
    p.unmount();
  });

  it("往下翻回贴底后自动恢复跟随最新内容（null，而不是 0）", async () => {
    const p = await probe(100, 10);
    await p.press("\u001b[5~");
    for (let i = 0; i < 30; i++) await p.press("\u001b[6~");
    expect(p.top()).toBe("top=null");
    p.unmount();
  });

  it("滚轮一格滚 WHEEL_STEP 行", async () => {
    const p = await probe(100, 10);
    await p.press("[<64;10;5M");
    expect(p.top()).toBe(`top=${90 - WHEEL_STEP}`);
    p.unmount();
  });

  it("按行滚动一次一行；Esc 回到底部", async () => {
    const p = await probe(100, 10);
    await p.press("\u001b[A");
    expect(p.top()).toBe("top=89");
    await p.press("\u001b[A");
    expect(p.top()).toBe("top=88");
    await p.press("\u001b[B");
    expect(p.top()).toBe("top=89");
    await p.press("\u001b");
    expect(p.top()).toBe("top=null");
    p.unmount();
  });

  it("内容不足一屏时怎么滚都贴底（clampViewTop 返回 null）", async () => {
    const p = await probe(3, 10);
    await p.press("\u001b[5~");
    expect(p.top()).toBe("top=null");
    p.unmount();
  });
});
