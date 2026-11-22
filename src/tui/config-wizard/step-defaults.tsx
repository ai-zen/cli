// 默认项子菜单 / 选择默认值（一次改动一次调用：`config.setDefaults` | `config.setGlobal`）
import { ReactNode } from "react";
import { SelectItem } from "../components.js";
import { endpointKeyState, findEndpoint, findModel } from "../../config-editor.js";
import { topLevelAgents } from "../../agents-store.js";
import type { AppConfig } from "../../config.js";
import { DefaultTarget } from "./types.js";
import { WizardContext } from "./engine.js";
import { ListStep } from "./list.js";
import { t } from "../../i18n/index.js";

/** 中断修复策略的展示名（值本身是 core 的口径，文案在词典里） */
function strategyLabel(value: string): string {
  if (value === "keep") return t("wiz.strategy.keep");
  if (value === "drop") return t("wiz.strategy.drop");
  if (value === "fill") return t("wiz.strategy.fill");
  return value;
}

/**
 * 配置里没写这两格时屏上用的值。
 *
 * 就是出厂值：SDK 的 `DEFAULT_APP_CONFIG.abortedMessageStrategy`（`keep`）与
 * `abortedToolRoundStrategy`（`fill`）。缺格或值非法的配置由同包的 `normalizeConfig` 补成这两个，
 * 所以屏上说的与真正生效的是同一个词；写回时也照这两个之一提交，不存在第三态。
 */
const FALLBACK_MESSAGE_STRATEGY = "keep";
const FALLBACK_TOOL_ROUND_STRATEGY = "fill";

/** 自动命名开关的两档（屏上的值；写进契约时变成布尔） */
const AUTO_TITLE_ON = "on";
const AUTO_TITLE_OFF = "off";

/** 中断策略两项与自动命名开关都是「固定几档」，没有「不设置」那一档 */
function isFixed(target: DefaultTarget): boolean {
  return (
    target === "abortedMessageStrategy" ||
    target === "abortedToolRoundStrategy" ||
    target === "autoTitle"
  );
}

/** 开关的一档 → 屏上那个词 */
function autoTitleLabel(value: string): string {
  return value === AUTO_TITLE_ON ? t("wiz.defaults.autoTitleOn") : t("wiz.defaults.autoTitleOff");
}

/**
 * 配置里这一格现在是哪一档。
 *
 * 没写这一格按开着算（宿主的 `AutoNamer` 也是这个口径），所以只有显式的 `false` 是关。
 */
function autoTitleWord(config: AppConfig): string {
  return autoTitleLabel(config.autoTitle === false ? AUTO_TITLE_OFF : AUTO_TITLE_ON);
}

/** 目标项的显示名 */
function labelOf(target: DefaultTarget): string {
  if (target === "defaultAgent") return t("wiz.defaults.agent");
  if (target === "defaultModel") return t("wiz.defaults.fallbackModel");
  if (target === "defaultMigrationModel") return t("wiz.defaults.migrationModel");
  if (target === "defaultImageModel") return t("wiz.defaults.imageModel");
  if (target === "namingModel") return t("wiz.defaults.namingModel");
  if (target === "abortedMessageStrategy") return t("wiz.defaults.strategyMessage");
  if (target === "abortedToolRoundStrategy") return t("wiz.defaults.strategyToolRound");
  return t("wiz.defaults.autoTitle");
}

/** 值 → 屏上那句摘要里用的显示名 */
function valueLabel(target: DefaultTarget, value: string): string {
  if (!value) return t("common.unsetPlain");
  if (target === "defaultAgent") return value;
  if (target === "abortedMessageStrategy" || target === "abortedToolRoundStrategy") {
    return strategyLabel(value);
  }
  if (target === "autoTitle") return autoTitleLabel(value);
  return value;
}

export function renderDefaultsStep(ctx: WizardContext): ReactNode {
  const { config, agents, error, activeStep, go, setDefaults, setGlobal, setError, cols, rows } =
    ctx;

  // ---------- 默认项子菜单 ----------
  if (activeStep.kind === "defaults") {
    const unset = t("common.unsetPlain");
    const defaultImage = (config.imageModels ?? []).find(
      (model) => model.id === config.defaultImageModel,
    );
    const items: SelectItem<DefaultTarget>[] = [
      {
        label: t("wiz.defaults.agent"),
        value: "defaultAgent",
        hint:
          agents.agents.find((agent) => agent.id === config.defaultAgent)?.name ??
          config.defaultAgent ??
          unset,
      },
      {
        label: t("wiz.defaults.fallbackModel"),
        value: "defaultModel",
        hint: findModel(config, config.defaultModel)?.name ?? config.defaultModel ?? unset,
      },
      {
        label: t("wiz.defaults.migrationModel"),
        value: "defaultMigrationModel",
        hint:
          findModel(config, config.defaultMigrationModel)?.name ??
          config.defaultMigrationModel ??
          unset,
      },
      {
        label: t("wiz.defaults.imageModel"),
        value: "defaultImageModel",
        hint: defaultImage?.name ?? config.defaultImageModel ?? unset,
      },
      {
        label: t("wiz.defaults.namingModel"),
        value: "namingModel",
        hint: findModel(config, config.namingModel)?.name ?? config.namingModel ?? unset,
      },
      {
        label: t("wiz.defaults.strategyMessage"),
        value: "abortedMessageStrategy",
        hint: strategyLabel(config.abortedMessageStrategy ?? FALLBACK_MESSAGE_STRATEGY),
      },
      {
        label: t("wiz.defaults.strategyToolRound"),
        value: "abortedToolRoundStrategy",
        hint: strategyLabel(config.abortedToolRoundStrategy ?? FALLBACK_TOOL_ROUND_STRATEGY),
      },
      {
        label: t("wiz.defaults.autoTitle"),
        value: "autoTitle",
        hint: autoTitleWord(config),
      },
    ];
    return (
      <ListStep
        columns={cols}
        rows={rows}
        title={t("wiz.defaults.title")}
        subtitle={t("wiz.defaults.subtitle")}
        warning={error ?? undefined}
        items={items}
        onPick={(target) => go({ kind: "pick-default", target })}
        onCancel={() => go({ kind: "menu" })}
      />
    );
  }

  // ---------- 选择某个默认项的值 ----------
  if (activeStep.kind === "pick-default") {
    const target = activeStep.target;
    const fixed = isFixed(target);
    /** 当前值打上「（当前）」标记；`value` 仍是写入用的那个字符串 */
    const mark = (value: string, current: string, label: string) =>
      `${label}${value === current ? t("common.current") : ""}`;
    const modelItems: SelectItem<string>[] = config.models.map((model) => {
      const key = endpointKeyState(config, model);
      return {
        label: model.name || model.id,
        value: model.id,
        hint: t("wiz.defaults.itemHint", {
          endpoint:
            key.endpointName ?? findEndpoint(config, model.endpointId)?.name ?? model.endpointId,
          state: key.ready ? t("wiz.defaults.keyReady") : t("wiz.defaults.missingKey"),
        }),
      };
    });

    let items: SelectItem<string>[] = [];
    if (target === "abortedMessageStrategy") {
      const current = config.abortedMessageStrategy ?? FALLBACK_MESSAGE_STRATEGY;
      items = (["keep", "drop"] as const).map((value) => ({
        label: mark(value, current, strategyLabel(value)),
        value,
        hint: value === "keep" ? t("wiz.strategy.keepHint") : t("wiz.strategy.dropHint"),
      }));
    } else if (target === "abortedToolRoundStrategy") {
      const current = config.abortedToolRoundStrategy ?? FALLBACK_TOOL_ROUND_STRATEGY;
      items = (["fill", "drop"] as const).map((value) => ({
        label: mark(value, current, strategyLabel(value)),
        value,
        hint: value === "fill" ? t("wiz.strategy.fillHint") : t("wiz.strategy.toolDropHint"),
      }));
    } else if (target === "autoTitle") {
      const current = config.autoTitle === false ? AUTO_TITLE_OFF : AUTO_TITLE_ON;
      items = ([AUTO_TITLE_ON, AUTO_TITLE_OFF] as const).map((value) => ({
        label: mark(value, current, autoTitleLabel(value)),
        value,
        hint:
          value === AUTO_TITLE_ON
            ? t("wiz.defaults.autoTitleOnHint")
            : t("wiz.defaults.autoTitleOffHint"),
      }));
    } else if (target === "defaultImageModel") {
      items = (config.imageModels ?? []).map((model) => ({
        label: model.name || model.id,
        value: model.id,
        hint: findEndpoint(config, model.endpointId)?.name ?? model.endpointId,
      }));
    } else if (target === "defaultAgent") {
      // 默认助手是入口：子 Agent 不是入口（宿主用 `function` 在不在明说了这件事）
      items = topLevelAgents(agents).map((agent) => ({
        label: agent.name || agent.id,
        value: agent.id,
        hint: t("wiz.defaults.agentHint", { id: agent.id }),
      }));
    } else {
      // 兜底模型 / 迁移模型 / 取名模型：同一个模型清单
      items = modelItems;
    }
    // id 型默认值可以「不设置」（`null` = 清掉这一项）
    if (!fixed) items = [...items, { label: t("common.unset"), value: "" }];

    /** 一个目标项的一次写入（id 型走 `setDefaults`，策略走 `setGlobal`） */
    const commit = (value: string): Promise<string | null> => {
      const shown = valueLabel(target, value);
      const message = t("wiz.defaults.updated", { label: labelOf(target), value: shown });
      if (target === "abortedMessageStrategy") {
        return setGlobal(
          { abortedMessageStrategy: value as AppConfig["abortedMessageStrategy"] },
          message,
        );
      }
      if (target === "abortedToolRoundStrategy") {
        return setGlobal(
          { abortedToolRoundStrategy: value as AppConfig["abortedToolRoundStrategy"] },
          message,
        );
      }
      if (target === "autoTitle") return setGlobal({ autoTitle: value === AUTO_TITLE_ON }, message);
      // 剩下五个都是 id 型默认项：空串 = 清掉这一项（契约里 `null` 就是清空）
      const chosen = value || null;
      if (target === "defaultAgent") return setDefaults({ defaultAgent: chosen }, message);
      if (target === "defaultModel") return setDefaults({ defaultModel: chosen }, message);
      if (target === "defaultMigrationModel") {
        return setDefaults({ defaultMigrationModel: chosen }, message);
      }
      if (target === "defaultImageModel")
        return setDefaults({ defaultImageModel: chosen }, message);
      return setDefaults({ namingModel: chosen }, message);
    };

    return (
      <ListStep
        columns={cols}
        rows={rows}
        title={labelOf(target)}
        subtitle={
          target === "autoTitle"
            ? t("wiz.defaults.autoTitleSubtitle")
            : fixed
              ? t("wiz.defaults.strategySubtitle")
              : t("wiz.defaults.pickSubtitle")
        }
        warning={error ?? undefined}
        items={items}
        onPick={(value) => {
          void (async () => {
            const failure = await commit(value);
            // 写失败留在本屏：宿主的句子摆在这一屏的 warning 行上
            if (failure) setError(failure);
            else go({ kind: "defaults" });
          })();
        }}
        onCancel={() => go({ kind: "defaults" })}
      />
    );
  }

  return null;
}
