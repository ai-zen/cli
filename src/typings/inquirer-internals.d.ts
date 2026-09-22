/**
 * inquirer 内部模块的最小类型声明
 *
 * 背景：`src/slash-hint-prompt.ts` 通过继承 inquirer 的 input 提示类来实现
 * 「输入 / 时在输入行下方列出候选命令」——inquirer 9 未导出 BasePrompt /
 * InputPrompt，只能深层导入其内部路径（inquirer@9 的 package.json 无
 * `exports` 字段，故 ESM 深层导入可用，已在 Node 26 + inquirer 9.3.8 下实测）。
 *
 * 约束：仅声明本项目实际用到的成员；**升级 inquirer 主版本时需回归验证**
 * 该模块路径、`render` 行为与 `ScreenManager` 的底栏（bottomContent）渲染。
 */

declare module "inquirer/lib/prompts/input.js" {
  import type { Interface } from "node:readline";

  /** inquirer 提示选项（仅列出本项目用到的字段） */
  export interface InputPromptOptions {
    name: string;
    message?: string;
    prefix?: string;
    suffix?: string;
    default?: string;
    transformer?: (
      value: string,
      answers: Record<string, unknown>,
      flags: { isFinal: boolean },
    ) => string;
    [key: string]: unknown;
  }

  /** inquirer 屏幕管理器（仅声明本项目用到的能力） */
  export interface PromptScreen {
    /** 渲染提示行与其下方的底栏内容 */
    render(content: string, bottomContent?: string): void;
  }

  export default class InputPrompt {
    constructor(
      question: InputPromptOptions,
      rl: Interface,
      answers: Record<string, unknown>,
    );

    /** 归一化后的提示选项 */
    readonly opt: InputPromptOptions;
    /** readline 实例（由 inquirer 注入） */
    rl: Interface;
    /** 已收集的答案 */
    answers: Record<string, unknown>;
    /** 屏幕管理器（负责折行、缩放、擦除与光标归位） */
    screen: PromptScreen;
    /** 提示状态：pending / touched / answered */
    status: string;
    /** 提交后的答案 */
    answer: string;

    /** 组装提示行（前缀 + 消息 + 默认值） */
    getQuestion(): string;
    /** 渲染提示行，`error` 非空时在底栏追加错误行 */
    render(error?: string): void;
    /** 启动提示会话 */
    run(): Promise<string>;
  }
}
