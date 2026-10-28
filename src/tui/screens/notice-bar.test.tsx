// 通知栏渲染：断言「多条通知真的都画出来了」。
//
// 这条路径以前没有任何测试——内联在 `Chat` 的 JSX 里，而 `Chat` 依赖整条会话链路
// （读配置 / 建 Agent / 连 MCP），没法单独渲染。而「只显示最后一条」这个 bug 恰恰
// 就出在这一层之上（单槽 state），所以渲染映射必须可测。
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { NoticeBar } from "./notice-bar.js";
import { noticeLines, type Notice } from "./notice.js";

const notice = (text: string, tone: "info" | "error" = "info", seq = 1): Notice => ({
  text,
  tone,
  seq,
});

const draw = (notices: Notice[], columns = 80): string => {
  const { lastFrame, unmount } = render(<NoticeBar lines={noticeLines(notices, columns)} />);
  const frame = lastFrame() ?? "";
  unmount();
  return frame;
};

describe("NoticeBar（通知栏渲染）", () => {
  it("队列里的每一条都上屏（不是只剩最后一条）", () => {
    const frame = draw([
      notice("配置已更新：模型名", "info", 1),
      notice("配置已更新：默认 Agent", "info", 2),
    ]);
    expect(frame).toContain("配置已更新：模型名");
    expect(frame).toContain("配置已更新：默认 Agent");
  });

  it("同一批摘要合成的一条多行也整体上屏", () => {
    const multi = notice("配置已更新：\n  模型名\n  默认 Agent", "info", 1);
    const frame = draw([multi]);
    expect(frame).toContain("模型名");
    expect(frame).toContain("默认 Agent");
  });

  it("info / error 两种语气都从行首开始，靠颜色区分", () => {
    const frame = draw([notice("已保存", "info", 1), notice("读取出错", "error", 2)]);
    expect(frame).toContain("已保存");
    expect(frame).toContain("读取出错");
    // 不加 `· ` / `✖ ` 前缀：文本与分隔线、输入行左对齐（语气差异由着色的 tone 表达）
    expect(frame).not.toContain("·");
    expect(frame).not.toContain("✖");
  });

  it("空队列不渲染任何内容", () => {
    expect(draw([])).toBe("");
  });
});
