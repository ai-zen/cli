// 对话视口 —— 「翻页 / 按行 / 滚轮 / 回底」的唯一入口
//
// 从 `chat.tsx` 抽出来的理由：视口是**不依赖会话**的独立状态机（一个 `viewTop` 状态
// 加一份最近布局的引用），却被塞在 God Component 里，与消息、输入、向导混在一起。
// 抽出来后，「滚动」这件事只有这一个地方能改。
//
// 关键点：所有动作都走 `scrollTo()` → `clampViewTop()`，因此
//   · 越界方向被自然吃掉，不会出现「滚过头回不来」；
//   · 回到底部时 `clampViewTop()` 返回 `null`，视口**自动**恢复「跟随最新内容」，
//     不需要各处手写「滚到底就清空滚动状态」。
import { useCallback, useRef, useState, type RefObject } from "react";
import { WHEEL_STEP } from "../mouse.js";
import { clampViewTop, type ChatLayout } from "./layout.js";

export interface ChatViewport {
  /** 视口顶部行索引（相对整个对话行）；`null` = 贴底（自动跟随最新内容） */
  viewTop: number | null;
  /**
   * 最近一帧的布局。**由渲染体在算完布局后写入**（`viewport.layoutRef.current = layout`）：
   * 键盘回调需要的总行数 / 视口高度只有布局算完才知道，而布局又依赖 `viewTop`
   * —— 用 ref 传递可避免两个方向互相等待。
   */
  layoutRef: RefObject<ChatLayout | null>;
  /** 滚到指定顶部（会被钳制；贴底时自动回到 `null`） */
  scrollTo: (nextTop: number) => void;
  /** 翻页：一页 = 视口高度 - 1 行（留一行上下文，不至于跳得没头没尾） */
  scrollByPage: (dir: -1 | 1) => void;
  /** 按行滚动 */
  scrollByLine: (dir: -1 | 1) => void;
  /** 鼠标滚轮：一格滚 `WHEEL_STEP` 行（与按行滚动共用一个钳制入口） */
  scrollByWheel: (dir: -1 | 1) => void;
  /** 贴底（恢复跟随最新内容） */
  scrollToBottom: () => void;
}

export function useChatViewport(): ChatViewport {
  const [viewTop, setViewTop] = useState<number | null>(null);
  const layoutRef = useRef<ChatLayout | null>(null);

  // 下面的回调只读 `layoutRef`（布局每帧更新）与 `setViewTop`，没有闭包捕获的旧状态，
  // 所以依赖数组为空即可保持引用稳定（可安全传给 memo 化的子组件）。
  const scrollTo = useCallback((nextTop: number) => {
    const L = layoutRef.current;
    if (!L) return;
    setViewTop(clampViewTop(L.totalLines, L.budget, nextTop));
  }, []);

  const scrollByPage = useCallback(
    (dir: -1 | 1) => {
      const L = layoutRef.current;
      if (!L) return;
      // 按「布局实际生效的顶部」算，而不是原始 `viewTop`：贴底时 `viewTop` 是
      // `null`，从 `layout.viewTop` 起算才能从底部往上翻一屏。
      scrollTo(L.viewTop + dir * Math.max(1, L.budget - 1));
    },
    [scrollTo],
  );

  const scrollByLine = useCallback(
    (dir: -1 | 1) => {
      const L = layoutRef.current;
      if (!L) return;
      scrollTo(L.viewTop + dir);
    },
    [scrollTo],
  );

  const scrollByWheel = useCallback(
    (dir: -1 | 1) => {
      const L = layoutRef.current;
      if (!L) return;
      scrollTo(L.viewTop + dir * WHEEL_STEP);
    },
    [scrollTo],
  );

  const scrollToBottom = useCallback(() => setViewTop(null), []);

  return { viewTop, layoutRef, scrollTo, scrollByPage, scrollByLine, scrollByWheel, scrollToBottom };
}
