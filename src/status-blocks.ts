/**
 * 状态栏的块：**取哪几处事实、按什么顺序摆**（PRD F-I6 / 3.9）。
 *
 * ## 为什么在客户端拼
 *
 * 宿主曾经在状态读数里直接给一份拼好的 `statusBlocks`。那份副本只在「拉读数的那一刻」成立：
 * 聊天过程中模型名与思考档全冻在打开会话那一刻，而每次回答结束、`/model`、`/think`、撤回之后都
 * 没人去拉读数 —— 屏幕上于是永远显示进入会话时的样子。
 *
 * 根因不是「忘了刷新」，而是**同一批事实存了两份**。所以这里不持有拷贝：每一块都在**读的时候**
 * 从会话层现取，改动一处事实，下一帧就是新的。
 *
 * 拼块不产生任何新事实；这里只决定摆哪几块、什么顺序。
 *
 * ## 用量那两块：宿主不报 ≠ 没有
 *
 * 新契约里没有用量快照（宿主不算、不存、不报）。但用量本身**是消息身上的事实**
 * （`AgentNS.Message.usage`，`CORE.md` 只给了唯一一种读法）：
 *
 *   · **本次** = 最后一条带 `usage` 的 assistant 消息的 `total_tokens`；
 *   · **累计** = 全部 assistant 消息的 `usage` 求和（含各层级 subagent 那些栏）。
 *
 * 于是它照样上屏，只是数字由客户端从消息上算（`session.ts` 的 `lastTotalTokens()` /
 * `totalTokens()`），不向宿主讨一个不存在的字段。这里只负责「摆出来」。
 *
 * ## 五块，顺序即摆放顺序
 *
 *   1. **身份**：模型 · 助手 · 思考强度；
 *   2. **四件事**：闲 / 忙、输入闸、输出闸、死活（`PRD 4.4`「这四件事用户都要看得见」）；
 *   3. **用量**：本次 tok / 累计 tok（算不出来就整段不占位，见 `tui/components.tsx`）；
 *   4. **速率**：生成中显示实时估算、结束后显示这一批的平均（`session-rate.ts`，CLI 自己的
 *      观测口径，不是宿主的事实）；
 *   5. **快捷键**：界面自己的话。
 *
 * 「上下文占用 / 目录 / 在跑的工具 / subagent」仍然不进来：工具与 subagent 在**阶段行**与页签里
 * 已经有了，同一件事在两个地方各说一遍只是占宽度。
 */

import type { AgentState, ModelState, SessionActivity, ThinkingState } from "./session/types.js";
import type { RateSample } from "./session-rate.js";

/**
 * 状态栏的一块。块内结构按 id 不同而不同（判别式联合）。
 *
 * 块名不在这里：块里写什么字是界面的词汇（`tui/components.tsx`）。这里只有事实。
 */
export type StatusBlock =
  /** 身份块：模型 · 助手 · 思考强度（块内用 ` · ` 并排，见 `tui/components.tsx`） */
  | {
      id: "identity";
      facts: { model: ModelState; agent: AgentState; thinking: ThinkingState };
    }
  /**
   * 用量块：**本次**用掉的 tok 与**累计**用掉的 tok。
   *
   * 两个数都是客户端从消息的 `usage` 上算的（见文件头）：`null` = 这一段还没有一条带 `usage`
   * 的 assistant 消息（还没答过）—— 那是「不知道」，不写 0 假装。
   */
  | { id: "usage"; facts: { lastTokens: number | null; totalTokens: number | null } }
  /**
   * 四件事：闲 / 忙、输入闸、输出闸、死活（`PRD 4.4`）。
   *
   * 它们是**四件事**，不是四格合成值：压成一格必然有一项报不出来（`PRD 4.4` 原话）。
   * 这里也不合成 —— 每一格各自一格，界面上怎么写由 `tui/components.tsx` 决定。
   *
   * 四格全 `null` = 读数还没到：那时整块不占位（不借「闲」占位，那是要报给用户的事实）。
   */
  | {
      id: "gates";
      facts: {
        status: SessionActivity | null;
        inputPaused: boolean | null;
        outputPaused: boolean | null;
        alive: boolean | null;
      };
    }
  /** 速率块：生成中显示实时估算，结束后显示这一批的平均（没有数据时不显示这一段） */
  | { id: "rate"; facts: { rate: RateSample | null; working: boolean } }
  /**
   * 快捷键块：**没有宿主事实**，写的是界面自己的话（`StatusBar` 的 `hint`，随语言与滚动状态变）。
   *
   * 它仍然在块集合里：块是排版单位（窄屏时整块顺延到下一行），提示行必须和另几块共用同一套
   * 折行规则，否则「行数由 `statusBarRows` 说了算」这件事就有个例外。
   */
  | { id: "keys" };

/** 拼块要的输入：全部来自会话层的活事实（用量那两个数由会话层从消息上算） */
export interface StatusBlockFacts {
  agent: AgentState;
  model: ModelState;
  thinking: ThinkingState;
  /** 本次用掉的 tok（最后一条带 `usage` 的 assistant 消息；还没答过 = `null`） */
  lastTokens: number | null;
  /** 累计用掉的 tok（全部 assistant 消息的 `usage` 求和；一条都没有 = `null`） */
  totalTokens: number | null;
  /** 生成速率快照（`session.rateSample`；生成中为实时值，结束后保留平均） */
  rate: RateSample | null;
  /** 手上有没有活（`session.status === "working"`）：速率那一段据此决定说实时还是说平均 */
  working: boolean;
  /** 四件事（`PRD 4.4`）：闲忙 / 输入闸 / 输出闸 / 死活，各一格，不推算、不合成 */
  status: SessionActivity | null;
  inputPaused: boolean | null;
  outputPaused: boolean | null;
  alive: boolean | null;
}

/** 五块，顺序即摆放顺序：身份 → 四件事 → 用量 → 速率 → 快捷键（提示优先级最低，被挤掉时它先走）。 */
export function statusBlocksOf(facts: StatusBlockFacts): StatusBlock[] {
  return [
    {
      id: "identity",
      facts: { model: facts.model, agent: facts.agent, thinking: facts.thinking },
    },
    {
      id: "gates",
      facts: {
        status: facts.status,
        inputPaused: facts.inputPaused,
        outputPaused: facts.outputPaused,
        alive: facts.alive,
      },
    },
    { id: "usage", facts: { lastTokens: facts.lastTokens, totalTokens: facts.totalTokens } },
    { id: "rate", facts: { rate: facts.rate, working: facts.working } },
    { id: "keys" },
  ];
}
