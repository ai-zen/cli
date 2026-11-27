import { describe, it, expect, beforeEach } from "vitest";
import {
  COMMAND_REGISTRY,
  canonicalCommandName,
  commandBlocksInput,
  commandNeedsIdle,
  findCommand,
  getCommandHints,
  matchCommandHints,
  parseCommandArgs,
  parseCommandInput,
} from "./registry.js";
import { setLocale, t } from "../i18n/index.js";
import { displayWidth } from "../text.js";

// 命令说明已 i18n 化：这些用例断言中文文案，显式锁定语言（不依赖宿主 LANG）
beforeEach(() => setLocale("zh"));

describe("会话命令元数据", () => {
  it("展示条目折叠别名（exit/quit 折叠为一条），且 exit 置于末尾", () => {
    const hints = getCommandHints();
    expect(hints[0]!.names).toEqual(["new"]); // exit 不再打头，避免误回车直接退出
    expect(hints[hints.length - 1]).toEqual({
      names: ["exit", "quit"],
      label: "/exit /quit",
      // 说明只说它真的做的事：`cmdExit` 直接退出，没有任何「要不要保存」的确认
      description: "退出程序（不关闭宿主）",
    });
  });

  /**
   * 「处理中不可用」的那几条：写会话级状态、或宿主会直接拒。
   *
   * 这张清单是有意的（见 `CommandMeta.needsIdle`），所以钉在这里：谁不小心把 `/new`
   * `/load` 之类加进去，或者把 `/back` 漏掉，这条会红 —— 而这两种错的后果分别是「把无害的
   * 命令禁掉」与「用户走完选择器才吃一个错」。
   */
  it("忙时禁用的恰好是那五条，会话的新建与切换一个都不禁", () => {
    expect(COMMAND_REGISTRY.filter((command) => command.needsIdle).map((c) => c.name)).toEqual([
      "back",
      "model",
      "think",
      "handoff",
      "migrate",
    ]);
    for (const name of ["new", "load", "sessions", "ws", "clear", "free", "agent", "config"]) {
      expect(commandNeedsIdle(name), `${name} 不该被忙闲拦住`).toBe(false);
    }
    // 别名走同一张表
    expect(commandNeedsIdle("revert")).toBe(true);
    expect(commandNeedsIdle("effort")).toBe(true);
  });

  it("菜单提示带着「处理中不可用」这一位（与入口那道门同一个判据）", () => {
    const byName = new Map(getCommandHints().map((hint) => [hint.names[0]!, hint]));
    expect(byName.get("back")?.needsIdle).toBe(true);
    expect(byName.get("new")?.needsIdle).toBeUndefined();
    // 其余条目一个字段都不多（与 `toEqual` 的老断言兼容）
    expect(byName.get("exit")).toEqual({
      names: ["exit", "quit"],
      label: "/exit /quit",
      description: "退出程序（不关闭宿主）",
    });
  });

  it("每个命令均有非空说明", () => {
    for (const hint of getCommandHints()) {
      expect(hint.description.trim().length).toBeGreaterThan(0);
    }
  });

  it("说明保持简洁：中文 ≤ 36、英文 ≤ 52 显示宽度", () => {
    // 斜杠菜单与 /help 都是一行一条，说明过长会把行塞满。上限紧贴当前最长 InboxEntry：
    // 中文 /mcp=35、英文 /upgrade=51，余量不大，改啰嗦了就会红。
    const LIMIT = { zh: 36, en: 52 } as const;
    for (const locale of ["zh", "en"] as const) {
      setLocale(locale);
      for (const hint of getCommandHints()) {
        const width = displayWidth(hint.description);
        expect(width, `${locale} ${hint.label}：${hint.description}`).toBeLessThanOrEqual(
          LIMIT[locale],
        );
      }
    }
    setLocale("zh");
  });

  it("命令说明跟随界面语言（key 存表、渲染时取词）", () => {
    setLocale("en");
    const exitHint = getCommandHints().at(-1)!;
    expect(exitHint.description).toBe("Quit the CLI (the host keeps running)");
    setLocale("zh");
    expect(getCommandHints().at(-1)!.description).toBe("退出程序（不关闭宿主）");
  });

  /**
   * `/handoff` 与 `/migrate` 是两件事：前者仅生成一份文档，后者写完还换手（记忆换掉、旧记忆成为一段
   * 存档会话）。两句说明要一眼分得开 —— 两边都是「写交接文档」的话，菜单上这两条就只能靠背。
   */
  it("`/handoff` 与 `/migrate` 的说明各说各的：一个仅生成，一个切换记忆", () => {
    for (const [locale, only, swap] of [
      ["zh", "仅生成", "切换记忆"],
      ["en", "only", "swap"],
    ] as const) {
      setLocale(locale);
      const handoff = findCommand("handoff")!;
      const migrate = findCommand("migrate")!;
      expect(t(handoff.descriptionKey)).toContain(only);
      expect(t(migrate.descriptionKey)).toContain(swap);
      expect(t(handoff.descriptionKey)).not.toBe(t(migrate.descriptionKey));
    }
    setLocale("zh");
  });

  it("命令名与别名不重复（主名、别名各归一条）", () => {
    const names = COMMAND_REGISTRY.flatMap((command) => [command.name, ...(command.aliases ?? [])]);
    expect(new Set(names).size).toBe(names.length);
  });

  /**
   * 「保存会话」这条命令不该再存在：新契约里会话一建就持久化（`session.list` 就是列表），
   * 没有「存档」这回事，也就没有「保存」这个动作。
   */
  it("/save 是 /rename 的别名（改名这半还在，「保存会话」那半作废了）", () => {
    // 旧版改名就是 `/save <名字>`：名字沿用了肌肉记忆，动作走 `session.rename`
    expect(canonicalCommandName("save")).toBe("rename");
    const mainNames = COMMAND_REGISTRY.map((command) => command.name);
    expect(mainNames).toContain("rename");
    // 而「保存会话」不再是一个动作：会话一建就持久化，没有第二个动作要按
    expect(mainNames).not.toContain("save");
  });

  /**
   * 搜索只服务桌面端，CLI 一阶段不做：名字、别名、说明、方法一样都不留。
   * 留下一个空壳（比如报「暂不支持」）就等于还在维护一条不存在的能力。
   */
  it("/search 不再注册（一阶段不做搜索）", () => {
    expect(COMMAND_REGISTRY.map((command) => command.name)).not.toContain("search");
    expect(canonicalCommandName("search")).toBeUndefined();
    expect(matchCommandHints("sea")).toEqual([]);
  });

  /**
   * 展示 InboxEntry 只有「名字 / 别名 / 说明」三样。这里钉住「不带来的东西」：客户端不需要
   * 把命令再到回去映射成契约方法 —— 那是宿主的事，命令名归命令名（从前多一个 `method`
   * 字段专为 `/help` 去宿主取句子，现在 `/help` 用本地词条，那个字段跟着删了）。
   */
  it("展示条目只带名字、别名、说明，外加「处理中不可用」那一格（只在需要时才出现）", () => {
    for (const hint of getCommandHints()) {
      // `needsIdle` 是可选的一位：有它的条目才多这一格，其余仍是老三样
      expect(Object.keys(hint).sort()).toEqual(
        hint.needsIdle === true
          ? ["description", "label", "names", "needsIdle"]
          : ["description", "label", "names"],
      );
    }
  });

  /**
   * `/back` 是主名、`/revert` 是别名（用户说的是「回到那条消息之前」，而 `revert` 是契约
   * 方法名）。两种写法归一到同一个主名，处理器只注册一份。
   */
  it("/back 为主名、/revert 为别名（两种写法归一到同一处理器）", () => {
    expect(canonicalCommandName("back")).toBe("back");
    expect(canonicalCommandName("REVERT")).toBe("back");
    expect(findCommand("revert")?.name).toBe("back");
    expect(findCommand("revert")?.aliases).toEqual(["revert"]);
  });

  /**
   * 一条命令一件事：`/clear` 只清屏、`/free` 只清排队区，两条各自是主名（不是别名关系，
   * 因为它们是两件事），且排序上紧挨着 —— 斜杠菜单里看到 `/clear` 就看得见 `/free`。
   */
  it("/free 挨着 /clear（拆成两条主名命令，一条命令一件事）", () => {
    const mainNames = COMMAND_REGISTRY.map((command) => command.name);
    expect(mainNames.indexOf("free")).toBe(mainNames.indexOf("clear") + 1);
    expect(canonicalCommandName("free")).toBe("free");
    expect(canonicalCommandName("FRE")).toBeUndefined(); // 前缀不是命令名（那是菜单筛选的事）
    expect(findCommand("free")?.aliases).toBeUndefined();
    // 两条说明各说一件事（从前 `/clear` 那条同时说了清队列）
    expect(findCommand("clear")?.descriptionKey).toBe("cmd.clear.desc");
    expect(findCommand("free")?.descriptionKey).toBe("cmd.free.desc");
  });

  /**
   * `/delete` 是硬删（三条死路之一，删前要警告）：名字就是 `delete`，
   * 没有别名、也没有「加个参数就不问」的旁路 —— 它排在最末那两条不可撤销的动作里，
   * 紧挨着 `/shutdown`。
   */
  it("/delete 已注册，且紧挨着 /shutdown（两条都是不可撤销的动作）", () => {
    const mainNames = COMMAND_REGISTRY.map((command) => command.name);
    expect(mainNames.indexOf("delete")).toBe(mainNames.indexOf("shutdown") - 1);
    expect(canonicalCommandName("DELETE")).toBe("delete");
    expect(findCommand("delete")?.descriptionKey).toBe("cmd.delete.desc");
    expect(matchCommandHints("del")).toEqual([
      { names: ["delete"], label: "/delete", description: "删除当前会话（消息与素材一并删除）" },
    ]);
    // 删会话只有一种写法：没有别名，也没有 `--force` 那种「省一次确认」的口子
    expect(findCommand("delete")?.aliases).toBeUndefined();
  });
});

describe("命令前缀匹配", () => {
  it("空关键词返回全部命令", () => {
    expect(matchCommandHints("")).toHaveLength(getCommandHints().length);
    expect(matchCommandHints("   ")).toHaveLength(getCommandHints().length);
  });

  it("按前缀过滤并保留说明", () => {
    expect(matchCommandHints("bac")).toEqual([
      {
        names: ["back", "revert"],
        label: "/back /revert",
        description: "撤回上次发言以便修改重发",
        // `/back` 处理中不可用（`needsIdle`）：菜单据此标一句
        needsIdle: true,
      },
    ]);
    // 别名同样能被前缀命中，且折回主名那一条
    expect(matchCommandHints("rev")).toEqual(matchCommandHints("bac"));
  });

  it("别名同样参与匹配且大小写不敏感", () => {
    expect(matchCommandHints("Q").map((hint) => hint.label)).toEqual(["/exit /quit"]);
    expect(matchCommandHints("QUIT").map((hint) => hint.label)).toEqual(["/exit /quit"]);
  });

  it("无匹配时返回空数组", () => {
    expect(matchCommandHints("zzz")).toEqual([]);
  });

  it("/agent 已注册：能在菜单里前缀匹配到，且说明不是空的", () => {
    expect(matchCommandHints("age")).toEqual([
      {
        names: ["agent"],
        label: "/agent",
        description: "设置默认助手定义（仅影响新会话）",
      },
    ]);
    expect(canonicalCommandName("agent")).toBe("agent");
  });

  /**
   * 输入 `pi` 就能在斜杠菜单里看到 `/pin`：说明与能否被前缀命中都在一处给齐。
   */
  it("/pin 能被前缀命中，并带出说明", () => {
    expect(matchCommandHints("pi")).toEqual([
      {
        names: ["pin"],
        label: "/pin",
        description: "置顶或取消置顶当前会话",
      },
    ]);
    expect(canonicalCommandName("PIN")).toBe("pin");
  });

  /** `/free` 与 `/clear` 各有各的说明：清队列那条不再搭在清屏那条上 */
  it("/clear 与 /free 各带各的说明（清屏 / 清排队区）", () => {
    expect(matchCommandHints("fre")).toEqual([
      { names: ["free"], label: "/free", description: "清空排队区（尚未发送的消息）" },
    ]);
    const clear = matchCommandHints("clear")[0]!;
    expect(clear.label).toBe("/clear");
    expect(clear.description).not.toBe(matchCommandHints("fre")[0]!.description);
  });
});

describe("命令名解析与元数据", () => {
  it("canonicalCommandName 把别名归一到主名（大小写不敏感）", () => {
    expect(canonicalCommandName("think")).toBe("think");
    expect(canonicalCommandName("EFFORT")).toBe("think");
    expect(canonicalCommandName("quit")).toBe("exit");
    expect(canonicalCommandName("nope")).toBeUndefined();
  });

  it("parseCommandInput 拆出命令名与参数；只打一个 `/` 也算命令", () => {
    expect(parseCommandInput("/migrate")).toEqual({ name: "migrate", args: [] });
    expect(parseCommandInput("  /MIGRATE  self ")).toEqual({ name: "migrate", args: ["self"] });
    expect(parseCommandInput("/")).toEqual({ name: "", args: [] });
    // 非斜杠输入不是命令（宿主会把它当普通消息发出去）
    expect(parseCommandInput("hello")).toBeNull();
    expect(parseCommandInput("")).toBeNull();
  });

  it("parseCommandArgs 与 parseCommandInput 的 args 同源（同一把尺子）", () => {
    for (const raw of ["/migrate", "/migrate self", "  /MIGRATE  self ", "/handoff", "/"]) {
      expect(parseCommandArgs(raw)).toEqual(parseCommandInput(raw)?.args ?? []);
    }
    expect(parseCommandArgs("/migrate summary extra")).toEqual(["summary", "extra"]);
  });

  it("blocksInput 只有「会调用模型」的命令为真（别名同样生效）", () => {
    expect(commandBlocksInput("migrate")).toBe(true);
    expect(commandBlocksInput("handoff")).toBe(true);
    // 别名归一到主名后仍应命中
    expect(commandBlocksInput("MIGRATE")).toBe(true);
    expect(commandBlocksInput("help")).toBe(false);
    expect(commandBlocksInput("think")).toBe(false);
    expect(commandBlocksInput("nope")).toBe(false);
  });

  it("每个命令的主名都能在表里查到自己的元数据", () => {
    for (const command of COMMAND_REGISTRY) {
      expect(findCommand(command.name)?.name).toBe(command.name);
      for (const alias of command.aliases ?? []) {
        expect(findCommand(alias)?.name).toBe(command.name);
      }
    }
  });
});
