/**
 * 粘贴：**括号粘贴**（bracketed paste）的收发 + 文本归一。
 *
 * ## 为什么需要它
 *
 * 终端默认把粘贴进来的东西当**键盘输入**原样吐给应用：多行文本里的每个 `\r` 都会被 Ink 解析成
 * 一次回车（`key.return`），于是粘贴三段话就变成「发出第一行 + 把剩下的当按键处理」；窗口宽、
 * 换行符（Windows 剪贴板是 `\r\n`）、制表符与零散控制字符也会原样进到草稿里 —— 输入框按 `\n`
 * 折行，`\r` 留在行尾，回显看起来就是「错位 / 少字 / 光标跳」。
 *
 * 括号粘贴是终端侧的解决办法：应用先发 `CSI ? 2004 h` 声明「我认得，请把粘贴包起来」，终端于是
 * 用 `CSI 200 ~ … CSI 201 ~` 把整段包住。认出这一对标记之后，里面的内容就是**一段文本**，
 * 不再逐段当按键解释。
 *
 * ## 两条形状都要认
 *
 * 实测（与 `mouse.ts` 文件头记的是同一件事）：Ink 会去掉序列**开头的 ESC**，`useInput` 的
 * `char` 拿到的是 `[<64;10;5M`、`[200~` 这种去掉 ESC 的样子；但整段一起到达时也可能带着 ESC。
 * 两种都收。
 *
 * ## 归一（{@link normalizePastedText}）
 *
 *   - `\r\n` 与单独的 `\r` → `\n`（草稿按 `\n` 折行）；
 *   - 去掉其余 C0 控制字符（`\t` 留着：它是文本里的缩进，默认宽度计 1 列、不破坏折行）；
 *   - 去掉末尾的换行：剪贴板与终端选区几乎总带一个尾换行，留着会让光标多跳一行。
 *
 * 纯逻辑、不依赖 React / ink，可独立单测。
 */

/** 开启括号粘贴的上报（与 `mouse.ts` 的 `MOUSE_ENABLE` 同一处下发） */
export const PASTE_ENABLE = "\u001b[?2004h";
/** 关闭。每条退出路径都下发一次，否则 shell 里的粘贴会继续被包着 */
export const PASTE_DISABLE = "\u001b[?2004l";

/**
 * 开启括号粘贴上报（与 `mouse.ts` 的 `enableMouseTracking` 同一处下发：每个 Ink 实例起来时）。
 *
 * 不开也「能用」—— 粘贴会被当按键逐字符吐进来，多行就散成了回车；开了之后终端才会把整段包起来。
 */
export function enableBracketedPaste(stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(PASTE_ENABLE);
}

/** 关闭（幂等）。退出 / 信号 / 异常路径各调用一次，否则 shell 里的粘贴会继续被包着 */
export function disableBracketedPaste(stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(PASTE_DISABLE);
}

/** 起始 / 结束标记的「内容部分」：Ink 可能把 ESC 吃掉，只交出这一段 */
const PASTE_START = "[200~";
const PASTE_END = "[201~";

/** 这一段里有没有粘贴起始标记；有则返回标记之后的那一截（没有就是 `null`） */
function afterStart(chunk: string): string | null {
  const at = chunk.indexOf(PASTE_START);
  return at === -1 ? null : chunk.slice(at + PASTE_START.length);
}

/**
 * 把一段粘贴进来的文本归一成草稿认得的样子（规则见文件头）。
 *
 * 只作用于**粘贴**：手工敲的字一个都不经过它（也没有需要归一的东西）。
 */
export function normalizePastedText(raw: string): string {
  return (
    raw
      // 两种换行都收成 `\n`
      .replace(/\r\n?/g, "\n")
      // 其余 C0（保留 `\n` 与 `\t`）：ESC / BEL / 退格之类进了草稿只会把回显弄乱
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      // 尾换行不留：粘贴几乎总带一个
      .replace(/\n+$/, "")
  );
}

/** 一次 `feed` 的结局 */
export type PasteFeed =
  /** 这段不是粘贴（照常当按键 / 打字处理） */
  | { kind: "none" }
  /** 粘贴还没结束（这一段已经收下，等后续的块） */
  | { kind: "pending" }
  /** 收完了：`text` 是归一后的整段（可能是空串 —— 粘了个空的） */
  | { kind: "text"; text: string };

/**
 * 括号粘贴的**拼装器**：一段粘贴可能被拆成好几块（终端按缓冲区分片写），
 * 这里负责把它们拼回去，并在结束标记处一次交出整段。
 *
 * 用法（每一块输入调用一次 `feed`）：
 *
 * ```ts
 * const feed = assembler.feed(char);
 * if (feed.kind === "pending") return;                      // 还在收
 * if (feed.kind === "text") return typeIntoDraft(feed.text); // 一次插入整段
 * // kind === "none" → 照常按键处理
 * ```
 *
 * 结束标记之后还有内容（一次粘贴后面紧跟打字）时忽略：那是下一次输入的事，不该塞进这一段。
 */
export class PasteAssembler {
  /** 正在收的那一段（`null` = 没在收）；空串表示「标记已经出现了，内容还没到」 */
  private buffer: string | null = null;

  /** 是否正在收一段粘贴（用例与调试用） */
  get collecting(): boolean {
    return this.buffer !== null;
  }

  feed(chunk: string): PasteFeed {
    // ① 已经在收：把这一块并进去，找结束标记
    if (this.buffer !== null) {
      const joined = this.buffer + chunk;
      return this.close(joined);
    }

    // ② 新的开始：标记前面可能还跟着别的东西（极少见），取标记之后的部分
    const started = afterStart(chunk);
    if (started !== null) return this.close(started);

    return { kind: "none" };
  }

  /** 找到结束标记就交出整段，否则把这部分留在缓冲里 */
  private close(payload: string): PasteFeed {
    const end = payload.indexOf(PASTE_END);
    if (end === -1) {
      this.buffer = payload;
      return { kind: "pending" };
    }
    this.buffer = null;
    return { kind: "text", text: normalizePastedText(payload.slice(0, end)) };
  }
}
