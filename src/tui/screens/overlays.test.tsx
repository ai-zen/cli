// 选择浮层的按键语义。
//
// 只测一件在生产里真的出过事的事：浮层弹出期间，`Chat` 的两个主输入处理器都
// 因为 `isActive` 带 `!pickerState` 而失活 —— 浮层自己若只认 Esc，那习惯按 Ctrl+C
// 的人在这段等待里就完全按不动（交接 / 迁移要先选执行者，正是最容易以为卡死的地方）。
import { beforeEach, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { setLocale } from "../../i18n/index.js";
import { FormOverlay, PickerOverlay } from "./overlays.js";

/**
 * 等到 `check()` 成立就返回；超时抛错，错误里说清等的是什么。
 *
 * **别用「睡够多少毫秒」代替它**：那是赌「够久」，而这里要的是「真的发生了」。上限 1000ms
 * 是**失败上限**，不是等待时长。
 */
const until = async (check: () => boolean, what: string, timeoutMs = 1000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`等不到：${what}（上限 ${timeoutMs}ms）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/**
 * 让出几拍宏任务 —— 让这一拍里**排在后面**的活先跑完。让的是执行顺序，不是一个时长。
 *
 * 为什么敲键之前要它：帧是在 commit 里画的，而 `useInput` 的订阅落在 passive effect 里，
 * 同一拍里排在画帧**之后**（React 的 Scheduler 在 Node 下走 `setImmediate`）。所以「帧里已经
 * 有浮层」还不等于「按键有人接」：这一刻塞进去的键会被直接**丢掉**，之后再睡多久都没用。
 */
const settle = async (turns = 2) => {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

function mount() {
  const picked: (string | null)[] = [];
  const { stdin, lastFrame, unmount } = render(
    <PickerOverlay
      title="选一个"
      items={[
        { label: "A", value: "a" },
        { label: "B", value: "b" },
      ]}
      columns={80}
      maxRows={10}
      onPick={(value) => picked.push(value)}
    />,
  );
  return { picked, stdin, frame: () => lastFrame() ?? "", unmount };
}

/** 浮层画出来、并且「按键有人接」的状态 —— 敲任何键之前都要先到这个状态 */
async function mounted() {
  const p = mount();
  await until(() => p.frame().includes("选一个"), "选择浮层画出来");
  await settle();
  return p;
}

describe("PickerOverlay", () => {
  it("Esc 取消：结算 null", async () => {
    const p = await mounted();
    p.stdin.write("\u001b");
    // 单键 Esc 要等 ink 自己的序列判定（~20ms）才认成 Esc —— 等它认，不猜它多久
    await until(() => p.picked.length > 0, "Esc 被结算成取消");
    expect(p.picked).toEqual([null]);
    p.unmount();
  });

  it("Ctrl+C 与 Esc 同义：结算 null（否则选择阶段无法中断）", async () => {
    const p = await mounted();
    p.stdin.write("\u0003");
    await until(() => p.picked.length > 0, "Ctrl+C 被结算成取消");
    expect(p.picked).toEqual([null]);
    p.unmount();
  });

  it("回车选中高亮项（Ctrl+C 不误伤正常选择）", async () => {
    const p = await mounted();
    p.stdin.write("\r");
    await until(() => p.picked.length > 0, "回车被结算成选中");
    expect(p.picked).toEqual(["a"]);
    p.unmount();
  });

  /**
   * 标题**折行**而不是裁切。
   *
   * 破坏性动作之前那一问（`/shutdown`、`/upgrade`、`/delete`）说的就是代价：裁掉后半截等于
   * 少说一个事实，而「同机其他客户端也会断开」正好落在后半截。这里用一条长到装不下的标题，
   * 钉住末尾那一段真的画出来了。
   */
  it("长标题折行：末尾那一段不被裁掉", async () => {
    const tail = "TAIL";
    const { lastFrame, unmount } = render(
      <PickerOverlay
        title={`${"前提。".repeat(30)} ${tail}`}
        items={[{ label: "A", value: "a" }]}
        columns={80}
        maxRows={10}
        onPick={() => {}}
      />,
    );

    await until(() => (lastFrame() ?? "").includes(tail), "长标题的末尾画出来了");
    unmount();
  });
});

// ==================== 表单浮层 ====================

/**
 * 表单浮层的按键语义（规矩本身在 `form-fields.test.ts` 里，纯函数那侧）。
 *
 * 这里只钉「面板这一层」的三件事：字能敲进去并提交成内容、Esc 交 cancel、校验没过**不关面板**
 * 且焦点跳到那一格。
 */
function mountForm() {
  const answers: { action: string; content?: Record<string, unknown> }[] = [];
  let cancelled = 0;
  const { stdin, lastFrame, unmount } = render(
    <FormOverlay
      title="填一下"
      schema={{
        type: "object",
        properties: {
          name: { type: "string", title: "名字" },
          flag: { type: "boolean", title: "开关" },
          tags: { type: "array", title: "标签", items: { type: "string", enum: ["a", "b"] } },
        },
        required: ["name"],
      }}
      onAnswer={(answer) => answers.push(answer)}
      onCancel={() => {
        cancelled += 1;
      }}
    />,
  );
  return { answers, cancelled: () => cancelled, stdin, frame: () => lastFrame() ?? "", unmount };
}

async function mountedForm() {
  const p = mountForm();
  await until(() => p.frame().includes("填一下"), "表单浮层画出来");
  await settle();
  return p;
}

/** 敲一个键，再等它被 ink 的序列判定吃掉（连续写方向键时会被合并成一条） */
async function key(form: { stdin: { write: (data: string) => void } }, data: string) {
  form.stdin.write(data);
  await new Promise((resolve) => setTimeout(resolve, 40));
}

describe("FormOverlay", () => {
  // 提交项与空值那两句是文案（走 `t`）：这里按中文断言
  beforeEach(() => setLocale("zh"));

  it("文本直接就能敲；枚举要回车展开；最后落到提交项回车交卷", async () => {
    const form = await mountedForm();

    // 焦点在「名字」上，直接敲 —— 不必先按回车进什么编辑态
    await key(form, "a");
    await key(form, "b");
    await until(() => form.frame().includes("ab"), "字上了屏");
    expect(form.frame()).toContain("▏");

    // ↓ 到开关、再 ↓ 到标签（枚举）：回车把候选展开
    await key(form, "\u001b[B");
    await key(form, "\u001b[B");
    await key(form, "\r");
    await until(() => form.frame().includes("[ ] a"), "候选展开了");

    // ↓ 移项光标到 b，空格勾上，回车收起
    await key(form, "\u001b[B");
    await key(form, " ");
    await until(() => form.frame().includes("[x] b"), "多选勾上了 b");
    await key(form, "\r");

    // 落到提交项，回车交卷
    await key(form, "\u001b[B");
    // 焦点不再占字符：提交那一行还在，靠颜色与加粗说（这里只断言它被画出来了）
    await until(() => form.frame().includes("[提交]"), "焦点落到提交项");
    await key(form, "\r");
    await until(() => form.answers.length === 1, "提交了一次");
    expect(form.answers[0]).toEqual({
      action: "accept",
      content: { name: "ab", flag: false, tags: ["b"] },
    });
    form.unmount();
  });

  it("必填没填就交卷：不关面板，焦点跳到那一格并在下面说清为什么", async () => {
    const form = await mountedForm();

    for (let step = 0; step < 3; step += 1) await key(form, "\u001b[B");
    await key(form, "\r");

    await until(() => form.frame().includes("必填"), "错误那一行画出来");
    expect(form.answers).toEqual([]);
    form.unmount();
  });

  it("Esc 交 cancel（不是替用户填一份）", async () => {
    const form = await mountedForm();

    await key(form, "\u001b");
    await until(() => form.cancelled() === 1, "取消了一次");
    expect(form.answers).toEqual([]);
    form.unmount();
  });

  it("布尔回车/空格都能直接切（不用展开）", async () => {
    const form = await mountedForm();

    await key(form, "\u001b[B"); // ↓ 到开关
    await key(form, "\r");
    await until(() => form.frame().includes("[x]"), "布尔被勾上");
    await key(form, " ");
    await until(() => form.frame().includes("[ ]"), "空格又切回去");

    form.unmount();
  });
});

/**
 * 提示行：只印此刻真的能按的键。
 *
 * 这一条是被真机上的噪声逼出来的：编辑文本时提示里还挂着「空格勾选」，而那时按空格什么都不做。
 */
describe("FormOverlay：提示行", () => {
  beforeEach(() => setLocale("zh"));

  /** 一张有文本、布尔、多选的表（三项，走浏览层那套） */
  function mountThree() {
    const { stdin, lastFrame, unmount } = render(
      <FormOverlay
        title="提示"
        schema={{
          type: "object",
          properties: {
            name: { type: "string", title: "名字" },
            flag: { type: "boolean", title: "开关" },
            tags: { type: "array", title: "标签", items: { type: "string", enum: ["a", "b"] } },
          },
        }}
        onAnswer={() => {}}
        onCancel={() => {}}
      />,
    );
    return { stdin, frame: () => lastFrame() ?? "", unmount };
  }

  it("编辑文本时不印「空格勾选」；编辑多选时才印", async () => {
    const form = mountThree();
    await until(() => form.frame().includes("提示"), "面板画出来");
    await settle();

    // 焦点在文本上：没有空格提示，也没有「换选项」
    const onText = form.frame();
    expect(onText).toContain("Enter");
    expect(onText).not.toContain("Space");
    expect(onText).not.toContain("选项");

    // ↓ 到开关：布尔才有空格
    await key(form, "\u001b[B");
    await until(() => form.frame().includes("Space"), "布尔上的提示里有空格");

    // ↓ 到标签、回车展开：多选既有空格也有换选项
    await key(form, "\u001b[B");
    await key(form, "\r");
    await until(() => form.frame().includes("选项"), "展开后才有换选项");
    expect(form.frame()).toContain("Space");
    form.unmount();
  });

  it("浏览层停在布尔上才印「空格勾选」", async () => {
    const form = mountThree();
    await until(() => form.frame().includes("提示"), "面板画出来");
    await settle();

    // 第一格是文本：没有空格提示
    expect(form.frame()).not.toContain("Space");

    await key(form, "\u001b[B"); // ↓ 到开关
    await until(() => form.frame().includes("Space"), "布尔上的提示里有空格");
    form.unmount();
  });
});
