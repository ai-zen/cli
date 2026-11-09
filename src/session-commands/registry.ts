/**
 * 对话命令元数据 — 对话命令清单的唯一来源
 *
 * 命令名、别名与说明集中声明于此，由 TUI 层复用：
 *   - 提示/补全：`src/tui/screens.tsx` 渲染输入 `/` 时的实时候选菜单
 *   - 帮助：`/help` 命令按本清单渲染
 *
 * 新增、改名或调整说明只需改动本文件。本模块为纯数据与纯函数，
 * 不依赖 chalk / React 等 UI 依赖，可直接单测。
 */

import { t } from "../i18n/index.js";

/** 单个对话命令的元数据 */
export interface CommandMeta {
  /** 主命令名（不含 `/` 前缀），同时是处理函数表的键 */
  name: string;
  /** 等价别名（不含 `/` 前缀） */
  aliases?: readonly string[];
  /**
   * 一句话说明的 i18n key。
   *
   * 这里存 **key 而不是文案**：本模块是纯数据，加载时机靠前（甚至早于语言初始化），
   * 存成文案就定死了「加载那一刻的语言」。渲染时由 `getCommandHints()` 用 `t()` 现取。
   */
  descriptionKey: string;
  /**
   * 执行期间会调用模型（较慢，几十秒）。
   *
   * 宿主据此**拦住输入框**：否则用户以为没反应、继续打字，按键会被静默吞进隐藏的
   * 输入缓冲，等命令结束后才突然冒出来（迁移过程中出现过这个 bug）。
   * 这是命令的属性而不是宿主的白名单 —— 新增命令只改本文件，宿主自动跟上。
   */
  blocksInput?: boolean;
}

/**
 * 命令元数据表（数组顺序即展示顺序）。
 *
 * 用 `as const` 声明以保留命令名的字面量类型，从而派生出 `CommandName`：
 * 命令处理器表以 `Record<CommandName, …>` 声明，于是「新增命令但忘了写处理器」是
 * **编译错误**，而不是运行时静默落到「未知命令」。
 *
 * 但 `as const` 的代价是联合类型里**没有别名的条目压根没有 `aliases` 字段**，
 * 遍历时访问会报错。所以这里只把它作为内部字面量，对外导出的
 * {@link COMMAND_REGISTRY} 放宽成 `readonly CommandMeta[]` —— 类型保护一分不少，
 * 而所有遍历点都能直接读 `command.aliases`，不需要额外的取值 helper。
 */
const REGISTRY_ENTRIES = [
  { name: "save", descriptionKey: "cmd.save.desc" },
  { name: "load", descriptionKey: "cmd.load.desc" },
  { name: "new", descriptionKey: "cmd.new.desc" },
  { name: "back", descriptionKey: "cmd.back.desc" },
  { name: "editor", descriptionKey: "cmd.editor.desc" },
  { name: "clear", descriptionKey: "cmd.clear.desc" },
  { name: "config", descriptionKey: "cmd.config.desc" },
  { name: "model", descriptionKey: "cmd.model.desc" },
  { name: "agent", descriptionKey: "cmd.agent.desc" },
  { name: "reload", descriptionKey: "cmd.reload.desc" },
  { name: "update", descriptionKey: "cmd.update.desc", blocksInput: true },
  { name: "mcp", descriptionKey: "cmd.mcp.desc" },
  { name: "lang", descriptionKey: "cmd.lang.desc" },
  { name: "think", aliases: ["effort"], descriptionKey: "cmd.think.desc" },
  { name: "key", descriptionKey: "cmd.key.desc" },
  { name: "handoff", descriptionKey: "cmd.handoff.desc", blocksInput: true },
  { name: "migrate", descriptionKey: "cmd.migrate.desc", blocksInput: true },
  { name: "help", descriptionKey: "cmd.help.desc" },
  // exit 置于末尾：斜杠菜单回车执行高亮项，避免「只输入 / 就回车」直接退出
  { name: "exit", aliases: ["quit"], descriptionKey: "cmd.exit.desc" },
] as const satisfies readonly CommandMeta[];

/** 命令主名的字面量联合（别名已归一到主名） */
export type CommandName = (typeof REGISTRY_ENTRIES)[number]["name"];

/** 命令元数据表：值来自上面的字面量，类型放宽到 `readonly CommandMeta[]` 便于遍历 */
export const COMMAND_REGISTRY: readonly CommandMeta[] = REGISTRY_ENTRIES;

/**
 * 把命令名（含别名）归一到主名；未知命令返回 `undefined`。
 *
 * `/think` 与 `/effort` 是同一条命令的两种写法，处理器只按主名注册一份。
 */
export function canonicalCommandName(name: string): CommandName | undefined {
  const normalized = name.trim().toLowerCase();
  // 在放宽类型的表上匹配（可直接读 `aliases`），再用同一下标取回字面量类型
  const index = COMMAND_REGISTRY.findIndex(
    (command) => command.name === normalized || command.aliases?.includes(normalized),
  );
  return index < 0 ? undefined : REGISTRY_ENTRIES[index]!.name;
}

/** 命中命令的元数据（别名可查） */
export function findCommand(name: string): CommandMeta | undefined {
  const canonical = canonicalCommandName(name);
  return COMMAND_REGISTRY.find((command) => command.name === canonical);
}

/** 该命令执行期间是否应拦住输入框（见 {@link CommandMeta.blocksInput}） */
export function commandBlocksInput(name: string): boolean {
  return findCommand(name)?.blocksInput ?? false;
}

/**
 * 把原始斜杠输入切成「命令名 + 参数」。
 *
 * 两种返回形状共用同一个切分规则（`/migrate  self ` → `migrate` + `["self"]`）：
 * 命令名由 {@link parseCommandInput} 取，参数由 {@link parseCommandArgs} 取。
 * 以前命令层自己又 `raw.trim().split(/\s+/).slice(1)` 了一遍 —— 命令名收敛了，
 * 参数没有，于是「参数怎么切」仍然有两份实现。
 */
function splitCommandInput(text: string): string[] {
  return text.trim().replace(/^\//, "").split(/\s+/);
}

/**
 * 从原始输入里取命令参数（首个 token 之后的全部 token）。
 *
 * 与 {@link parseCommandInput} 共用 {@link splitCommandInput}，保证「命令名边界」与
 * 「参数边界」用的是同一把尺子。
 */
export function parseCommandArgs(text: string): string[] {
  return splitCommandInput(text).slice(1);
}

/**
 * 解析斜杠输入：`/migrate summary` → `{ name: "migrate", args: ["summary"] }`。
 *
 * 命令名的解析**只有这一处**：此前宿主自己也 `slice(1).split(/\s+/)[0]` 了一遍，
 * 于是「命令名怎么算」在命令层与宿主层各有一份实现。
 *
 * 注意「只打了个 `/`」也算命令（`name` 为空串）：宿主按斜杠前缀分流，空命令名
 * 落到「未知命令」——与拆出本函数之前的行为一致。
 *
 * @returns 非斜杠输入返回 `null`
 */
export function parseCommandInput(text: string): { name: string; args: string[] } | null {
  if (!text.trim().startsWith("/")) return null;
  const [name, ...args] = splitCommandInput(text);
  return { name: name.toLowerCase(), args };
}

/** 命令展示条目：等价写法（如 `/exit` `/quit`）折叠为一条 */
export interface CommandHint {
  /** 全部等价写法（不含 `/` 前缀），首个为主命令名 */
  names: string[];
  /** 展示用命令串，如 `/exit /quit` */
  label: string;
  /** 一句话说明 */
  description: string;
}

/** 展开全部命令为展示条目（别名折叠） */
export function getCommandHints(): CommandHint[] {
  return COMMAND_REGISTRY.map((command) => {
    const names = [command.name, ...(command.aliases ?? [])];
    return {
      names,
      label: names.map((name) => `/${name}`).join(" "),
      description: t(command.descriptionKey),
    };
  });
}

/**
 * 命令列展示宽度：按最长展示命令串对齐，供 `/help` 与输入提示共用。
 * 展示命令串均为 ASCII，`padEnd` 的字符数即显示宽度。
 */
export const COMMAND_LABEL_WIDTH =
  Math.max(...getCommandHints().map((hint) => hint.label.length)) + 3;

/**
 * 前缀匹配命令
 * @param keyword 不含 `/` 前缀的输入片段；空串（即仅输入了 `/`）返回全部命令
 */
export function matchCommandHints(keyword: string): CommandHint[] {
  const normalized = keyword.trim().toLowerCase();
  if (!normalized) return getCommandHints();

  return getCommandHints().filter((hint) =>
    hint.names.some((name) => name.startsWith(normalized)),
  );
}

/** 全部命令名（含别名，升序），供启动横幅等场景展示 */
export function getCommandNames(): string[] {
  const names = new Set<string>();
  for (const hint of getCommandHints()) {
    for (const name of hint.names) names.add(name);
  }
  return Array.from(names).sort();
}
