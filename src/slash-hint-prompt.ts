/**
 * 对话输入提示 — 输入 `/` 时在输入行下方实时列出可用命令
 *
 * 实现方式：继承 inquirer 的 input 提示，仅覆写 `render`，把候选命令作为
 * 底栏（bottomContent）交给 inquirer 的 ScreenManager 渲染，从而复用其折行、
 * 终端缩放、擦除与光标归位处理，与其它提示的渲染行为保持一致。
 *
 * 设计边界：
 *   - 非 TTY（stdin/stdout 被重定向、e2e 脚本）不渲染提示，退化为普通输入行；
 *   - 仅作提示，不改变提交语义：回车始终提交当前输入原文，由
 *     `dispatchCommand` 按精确命令名分发（不做前缀补全、不做高亮选择）；
 *   - 普通聊天内容（非 `/` 开头）不产生任何提示。
 */

import chalk from "chalk";
import inquirer from "inquirer";
import InputPrompt from "inquirer/lib/prompts/input.js";
import {
  COMMAND_LABEL_WIDTH,
  matchCommandHints,
} from "./conversation-commands/registry.js";

/** 注册到 inquirer 的自定义提示类型名 */
export const SLASH_HINT_PROMPT_TYPE = "conversationInput";

/** 无匹配命令时的提示文案 */
const NO_MATCH_HINT = "无匹配命令（输入 /help 查看全部）";

/**
 * 生成命令提示底栏文本（纯函数，便于单测）
 * @param line 当前输入行；非 `/` 开头一律返回空串
 */
export function renderCommandHint(line: string): string {
  if (!line.startsWith("/")) return "";

  const hints = matchCommandHints(line.slice(1));
  if (hints.length === 0) return "  " + chalk.gray(NO_MATCH_HINT);

  return hints
    .map(
      (hint) =>
        `  ${chalk.cyan(hint.label.padEnd(COMMAND_LABEL_WIDTH))}${chalk.gray(hint.description)}`,
    )
    .join("\n");
}

/**
 * 带命令提示的对话输入提示
 *
 * `render` 为 inquirer@9 `lib/prompts/input.js#render` 的等价实现，差异仅在于
 * 额外注入命令提示底栏；升级 inquirer 主版本时需比对上游实现（见
 * `src/typings/inquirer-internals.d.ts` 的说明）。
 *
 * 导出仅为注册（`registerSlashHintPrompt`）与单测使用，业务侧请使用 `askInput`。
 */
export class SlashHintPrompt extends InputPrompt {
  render(error?: string): void {
    const isFinal = this.status === "answered";
    const appendContent = isFinal ? this.answer : this.rl.line;
    const { transformer } = this.opt;

    let message = this.getQuestion();
    message += transformer
      ? transformer(appendContent, this.answers, { isFinal })
      : isFinal
        ? chalk.cyan(appendContent)
        : appendContent;

    // 底栏：命令提示（仅真实终端、且尚未提交时渲染）
    let bottomContent =
      !isFinal && process.stdout.isTTY ? renderCommandHint(this.rl.line) : "";

    if (error) {
      const errorLine = chalk.red(">> ") + error;
      bottomContent = bottomContent
        ? `${bottomContent}\n${errorLine}`
        : errorLine;
    }

    this.screen.render(message, bottomContent);
  }
}

/** 是否已注册（避免重复注册同一提示类型） */
let registered = false;

/** 注册自定义提示类型（幂等） */
export function registerSlashHintPrompt(): void {
  if (registered) return;
  inquirer.registerPrompt(SLASH_HINT_PROMPT_TYPE, SlashHintPrompt);
  registered = true;
}

/**
 * 读取一行对话输入
 * @returns 去除首尾空白后的输入内容（用户直接回车时为空串）
 */
export async function askInput(): Promise<string> {
  registerSlashHintPrompt();

  const { question } = await inquirer.prompt<{ question: string }>([
    {
      type: SLASH_HINT_PROMPT_TYPE,
      name: "question",
      message: chalk.cyan("你:"),
      prefix: "💬",
    },
  ]);

  return (question ?? "").trim();
}
