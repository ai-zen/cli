// 向导宿主的单元测试 —— 测「读快照 → 接管 → 关闭后让改动生效」这条生命周期
//
// 依赖全部注入（通知 / 是否有会话 / 重启 / 重载），配置与 Agent 仓储打桩，
// 于是这段逻辑第一次可以在没有真终端、没有真会话的情况下被断言。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { Text, useInput } from "ink";
import { setLocale } from "../../i18n/index.js";

const { calls, fakeConfig, fakeAgents } = vi.hoisted(() => {
  const calls: { notify: [string, string?][]; restarted: number; reloaded: number } = {
    notify: [],
    restarted: 0,
    reloaded: 0,
  };
  /** 一份最小可用配置：模型 gpt-6 绑在端点 e1 上 */
  const fakeConfig = () => ({
    models: [{ id: "gpt-6", name: "GPT 6", endpointId: "e1" }],
    endpoints: [{ id: "e1", name: "E1", baseUrl: "https://example.test/v1", apiKey: "sk-test" }],
    imageModels: [],
  });
  const fakeAgents = () => ({ agents: [{ id: "default", name: "Default" }] });
  return { calls, fakeConfig, fakeAgents };
});

vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    readConfig: vi.fn(async () => fakeConfig()),
    readReasoningPresets: vi.fn(async () => ({})),
    readMcpConfig: vi.fn(async (scope: string) => ({ mcpServers: {}, scope })),
  };
});

vi.mock("../../agents-store.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, readAgentStore: vi.fn(async () => actual.createAgentStore(fakeAgents().agents as any, [])) };
});

import { useWizardHost } from "./use-wizard-host.js";
import { readConfig } from "../../config.js";

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 40));
};

/** 探针：把 hook 的状态写成一行，按键触发各个入口 */
function Probe({ hasSession }: { hasSession: boolean }) {
  const w = useWizardHost({
    modelId: "gpt-6",
    notify: (text, tone) => calls.notify.push([text, tone]),
    hasSession: () => hasSession,
    restart: () => {
      calls.restarted += 1;
    },
    reloadSession: () => {
      calls.reloaded += 1;
    },
  });
  useInput((char) => {
    if (char === "o") void w.openWizard({ kind: "menu" });
    if (char === "k") void w.openKeyEditor();
    if (char === "c") {
      w.closeWizard({
        dirty: true,
        summary: ["模型名 → NewName", "思考档位 → high"],
        changedEndpointIds: ["e1"],
      });
    }
    if (char === "d") {
      w.closeWizard({ dirty: true, summary: [], changedEndpointIds: ["e9"], mcpChanged: false });
    }
    if (char === "n") {
      w.closeWizard({ dirty: false, summary: [], changedEndpointIds: [] });
    }
  });
  return (
    <Text>
      {[
        `step=${w.wizardStep ? w.wizardStep.kind : "null"}`,
        `config=${w.wizardConfig ? "loaded" : "null"}`,
        `agents=${w.wizardAgents.length}`,
        `mcp=${w.wizardMcp ? "loaded" : "null"}`,
        `store=${w.wizardAgentStore ? "loaded" : "null"}`,
      ].join(" ")}
    </Text>
  );
}

async function probe(hasSession = true) {
  const { stdin, lastFrame, unmount } = render(<Probe hasSession={hasSession} />);
  await flush();
  const press = async (char: string) => {
    stdin.write(char);
    await flush();
  };
  return { press, frame: () => (lastFrame() ?? "").trim(), unmount };
}

describe("useWizardHost", () => {
  beforeEach(() => {
    setLocale("zh");
    calls.notify = [];
    calls.restarted = 0;
    calls.reloaded = 0;
    vi.mocked(readConfig).mockImplementation(async () => fakeConfig() as any);
  });

  it("打开向导：先读齐快照再接管", async () => {
    const p = await probe();
    expect(p.frame()).toBe("step=null config=null agents=0 mcp=null store=null");
    await p.press("o");
    expect(p.frame()).toBe("step=menu config=loaded agents=1 mcp=loaded store=loaded");
    p.unmount();
  });

  it("读配置失败时只报错，不进向导", async () => {
    vi.mocked(readConfig).mockRejectedValueOnce(new Error("EACCES"));
    const p = await probe();
    await p.press("o");
    expect(p.frame()).toBe("step=null config=null agents=0 mcp=null store=null");
    expect(calls.notify).toEqual([["读取配置失败：EACCES", "error"]]);
    p.unmount();
  });

  it("`/key`：当前模型没绑端点时提示，不进向导", async () => {
    vi.mocked(readConfig).mockResolvedValueOnce({
      models: [{ id: "gpt-6", name: "GPT 6", endpointId: "missing" }],
      endpoints: [],
      imageModels: [],
    } as any);
    const p = await probe();
    await p.press("k");
    expect(p.frame()).toBe("step=null config=null agents=0 mcp=null store=null");
    expect(calls.notify[0]?.[1]).toBe("error");
    expect(calls.notify[0]?.[0]).toContain("未绑定可用端点");
    p.unmount();
  });

  it("`/key`：有端点时直达该端点的密钥编辑步骤", async () => {
    const p = await probe();
    await p.press("k");
    expect(p.frame()).toContain("step=edit");
    expect(p.frame()).toContain("config=loaded");
    p.unmount();
  });

  it("关闭时把同一批摘要合成一条通知（只占一个队列槽位），且清空向导状态", async () => {
    const p = await probe();
    await p.press("o");
    await p.press("c");
    expect(p.frame()).toBe("step=null config=null agents=1 mcp=null store=null");
    expect(calls.notify).toHaveLength(1);
    const [text] = calls.notify[0]!;
    expect(text).toContain("配置已更新");
    expect(text).toContain("模型名 → NewName");
    expect(text).toContain("思考档位 → high");
    p.unmount();
  });

  it("改到当前端点 → 重载会话", async () => {
    const p = await probe();
    await p.press("o");
    await p.press("c");
    expect(calls.reloaded).toBe(1);
    expect(calls.restarted).toBe(0);
    p.unmount();
  });

  it("只改了无关配置（不含当前端点、无 MCP / Agent 改动）→ 什么都不做", async () => {
    const p = await probe();
    await p.press("o");
    await p.press("d");
    expect(calls.reloaded).toBe(0);
    expect(calls.restarted).toBe(0);
    p.unmount();
  });

  it("没有 dirty 时只显示摘要，不重载也不重启", async () => {
    const p = await probe();
    await p.press("o");
    await p.press("n");
    expect(calls.notify).toHaveLength(0);
    expect(calls.reloaded).toBe(0);
    expect(calls.restarted).toBe(0);
    p.unmount();
  });

  it("会话还没建好就改了配置 → 重启", async () => {
    const p = await probe(false);
    await p.press("o");
    await p.press("c");
    expect(calls.restarted).toBe(1);
    expect(calls.reloaded).toBe(0);
    p.unmount();
  });
});
