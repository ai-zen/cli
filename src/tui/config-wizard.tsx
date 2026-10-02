/**
 * 配置向导 —— 纯 Ink 实现（**不依赖 inquirer**）
 *
 * 三种入口，共用同一套渲染与步骤机：
 *   1. 首启引导（`onboarding`）：启动时发现模型绑定的端点缺 API Key，直接进入「输入 Key」步骤；
 *   2. `/key`：会话内快速设置**当前模型所用端点**的 API Key（`initialStep` 直达编辑步骤）；
 *   3. `/config`：会话内打开配置中心（默认模型 / 端点凭据 / 端点地址 / 新建端点）。
 *
 * 设计要点：
 *   - 只做渲染与键盘分发，配置的读取与不可变改写全部委托 `../config-editor.js`；
 *   - 每次确认即写入磁盘（`onSave`），无「未保存草稿」概念，与 `config.json` 单一数据源一致；
 *   - 文本输入屏自带硬件光标同步（`useCursor`），IME 候选框跟随光标 —— 与对话屏同一套
 *     「整帧高度小于终端行数」约定（见 `text.ts` 的 `usableFrameRows`）。
 */

import { useRef, useState, type ReactNode } from "react";
import { Box, Text, useCursor, useInput, useWindowSize } from "ink";
import type { AppConfig } from "@ai-zen/agents-sdk";
import { theme } from "./theme.js";
import { SelectList, KeyHints, type SelectItem } from "./components.js";
import {
  INPUT_PREFIX_WIDTH,
  bottomPadding,
  clipWidth,
  displayWidth,
  layoutInput,
  usableFrameRows,
  wrapText,
  isTerminalReply,
} from "./text.js";
import { CONFIG_FILE } from "../config.js";
import {
  addEndpoint,
  apiKeyGuide,
  findEndpoint,
  findModel,
  isApiKeySet,
  maskApiKey,
  setDefaultModel,
  setEndpointApiKey,
  setEndpointBaseUrl,
  summarizeEndpoints,
} from "../config-editor.js";

// ==================== 类型 ====================

/** 可编辑的端点字段 */
export type EndpointField = "apiKey" | "baseUrl";

/** 向导步骤（判别联合，逐步收敛） */
export type WizardStep =
  | { kind: "menu" }
  | { kind: "pick-model" }
  | { kind: "pick-endpoint"; field: EndpointField }
  | { kind: "edit"; field: EndpointField; endpointId: string }
  | { kind: "new-endpoint"; field: "name" | "baseUrl" | "apiKey"; draft: NewEndpointDraft };

export interface NewEndpointDraft {
  name: string;
  baseUrl: string;
  apiKey: string;
}

/** 向导关闭时回传的变更结果 */
export interface WizardCloseResult {
  /** 是否有改动写入磁盘 */
  dirty: boolean;
  /** 人话变更摘要（宿主渲染为对话区提示） */
  summary: string[];
  /** 被改动的端点 id（宿主据此判断是否需要重建 Agent） */
  changedEndpointIds: string[];
}

export interface ConfigWizardProps {
  /** 打开向导时的配置快照 */
  config: AppConfig;
  /** 起始步骤（默认配置中心菜单） */
  initialStep?: WizardStep;
  /** 首启引导模式：文案更完整，Esc 语义为「放弃」 */
  onboarding?: boolean;
  /** 保存成功后直接关闭（首启引导 / `/key`），否则回到配置中心菜单 */
  closeOnSave?: boolean;
  /** 持久化配置（通常是 `saveConfig`） */
  onSave: (config: AppConfig) => Promise<void>;
  /** 关闭向导 */
  onClose: (result: WizardCloseResult) => void;
}

// ==================== 头部行 ====================

interface Row {
  text: string;
  color: string;
  bold: boolean;
}

/** 把一段文本按终端宽度折行成「每行一条 row」（渲染时以 truncate 保证 1 行 = 1 终端行） */
function textRows(text: string, columns: number, color: string, bold = false): Row[] {
  return wrapText(text, Math.max(8, columns - 2)).map((line) => ({ text: line, color, bold }));
}

function Header({ rows: headerRows }: { rows: Row[] }) {
  return (
    <>
      {headerRows.map((row, index) => (
        <Box key={index} paddingX={1}>
          <Text color={row.color} bold={row.bold} wrap="truncate">
            {row.text}
          </Text>
        </Box>
      ))}
    </>
  );
}

// ==================== 向导外壳（自底部向上布局）====================

/**
 * 向导外壳 —— 与对话屏一致：内容用顶部空白行顶到底部。
 *
 * 帧高 = 内容行数 + 顶部留白，其中留白 = 「终端行数 − 1 − 内容行数」。
 * 这样内容永不飘到视口外（之前短帧顶对齐时，从对话屏切过来会被擦除/滚动错位顶出可视区，
 * 在 VS Code 终端里表现为「渲染不全」），且与对话屏帧高一致、切换时不抖动。
 */
function WizardFrame({
  columns,
  rows,
  contentLines,
  children,
}: {
  columns: number;
  rows: number;
  contentLines: number;
  children: ReactNode;
}) {
  const pad = bottomPadding(rows, contentLines);
  return (
    <Box flexDirection="column" width={columns}>
      {Array.from({ length: pad }, (_, index) => (
        <Text key={`pad-${index}`}> </Text>
      ))}
      {children}
    </Box>
  );
}

// ==================== 输入屏布局（纯函数，便于单测）====================

export interface PromptLayoutInput {
  /** 终端行数 */
  terminalRows: number;
  /** 标题 + 说明已占行数 */
  headerLines: number;
  /** 输入区折行后的行数 */
  inputLines: number;
  /** 输入区之后额外占用的行数（空值提示 / 错误行 / 明文提示） */
  extraLines: number;
  /** 底部键位提示行数（通常 1） */
  hintLines: number;
  /** 光标在输入区内的行 / 列（列以 code point 计） */
  cursorRow: number;
  cursorCol: number;
  /** 光标所在行的文本（不含提示符） */
  lineText: string;
}

export interface PromptLayout {
  /** 内容总行数 */
  contentLines: number;
  /** 顶部留白行数 */
  topPadding: number;
  /** 终端硬件光标坐标（相对整帧原点，供 IME 候选框定位） */
  cursor: { x: number; y: number };
}

/** 计算输入屏的顶部留白与硬件光标坐标（吸底布局 + IME 跟随） */
export function promptLayout(input: PromptLayoutInput): PromptLayout {
  const contentLines = input.headerLines + input.inputLines + input.extraLines + input.hintLines;
  const topPadding = bottomPadding(input.terminalRows, contentLines);
  const before = Array.from(input.lineText).slice(0, input.cursorCol).join("");
  return {
    contentLines,
    topPadding,
    cursor: {
      x: INPUT_PREFIX_WIDTH + displayWidth(before),
      y: topPadding + input.headerLines + input.cursorRow,
    },
  };
}

// ==================== 文本输入屏 ====================

interface PromptScreenProps {
  columns: number;
  /** 终端行数（吸底布局用） */
  rows: number;
  title: string;
  /** 标题下的说明行（自动折行） */
  details?: string[];
  /** 输入框初始值 */
  initialValue?: string;
  /** 掩码输入（API Key），Tab 可临时切明文核对 */
  mask?: boolean;
  /** 上级校验错误 */
  error?: string | null;
  hints: [string, string][];
  /** 光标位置变化时回调（用于宿主实时预览，可省略） */
  onChange?: (value: string) => void;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/**
 * 全屏单行输入：标题 + 输入行 + 键位提示（吸底布局）。
 *
 * 硬件光标 y 由 `promptLayout()` 按「顶部留白 + 标题行数 + 输入行内偏移」算出，
 * 而整帧高度恒小于终端行数（不命中 Ink 全屏分支），因此 IME 候选框与自绘光标精确对齐。
 */
export function PromptScreen(props: PromptScreenProps) {
  const { setCursorPosition } = useCursor();
  const [value, setValue] = useState(props.initialValue ?? "");
  const [cursor, setCursor] = useState(Array.from(props.initialValue ?? "").length);
  const [revealed, setRevealed] = useState(!props.mask);

  const chars = Array.from(value);
  const caret = Math.max(0, Math.min(cursor, chars.length));
  const display = revealed ? value : "•".repeat(chars.length);
  const layout = layoutInput(display, caret, Math.max(4, props.columns - 4));

  const header: Row[] = [
    ...textRows(`? ${props.title}`, props.columns, theme.warn, true),
    ...(props.details ?? []).flatMap((detail) => textRows(detail, props.columns, theme.dim)),
  ];
  // 输入区之后的附加行：空值提示 / 校验错误 / 明文提示
  const extraLines = (chars.length === 0 ? 1 : 0) + (props.error ? 1 : 0) + (props.mask && revealed ? 1 : 0);
  const position = promptLayout({
    terminalRows: props.rows,
    headerLines: header.length,
    inputLines: layout.lines.length,
    extraLines,
    hintLines: 1,
    cursorRow: layout.cursorRow,
    cursorCol: layout.cursorCol,
    lineText: layout.lines[layout.cursorRow] ?? "",
  });
  setCursorPosition(position.cursor);

  const update = (next: string, nextCursor: number) => {
    setValue(next);
    setCursor(nextCursor);
    props.onChange?.(next);
  };
  const insert = (text: string) => {
    update(chars.slice(0, caret).join("") + text + chars.slice(caret).join(""), caret + Array.from(text).length);
  };
  const deleteBefore = () => {
    if (caret === 0) return;
    update(chars.slice(0, caret - 1).join("") + chars.slice(caret).join(""), caret - 1);
  };
  const deleteAfter = () => {
    if (caret >= chars.length) return;
    update(chars.slice(0, caret).join("") + chars.slice(caret + 1).join(""), caret);
  };

  useInput((char, key) => {
    // 终端应答序列（如 Kitty 查询应答 `[?0u`）不是用户输入，丢弃
    if (isTerminalReply(char)) return;
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (key.return) {
      props.onSubmit(value);
      return;
    }
    if (key.tab && props.mask) {
      setRevealed((v) => !v);
      return;
    }
    if (char === "u" && key.ctrl) {
      update("", 0);
      return;
    }
    if (key.leftArrow) {
      setCursor(Math.max(0, caret - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor(Math.min(chars.length, caret + 1));
      return;
    }
    if (key.home) {
      setCursor(0);
      return;
    }
    if (key.end) {
      setCursor(chars.length);
      return;
    }
    if (key.backspace) {
      deleteBefore();
      return;
    }
    if (key.delete) {
      deleteAfter();
      return;
    }
    if (char && !key.ctrl && !key.meta) insert(char);
  });

  return (
    <WizardFrame columns={props.columns} rows={props.rows} contentLines={position.contentLines}>
      <Header rows={header} />

      <Box flexDirection="column" paddingX={1}>
        {layout.lines.map((line, index) => {
          const prompt =
            index === 0 ? (
              <Text color={theme.brand[0]} bold>
                {"❯ "}
              </Text>
            ) : (
              <Text>{"  "}</Text>
            );
          if (index !== layout.cursorRow) {
            return (
              <Text key={index} wrap="truncate">
                {prompt}
                <Text>{line}</Text>
              </Text>
            );
          }
          const rowChars = Array.from(line);
          const at = rowChars[layout.cursorCol];
          return (
            <Text key={index} wrap="truncate">
              {prompt}
              <Text>{rowChars.slice(0, layout.cursorCol).join("")}</Text>
              <Text inverse color={theme.brand[0]}>
                {at ?? " "}
              </Text>
              <Text>{rowChars.slice(layout.cursorCol + 1).join("")}</Text>
            </Text>
          );
        })}
      </Box>

      {chars.length === 0 ? (
        <Box paddingX={1}>
          <Text color={theme.faint} wrap="truncate">
            {props.mask ? "（粘贴或输入后按 Enter 保存，Tab 可切明文核对）" : "（输入后按 Enter 确认）"}
          </Text>
        </Box>
      ) : null}

      {props.error ? (
        <Box paddingX={1}>
          <Text color={theme.error} wrap="truncate">
            ✖ {props.error}
          </Text>
        </Box>
      ) : null}

      {props.mask && revealed ? (
        <Box paddingX={1}>
          <Text color={theme.warn} wrap="truncate">
            ⚠ 当前为明文显示（Tab 切回掩码）
          </Text>
        </Box>
      ) : null}

      <KeyHints hints={props.hints} />
    </WizardFrame>
  );
}

// ==================== 列表选择屏 ====================

interface ListStepProps<T> {
  columns: number;
  /** 终端行数（吸底布局用） */
  rows: number;
  title: string;
  subtitle?: string;
  items: SelectItem<T>[];
  onPick: (value: T) => void;
  onCancel: () => void;
}

function ListStep<T>({ columns, rows, title, subtitle, items, onPick, onCancel }: ListStepProps<T>) {
  const { setCursorPosition } = useCursor();
  // 列表屏无文本编辑：显式隐藏硬件光标，避免沿用上一屏（对话屏）的位置
  setCursorPosition(undefined);
  useInput((_char, key) => {
    if (key.escape) onCancel();
  });

  const headerRows: Row[] = [
    ...textRows(title, columns, theme.highlight, true),
    ...(subtitle ? textRows(subtitle, columns, theme.dim) : []),
  ];
  // 列表项多到装不下时就截断（每项严格占一行，吸底布局才能精确留白）
  const maxItems = Math.max(1, usableFrameRows(rows) - (headerRows.length + 3));
  const visible = items.slice(0, maxItems);
  const truncated = items.length > visible.length;
  const contentLines = headerRows.length + 1 + Math.max(visible.length, 1) + (truncated ? 1 : 0) + 1;

  return (
    <WizardFrame columns={columns} rows={rows} contentLines={contentLines}>
      <Header rows={headerRows} />
      <Box marginTop={1} flexDirection="column">
        {visible.length > 0 ? (
          <SelectList items={visible} onSelect={onPick} columns={columns} />
        ) : (
          <Text color={theme.faint} wrap="truncate">
            {"  （无可选项）"}
          </Text>
        )}
        {truncated ? (
          <Text color={theme.faint} wrap="truncate">
            {`  （共 ${items.length} 项，仅显示前 ${visible.length} 项）`}
          </Text>
        ) : null}
      </Box>
      <KeyHints hints={[["↑ ↓", "选择"], ["Enter", "确认"], ["Esc", "返回"]]} />
    </WizardFrame>
  );
}

// ==================== 配置中心菜单 ====================

interface MenuStepProps {
  columns: number;
  /** 终端行数（吸底布局用） */
  rows: number;
  config: AppConfig;
  savedCount: number;
  /** 最近一次保存提示 */
  notice?: string | null;
  onPick: (action: string) => void;
  onClose: () => void;
}

function MenuStep({ columns, rows, config, savedCount, notice, onPick, onClose }: MenuStepProps) {
  const { setCursorPosition } = useCursor();
  setCursorPosition(undefined); // 无文本编辑：隐藏硬件光标
  useInput((_char, key) => {
    if (key.escape) onClose();
  });

  const defaultModel = findModel(config, config.defaultModel);
  const items: SelectItem<string>[] = [
    {
      label: "默认模型",
      value: "model",
      hint: defaultModel?.name ?? config.defaultModel ?? "未设置",
    },
    {
      label: "端点凭据（API Key）",
      value: "apiKey",
      hint: summarizeEndpoints(config),
    },
    {
      label: "端点地址（Base URL）",
      value: "baseUrl",
      hint: `${config.endpoints.length} 个端点`,
    },
    {
      label: "新建端点",
      value: "new",
      hint: "自定义 OpenAI 兼容服务",
    },
    {
      label: "完成",
      value: "done",
      hint: savedCount > 0 ? `已保存 ${savedCount} 项改动` : "返回对话",
    },
  ];

  const headerRows: Row[] = [
    ...textRows("◆ 配置中心", columns, theme.highlight, true),
    ...textRows(`配置文件：${CONFIG_FILE}`, columns, theme.faint),
    ...textRows("改动即时写入磁盘；涉及当前端点的改动会重建会话（消息保留）。", columns, theme.dim),
    ...(notice ? textRows(`✔ ${notice}`, columns, theme.ok) : []),
  ];
  const contentLines = headerRows.length + 1 + items.length + 1;

  return (
    <WizardFrame columns={columns} rows={rows} contentLines={contentLines}>
      <Header rows={headerRows} />
      <Box marginTop={1}>
        <SelectList items={items} onSelect={onPick} columns={columns} />
      </Box>
      <KeyHints hints={[["↑ ↓", "选择"], ["Enter", "确认"], ["Esc", "完成返回"]]} />
    </WizardFrame>
  );
}

// ==================== 向导主体 ====================

export function ConfigWizard(props: ConfigWizardProps) {
  const { columns, rows: terminalRows } = useWindowSize();
  const cols = columns ?? 80;
  const rows = terminalRows ?? 24;

  const [config, setConfig] = useState(props.config);
  const [step, setStep] = useState<WizardStep>(props.initialStep ?? { kind: "menu" });
  const [draft, setDraft] = useState<NewEndpointDraft>({ name: "", baseUrl: "", apiKey: "" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 累加器放 ref：`commit()` 后需要立刻读到最新值再决定是否关闭
  const acc = useRef<WizardCloseResult>({ dirty: false, summary: [], changedEndpointIds: [] });

  const snapshot = (): WizardCloseResult => ({
    dirty: acc.current.dirty,
    summary: [...acc.current.summary],
    changedEndpointIds: [...acc.current.changedEndpointIds],
  });

  const go = (next: WizardStep) => {
    setError(null);
    setStep(next);
  };

  /** 写盘 + 记录变更；成功且 `closeOnSave` 时直接关闭 */
  const commit = async (next: AppConfig, message: string, endpointId?: string) => {
    setError(null);
    try {
      await props.onSave(next);
    } catch (cause: any) {
      setError(`写入配置失败：${cause?.message ?? cause}`);
      return;
    }
    setConfig(next);
    acc.current.dirty = true;
    acc.current.summary.push(message);
    if (endpointId && !acc.current.changedEndpointIds.includes(endpointId)) {
      acc.current.changedEndpointIds.push(endpointId);
    }
    setNotice(message);
    if (props.closeOnSave) props.onClose(snapshot());
    else go({ kind: "menu" });
  };

  // 端点可能在向导打开期间被外部删除：渲染前收敛回菜单，避免空指针
  const activeStep: WizardStep =
    step.kind === "edit" && !findEndpoint(config, step.endpointId) ? { kind: "menu" } : step;

  // ---------- 配置中心菜单 ----------
  if (activeStep.kind === "menu") {
    return (
      <MenuStep
        columns={cols}
        rows={rows}
        config={config}
        savedCount={acc.current.summary.length}
        notice={notice}
        onClose={() => props.onClose(snapshot())}
        onPick={(action) => {
          if (action === "model") go({ kind: "pick-model" });
          else if (action === "apiKey") go({ kind: "pick-endpoint", field: "apiKey" });
          else if (action === "baseUrl") go({ kind: "pick-endpoint", field: "baseUrl" });
          else if (action === "new") go({ kind: "new-endpoint", field: "name", draft });
          else props.onClose(snapshot());
        }}
      />
    );
  }

  // ---------- 选择默认模型 ----------
  if (activeStep.kind === "pick-model") {
    const items: SelectItem<string>[] = config.models.map((model) => {
      const endpoint = findEndpoint(config, model.endpointId);
      return {
        label: model.name || model.id,
        value: model.id,
        hint: `${endpoint?.name ?? model.endpointId} · ${isApiKeySet(endpoint?.apiKey) ? "密钥就绪" : "缺 API Key"}`,
      };
    });
    return (
      <ListStep
        columns={cols}
        rows={rows}
        title="默认模型"
        subtitle="新会话的起始模型（当前对话不受影响）"
        items={items}
        onPick={(modelId) => {
          const model = findModel(config, modelId);
          void commit(setDefaultModel(config, modelId), `默认模型 → ${model?.name ?? modelId}`);
        }}
        onCancel={() => go({ kind: "menu" })}
      />
    );
  }

  // ---------- 选择端点 ----------
  if (activeStep.kind === "pick-endpoint") {
    const field = activeStep.field;
    const items: SelectItem<string>[] = config.endpoints.map((endpoint) => ({
      label: endpoint.name || endpoint.id,
      value: endpoint.id,
      hint: field === "apiKey" ? maskApiKey(endpoint.apiKey) : endpoint.baseUrl,
    }));
    return (
      <ListStep
        columns={cols}
        rows={rows}
        title={field === "apiKey" ? "选择端点 · API Key" : "选择端点 · Base URL"}
        subtitle={`共 ${config.endpoints.length} 个端点`}
        items={items}
        onPick={(endpointId) => go({ kind: "edit", field, endpointId })}
        onCancel={() => go({ kind: "menu" })}
      />
    );
  }

  // ---------- 编辑端点字段 ----------
  if (activeStep.kind === "edit") {
    const endpoint = findEndpoint(config, activeStep.endpointId)!;
    const name = endpoint.name || endpoint.id;

    if (activeStep.field === "apiKey") {
      const guide = apiKeyGuide(endpoint.baseUrl);
      return (
        <PromptScreen
          key={`apiKey:${endpoint.id}`}
          columns={cols}
          rows={rows}
          title={props.onboarding ? `首次配置 · 设置 ${name} 的 API Key` : `设置 API Key · ${name}`}
          details={[
            `端点：${name} · ${endpoint.baseUrl}`,
            `当前：${maskApiKey(endpoint.apiKey)}`,
            guide.url
              ? `${guide.vendor} 申请地址：${guide.url}`
              : `${guide.vendor}：请向服务提供方获取 API Key`,
            props.onboarding ? "保存后立即进入对话（Esc 放弃并退出）。" : undefined,
          ].filter((line): line is string => Boolean(line))}
          mask
          error={error}
          hints={[
            ["Enter", props.onboarding ? "保存并进入对话" : "保存"],
            ["Tab", "明文/掩码"],
            ["Esc", props.closeOnSave ? "放弃" : "返回"],
          ]}
          onSubmit={(value) => {
            const key = value.trim();
            if (!key) {
              setError("API Key 不能为空");
              return;
            }
            void commit(setEndpointApiKey(config, endpoint.id, key), `端点 ${name} 的 API Key 已更新`, endpoint.id);
          }}
          onCancel={() => (props.closeOnSave ? props.onClose(snapshot()) : go({ kind: "menu" }))}
        />
      );
    }

    // Base URL
    return (
      <PromptScreen
        key={`baseUrl:${endpoint.id}`}
        columns={cols}
        rows={rows}
        title={`设置 Base URL · ${name}`}
        details={[`当前：${endpoint.baseUrl}`, "需以 http:// 或 https:// 开头（OpenAI 兼容端点）"]}
        initialValue={endpoint.baseUrl}
        error={error}
        hints={[["Enter", "保存"], ["Esc", "返回"]]}
        onSubmit={(value) => {
          const baseUrl = value.trim();
          if (!/^https?:\/\//i.test(baseUrl)) {
            setError("Base URL 需以 http:// 或 https:// 开头");
            return;
          }
          void commit(setEndpointBaseUrl(config, endpoint.id, baseUrl), `端点 ${name} 的 Base URL 已更新`, endpoint.id);
        }}
        onCancel={() => go({ kind: "menu" })}
      />
    );
  }

  // ---------- 新建端点（名称 → Base URL → API Key）----------
  const field = activeStep.field;

  if (field === "name") {
    return (
      <PromptScreen
        key="new:name"
        columns={cols}
        rows={rows}
        title="新建端点 · 名称"
        details={["用于在配置与状态栏中标识该服务，例如 My Gateway"]}
        initialValue={draft.name}
        error={error}
        hints={[["Enter", "下一步"], ["Esc", "返回"]]}
        onSubmit={(value) => {
          const name = value.trim();
          if (!name) {
            setError("名称不能为空");
            return;
          }
          const next = { ...draft, name };
          setDraft(next);
          setError(null);
          setStep({ kind: "new-endpoint", field: "baseUrl", draft: next });
        }}
        onCancel={() => go({ kind: "menu" })}
      />
    );
  }

  if (field === "baseUrl") {
    return (
      <PromptScreen
        key="new:baseUrl"
        columns={cols}
        rows={rows}
        title="新建端点 · Base URL"
        details={["例如 https://api.openai.com/v1（须为 OpenAI 兼容接口）"]}
        initialValue={draft.baseUrl}
        error={error}
        hints={[["Enter", "下一步"], ["Esc", "返回"]]}
        onSubmit={(value) => {
          const baseUrl = value.trim();
          if (!/^https?:\/\//i.test(baseUrl)) {
            setError("Base URL 需以 http:// 或 https:// 开头");
            return;
          }
          const next = { ...draft, baseUrl };
          setDraft(next);
          setError(null);
          setStep({ kind: "new-endpoint", field: "apiKey", draft: next });
        }}
        onCancel={() => {
          setError(null);
          setStep({ kind: "new-endpoint", field: "name", draft });
        }}
      />
    );
  }

  return (
    <PromptScreen
      key="new:apiKey"
      columns={cols}
      rows={rows}
      title="新建端点 · API Key"
      details={[
        `端点：${draft.name} · ${draft.baseUrl}`,
        "可留空稍后再补（留空时该端点暂不可用）",
        apiKeyGuide(draft.baseUrl).url
          ? `${apiKeyGuide(draft.baseUrl).vendor} 申请地址：${apiKeyGuide(draft.baseUrl).url}`
          : undefined,
      ].filter((line): line is string => Boolean(line))}
      mask
      error={error}
      hints={[["Enter", "保存端点"], ["Tab", "明文/掩码"], ["Esc", "返回"]]}
      onSubmit={(value) => {
        const apiKey = value.trim();
        const { config: next, endpoint } = addEndpoint(config, { ...draft, apiKey });
        void commit(
          next,
          `已添加端点 ${endpoint.name}（${endpoint.id}）${apiKey ? "" : " · API Key 待补充"}`,
          endpoint.id,
        );
      }}
      onCancel={() => {
        setError(null);
        setStep({ kind: "new-endpoint", field: "baseUrl", draft });
      }}
    />
  );
}
