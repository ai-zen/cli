/**
 * 会话命令元数据 — 会话命令清单的唯一来源
 *
 * 名字、别名、说明与「是否阻塞输入」集中声明于此，两处消费：
 *   - 提示 / 补全：`src/tui/screens/chat.tsx` 渲染输入 `/` 时的实时候选菜单
 *   - 帮助：`/help` 按本清单渲染，说明就是这里的 `cmd.*.desc`
 *
 * ## 文案为什么不问宿主
 *
 * 命令是**客户端概念**：宿主只有一个方法表，它不知道 `/back` `/pin` 这些名字，也不知道
 * 哪些方法被包成了命令，所以宿主根本渲染不出这句说明。硬让宿主去说，斜杠菜单与 `/help`
 * 就会各有一套措辞（两套词表早晚漂），改一个字还要等宿主发版。一句话只有一个出处：
 * 本表的 `descriptionKey`。
 *
 * ## 为什么不叫 `tui/commands`
 *
 * 「有哪些命令」不是渲染事实 —— `stdio` 与将来的任何前端都该有同一份清单，而
 * `tui/` 是叶子（除它自己以外，全仓不许 import 它）。它住在 `src/commands/` 之后，
 * 命令层就不必为了一个常量表把 Ink 拖进依赖图（门禁见 `scripts/check-imports.mjs`）。
 *
 * 本模块为纯数据与纯函数，不依赖 React / Ink 等 UI 依赖，可直接单测。
 */

import { t } from "../i18n/index.js";

/** 单个会话命令的元数据 */
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
  /**
   * **这一段正在跑时不能执行**（写会话级状态、或宿主会直接拒的那几条）。
   *
   * 判据在 `handlers.ts` 的 `runCommand` 入口统一查一次，提示也由那里给 —— 命令自己不必各写一遍。
   *
   * 为什么它们是「禁用」而不是「问一句」：这几条一旦落在运行中的这一段上，要么宿主立刻拒
   * （`session.revert` 的 `busy`、`handoff.start` 的 `conflict`），要么就是**一批内部换家**
   * （`session.updateModel` / `updateThinkingLevel` 宿主不拦，下一轮请求立刻换模型与思考参数，
   * 工具调用格式与参数都可能对不上）。前者让用户白走一遍选择器/确认才吃一个错，后者是实打实的
   * 错位 —— 两种都该在按下去那一刻就说清。
   *
   * 会话的**新建与切换**（`/new` `/load` `/sessions` `/ws`）不在此列：它们不动运行中的那一段。
   */
  needsIdle?: boolean;
}

/**
 * 命令元数据表（数组顺序即展示顺序）。
 *
 * 用 `as const` 声明以保留命令名的字面量类型，从而派生出 `CommandName`：
 * 命令处理器表以 `Record<CommandName, …>` 声明，于是「新增命令但忘了写处理器」是
 * **编译错误**，而不是运行时静默落到「未知命令」。
 *
 * 但 `as const` 的代价是联合类型里**没有别名的 InboxEntry 压根没有 `aliases` 字段**，
 * 遍历时访问会报错。所以这里只把它作为内部字面量，对外导出的
 * {@link COMMAND_REGISTRY} 放宽成 `readonly CommandMeta[]` —— 类型保护一分不少，
 * 而所有遍历点都能直接读 `command.aliases`，不需要额外的取值 helper。
 */
/**
 * 命令表（顺序即展示顺序）。
 *
 * ## 名字变化（旧 → 新）
 *
 * `save` 从主名退成 `rename` 的别名：旧版 `/save <名字>` 干的是**改名**（原名是自动起的文件名），
 * 那一半名字变了、动作还在；而 `/save` 的「保存会话」那一半作废了 —— 会话一建就持久化
 * （`session.list` 就是列表），保存是多余的第三个动作。`search` 删掉了：搜索只服务桌面端
 * （PRD F-C6 已改写），CLI 一阶段不做。`update` → `upgrade` 改的不是名字而是**语义**
 * （旧版升的是 CLI 自己；现在装的是宿主包、重启的是宿主，PRD 3.8 / 2.3）。
 *
 * `back` 是主名、`revert` 退成别名：用户说的是「回到那条消息之前」，而契约方法名
 * `session.revert` 本来就在 Agent 里写明，不必让命令名去迁就它。
 *
 * `descriptionKey` 的键名与命令名对齐（`cmd.upgrade.*` 跟着 `upgrade`、`cmd.back.*` 跟着
 * `back`）：键名和命令名不一致时，下一个人改文案得先猜哪一份字典说的是哪条命令。
 *
 * `clear` 与 `free` 是**拆出来的两条**：`/clear` 只清屏、`/free` 只清排队区（一条命令一件事），
 * 从前「`/clear` 顺手清队列」那一半的说明与提示文案也跟着搬到 `cmd.free.*` 上。
 */
const REGISTRY_ENTRIES = [
  { name: "new", descriptionKey: "cmd.new.desc" },
  { name: "load", descriptionKey: "cmd.load.desc" },
  /**
   * 活跃会话列表：本进程挂着的 ∪ 宿主上正在跑的，选中即切（PRD D4）。
   *
   * 名字取 `sessions`、别名 `ps` —— 它回答的是「现在有哪些会话活着」，与 `ps` 在 shell 里
   * 回答的问题是同构的（不打断任何一段，只是看一眼并切过去）。
   */
  { name: "sessions", aliases: ["ps"], descriptionKey: "cmd.sessions.desc" },
  /**
   * 工作区是**实体入口**（PRD D30）：列 / 选 / 建都在这条命令上。名字取 `ws` ——
   * `/workspace` 多三层字母却不多一个意思，而它是启动流程里第一个会被敲的命令。
   */
  { name: "ws", descriptionKey: "cmd.ws.desc" },
  /**
   * 置顶这件事写的是会话行上的一个字段（`session.pin`），排出来的顺序由 `session.list`
   * 给 —— 命令名与别名是客户端的事，能力在宿主（PRD F-E1）。
   */
  { name: "pin", descriptionKey: "cmd.pin.desc" },
  // 撤回要删消息（`session.revert`）：宿主在跑的时候直接拒 —— 见 `needsIdle`
  { name: "back", aliases: ["revert"], descriptionKey: "cmd.back.desc", needsIdle: true },
  /**
   * 改名字：写的是会话行上那一格（`session.rename`），id 与其余 10 格不动（PRD 1.5）。
   *
   * `save` 当别名：旧版改名的动作就叫 `/save <名字>`（原名是自动起的文件名），肌肉记忆在那里。
   * 旧版的「保存会话」那一半已作废 —— 新契约里会话一建就持久化，没有第二个动作要按。
   */
  { name: "rename", aliases: ["save"], descriptionKey: "cmd.rename.desc" },
  { name: "editor", descriptionKey: "cmd.editor.desc" },
  /**
   * `/clear` **只清屏**（屏幕起点后移，上下文一个字不动）：一条命令一件事。
   *
   * 从前它顺手清排队区，于是「清了屏」与「清了队列」在按下去那一刻分不开 —— 想只清屏也做不到。
   * 现在排队区归紧跟着的 `/free`（`agent.clearInbox`），两条命令各说一件事。
   */
  { name: "clear", descriptionKey: "cmd.clear.desc" },
  /** `/free` 只清排队区（`agent.clearInbox`）：跑中排着的话、交接期间别人投进来的话 */
  { name: "free", descriptionKey: "cmd.free.desc" },
  { name: "config", descriptionKey: "cmd.config.desc" },
  // 换模型 / 换思考档写的是会话行：下一轮请求立刻换家（宿主不拦），一批内部换模型最容易出事
  { name: "model", descriptionKey: "cmd.model.desc", needsIdle: true },
  { name: "think", aliases: ["effort"], descriptionKey: "cmd.think.desc", needsIdle: true },
  { name: "agent", descriptionKey: "cmd.agent.desc" },
  { name: "mcp", descriptionKey: "cmd.mcp.desc" },
  { name: "key", descriptionKey: "cmd.key.desc" },
  /**
   * `/reload` 让宿主重新发现能力（MCP 服务器、工具、skill、subagent）：Scope 活在宿主进程里，
   * 这一条是那个「现在刷一遍」的入口，回执里说清刷了几份、有没有没刷成的。
   */
  { name: "reload", descriptionKey: "cmd.reload.desc" },
  { name: "upgrade", descriptionKey: "cmd.upgrade.desc" },
  { name: "lang", descriptionKey: "cmd.lang.desc" },
  /**
   * 交接两条，后果不同，所以是两个名字：`/handoff` 只写一份文档（`kind: "document"`，记忆与 Agent
   * 都不动），`/migrate` 写完就换手（`kind: "swap"`，旧记忆成为一段已存档会话）。两句说明也就得
   * 各说各的，菜单上才分得开。
   */
  // 交接要换记忆 / 写文档：宿主在跑的时候拒（「等它答完再交接」），客户端提前拦
  { name: "handoff", descriptionKey: "cmd.handoff.desc", blocksInput: true, needsIdle: true },
  { name: "migrate", descriptionKey: "cmd.migrate.desc", blocksInput: true, needsIdle: true },
  { name: "help", descriptionKey: "cmd.help.desc" },
  /**
   * `/kill` 杀死一段会话的**Agent**（`agent.kill`）：PRD 1.2 里「能让一段会话死的三条路」
   * 之一，而且只有这一条会让没消费的 InboxEntry 悄然消失 —— 所以它排在 `/delete` 前面、与 `/delete`
   * `/shutdown` 挨着摆（三条都是一次确认之后不可撤销的动作）。
   *
   * 与 `/delete` 分的很清楚：`/kill` 收掉的是 agent，会话行与历史一个字不动；`/delete` 删的
   * 是那一段会话本身（消息与 Asset 一起没）。名字取 `kill` —— 它就是一回事。
   */
  { name: "kill", descriptionKey: "cmd.kill.desc" },
  /**
   * `/delete` 删掉**当前这一段会话**（硬删）：PRD 1.2 里「能让一段会话死的三条路」之一，
   * 4.1 要求「删前警告并把代价说清」。名字就是 `delete` —— 它不含「归档」「关闭」那种
   * 可逆的言外之意，与它真正做的事一致。
   *
   * 排得与 `shutdown` 紧挨着：两条都是不可撤销的破坏性动作，与 `/clear` `/free` 那种
   * 「按错了再看一眼」的分开摆。末位仍然留给 `exit`。
   */
  { name: "delete", descriptionKey: "cmd.delete.desc" },
  /**
   * 破坏性动作里最靠后的那一条：关掉宿主会踢掉同一台机器上的其他客户端（含桌面端）。
   * 排在 `exit` 之前 —— 末位留给「只输入 / 就回车」，那一下不该落到关宿主上。
   */
  { name: "shutdown", descriptionKey: "cmd.shutdown.desc" },
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
 * 该命令是否**只在空闲时**能执行（见 {@link CommandMeta.needsIdle}）。
 *
 * 拦的地方只有一处（`runCommand` 入口），菜单标灰读的是同一个函数 —— 两处都从这里问，
 * 于是「菜单说不可用」与「按下去真不可用」不会分叉。
 */
export function commandNeedsIdle(name: string): boolean {
  return findCommand(name)?.needsIdle ?? false;
}

/**
 * 把原始斜杠输入切成「命令名 + 参数」。
 *
 * 两种返回形状共用同一个切分规则（`/migrate  self ` → `migrate` + `["self"]`）：
 * 命令名由 {@link parseCommandInput} 取，参数由 {@link parseCommandArgs} 取。两者必须走
 * 同一个切分器，否则「命令名到哪结束」会有两份互不相干的实现。
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
 * 命令名的解析**只有这一处**（宿主不知道命令这回事，它只认方法名）—— 任何地方要
 * 切开斜杠输入都调本函数，不自己 `slice(1).split(/\s+/)[0]`。
 *
 * 注意「只打了个 `/`」也算命令（`name` 为空串）：调用方按斜杠前缀分流，空命令名
 * 落到「未知命令」。
 *
 * @returns 非斜杠输入返回 `null`
 */
export function parseCommandInput(text: string): { name: string; args: string[] } | null {
  if (!text.trim().startsWith("/")) return null;
  const [name, ...args] = splitCommandInput(text);
  return { name: name.toLowerCase(), args };
}

/** 命令展示 InboxEntry：等价写法（如 `/exit` `/quit`）折叠为一条 */
export interface CommandHint {
  /** 全部等价写法（不含 `/` 前缀），首个为主命令名 */
  names: string[];
  /** 忙时不可用（`needsIdle`）：菜单据此标一句「忙时不可用」，按下去也会被入口那道门拦住 */
  needsIdle?: boolean;
  /** 展示用命令串，如 `/exit /quit` */
  label: string;
  /** 一句话说明（本地词条：斜杠菜单与 `/help` 用的是这一句） */
  description: string;
}

/** 展开全部命令为展示 InboxEntry（别名折叠） */
export function getCommandHints(): CommandHint[] {
  return COMMAND_REGISTRY.map((command) => {
    const names = [command.name, ...(command.aliases ?? [])];
    return {
      names,
      ...(command.needsIdle === true ? { needsIdle: true } : {}),
      label: names.map((name) => `/${name}`).join(" "),
      description: t(command.descriptionKey),
    };
  });
}

/**
 * 前缀匹配命令
 * @param keyword 不含 `/` 前缀的输入片段；空串（即仅输入了 `/`）返回全部命令
 */
export function matchCommandHints(keyword: string): CommandHint[] {
  const normalized = keyword.trim().toLowerCase();
  if (!normalized) return getCommandHints();

  return getCommandHints().filter((hint) => hint.names.some((name) => name.startsWith(normalized)));
}
