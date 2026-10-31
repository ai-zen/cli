// `@` 文件菜单的渲染护栏：行数、视窗滚动、扫描中占位。
//
// 行数这条尤其重要：`computeChatLayout` 用的是 `mentionMenuRows()`，这里断言的是
// 「真正渲染出几行」。两者一旦不一致，输入框就会整体位移一行，硬件光标（IME）跟着偏。
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { MentionMenu } from "./components.js";
import { setLocale } from "../i18n/index.js";
import { MENTION_ROWS, type PathEntry } from "./mention.js";

const items: PathEntry[] = Array.from({ length: 30 }, (_, i) => ({
  path: `src/file${String(i).padStart(2, "0")}.ts`,
  dir: false,
}));

const lines = (frame: string) => frame.split("\n").filter((line) => line.trim().length > 0);

describe("MentionMenu", () => {
  it("候选超过一屏时只渲染 MENTION_ROWS 行（布局不会被候选数撑爆）", () => {
    setLocale("zh");
    const { lastFrame, unmount } = render(<MentionMenu items={items} selected={0} scanning={false} />);
    expect(lines(lastFrame() ?? "")).toHaveLength(MENTION_ROWS);
    expect(lastFrame() ?? "").toContain("file00.ts");
    unmount();
  });

  it("高亮越出窗口后视窗跟随滚动", () => {
    const { lastFrame, unmount } = render(<MentionMenu items={items} selected={12} scanning={false} />);
    const frame = lastFrame() ?? "";
    expect(lines(frame)).toHaveLength(MENTION_ROWS);
    expect(frame).toContain("file12.ts");
    expect(frame).not.toContain("file00.ts");
    unmount();
  });

  it("目录带尾斜杠（提示「选中后会继续往下钻」）", () => {
    const { lastFrame, unmount } = render(
      <MentionMenu items={[{ path: "src/tui", dir: true }]} selected={0} scanning={false} />,
    );
    expect(lastFrame() ?? "").toContain("src/tui/");
    unmount();
  });

  it("扫描中额外占一行（这一行已算进 mentionMenuRows）", () => {
    setLocale("zh");
    const { lastFrame, unmount } = render(<MentionMenu items={[]} selected={0} scanning={true} />);
    const frame = lastFrame() ?? "";
    expect(lines(frame)).toHaveLength(1);
    expect(frame).toContain("扫描");
    unmount();
  });

  it("扫描结束且无匹配：不占行", () => {
    const { lastFrame, unmount } = render(<MentionMenu items={[]} selected={0} scanning={false} />);
    expect(lines(lastFrame() ?? "")).toHaveLength(0);
    unmount();
  });
});
