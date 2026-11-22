/**
 * 工作区屏 —— 启动时「该进哪个工作区」的选择环节（PRD D30）。
 *
 * ## 什么时候会看到它
 *
 * 只在**远端宿主**上、且本机没记过（或记着的那个已经不在）时。本机那条路用当前目录，永远选不到
 * 这一屏；远端则必须有人告诉我们是哪台机器上的哪个目录 —— 这一屏就是那个「有人」。
 *
 * ## 为什么新建要手填路径
 *
 * `workspace.create` 收的是**宿主上的**绝对路径。远端部署时我们这一侧的 `process.cwd()` 在对面
 * 可能根本不存在（这正是 D30 要消灭的那个错），所以本屏不预填、不猜，只让用户敲 —— 路径提示里
 * 明说「这个路径在宿主那一台机器上」。
 *
 * ## 与连接屏同一套骨架
 *
 * 列表用 `SelectList`、输入用配置向导那块 `PromptScreen`、`Esc` 在任何阶段都是退出（本屏在启动
 * 路径上，没有「先保存再说」的东西要抢救）。宿主上一个工作区都没有时直接进输入框：那时唯一能做
 * 的事就是新建一个。
 */

import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import type { HostConnection, WorkspaceSnapshot } from "../../session/types.js";
import { listWorkspaces, useOrRegisterWorkspace, workspaceHint } from "../../workspace.js";
import { SelectList, Spinner, type SelectItem } from "../components.js";
import { theme } from "../theme.js";
import { PromptScreen } from "../config-wizard/index.js";

/** 屏的结局：选中（或新建）了一个工作区 / 用户放弃 */
export type WorkspacePickResult =
  { kind: "chosen"; workspace: WorkspaceSnapshot } | { kind: "exit" };

/** 列表里「新建」那一项的值（工作区 id 是宿主给的 uuid，撞不上） */
const NEW_WORKSPACE = "__new__";

export interface WorkspacePickScreenProps {
  /** 只用到「问一句」那一面（与 `/ws` 拿的是同一条连接的同一个面） */
  connection: Pick<HostConnection, "api">;
  /**
   * 结局出口（缺省 `useApp().exit`，由挂载处 `mount()` 的返回值接住；用例喂一个假的）。
   */
  onResult?: (result: WorkspacePickResult) => void;
  /** 测试用的固定尺寸（缺省按真实窗口） */
  terminalSize?: { columns: number; rows: number };
}

/** 屏内的阶段 */
type Phase = "loading" | "list" | "path" | "failed";

export function WorkspacePickScreen(props: WorkspacePickScreenProps) {
  const windowSize = useWindowSize();
  const columns = props.terminalSize?.columns ?? windowSize.columns ?? 80;
  const rows = props.terminalSize?.rows ?? windowSize.rows ?? 24;
  const { exit } = useApp();
  /** 结局出口：生产走 ink 的退出通道（`tui/index.tsx` 的 `mount()` 接住），用例喂一个假的 */
  const finish = props.onResult ?? exit;

  const [phase, setPhase] = useState<Phase>("loading");
  const [workspaces, setWorkspaces] = useState<WorkspaceSnapshot[]>([]);
  /** 读列表失败的原因（连接断了 / 宿主不认这条方法）：说出来，不假装「一个都没有」 */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pathError, setPathError] = useState<string | null>(null);

  /** 卸载之后不许再 setState / exit（列表与新建都是异步的，用户可能已经按 Esc 走了） */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const listed = await listWorkspaces(props.connection);
        if (!alive.current) return;
        setWorkspaces(listed);
        // 一个都没有 → 唯一能做的事就是新建一个（远端必须由用户给路径）
        setPhase(listed.length === 0 ? "path" : "list");
      } catch (error) {
        if (!alive.current) return;
        setLoadError(error instanceof Error ? error.message : String(error));
        setPhase("failed");
      }
    })();
  }, [props.connection]);

  /** 新建：`cwd` 原样递给宿主（路径归一、目录在不在都是它的事） */
  const submitPath = async (raw: string) => {
    const cwd = raw.trim();
    if (cwd === "") {
      setPathError(t("ws.pathEmpty"));
      return;
    }
    setPathError(null);
    try {
      const workspace = await useOrRegisterWorkspace(props.connection, cwd);
      if (!alive.current) return;
      finish({ kind: "chosen", workspace } satisfies WorkspacePickResult);
    } catch (error) {
      if (!alive.current) return;
      setPathError(error instanceof Error ? error.message : String(error));
    }
  };

  // `Esc` / `Ctrl+C` 在任何阶段都是退出（与连接屏同一条口径）
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c"))
      finish({ kind: "exit" } satisfies WorkspacePickResult);
  });

  if (phase === "loading") {
    return (
      <Box paddingX={1}>
        <Spinner label={t("ws.loading")} />
      </Box>
    );
  }

  if (phase === "failed") {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.error} wrap="wrap">
          {`✖ ${loadError ?? ""}`}
        </Text>
        <Text> </Text>
        <Text color={theme.faint}>{t("ws.keys")}</Text>
      </Box>
    );
  }

  if (phase === "path") {
    return (
      <PromptScreen
        key="workspace-path"
        columns={columns}
        rows={rows}
        title={t("ws.pathTitle")}
        details={[t("ws.pathHelp")]}
        error={pathError}
        hints={[
          ["Enter", t("ws.pathSubmit")],
          ["Esc", t("ws.exit")],
        ]}
        onSubmit={(raw) => void submitPath(raw)}
        onCancel={() => finish({ kind: "exit" } satisfies WorkspacePickResult)}
      />
    );
  }

  const items: SelectItem<string>[] = [
    ...workspaces.map((workspace) => ({
      label: workspace.name,
      value: workspace.id,
      // 目录在不在是宿主给的事实，这里只把它摆出来（不在也照样能进，PRD D12）
      hint: workspaceHint(workspace),
    })),
    { label: t("ws.newLabel"), value: NEW_WORKSPACE },
  ];

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={theme.accent} bold>
        {t("ws.title")}
      </Text>
      <Text color={theme.dim} wrap="wrap">
        {t("ws.hint")}
      </Text>
      <Text> </Text>
      <SelectList
        items={items}
        columns={columns}
        onSelect={(value) => {
          if (value === NEW_WORKSPACE) {
            setPathError(null);
            setPhase("path");
            return;
          }
          const workspace = workspaces.find((item) => item.id === value);
          if (workspace) finish({ kind: "chosen", workspace } satisfies WorkspacePickResult);
        }}
      />
      <Text> </Text>
      <Text color={theme.faint}>{t("ws.keys")}</Text>
    </Box>
  );
}
