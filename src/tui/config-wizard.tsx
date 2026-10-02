/**
 * 配置向导 —— 纯 Ink 实现（**不依赖 inquirer**）
 *
 * 三种入口，共用同一套渲染与步骤机：
 *   1. 首启引导（`onboarding`）：启动时发现模型绑定的端点缺 API Key，直接进入「输入 Key」步骤；
 *   2. `/key`：会话内快速设置**当前模型所用端点**的 API Key（`initialStep` 直达编辑步骤）；
 *   3. `/config`：会话内打开配置中心，尽可能全面地管理 `config.json`：
 *      端点管理 / 模型管理 / 图片模型 / 默认项（默认模型·图片模型·Agent·迁移模型）/ 工具输出上限。
 *      列表 = [＋ 新建…] + 各条目；选中条目后进入**详情屏**，一屏内就地编辑其字段（含删除）。
 *
 * 设计要点：
 *   - 只做渲染与键盘分发，配置的读取与不可变改写全部委托 `../config-editor.js`；
 *   - 每次确认即写入磁盘（`onSave`），无「未保存草稿」概念，与 `config.json` 单一数据源一致；
 *   - 详情屏与输入屏自带硬件光标同步（`useCursor`），IME 候选框跟随光标 —— 与对话屏同一套
 *     「整帧高度小于终端行数」约定（见 `text.ts` 的 `usableFrameRows`）。
 */

import { useRef, useState, type ReactNode } from "react";
import { Box, Text, useCursor, useInput, useWindowSize } from "ink";
import type { AppConfig, Endpoint, ImageModel, Model } from "@ai-zen/agents-sdk";
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
  addImageModel,
  addModel,
  apiKeyGuide,
  findEndpoint,
  findModel,
  isApiKeySet,
  maskApiKey,
  modelsUsingEndpoint,
  removeEndpoint,
  removeImageModel,
  removeModel,
  setDefaultAgent,
  setDefaultImageModel,
  setDefaultMigrationModel,
  setDefaultModel,
  setEndpointApiKey,
  setEndpointBaseUrl,
  setMaxToolOutput,
  summarizeEndpoints,
  updateEndpoint,
  updateImageModel,
  updateModel,
} from "../config-editor.js";

// ==================== 类型 ====================

/** 可编辑的端点字段（首启引导 / `/key` 的直达编辑步骤用） */
export type EndpointField = "apiKey" | "baseUrl";

/** 「默认项」的四类目标 */
export type DefaultTarget = "defaultModel" | "defaultImageModel" | "defaultAgent" | "defaultMigrationModel";

/** 向导步骤（判别联合，逐步收敛） */
export type WizardStep =
  | { kind: "menu" }
  | { kind: "defaults" }
  | { kind: "pick-default"; target: DefaultTarget }
  | { kind: "endpoints" }
  | { kind: "endpoint"; endpointId: string }
  | { kind: "models" }
  | { kind: "model"; modelId: string }
  | { kind: "image-models" }
  | { kind: "image-model"; modelId: string }
  | { kind: "max-tool-output" }
  | { kind: "new-endpoint"; field: "name" | "baseUrl" | "apiKey"; draft: NewEndpointDraft }
  | { kind: "new-model" }
  | { kind: "new-image-model" }
  | { kind: "edit"; field: EndpointField; endpointId: string };

/** 列表里「新建…」哨兵值（实例 id 由名称派生、不含下划线，故不会冲突） */
const NEW_ENDPOINT = "__new_endpoint__";
const NEW_MODEL = "__new_model__";
const NEW_IMAGE_MODEL = "__new_image_model__";

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
  /** 可用于「默认 Agent」选择的 Agent 清单（可选） */
  agents?: { id: string; name: string }[];
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

/** 按显示宽度右侧补空格（用于把字段值对齐到同一列） */
function padDisplay(text: string, width: number): string {
  const w = displayWidth(text);
  return w >= width ? text : text + " ".repeat(width - w);
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
          // key 绑定标题：切换步骤时强制重建，避免复用上一个列表的高亮索引
          <SelectList key={title} items={visible} onSelect={onPick} columns={columns} />
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
  const defaultImage = (config.imageModels ?? []).find((model) => model.id === config.defaultImageModel);
  const items: SelectItem<string>[] = [
    {
      label: "端点管理",
      value: "endpoints",
      hint: summarizeEndpoints(config),
    },
    {
      label: "模型管理",
      value: "models",
      hint: `${config.models.length} 个 · 默认 ${defaultModel?.name ?? config.defaultModel ?? "未设置"}`,
    },
    {
      label: "图片模型",
      value: "imageModels",
      hint: `${config.imageModels?.length ?? 0} 个 · 默认 ${defaultImage?.name ?? config.defaultImageModel ?? "未设置"}`,
    },
    {
      label: "默认项",
      value: "defaults",
      hint: `Agent ${config.defaultAgent ?? "未设置"} · 迁移 ${config.defaultMigrationModel ?? "未设置"}`,
    },
    {
      label: "工具输出上限",
      value: "maxToolOutput",
      hint: `${config.maxToolOutput ?? 32768} 字符`,
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

// ==================== 通用详情屏（就地编辑）====================

export type DetailFieldKind = "text" | "secret" | "number" | "enum" | "bool";

/** 详情屏的一个可编辑字段 */
export interface DetailField {
  key: string;
  label: string;
  kind: DetailFieldKind;
  /** 展示值（bool → "是"/"否"；enum → 当前选项 label；secret → 已掩码的串） */
  value: string;
  /** 进入编辑（text/secret/number）时的初值；缺省用 `value` */
  initial?: string;
  /** enum 选项 */
  options?: { label: string; value: string }[];
  /** 提交文本 / 枚举值：返回错误信息或 `null`（成功） */
  commit?: (raw: string) => Promise<string | null>;
  /** bool 切换 */
  toggle?: () => Promise<string | null>;
}

/** 详情屏底部的整体动作（如「删除」），危险动作以红色呈现并可二次确认 */
export interface DetailAction {
  label: string;
  run: () => Promise<string | null>;
}

interface DetailStepProps {
  columns: number;
  rows: number;
  title: string;
  /** 标题下的说明行 */
  details?: string[];
  fields: DetailField[];
  notice?: string | null;
  /** 底部危险动作（如删除） */
  action?: DetailAction;
  onBack: () => void;
}

/**
 * 通用详情屏 —— 一屏列出某实体的全部字段，就地编辑：
 *   - 导航态：`↑ ↓` 在字段（含底部动作）间移动，`Esc` 返回列表；
 *   - 文本类（text/secret/number）：`Enter` 进入编辑，`Enter` 保存、`Esc` 取消，secret 支持 `Tab` 切明文；
 *   - bool：`Enter` 直接切换；enum：`Enter` 弹出选项列表；
 *   - 动作行：`Enter` 弹二次确认，确认后执行（通常用于删除）。
 *
 * 文本编辑时光标「就地」落在所选字段的值上（硬件光标同步，IME 候选框跟随）；
 * 帧高恒为「终端行数 − 1」，与其它屏一致。
 */
function DetailStep({ columns, rows, title, details, fields, notice, action, onBack }: DetailStepProps) {
  const { setCursorPosition } = useCursor();
  const rowCount = Math.max(1, fields.length + (action ? 1 : 0));
  const [index, setIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const labelWidth = Math.max(6, ...fields.map((f) => displayWidth(f.label)));
  const valueX = 2 + labelWidth + 2;
  const field = index < fields.length ? fields[index] : undefined;
  const onActionRow = Boolean(action) && index === fields.length;

  const chars = Array.from(value);
  const caret = Math.max(0, Math.min(cursor, chars.length));
  const masked = field?.kind === "secret" && !revealed;

  const beginEdit = () => {
    if (!field) return;
    const current = field.initial ?? field.value;
    setValue(current);
    setCursor(Array.from(current).length);
    setRevealed(false);
    setError(null);
    setEditing(true);
  };
  const update = (next: string, nextCursor: number) => {
    setValue(next);
    setCursor(nextCursor);
  };
  const insert = (text: string) =>
    update(chars.slice(0, caret).join("") + text + chars.slice(caret).join(""), caret + Array.from(text).length);
  const deleteBefore = () => {
    if (caret === 0) return;
    update(chars.slice(0, caret - 1).join("") + chars.slice(caret).join(""), caret - 1);
  };
  const deleteAfter = () => {
    if (caret >= chars.length) return;
    update(chars.slice(0, caret).join("") + chars.slice(caret + 1).join(""), caret);
  };

  const apply = async (run: () => Promise<string | null>) => {
    setError(null);
    const failure = await run();
    if (failure) setError(failure);
  };

  const submit = async () => {
    if (!field?.commit) return;
    const raw = value.trim();
    const current = (field.initial ?? field.value).trim();
    if (raw === current) {
      setEditing(false);
      setError(null);
      return;
    }
    const failure = await field.commit(raw);
    if (failure) {
      setError(failure);
      return;
    }
    setEditing(false);
    setError(null);
  };

  useInput(
    (char, key) => {
      if (isTerminalReply(char)) return;
      if (editing) {
        if (key.escape) {
          setEditing(false);
          setError(null);
          return;
        }
        if (key.return) {
          void submit();
          return;
        }
        if (key.tab && field?.kind === "secret") {
          setRevealed((r) => !r);
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
        return;
      }
      if (key.escape) {
        onBack();
        return;
      }
      if (key.upArrow) {
        setIndex((i) => (i - 1 + rowCount) % rowCount);
        return;
      }
      if (key.downArrow) {
        setIndex((i) => (i + 1) % rowCount);
        return;
      }
      if (key.return) {
        if (onActionRow && action) {
          setConfirming(true);
          return;
        }
        if (!field) return;
        if (field.kind === "bool") {
          if (field.toggle) void apply(field.toggle);
          return;
        }
        if (field.kind === "enum") {
          setChoosing(true);
          return;
        }
        beginEdit();
      }
    },
    { isActive: !choosing && !confirming },
  );

  // ---- 子屏：枚举选择 ----
  const enumOptions = field?.options;
  if (choosing && field && enumOptions) {
    const target = field;
    return (
      <ListStep
        columns={columns}
        rows={rows}
        title={`${target.label} · 选择`}
        items={enumOptions.map((option) => ({ label: option.label || "（空）", value: option.value }))}
        onPick={(picked) => {
          setChoosing(false);
          if (target.commit) void apply(() => target.commit!(picked));
        }}
        onCancel={() => setChoosing(false)}
      />
    );
  }

  // ---- 子屏：动作二次确认 ----
  if (confirming && action) {
    const target = action;
    return (
      <ListStep
        columns={columns}
        rows={rows}
        title={`${target.label}？`}
        subtitle={`${title} —— 此操作不可撤销`}
        items={[
          { label: `确认${target.label}`, value: "yes" },
          { label: "取消", value: "no" },
        ]}
        onPick={(picked) => {
          setConfirming(false);
          if (picked === "yes") void apply(target.run);
        }}
        onCancel={() => setConfirming(false)}
      />
    );
  }

  // ---- 主屏 ----
  const headerRows: Row[] = [
    ...textRows(title, columns, theme.highlight, true),
    ...(details ?? []).flatMap((detail) => textRows(detail, columns, theme.dim)),
    ...(notice ? textRows(`✔ ${notice}`, columns, theme.ok) : []),
    ...(error ? textRows(`✖ ${error}`, columns, theme.error) : []),
  ];
  const contentLines = headerRows.length + 1 + fields.length + (action ? 1 : 0) + 1;

  if (editing && field) {
    const shown = masked ? "•".repeat(chars.length) : value;
    const shownChars = Array.from(shown);
    setCursorPosition({
      x: valueX + displayWidth(shownChars.slice(0, caret).join("")),
      y: bottomPadding(rows, contentLines) + headerRows.length + 1 + index,
    });
  } else {
    setCursorPosition(undefined);
  }

  const hints: [string, string][] = editing
    ? masked
      ? [
          ["Enter", "保存"],
          ["Tab", "明文/掩码"],
          ["Esc", "取消"],
        ]
      : [
          ["Enter", "保存"],
          ["Esc", "取消"],
        ]
    : onActionRow
      ? [
          ["Enter", "执行"],
          ["↑ ↓", "移动"],
          ["Esc", "返回"],
        ]
      : field?.kind === "bool"
        ? [
            ["Enter", "切换"],
            ["↑ ↓", "移动"],
            ["Esc", "返回"],
          ]
        : field?.kind === "enum"
          ? [
              ["Enter", "选择"],
              ["↑ ↓", "移动"],
              ["Esc", "返回"],
            ]
          : [
              ["Enter", "编辑"],
              ["↑ ↓", "移动"],
              ["Esc", "返回"],
            ];

  return (
    <WizardFrame columns={columns} rows={rows} contentLines={contentLines}>
      <Header rows={headerRows} />
      <Box marginTop={1} flexDirection="column">
        {fields.map((f, i) => {
          const selected = i === index;
          const active = editing && selected;
          const rowMasked = f.kind === "secret" && !revealed;
          let before = f.value;
          let at = "";
          let after = "";
          if (active) {
            const shown = rowMasked ? "•".repeat(chars.length) : value;
            const shownChars = Array.from(shown);
            before = shownChars.slice(0, caret).join("");
            at = shownChars[caret] ?? " ";
            after = shownChars.slice(caret + 1).join("");
          }
          return (
            <Text key={f.key} wrap="truncate">
              <Text color={selected ? theme.brand[0] : theme.faint}>{selected ? "❯ " : "  "}</Text>
              <Text bold={selected} color={selected ? theme.highlight : theme.assistant}>
                {padDisplay(f.label, labelWidth)}
              </Text>
              <Text>{"  "}</Text>
              {active ? (
                <>
                  <Text>{before}</Text>
                  <Text inverse color={theme.brand[0]}>
                    {at}
                  </Text>
                  <Text>{after}</Text>
                </>
              ) : (
                <Text color={f.kind === "text" ? theme.assistant : theme.dim}>{before}</Text>
              )}
            </Text>
          );
        })}
        {action ? (
          <Text wrap="truncate">
            <Text color={index === fields.length ? theme.brand[0] : theme.faint}>
              {index === fields.length ? "❯ " : "  "}
            </Text>
            <Text bold={index === fields.length} color={theme.error}>
              {padDisplay(action.label, labelWidth)}
            </Text>
          </Text>
        ) : null}
      </Box>
      <KeyHints hints={hints} />
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

  /** 记录一次成功写盘：更新配置快照、累加变更、刷新提示 */
  const record = (next: AppConfig, message: string, changedEndpointIds: string[] = []) => {
    setConfig(next);
    acc.current.dirty = true;
    acc.current.summary.push(message);
    for (const id of changedEndpointIds) {
      if (!acc.current.changedEndpointIds.includes(id)) acc.current.changedEndpointIds.push(id);
    }
    setNotice(message);
  };

  /** 写盘 + 记录变更，**原地停留**；返回错误信息或 `null`（供详情屏字段提交使用） */
  const persist = async (next: AppConfig, message: string, changedEndpointIds: string[] = []): Promise<string | null> => {
    try {
      await props.onSave(next);
    } catch (cause: any) {
      return `写入配置失败：${cause?.message ?? cause}`;
    }
    record(next, message, changedEndpointIds);
    return null;
  };

  /** 写盘 + 记录变更 + 跳转；成功且 `closeOnSave` 时直接关闭，否则跳到 `after` 步骤（默认回菜单） */
  const commit = async (
    next: AppConfig,
    message: string,
    changedEndpointIds: string[] = [],
    after: WizardStep | "stay" = { kind: "menu" },
  ) => {
    setError(null);
    const failure = await persist(next, message, changedEndpointIds);
    if (failure) {
      setError(failure);
      return;
    }
    if (props.closeOnSave) props.onClose(snapshot());
    else if (after !== "stay") go(after);
  };

  // 条目可能在向导打开期间被外部删除：渲染前收敛回其列表，避免空指针
  const normalize = (current: WizardStep): WizardStep => {
    if ((current.kind === "edit" || current.kind === "endpoint") && !findEndpoint(config, current.endpointId)) {
      return { kind: "endpoints" };
    }
    if (current.kind === "model" && !findModel(config, current.modelId)) return { kind: "models" };
    if (
      current.kind === "image-model" &&
      !(config.imageModels ?? []).some((model) => model.id === current.modelId)
    ) {
      return { kind: "image-models" };
    }
    return current;
  };
  const activeStep = normalize(step);

  // ---------- 字段构造器 ----------

  /** 端点详情字段（editable：名称 / Base URL / API Key / 描述） */
  const endpointFields = (endpoint: Endpoint): DetailField[] => {
    const name = endpoint.name || endpoint.id;
    const save = (patch: Partial<Endpoint>, label: string) =>
      persist(updateEndpoint(config, endpoint.id, patch), `端点 ${name} 的 ${label} 已更新`, [endpoint.id]);
    return [
      {
        key: "name",
        label: "名称",
        kind: "text",
        value: name,
        initial: endpoint.name,
        commit: (raw) => (raw.trim() ? save({ name: raw.trim() }, "名称") : Promise.resolve("名称不能为空")),
      },
      {
        key: "baseUrl",
        label: "Base URL",
        kind: "text",
        value: endpoint.baseUrl,
        initial: endpoint.baseUrl,
        commit: (raw) =>
          /^https?:\/\//i.test(raw) ? save({ baseUrl: raw }, "Base URL") : Promise.resolve("Base URL 需以 http:// 或 https:// 开头"),
      },
      {
        key: "apiKey",
        label: "API Key",
        kind: "secret",
        value: maskApiKey(endpoint.apiKey),
        initial: endpoint.apiKey ?? "",
        commit: (raw) => (raw ? save({ apiKey: raw }, "API Key") : Promise.resolve("API Key 不能为空")),
      },
      {
        key: "description",
        label: "描述",
        kind: "text",
        value: endpoint.description ?? "（空）",
        initial: endpoint.description ?? "",
        commit: (raw) => save({ description: raw || undefined }, "描述"),
      },
    ];
  };

  /** 模型详情字段；编辑「出厂托管」模型时自动标记 `custom: true`（否则改动会被 SDK 同步覆盖） */
  const modelFields = (model: Model): DetailField[] => {
    const managed = !model.custom;
    const save = (patch: Partial<Model>, label: string) => {
      const next = updateModel(config, model.id, managed ? { ...patch, custom: true } : patch);
      const suffix = managed ? "（已标记为自定义，改动才会保留）" : "";
      return persist(next, `模型 ${model.name || model.id} 的 ${label} 已更新${suffix}`, [model.endpointId]);
    };
    return [
      {
        key: "name",
        label: "名称",
        kind: "text",
        value: model.name || model.id,
        initial: model.name,
        commit: (raw) => (raw.trim() ? save({ name: raw.trim() }, "名称") : Promise.resolve("名称不能为空")),
      },
      {
        key: "endpointId",
        label: "端点",
        kind: "enum",
        value: findEndpoint(config, model.endpointId)?.name ?? model.endpointId,
        options: config.endpoints.map((endpoint) => ({ label: endpoint.name || endpoint.id, value: endpoint.id })),
        commit: (raw) => (raw === model.endpointId ? Promise.resolve(null) : save({ endpointId: raw }, "端点")),
      },
      {
        key: "modelName",
        label: "模型名",
        kind: "text",
        value: model.modelName ?? "（同 id）",
        initial: model.modelName ?? "",
        commit: (raw) => save({ modelName: raw || undefined }, "模型名"),
      },
      {
        key: "maxContextTokens",
        label: "迁移阈值",
        kind: "number",
        value: String(model.maxContextTokens ?? 0),
        initial: String(model.maxContextTokens ?? 0),
        commit: (raw) => {
          const n = Number(raw.trim());
          return Number.isFinite(n) && n > 0 ? save({ maxContextTokens: Math.floor(n) }, "迁移阈值") : Promise.resolve("迁移阈值需为正整数");
        },
      },
      {
        key: "vision",
        label: "视觉",
        kind: "bool",
        value: model.vision ? "是" : "否",
        toggle: () => save({ vision: !model.vision }, "视觉"),
      },
      {
        key: "description",
        label: "描述",
        kind: "text",
        value: model.description ?? "（空）",
        initial: model.description ?? "",
        commit: (raw) => save({ description: raw || undefined }, "描述"),
      },
      {
        key: "custom",
        label: "自定义",
        kind: "bool",
        value: model.custom ? "是" : "否（出厂托管）",
        toggle: () =>
          persist(updateModel(config, model.id, { custom: !model.custom }), `模型 ${model.name || model.id} 的「自定义」已设为 ${!model.custom ? "是" : "否"}`, [model.endpointId]),
      },
    ];
  };

  /** 图片模型详情字段（同样对托管条目自动标记 `custom: true`） */
  const imageModelFields = (model: ImageModel): DetailField[] => {
    const managed = !model.custom;
    const save = (patch: Partial<ImageModel>, label: string) => {
      const next = updateImageModel(config, model.id, managed ? { ...patch, custom: true } : patch);
      const suffix = managed ? "（已标记为自定义，改动才会保留）" : "";
      return persist(next, `图片模型 ${model.name || model.id} 的 ${label} 已更新${suffix}`, [model.endpointId]);
    };
    return [
      {
        key: "name",
        label: "名称",
        kind: "text",
        value: model.name || model.id,
        initial: model.name,
        commit: (raw) => (raw.trim() ? save({ name: raw.trim() }, "名称") : Promise.resolve("名称不能为空")),
      },
      {
        key: "endpointId",
        label: "端点",
        kind: "enum",
        value: findEndpoint(config, model.endpointId)?.name ?? model.endpointId,
        options: config.endpoints.map((endpoint) => ({ label: endpoint.name || endpoint.id, value: endpoint.id })),
        commit: (raw) => (raw === model.endpointId ? Promise.resolve(null) : save({ endpointId: raw }, "端点")),
      },
      {
        key: "modelName",
        label: "模型名",
        kind: "text",
        value: model.modelName,
        initial: model.modelName,
        commit: (raw) => (raw.trim() ? save({ modelName: raw.trim() }, "模型名") : Promise.resolve("模型名不能为空")),
      },
      {
        key: "defaultSize",
        label: "尺寸",
        kind: "text",
        value: model.defaultSize ?? "（默认）",
        initial: model.defaultSize ?? "",
        commit: (raw) => save({ defaultSize: raw || undefined }, "尺寸"),
      },
      {
        key: "defaultQuality",
        label: "质量",
        kind: "text",
        value: model.defaultQuality ?? "（默认）",
        initial: model.defaultQuality ?? "",
        commit: (raw) => save({ defaultQuality: raw || undefined }, "质量"),
      },
      {
        key: "custom",
        label: "自定义",
        kind: "bool",
        value: model.custom ? "是" : "否（出厂托管）",
        toggle: () =>
          persist(updateImageModel(config, model.id, { custom: !model.custom }), `图片模型 ${model.name || model.id} 的「自定义」已设为 ${!model.custom ? "是" : "否"}`, [model.endpointId]),
      },
    ];
  };

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
          if (action === "endpoints") go({ kind: "endpoints" });
          else if (action === "models") go({ kind: "models" });
          else if (action === "imageModels") go({ kind: "image-models" });
          else if (action === "defaults") go({ kind: "defaults" });
          else if (action === "maxToolOutput") go({ kind: "max-tool-output" });
          else props.onClose(snapshot());
        }}
      />
    );
  }

  // ---------- 默认项子菜单 ----------
  if (activeStep.kind === "defaults") {
    const defaultImage = (config.imageModels ?? []).find((model) => model.id === config.defaultImageModel);
    const items: SelectItem<DefaultTarget>[] = [
      {
        label: "默认模型",
        value: "defaultModel",
        hint: findModel(config, config.defaultModel)?.name ?? config.defaultModel ?? "未设置",
      },
      {
        label: "默认图片模型",
        value: "defaultImageModel",
        hint: defaultImage?.name ?? config.defaultImageModel ?? "未设置",
      },
      { label: "默认 Agent", value: "defaultAgent", hint: config.defaultAgent ?? "未设置" },
      {
        label: "默认迁移模型",
        value: "defaultMigrationModel",
        hint: findModel(config, config.defaultMigrationModel)?.name ?? config.defaultMigrationModel ?? "未设置",
      },
    ];
    return (
      <ListStep
        columns={cols}
        rows={rows}
        title="默认项"
        subtitle="新会话 / 任务迁移使用的默认值"
        items={items}
        onPick={(target) => go({ kind: "pick-default", target })}
        onCancel={() => go({ kind: "menu" })}
      />
    );
  }

  // ---------- 选择某个默认项的值 ----------
  if (activeStep.kind === "pick-default") {
    const target = activeStep.target;
    let title = "默认项";
    let items: SelectItem<string>[] = [];
    if (target === "defaultModel" || target === "defaultMigrationModel") {
      title = target === "defaultModel" ? "默认模型" : "默认迁移模型";
      items = config.models.map((model) => {
        const endpoint = findEndpoint(config, model.endpointId);
        return {
          label: model.name || model.id,
          value: model.id,
          hint: `${endpoint?.name ?? model.endpointId} · ${isApiKeySet(endpoint?.apiKey) ? "密钥就绪" : "缺 API Key"}`,
        };
      });
    } else if (target === "defaultImageModel") {
      title = "默认图片模型";
      items = (config.imageModels ?? []).map((model) => ({
        label: model.name || model.id,
        value: model.id,
        hint: findEndpoint(config, model.endpointId)?.name ?? model.endpointId,
      }));
    } else {
      title = "默认 Agent";
      items = (props.agents ?? []).map((agent) => ({ label: agent.name, value: agent.id, hint: agent.id }));
    }
    items = [...items, { label: "（未设置）", value: "" }];
    return (
      <ListStep
        columns={cols}
        rows={rows}
        title={title}
        subtitle="选中后即时写盘"
        items={items}
        onPick={(value) => {
          const id = value || undefined;
          const label = value || "未设置";
          if (target === "defaultModel") void commit(setDefaultModel(config, id), `默认模型 → ${label}`, [], { kind: "defaults" });
          else if (target === "defaultMigrationModel")
            void commit(setDefaultMigrationModel(config, id), `默认迁移模型 → ${label}`, [], { kind: "defaults" });
          else if (target === "defaultImageModel")
            void commit(setDefaultImageModel(config, id), `默认图片模型 → ${label}`, [], { kind: "defaults" });
          else void commit(setDefaultAgent(config, id), `默认 Agent → ${label}`, [], { kind: "defaults" });
        }}
        onCancel={() => go({ kind: "defaults" })}
      />
    );
  }

  // ---------- 端点管理（[新建端点] + 端点列表）----------
  if (activeStep.kind === "endpoints") {
    const items: SelectItem<string>[] = [
      { label: "＋ 新建端点", value: NEW_ENDPOINT, hint: "自定义 OpenAI 兼容服务" },
      ...config.endpoints.map((endpoint) => ({
        label: endpoint.name || endpoint.id,
        value: endpoint.id,
        hint: `${maskApiKey(endpoint.apiKey)} · ${endpoint.baseUrl}`,
      })),
    ];
    return (
      <ListStep
        columns={cols}
        rows={rows}
        title="端点管理"
        subtitle={`共 ${config.endpoints.length} 个端点 · 选中后可就地编辑 / 删除`}
        items={items}
        onPick={(value) =>
          value === NEW_ENDPOINT
            ? go({ kind: "new-endpoint", field: "name", draft })
            : go({ kind: "endpoint", endpointId: value })
        }
        onCancel={() => go({ kind: "menu" })}
      />
    );
  }

  // ---------- 端点详情（就地编辑名称 / Base URL / API Key / 描述）----------
  if (activeStep.kind === "endpoint") {
    const endpoint = findEndpoint(config, activeStep.endpointId)!;
    const name = endpoint.name || endpoint.id;
    const modelCount = modelsUsingEndpoint(config, endpoint.id).length;
    return (
      <DetailStep
        columns={cols}
        rows={rows}
        title={`◆ 端点 · ${name}`}
        details={[`${endpoint.id}${modelCount > 0 ? ` · ${modelCount} 个模型引用` : ""}`, "↑ ↓ 移动 · Enter 编辑 · 改动即时写入磁盘"]}
        fields={endpointFields(endpoint)}
        notice={notice}
        action={{
          label: "删除端点",
          run: async () => {
            const refs = modelsUsingEndpoint(config, endpoint.id);
            if (refs.length > 0) {
              return `无法删除：仍被 ${refs.length} 个模型引用（${refs.map((m) => m.name || m.id).join("、")}），请先删除或改绑这些模型`;
            }
            const failure = await persist(removeEndpoint(config, endpoint.id), `已删除端点 ${name}`);
            if (!failure) go({ kind: "endpoints" });
            return failure;
          },
        }}
        onBack={() => go({ kind: "endpoints" })}
      />
    );
  }

  // ---------- 模型管理 ----------
  if (activeStep.kind === "models") {
    const items: SelectItem<string>[] = [
      { label: "＋ 新建模型", value: NEW_MODEL, hint: "自动标记为自定义（custom）" },
      ...config.models.map((model) => ({
        label: model.name || model.id,
        value: model.id,
        hint: `${findEndpoint(config, model.endpointId)?.name ?? model.endpointId} · ${model.custom ? "自定义" : "出厂托管"}${model.vision ? " · 视觉" : ""}`,
      })),
    ];
    return (
      <ListStep
        columns={cols}
        rows={rows}
        title="模型管理"
        subtitle={`共 ${config.models.length} 个模型 · 选中后可就地编辑 / 删除`}
        items={items}
        onPick={(value) => (value === NEW_MODEL ? go({ kind: "new-model" }) : go({ kind: "model", modelId: value }))}
        onCancel={() => go({ kind: "menu" })}
      />
    );
  }

  // ---------- 模型详情 ----------
  if (activeStep.kind === "model") {
    const model = findModel(config, activeStep.modelId)!;
    const name = model.name || model.id;
    return (
      <DetailStep
        columns={cols}
        rows={rows}
        title={`◆ 模型 · ${name}`}
        details={[`${model.id} · ${model.custom ? "自定义" : "出厂托管（编辑会自动转自定义）"}`, "↑ ↓ 移动 · Enter 编辑/切换 · 改动即时写入磁盘"]}
        fields={modelFields(model)}
        notice={notice}
        action={{
          label: "删除模型",
          run: async () => {
            const failure = await persist(removeModel(config, model.id), `已删除模型 ${name}`);
            if (!failure) go({ kind: "models" });
            return failure;
          },
        }}
        onBack={() => go({ kind: "models" })}
      />
    );
  }

  // ---------- 图片模型列表 ----------
  if (activeStep.kind === "image-models") {
    const list = config.imageModels ?? [];
    const items: SelectItem<string>[] = [
      { label: "＋ 新建图片模型", value: NEW_IMAGE_MODEL, hint: "自动标记为自定义（custom）" },
      ...list.map((model) => ({
        label: model.name || model.id,
        value: model.id,
        hint: `${findEndpoint(config, model.endpointId)?.name ?? model.endpointId} · ${model.custom ? "自定义" : "出厂托管"}`,
      })),
    ];
    return (
      <ListStep
        columns={cols}
        rows={rows}
        title="图片模型"
        subtitle={`共 ${list.length} 个 · 选中后可就地编辑 / 删除`}
        items={items}
        onPick={(value) => (value === NEW_IMAGE_MODEL ? go({ kind: "new-image-model" }) : go({ kind: "image-model", modelId: value }))}
        onCancel={() => go({ kind: "menu" })}
      />
    );
  }

  // ---------- 图片模型详情 ----------
  if (activeStep.kind === "image-model") {
    const model = (config.imageModels ?? []).find((m) => m.id === activeStep.modelId)!;
    const name = model.name || model.id;
    return (
      <DetailStep
        columns={cols}
        rows={rows}
        title={`◆ 图片模型 · ${name}`}
        details={[`${model.id} · ${model.custom ? "自定义" : "出厂托管（编辑会自动转自定义）"}`, "↑ ↓ 移动 · Enter 编辑/切换 · 改动即时写入磁盘"]}
        fields={imageModelFields(model)}
        notice={notice}
        action={{
          label: "删除图片模型",
          run: async () => {
            const failure = await persist(removeImageModel(config, model.id), `已删除图片模型 ${name}`);
            if (!failure) go({ kind: "image-models" });
            return failure;
          },
        }}
        onBack={() => go({ kind: "image-models" })}
      />
    );
  }

  // ---------- 工具输出上限 ----------
  if (activeStep.kind === "max-tool-output") {
    const current = config.maxToolOutput ?? 32768;
    return (
      <PromptScreen
        key="maxToolOutput"
        columns={cols}
        rows={rows}
        title="工具输出上限（字符数）"
        details={[`当前：${current}`, "工具单次输出超过该值时落盘或仅警告，避免撑爆上下文"]}
        initialValue={String(current)}
        error={error}
        hints={[["Enter", "保存"], ["Esc", "返回"]]}
        onSubmit={(value) => {
          const n = Number(value.trim());
          if (!Number.isFinite(n) || n <= 0) {
            setError("需为正整数");
            return;
          }
          void commit(setMaxToolOutput(config, Math.floor(n)), `工具输出上限 → ${Math.floor(n)} 字符`, [], { kind: "menu" });
        }}
        onCancel={() => go({ kind: "menu" })}
      />
    );
  }

  // ---------- 新建模型（名称 → 创建并进入详情）----------
  if (activeStep.kind === "new-model") {
    const endpointId = config.endpoints[0]?.id ?? "";
    return (
      <PromptScreen
        key="new:model"
        columns={cols}
        rows={rows}
        title="新建模型 · 名称"
        details={[
          "用于在配置与状态栏中标识该模型，例如 My GPT",
          config.endpoints.length === 0
            ? "⚠ 尚未配置端点，创建后请先到「端点管理」添加端点"
            : `将默认绑定端点：${findEndpoint(config, endpointId)?.name ?? endpointId}`,
        ]}
        error={error}
        hints={[["Enter", "创建并编辑"], ["Esc", "返回"]]}
        onSubmit={(value) => {
          const name = value.trim();
          if (!name) {
            setError("名称不能为空");
            return;
          }
          const { config: next, model } = addModel(config, { name, endpointId });
          void (async () => {
            const failure = await persist(next, `已新建模型 ${model.name}（${model.id}，已标记为自定义）`);
            if (failure) {
              setError(failure);
              return;
            }
            go({ kind: "model", modelId: model.id });
          })();
        }}
        onCancel={() => go({ kind: "models" })}
      />
    );
  }

  // ---------- 新建图片模型（名称 → 创建并进入详情）----------
  if (activeStep.kind === "new-image-model") {
    const endpointId = config.endpoints[0]?.id ?? "";
    return (
      <PromptScreen
        key="new:image-model"
        columns={cols}
        rows={rows}
        title="新建图片模型 · 名称"
        details={[
          "用于在配置与状态栏中标识该模型，例如 My Image",
          config.endpoints.length === 0
            ? "⚠ 尚未配置端点，创建后请先到「端点管理」添加端点"
            : `将默认绑定端点：${findEndpoint(config, endpointId)?.name ?? endpointId}`,
        ]}
        error={error}
        hints={[["Enter", "创建并编辑"], ["Esc", "返回"]]}
        onSubmit={(value) => {
          const name = value.trim();
          if (!name) {
            setError("名称不能为空");
            return;
          }
          const { config: next, model } = addImageModel(config, { name, endpointId });
          void (async () => {
            const failure = await persist(next, `已新建图片模型 ${model.name}（${model.id}，已标记为自定义）`);
            if (failure) {
              setError(failure);
              return;
            }
            go({ kind: "image-model", modelId: model.id });
          })();
        }}
        onCancel={() => go({ kind: "image-models" })}
      />
    );
  }

  // ---------- 端点字段直达编辑（首启引导 / `/key`）----------
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
            void commit(setEndpointApiKey(config, endpoint.id, key), `端点 ${name} 的 API Key 已更新`, [endpoint.id]);
          }}
          onCancel={() => (props.closeOnSave ? props.onClose(snapshot()) : go({ kind: "menu" }))}
        />
      );
    }

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
          void commit(setEndpointBaseUrl(config, endpoint.id, baseUrl), `端点 ${name} 的 Base URL 已更新`, [endpoint.id]);
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
        onCancel={() => go({ kind: "endpoints" })}
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
          [endpoint.id],
          { kind: "endpoints" },
        );
      }}
      onCancel={() => {
        setError(null);
        setStep({ kind: "new-endpoint", field: "baseUrl", draft });
      }}
    />
  );
}
