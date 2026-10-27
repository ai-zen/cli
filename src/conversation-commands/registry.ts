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
  aliases?: string[];
  /**
   * 一句话说明的 i18n key。
   *
   * 这里存 **key 而不是文案**：本模块是纯数据，加载时机靠前（甚至早于语言初始化），
   * 存成文案就定死了「加载那一刻的语言」。渲染时由 `getCommandHints()` 用 `t()` 现取。
   */
  descriptionKey: string;
}

/** 命令元数据表（数组顺序即展示顺序） */
export const COMMAND_REGISTRY: readonly CommandMeta[] = [
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
  { name: "mcp", descriptionKey: "cmd.mcp.desc" },
  { name: "lang", descriptionKey: "cmd.lang.desc" },
  { name: "think", aliases: ["effort"], descriptionKey: "cmd.think.desc" },
  { name: "key", descriptionKey: "cmd.key.desc" },
  { name: "handoff", descriptionKey: "cmd.handoff.desc" },
  { name: "migrate", descriptionKey: "cmd.migrate.desc" },
  { name: "help", descriptionKey: "cmd.help.desc" },
  // exit 置于末尾：斜杠菜单回车执行高亮项，避免「只输入 / 就回车」直接退出
  { name: "exit", aliases: ["quit"], descriptionKey: "cmd.exit.desc" },
];

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
