/**
 * subagent 结局的用例：**名册那一格 + 它自己那条消息 → 一个圆点**。
 *
 * 名册只说 `working` / `idle` / `ended`，不报「出错 / 被叫停」。但那两件事就写在它栏里最后一条
 * 消息上（`status` / `error`），所以它们能算回来（PRD 3.9「失败必须显示失败」）；一条消息都没有
 * 的时候算不出来 —— 那就停在名册那一格，**不猜**。
 */

import { beforeEach, describe, expect, it } from "vitest";
import { AgentNS } from "@ai-zen/agents-core";
import {
  forgetSubAgentEndings,
  markSubAgentEndingSpoken,
  subAgentEndingOf,
  subAgentStatusOf,
} from "./subagent-status.js";
import type { SubAgentFact } from "./session/types.js";

// 记账是模块级的（重挂载之后不能重说）：用例共享一张模块图，上一条说过的结局会串到下一条
beforeEach(() => forgetSubAgentEndings());

const fact = (state: SubAgentFact["state"]): SubAgentFact => ({
  toolCallId: "tool-1",
  name: "查一下",
  state,
});

const said = (overrides: Partial<AgentNS.Message> = {}): AgentNS.Message => ({
  id: "s-1",
  // `createdAt` 是 core 的必填格（夹具补齐，断言一个字不动）
  createdAt: overrides.createdAt ?? 1,
  role: AgentNS.Role.Assistant,
  status: AgentNS.MessageStatus.Completed,
  content: "查到了",
  ...overrides,
});

describe("subAgentStatusOf（subagent 那一格说的是什么）", () => {
  it("名册说还在动：就是「在跑」（现读的观测值，不去翻旧消息）", () => {
    expect(subAgentStatusOf(fact("working"), [])).toBe("working");
    // 哪怕它最后一条消息看起来已经结束，名册说在动就说在动
    expect(subAgentStatusOf(fact("working"), [said()])).toBe("working");
  });

  it("散场了、最后一条是正常回答：完成（`ended`）", () => {
    expect(subAgentStatusOf(fact("ended"), [said()])).toBe("ended");
    expect(subAgentStatusOf(fact("idle"), [said()])).toBe("idle");
  });

  it("最后一条消息 status 是 `error`（或带着 `error`）→ 失败", () => {
    expect(subAgentStatusOf(fact("ended"), [said({ status: AgentNS.MessageStatus.Error })])).toBe(
      "error",
    );
    expect(
      subAgentStatusOf(fact("idle"), [
        said({
          error: { name: "AgentError", message: "炸了" } as unknown as AgentNS.Message["error"],
        }),
      ]),
    ).toBe("error");
  });

  it("最后一条消息 status 是 `aborted` → 被叫停（与「失败」不是一回事）", () => {
    expect(subAgentStatusOf(fact("ended"), [said({ status: AgentNS.MessageStatus.Aborted })])).toBe(
      "aborted",
    );
  });

  it("结局只看**最后一条**：中间那条工具失败不算（它后来答完了）", () => {
    const tool = said({ id: "t-1", role: AgentNS.Role.Tool, status: AgentNS.MessageStatus.Error });
    expect(subAgentStatusOf(fact("ended"), [tool, said({ id: "s-2" })])).toBe("ended");
  });

  it("一条消息都没有：算不出来就停在名册那一格（不编一个「失败」出来）", () => {
    expect(subAgentStatusOf(fact("ended"), [])).toBe("ended");
    expect(subAgentStatusOf(fact("idle"), [])).toBe("idle");
  });
});

describe("subAgentEndingOf（结束了要说的那句话从哪里来）", () => {
  it("还在跑 / 还挂着：没有结局可说", () => {
    expect(subAgentEndingOf(fact("working"), [said()])).toBeNull();
    expect(subAgentEndingOf(fact("idle"), [said()])).toBeNull();
  });

  it("散场了、最后一条是正常回答：完成", () => {
    expect(subAgentEndingOf(fact("ended"), [said({ id: "s-9" })])).toEqual({
      ending: "ended",
      key: "s-9",
    });
  });

  it("失败：原话就是那一条消息上的 `error.message`（不另编一句）", () => {
    expect(
      subAgentEndingOf(fact("ended"), [
        said({
          id: "s-3",
          status: AgentNS.MessageStatus.Error,
          error: {
            name: "AgentError",
            message: "ECONNREFUSED 127.0.0.1:443",
          } as unknown as AgentNS.Message["error"],
        }),
      ]),
    ).toEqual({ ending: "error", reason: "ECONNREFUSED 127.0.0.1:443", key: "s-3" });
  });

  it("标注了出错、宿主却没给原因：只说失败，不猜原因", () => {
    expect(
      subAgentEndingOf(fact("ended"), [said({ id: "s-4", status: AgentNS.MessageStatus.Error })]),
    ).toEqual({ ending: "error", key: "s-4" });
  });

  it("被叫停不是失败：单独一格", () => {
    expect(
      subAgentEndingOf(fact("ended"), [said({ id: "s-5", status: AgentNS.MessageStatus.Aborted })]),
    ).toEqual({ ending: "aborted", key: "s-5" });
  });
});

describe("markSubAgentEndingSpoken（同一条结局只说一次）", () => {
  it("同一个键：头一次说、之后不再说", () => {
    expect(markSubAgentEndingSpoken("s-1")).toBe(true);
    expect(markSubAgentEndingSpoken("s-1")).toBe(false);
  });

  it("另一个键（下一次委派的另一条结局消息）照说", () => {
    expect(markSubAgentEndingSpoken("s-1")).toBe(true);
    expect(markSubAgentEndingSpoken("s-2")).toBe(true);
  });

  it("清空之后又是头一次（用例专用入口）", () => {
    expect(markSubAgentEndingSpoken("s-1")).toBe(true);
    forgetSubAgentEndings();
    expect(markSubAgentEndingSpoken("s-1")).toBe(true);
  });
});
