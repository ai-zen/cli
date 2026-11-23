import { describe, it, expect, beforeEach } from "vitest";
import { AgentNS, Message } from "@ai-zen/agents-core";
import type { AgentDefinition, AppConfig, EndpointDefinition, ModelDefinition } from "./config.js";
import {
  agentPromptText,
  apiKeyGuide,
  endpointKeyState,
  findEndpoint,
  findModel,
  formatAgentPermission,
  formatArgs,
  formatPermission,
  kvEntries,
  kvSummary,
  maskSecret,
  modelsUsingEndpoint,
  parseArgs,
  parseFunctionParameters,
  parseKvInput,
  parsePermission,
  patchPermission,
  resolveCredential,
  summarizeEndpoints,
  summarizePermissions,
  uniqueAgentId,
  uniqueEndpointId,
  uniqueImageModelId,
  uniqueModelId,
  withAgentFunction,
  withAgentPrompt,
} from "./config-editor.js";
import { setLocale } from "./i18n/index.js";

// 摘要与校验文案已 i18n 化：这些用例断言中文，显式锁定语言（不依赖宿主 LANG）
beforeEach(() => setLocale("zh"));

// ==================== 夹具（宿主 / 契约里的形状）====================

const endpointOf = (over: Partial<EndpointDefinition> = {}): EndpointDefinition => ({
  id: "deepseek",
  name: "DeepSeek",
  baseUrl: "https://api.deepseek.com",
  apiKey: "sk-live-9f3a",
  description: undefined,
  capabilities: { filesApi: false },
  ...over,
});

const modelOf = (over: Partial<ModelDefinition> = {}): ModelDefinition => ({
  id: "deepseek-flash",
  name: "DeepSeek Flash",
  endpointId: "deepseek",
  tokenThresholds: { handoff: 250_000, guard: 375_000 },
  defaultParams: {},
  ...over,
});

const configOf = (over: Partial<AppConfig> = {}): AppConfig => ({
  endpoints: [],
  models: [],
  imageModels: [],
  ...over,
});

const permissionsOf = (): NonNullable<AgentDefinition["permissions"]> => ({
  tools: { allow: ["*"] },
});

// ==================== 查询 ====================

describe("config-editor / 查询", () => {
  it("findModel / findEndpoint 命中与未命中", () => {
    const config = configOf({ models: [modelOf()], endpoints: [endpointOf()] });
    expect(findModel(config, "deepseek-flash")?.id).toBe("deepseek-flash");
    expect(findModel(config, "nope")).toBeUndefined();
    expect(findModel(config, undefined)).toBeUndefined();
    expect(findEndpoint(config, "deepseek")?.name).toBe("DeepSeek");
    expect(findEndpoint(config, "nope")).toBeUndefined();
  });

  it("modelsUsingEndpoint 列出引用该端点的模型", () => {
    const config = configOf({
      models: [
        modelOf({ id: "a", endpointId: "deepseek" }),
        modelOf({ id: "b", endpointId: "other" }),
        modelOf({ id: "c", endpointId: "deepseek" }),
      ],
    });
    expect(modelsUsingEndpoint(config, "deepseek").map((model) => model.id)).toEqual(["a", "c"]);
  });

  it("resolveCredential 汇总模型 → 端点凭据（密钥明文在配置里，屏上只给掩码）", () => {
    const config = configOf({ models: [modelOf()], endpoints: [endpointOf()] });
    expect(resolveCredential(config, "deepseek-flash")).toEqual({
      modelId: "deepseek-flash",
      modelName: "DeepSeek Flash",
      endpointId: "deepseek",
      endpointName: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      apiKeyMasked: "sk-…9f3a",
      configured: true,
    });
    // 没配密钥 = 那一格是空串（`add` 收整条，没配就是 `""`）
    const noKey = configOf({
      models: [modelOf()],
      endpoints: [endpointOf({ apiKey: "" })],
    });
    expect(resolveCredential(noKey, "deepseek-flash")?.configured).toBe(false);
    expect(resolveCredential(noKey, "deepseek-flash")?.apiKeyMasked).toBe("");
  });

  it("resolveCredential 在模型 / 端点缺失时返回 undefined", () => {
    expect(resolveCredential(configOf(), "deepseek-flash")).toBeUndefined();
    const orphan = configOf({ models: [modelOf({ endpointId: "gone" })] });
    expect(resolveCredential(orphan, "deepseek-flash")).toBeUndefined();
  });

  it("summarizeEndpoints 用 ✓ / ✗ 标注密钥状态", () => {
    expect(summarizeEndpoints(configOf())).toBe("无端点");
    const config = configOf({
      endpoints: [
        endpointOf({ id: "a", name: "OpenAI", apiKey: "" }),
        endpointOf({ id: "b", name: "DeepSeek", apiKey: "sk-x" }),
      ],
    });
    expect(summarizeEndpoints(config)).toBe("OpenAI ✗ · DeepSeek ✓");
  });

  it("maskSecret 只留头三尾四；太短的串连头尾都不留", () => {
    expect(maskSecret("sk-live-9f3a")).toBe("sk-…9f3a");
    expect(maskSecret("abc")).toBe("…");
    expect(maskSecret("12345678")).toBe("…");
    expect(maskSecret("")).toBe("");
  });

  it("endpointKeyState 只说得出「端点还在不在、密钥填没填」", () => {
    const config = configOf({ endpoints: [endpointOf()] });
    expect(endpointKeyState(config, modelOf())).toEqual({ endpointName: "DeepSeek", ready: true });
    expect(
      endpointKeyState(configOf({ endpoints: [endpointOf({ apiKey: "" })] }), modelOf()),
    ).toEqual({ endpointName: "DeepSeek", ready: false });
    // 端点不在配置里：那条路一定跑不起来
    expect(endpointKeyState(configOf(), modelOf())).toEqual({ endpointName: null, ready: false });
  });

  it("apiKeyGuide 按 baseUrl 识别厂商", () => {
    expect(apiKeyGuide("https://api.deepseek.com").vendor).toBe("DeepSeek");
    expect(apiKeyGuide("https://open.bigmodel.cn/api").url).toContain("bigmodel.cn");
    expect(apiKeyGuide("https://example.com").vendor).toBe("OpenAI 兼容端点");
    expect(apiKeyGuide(undefined).url).toBeUndefined();
  });
});

// ==================== 由名称派生 id ====================

describe("config-editor / 派生 id（id 由客户端定，宿主只落盘）", () => {
  it("uniqueEndpointId / uniqueModelId / uniqueImageModelId 派生合法 id 并避让冲突", () => {
    const config = configOf({
      endpoints: [endpointOf({ id: "my-gateway" })],
      models: [modelOf({ id: "glm-5" })],
      imageModels: [
        {
          id: "image-1",
          name: "Image 1",
          endpointId: "deepseek",
          modelName: "img",
        },
      ],
    });
    expect(uniqueEndpointId(config, "My Gateway")).toBe("my-gateway-2");
    expect(uniqueEndpointId(config, "Other!")).toBe("other");
    expect(uniqueEndpointId(config, "")).toBe("endpoint");
    expect(uniqueModelId(config, "GLM 5")).toBe("glm-5-2");
    expect(uniqueImageModelId(config, "Image 1")).toBe("image-1-2");
    expect(uniqueImageModelId(config, "New")).toBe("new");
  });

  it("uniqueAgentId 避让既有 id", () => {
    expect(uniqueAgentId(["default"], "default")).toBe("default-2");
    expect(uniqueAgentId([], "Code Reviewer")).toBe("code-reviewer");
  });
});

// ==================== argv / KEY=VALUE ====================

describe("parseArgs / formatArgs", () => {
  it("按空白切分，支持引号包裹与转义空格", () => {
    expect(parseArgs("-y chrome-devtools-mcp@latest")).toEqual([
      "-y",
      "chrome-devtools-mcp@latest",
    ]);
    expect(parseArgs(`--path "/tmp/my dir"`)).toEqual(["--path", "/tmp/my dir"]);
    expect(parseArgs("--path /tmp/my\\ dir")).toEqual(["--path", "/tmp/my dir"]);
    expect(parseArgs("  ")).toEqual([]);
  });

  it("formatArgs 与 parseArgs 互逆（含空白的参数加引号）", () => {
    const argv = ["-y", "server", "--root", "/tmp/my dir"];
    expect(formatArgs(argv)).toBe(`-y server --root "/tmp/my dir"`);
    expect(parseArgs(formatArgs(argv))).toEqual(argv);
    expect(formatArgs(undefined)).toBe("");
  });
});

describe("parseKvInput / kvEntries / kvSummary", () => {
  it("以首个 = 分割，KEY 去空白，VALUE 原样（含首尾空格）", () => {
    expect(parseKvInput("TOKEN=a=b")).toEqual({ key: "TOKEN", value: "a=b" });
    // KEY 两侧空白被去掉，VALUE 一个字符都不动 —— 用户可能就是想要那个前导空格
    expect(parseKvInput("TOKEN = a=b")).toEqual({ key: "TOKEN", value: " a=b" });
    expect(parseKvInput("NOEQUALS")).toBeNull();
    expect(parseKvInput("  = 1")).toBeNull();
  });

  it("kvEntries 保持插入顺序，kvSummary 展示项数与键名", () => {
    expect(kvEntries({ PATH: "/bin", HOME: "/root" })).toEqual([
      { key: "PATH", value: "/bin" },
      { key: "HOME", value: "/root" },
    ]);
    expect(kvEntries(undefined)).toEqual([]);
    expect(kvSummary({ PATH: "/bin", HOME: "/root" })).toBe("2 项（PATH, HOME）");
    expect(kvSummary({})).toBe("（空）");
  });
});

// ==================== 权限四维 ====================

describe("权限策略的文本往返", () => {
  it("parsePermission / formatPermission 往返", () => {
    expect(parsePermission("allow: a, b")).toEqual({ allow: ["a", "b"] });
    expect(parsePermission("DENY : *")).toEqual({ deny: ["*"] });
    expect(parsePermission("")).toBeNull();
    expect(formatPermission({ allow: ["a", "b"] })).toBe("allow: a, b");
    expect(formatPermission({ deny: ["*"] })).toBe("deny: *");
    expect(formatPermission(undefined)).toBe("");
  });

  it("非法输入返回可直接上屏的错误文本", () => {
    expect(typeof parsePermission("whatever")).toBe("string");
    expect(typeof parsePermission("allow:")).toBe("string");
  });

  it("formatAgentPermission 读某一维", () => {
    expect(formatAgentPermission(permissionsOf(), "tools")).toBe("allow: *");
    expect(formatAgentPermission(permissionsOf(), "skills")).toBe("");
    expect(formatAgentPermission(null, "tools")).toBe("");
  });

  it("summarizePermissions 概览已配置的维度", () => {
    expect(summarizePermissions(permissionsOf())).toBe("1 维（tools）");
    expect(summarizePermissions(null)).toBe("（未设置）");
  });

  it("patchPermission 可写可删，且不改动入参", () => {
    const before = permissionsOf();
    const added = patchPermission(before, "mcps", { deny: ["*"] });
    expect(added.mcps).toEqual({ deny: ["*"] });
    expect(before.mcps).toBeUndefined();

    const removed = patchPermission(added, "tools", null);
    expect(removed.tools).toBeUndefined();
    expect(added.tools).toEqual({ allow: ["*"] });
  });
});

// ==================== AgentDefinition 提示词 / 函数定义 ====================

describe("助手提示词与函数定义", () => {
  it("agentPromptText 只认首条 system 的纯文本，读不到就当空", () => {
    expect(agentPromptText([Message.System("你是助手"), Message.User("开始")])).toBe("你是助手");
    // `null` = 这份定义没有提示词可读（不是「提示词是空串」，但屏上都显示为空）
    expect(agentPromptText(null)).toBe("");
    // 分段内容表达不了一段纯文本：不拼、不猜，当空
    const sectioned = new Message({
      role: AgentNS.Role.System,
      content: [{ type: "text", text: "分段" }],
    });
    expect(agentPromptText([sectioned])).toBe("");
    expect(agentPromptText([Message.User("没有 system")])).toBe("");
  });

  it("withAgentPrompt 换掉首条 system 的内容，其余消息与其 id 原样带上", () => {
    const system = Message.System("旧提示词");
    const user = Message.User("开始吧");
    const next = withAgentPrompt([system, user], "新提示词");

    expect(next).toHaveLength(2);
    expect(next[0]!.id).toBe(system.id);
    expect(next[0]!.role).toBe("system");
    expect(next[0]!.content).toBe("新提示词");
    expect(next[1]).toBe(user);
  });

  it("withAgentPrompt 在缺 system 时前插一条，且空串是合法写入", () => {
    const next = withAgentPrompt(null, "");
    // 宿主只校验「非空且至少一条 system」：所以清空提示词也是合法形状，这里不替用户补默认值
    expect(next).toHaveLength(1);
    expect(next[0]!.role).toBe("system");
    expect(next[0]!.content).toBe("");
  });

  it("withAgentFunction 是在现有那份上盖一项（function 是整份替换，不能只发改的那项）", () => {
    const fn = { name: "review", description: "审稿", parameters: { type: "object" } } as const;
    expect(withAgentFunction({ ...fn }, { description: "新说明" })).toEqual({
      name: "review",
      description: "新说明",
      parameters: { type: "object" },
    });
  });

  it("parseFunctionParameters：合法对象直接给，其余都给一句人话", () => {
    expect(parseFunctionParameters('{"type":"object","properties":{}}')).toEqual({
      type: "object",
      properties: {},
    });
    expect(parseFunctionParameters("")).toBe("参数 schema 不能为空（没有参数就写 {}）");
    expect(typeof parseFunctionParameters('{"type":')).toBe("string");
    // 数组 / null / 标量都不是「一个 JSON 对象」
    expect(parseFunctionParameters("[1,2]")).toBe("参数 schema 必须是一个 JSON 对象（形如 {}）");
    expect(parseFunctionParameters("null")).toBe("参数 schema 必须是一个 JSON 对象（形如 {}）");
    expect(parseFunctionParameters('"text"')).toBe("参数 schema 必须是一个 JSON 对象（形如 {}）");
  });
});
