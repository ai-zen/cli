// 配置向导宿主 —— 「打开向导 / 读齐快照 / 关闭后让改动生效」的唯一实现
//
// 从 `chat.tsx` 抽出来的理由：向导本身（`config-wizard/`）是独立状态机，但**宿主**
// 的活儿散落在对话屏里 —— 6 个 `useState`、3 个入口函数，还要顺手记「当前模型用的是
// 哪个端点」以便关闭时判断要不要重建会话。这些既不属于「对话」，也没法单测（要一路
// 从键盘打到向导关闭才能碰到）。
//
// 依赖方向是**注入**而非 import 会话：宿主要做的事（通知、重启、重载会话）都通过
// `WizardHostDeps` 传进来，于是 hook 可以在测试里用假依赖跑完整生命周期。
import { useRef, useState } from "react";
import type { AppConfig, ReasoningPresets } from "@ai-zen/agents-sdk";
import { mcpConfigOrEmpty, type McpScope } from "../../config.js";
import type { AgentStore } from "../../agents-store.js";
import type { ConfigPort } from "../../server-client/index.js";
import { resolveCredential } from "../../config-editor.js";
import type { McpSnapshot, WizardCloseResult, WizardStep } from "../config-wizard/index.js";
import { t } from "../../i18n/index.js";
import type { Notice } from "./notice.js";

export interface WizardHostDeps {
  /** 当前模型 id：`/key` 直达它所用端点的密钥；也是「当前端点是否被改动」的比较基准 */
  modelId: string;
  /** 通知出口（读写失败、变更摘要都从这里出去，不进食转录） */
  notify: (text: string, tone?: Notice["tone"]) => void;
  /** 会话是否已建好（未建好时改配置只能重启） */
  hasSession: () => boolean;
  /** 会话还没建好就改了配置 → 只能重启进程让新配置生效 */
  restart: () => void;
  /** 改了当前端点 / MCP / Agent 定义 / 中断策略 → 重载会话（消息保留） */
  reloadSession: () => void;
  /**
   * 配置面（快照的唯一来源）。
   *
   * **必填**：向导要读的全部东西（配置 / 策略表 / MCP / Agent 定义）都只在服务端那一份
   * 真相里。曾经它有个「缺省读本地磁盘」的默认值 —— 忘了注入就会静默读到客户端本机的
   * `~/.ai-zen`，写却写到服务端（「界面说改好了、跑起来还是旧的」）。
   * 测试注入假端口即可，**不必** `vi.mock` 整个 config 模块（模块级替换在进程内共享
   * 模块时会泄漏到其他测试文件）。
   */
  config: ConfigPort;
}

export interface WizardHost {
  wizardStep: WizardStep | null;
  wizardConfig: AppConfig | null;
  /** 服务端那份 `config.json` 的路径（菜单要印它；未进向导时为空串） */
  wizardConfigPath: string;
  wizardPresets: ReasoningPresets;
  wizardAgents: { id: string; name: string }[];
  wizardMcp: McpSnapshot | null;
  wizardAgentStore: AgentStore | null;
  /** 打开向导：先读齐快照再接管整屏（读失败则只报错、不进向导） */
  openWizard: (step: WizardStep) => Promise<void>;
  /** `/key`：直达当前模型所用端点的 API Key 编辑步骤 */
  openKeyEditor: () => Promise<void>;
  /** 向导关闭：渲染变更摘要，并让改动生效 */
  closeWizard: (result: WizardCloseResult) => void;
}

export function useWizardHost({
  modelId,
  notify,
  hasSession,
  restart,
  reloadSession,
  config: configPort,
}: WizardHostDeps): WizardHost {
  const [wizardStep, setWizardStep] = useState<WizardStep | null>(null);
  const [wizardConfig, setWizardConfig] = useState<AppConfig | null>(null);
  const [wizardConfigPath, setWizardConfigPath] = useState<string>("");
  const [wizardPresets, setWizardPresets] = useState<ReasoningPresets>({});
  const [wizardAgents, setWizardAgents] = useState<{ id: string; name: string }[]>([]);
  const [wizardMcp, setWizardMcp] = useState<McpSnapshot | null>(null);
  const [wizardAgentStore, setWizardAgentStore] = useState<AgentStore | null>(null);
  /**
   * 打开向导时当前模型所用的端点 id —— 关闭时据此判断「当前端点有没有被改」。
   *
   * 用 ref 而不是 state：它只在 `openWizard` / `closeWizard` 之间传递，不上屏，
   * 放 state 会多一次无意义渲染。
   */
  const currentEndpointRef = useRef<string | null>(null);

  const openWizard = async (step: WizardStep) => {
    try {
      // 一次调用拿两样：配置本身 + 那份文件在服务端的位置（菜单要印后者）
      const { config, path } = await configPort.readConfigFile();
      setWizardConfigPath(path);
      currentEndpointRef.current = resolveCredential(config, modelId)?.endpointId ?? null;
      const agentStore = await configPort.readAgentStore();
      setWizardConfig(config);
      setWizardPresets(await configPort.readReasoningPresets());
      setWizardAgents(
        agentStore.agents.map((agent) => ({ id: agent.id, name: agent.name || agent.id })),
      );
      setWizardAgentStore(agentStore);
      // 坏文件照样进屏（屏上写明），只把失败原因随之带过去
      const globalMcp = await configPort.readMcpConfig("global");
      const projectMcp = await configPort.readMcpConfig("project");
      const errors: Partial<Record<McpScope, string>> = {};
      if (!globalMcp.ok) errors.global = globalMcp.error;
      if (!projectMcp.ok) errors.project = projectMcp.error;
      setWizardMcp({
        global: mcpConfigOrEmpty(globalMcp),
        project: mcpConfigOrEmpty(projectMcp),
        // 路径来自服务端（读那份文件的人才知道它在哪）
        paths: { global: globalMcp.path, project: projectMcp.path },
        ...(Object.keys(errors).length ? { errors } : {}),
      });
      setWizardStep(step);
    } catch (error: any) {
      notify(t("chat.configReadFailed", { error: error?.message ?? error }), "error");
    }
  };

  const openKeyEditor = async () => {
    try {
      const config = await configPort.readConfig();
      const credential = resolveCredential(config, modelId);
      if (!credential) {
        notify(t("chat.modelNoEndpoint", { id: modelId }), "error");
        return;
      }
      currentEndpointRef.current = credential.endpointId;
      setWizardConfig(config);
      setWizardStep({ kind: "edit", field: "apiKey", endpointId: credential.endpointId });
    } catch (error: any) {
      notify(t("chat.configReadFailed", { error: error?.message ?? error }), "error");
    }
  };

  /** 向导关闭：渲染变更摘要；若改到当前端点 / MCP / Agent 定义则重建会话（消息保留） */
  const closeWizard = (result: WizardCloseResult) => {
    setWizardStep(null);
    setWizardConfig(null);
    setWizardMcp(null);
    setWizardAgentStore(null);
    // 同一批摘要合成**一条**（多行）：既能全部显示，又只占通知队列的一个槽位。
    // 逐条 push 在单槽时代只剩最后一条，在队列时代则会挤掉更早的进度提示。
    const { summary } = result;
    if (summary.length === 1) {
      notify(t("chat.configUpdated", { line: summary[0]! }));
    } else if (summary.length > 1) {
      // 子项缩进 = 一个汉字宽度（两个半角空格），不加 `·` 之类的项目符号：
      // 通知正文本身就左对齐于行首，子项只需要一点层级差，符号是多余装饰。
      notify(
        t("chat.configUpdatedMulti", { lines: summary.map((line) => `  ${line}`).join("\n") }),
      );
    }
    if (!result.dirty) return;

    // 会话都没建好 → 只能重启让新配置生效。
    if (!hasSession()) {
      restart();
      return;
    }
    // 只有「当前端点 / MCP / Agent 定义 / 建 Agent 时才读的配置（中断策略）」变了
    // 才需要重建会话；改的是别的模型、别的端点的参数，当前会话不受影响，不该白重连一次。
    const endpointChanged =
      !!currentEndpointRef.current &&
      result.changedEndpointIds.includes(currentEndpointRef.current);
    if (
      endpointChanged ||
      result.mcpChanged ||
      result.agentsChanged ||
      result.sessionOptionsChanged
    ) {
      reloadSession();
    }
  };

  return {
    wizardStep,
    wizardConfig,
    wizardConfigPath,
    wizardPresets,
    wizardAgents,
    wizardMcp,
    wizardAgentStore,
    openWizard,
    openKeyEditor,
    closeWizard,
  };
}
