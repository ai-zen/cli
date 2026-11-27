// 通用详情屏 DetailStep（就地编辑）
import { useEffect, useState } from "react";
import { Box, Text, useCursor, useInput } from "ink";
import { theme } from "../theme.js";
import { KeyHints } from "../components.js";
import { bottomPadding, displayWidth, graphemes, isTerminalReply } from "../text.js";
import { Header, WizardFrame, Row, textRows, padDisplay } from "./frame.js";
import { ListStep } from "./list.js";
import { t } from "../../i18n/index.js";

/** 字段形态；`open` = 按 Enter 进子屏（进的不一定是 key-value 子屏，故不叫 `map`） */
export type DetailFieldKind = "text" | "secret" | "number" | "enum" | "bool" | "open";

/** 详情屏的一个可编辑字段 */
export interface DetailField {
  key: string;
  label: string;
  kind: DetailFieldKind;
  /** 展示值（bool → "是"/"否"；enum → 当前选项 label；secret → 已掩码的串） */
  value: string;
  /** 进入编辑（text/secret/number）时的初值；缺省用 `value` */
  initial?: string;
  options?: { label: string; value: string }[];
  /**
   * 提交文本 / 枚举值：返回错误信息或 `null`（成功）。
   *
   * 同步校验直接返回字符串即可：字段构造器里大量「格式不对就报错」的判断本就没有
   * 异步动作，只为满足签名写成 `Promise.resolve(t(...))` 是纯噪音。
   */
  commit?: (raw: string) => string | null | Promise<string | null>;
  toggle?: () => string | null | Promise<string | null>;
  /** `open` 类型：按 Enter 进入子屏（键值编辑 / 权限 / 函数参数） */
  open?: () => void;
  /**
   * 只读行：把事实摆出来但不能改（`AgentView` 里没有提示词 / 函数定义的那几项就是这一类）。
   * Enter 不做事，键位提示也不说「编辑」。
   */
  readOnly?: boolean;
  /**
   * 写之前先出一次确认，即「二次确认要能先给代价、再真做」。
   *
   * `title` 是一句问话、`cost` 是要摆出来的那几行事实（影响面）。没有它就直接写 ——
   * 改一个名字、填一个 Base URL 不必每次问一遍。
   */
  confirm?: { title: string; cost: readonly string[] };
}

/** 详情屏底部的整体动作（如「删除」「恢复出厂设置」），危险动作以红色呈现并可二次确认 */
export interface DetailAction {
  label: string;
  run: () => Promise<string | null>;
  /** 危险动作（删除）：红色呈现。恢复出厂这类「重置」用它为 `false` */
  danger?: boolean;
  /**
   * 删之前的「代价」：删它会连累谁，即「删东西之前要说清还有谁指它」。
   *
   * 事实事前摆出来，不等宿主拒一次才知道 —— 宿主拒的那句话仍会照原样上屏，那是事后。
   * 每一行只写从手里已有的配置里数得出来的东西，数不出来就不给数字。
   */
  cost?: readonly string[];
}

export interface DetailStepProps {
  columns: number;
  rows: number;
  title: string;
  /** 标题下的说明行 */
  details?: string[];
  fields: DetailField[];
  notice?: string | null;
  /** 底部动作（如「恢复出厂设置」「删除」），按数组顺序排在字段之后 */
  actions?: DetailAction[];
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
export function DetailStep({
  columns,
  rows,
  title,
  details,
  fields,
  actions,
  notice,
  onBack,
}: DetailStepProps) {
  const { setCursorPosition } = useCursor();
  const rowCount = Math.max(1, fields.length + (actions?.length ?? 0));
  const [index, setIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  /** 待确认的动作在 `actions` 里的下标；`null` 表示没在确认 */
  const [confirming, setConfirming] = useState<number | null>(null);
  /** 待写的字段值（字段上带 `confirm` 时，先把值停在这里、屏上换确认）；`null` = 没在确认 */
  const [pendingWrite, setPendingWrite] = useState<string | null>(null);

  // 行数变化（如 Agent 详情 ↔ 权限子屏共用本组件）时收敛高亮索引，避免越界导致无高亮
  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, rowCount - 1)));
  }, [rowCount]);

  const labelWidth = Math.max(6, ...fields.map((f) => displayWidth(f.label)));
  const valueX = 2 + labelWidth + 2;
  const field = index < fields.length ? fields[index] : undefined;
  const currentAction = actions?.[index - fields.length];
  const onActionRow = Boolean(currentAction);

  const chars = graphemes(value);
  const caret = Math.max(0, Math.min(cursor, chars.length));
  const masked = field?.kind === "secret" && !revealed;

  const beginEdit = () => {
    if (!field || field.readOnly) return;
    const current = field.initial ?? field.value;
    setValue(current);
    setCursor(graphemes(current).length);
    setRevealed(false);
    setError(null);
    setEditing(true);
  };
  const update = (next: string, nextCursor: number) => {
    setValue(next);
    setCursor(nextCursor);
  };
  const insert = (text: string) =>
    update(
      chars.slice(0, caret).join("") + text + chars.slice(caret).join(""),
      caret + graphemes(text).length,
    );
  const deleteBefore = () => {
    if (caret === 0) return;
    update(chars.slice(0, caret - 1).join("") + chars.slice(caret).join(""), caret - 1);
  };
  const deleteAfter = () => {
    if (caret >= chars.length) return;
    update(chars.slice(0, caret).join("") + chars.slice(caret + 1).join(""), caret);
  };

  const apply = async (run: () => string | null | Promise<string | null>) => {
    setError(null);
    const failure = await run();
    if (failure) setError(failure);
  };

  /** 真的把那一次写发出去（字段确认之后的写进 messages） */
  const writeField = async (raw: string) => {
    setPendingWrite(null);
    if (!field?.commit) return;
    const failure = await field.commit(raw);
    if (failure) {
      setError(failure);
      return;
    }
    setEditing(false);
    setError(null);
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
    // 带 `confirm` 的字段：先把代价摆出来（这一次一个写请求都不发）
    if (field.confirm) {
      setPendingWrite(raw);
      return;
    }
    await writeField(raw);
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
        if (currentAction) {
          // 存的是 `actions` 里的相对下标：`index` 是「字段 + 动作」的整行下标
          setConfirming(index - fields.length);
          return;
        }
        if (!field) return;
        if (field.readOnly) return;
        if (field.kind === "bool") {
          if (field.toggle) void apply(field.toggle);
          return;
        }
        if (field.kind === "enum") {
          setChoosing(true);
          return;
        }
        if (field.kind === "open") {
          field.open?.();
          return;
        }
        beginEdit();
      }
    },
    { isActive: !choosing && confirming === null && pendingWrite === null },
  );

  const enumOptions = field?.options;
  if (choosing && field && enumOptions) {
    const target = field;
    return (
      <ListStep
        columns={columns}
        rows={rows}
        title={t("wiz.pickTitle", { label: target.label })}
        items={enumOptions.map((option) => ({
          label: option.label || t("common.empty"),
          value: option.value,
        }))}
        onPick={(picked) => {
          setChoosing(false);
          if (target.commit) void apply(() => target.commit!(picked));
        }}
        onCancel={() => setChoosing(false)}
      />
    );
  }

  if (pendingWrite !== null && field?.confirm) {
    const pending = pendingWrite;
    return (
      <ListStep
        columns={columns}
        rows={rows}
        title={field.confirm.title}
        subtitle={field.confirm.cost.join("\n")}
        items={[
          { label: t("common.yes"), value: "yes" },
          { label: t("common.no"), value: "no" },
        ]}
        onPick={(picked) => {
          if (picked === "yes") void writeField(pending);
          else {
            // 「否」：什么都不写，回到字段列表（草稿不进撤销栈，也没发过一次请求）
            setPendingWrite(null);
            setEditing(false);
            setError(null);
          }
        }}
        onCancel={() => setPendingWrite(null)}
      />
    );
  }

  const target = confirming === null ? undefined : actions?.[confirming];
  if (target) {
    return (
      <ListStep
        columns={columns}
        rows={rows}
        title={t("wiz.confirmTitle", { label: target.label })}
        // 代价排在「撤不回来」之后：先把影响面读一遍，再问要不要按下去
        subtitle={[t("wiz.irreversible", { title }), ...(target.cost ?? [])].join("\n")}
        items={[
          { label: t("wiz.confirmAction", { label: target.label }), value: "yes" },
          { label: t("ui.cancel"), value: "no" },
        ]}
        onPick={(picked) => {
          setConfirming(null);
          if (picked === "yes") void apply(target.run);
        }}
        onCancel={() => setConfirming(null)}
      />
    );
  }

  const headerRows: Row[] = [
    ...textRows(title, columns, theme.highlight, true),
    ...(details ?? []).flatMap((detail) => textRows(detail, columns, theme.dim)),
    ...(notice ? textRows(`✔ ${notice}`, columns, theme.ok) : []),
    ...(error ? textRows(`✖ ${error}`, columns, theme.error) : []),
  ];
  const contentLines = headerRows.length + 1 + fields.length + (actions?.length ?? 0) + 1;

  if (editing && field) {
    const shown = masked ? "•".repeat(chars.length) : value;
    const shownChars = graphemes(shown);
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
          ["Enter", t("ui.save")],
          ["Tab", t("ui.plainOrMasked")],
          ["Esc", t("ui.cancel")],
        ]
      : [
          ["Enter", t("ui.save")],
          ["Esc", t("ui.cancel")],
        ]
    : onActionRow
      ? [
          ["Enter", t("ui.run")],
          ["↑ ↓", t("ui.move")],
          ["Esc", t("ui.back")],
        ]
      : field?.readOnly
        ? [
            ["↑ ↓", t("ui.move")],
            ["Esc", t("ui.back")],
          ]
        : field?.kind === "bool"
          ? [
              ["Enter", t("ui.toggle")],
              ["↑ ↓", t("ui.move")],
              ["Esc", t("ui.back")],
            ]
          : field?.kind === "enum"
            ? [
                ["Enter", t("ui.select")],
                ["↑ ↓", t("ui.move")],
                ["Esc", t("ui.back")],
              ]
            : field?.kind === "open"
              ? [
                  ["Enter", t("ui.open")],
                  ["↑ ↓", t("ui.move")],
                  ["Esc", t("ui.back")],
                ]
              : [
                  ["Enter", t("ui.edit")],
                  ["↑ ↓", t("ui.move")],
                  ["Esc", t("ui.back")],
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
            const shownChars = graphemes(shown);
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
        {actions?.map((item, i) => {
          const selected = index === fields.length + i;
          return (
            <Text key={item.label} wrap="truncate">
              <Text color={selected ? theme.brand[0] : theme.faint}>{selected ? "❯ " : "  "}</Text>
              <Text bold={selected} color={item.danger ? theme.error : theme.assistant}>
                {padDisplay(item.label, labelWidth)}
              </Text>
            </Text>
          );
        })}
      </Box>
      <KeyHints hints={hints} />
    </WizardFrame>
  );
}
