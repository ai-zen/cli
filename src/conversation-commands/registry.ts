/**
 * 对话命令元数据 — 对话命令清单的唯一来源
 *
 * 命令名、别名与说明集中声明于此，由三类消费方共用：
 *   - 分发：`./index.ts` 按主命令名装配处理函数表，并按别名自动展开
 *   - 帮助：`./help.ts` 渲染 `/help` 输出
 *   - 提示：`../slash-hint-prompt.ts` 渲染输入 `/` 时的实时候选提示
 *
 * 新增、改名或调整说明只需改动本文件。本模块为纯数据与纯函数，
 * 不依赖 inquirer / chalk，可直接单测。
 */

/** 单个对话命令的元数据 */
export interface CommandMeta {
  /** 主命令名（不含 `/` 前缀），同时是处理函数表的键 */
  name: string;
  /** 等价别名（不含 `/` 前缀） */
  aliases?: string[];
  /** 一句话说明 */
  description: string;
}

/** 命令元数据表（数组顺序即展示顺序） */
export const COMMAND_REGISTRY: readonly CommandMeta[] = [
  { name: "exit", aliases: ["quit"], description: "退出对话（会提示是否保存）" },
  { name: "save", description: "保存当前对话" },
  { name: "new", description: "重置会话（清空历史）" },
  { name: "back", description: "撤回消息（可修改后重发）" },
  { name: "editor", description: "使用系统编辑器输入长消息" },
  { name: "clear", description: "清屏" },
  { name: "migrate", description: "手动任务迁移（生成交接文档并开启新会话）" },
  { name: "help", description: "显示此帮助" },
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
      description: command.description,
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
