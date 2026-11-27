/**
 * 把「显示光标」这一个序列拦在**写终端那一层**
 *
 * ## 为什么要拦
 *
 * Ink 每帧重画都先发 `?25l` 隐藏光标、画完再发 `?25h` 显示（`log-update.js` 的
 * `buildReturnToBottomPrefix` 带前者，`buildCursorSuffix` 带后者）。流式回答按 60ms 一帧，
 * 终端每秒因此收到十几对序列：光标表现为高频频闪（终端自己的 blink 节拍被反复重置），
 * 或者在隐藏的那一帧真的消失。
 *
 * Ink 没有开关能关掉这件事 —— 能管它的 `showCursor` 只活在 `logUpdate.create()` 的内部参数里，
 * `render()` 没往外给；而「这一帧不报位置」在它那儿等于「把光标藏起来」，那样连输入法的锚点
 * 一起丢了（不再发 `cursorTo`，终端光标停在这一帧写到的末尾）。
 *
 * ## 拦的是什么、为什么这样拦得住
 *
 * 拦截对象只有 `?25h`（显示）。位置序列（`cursorUp` / `cursorTo`）一个字节都不动，所以**终端
 * 光标的位置仍在逐帧更新**，输入法候选框跟着那个位置走；差别是那个方块不再被画出来。
 * 终端因此既没有「显/隐」的状态变化，也没有中途消失的那一帧：流式期间零 toggle。
 *
 * 代价是屏上看不到光标本体：草稿非空时有 `CursorInputRow` 自绘的逆显块，占位态（空输入）
 * 则什么都没有。这两件事出自同一个决定 —— 看得见的光标，代价是每帧一次 toggle。
 *
 * ## 退出时要还回去
 *
 * 这里只作用于**交给 Ink 的那条流**。`farewell()` 与信号兜底写的是 `process.stdout` 本身，
 * 那两处照旧发 `?25h` —— 回到 shell 时光标仍然可见。
 */

/** 显示光标（DECTCEM 开）：被拦掉的只有这一个序列 */
const SHOW_CURSOR = "\u001b[?25h";

/** 一条「能写」的流：够 Ink 用，也够用例替身用 */
export interface WritableStream {
  write(chunk: unknown, ...rest: unknown[]): boolean;
}

/** 从一段写往终端的文本里去掉「显示光标」序列（别的字节一个不动） */
export function stripCursorShow(text: string): string {
  return text.includes(SHOW_CURSOR) ? text.split(SHOW_CURSOR).join("") : text;
}

/**
 * 交一条「不显示光标」的流给 Ink：写入照旧，只把 `?25h` 滤掉。
 *
 * 其余一切原样透传 —— `columns` / `rows` / `isTTY` 是 Ink 判交互模式与排版用的，`on('resize')`
 * 是它挂尺寸变化用的；方法绑回**真流**：经代理调用时 `this` 否则会变成代理，Node 的流方法
 * 读到的内部字段全是空的。
 *
 * 不做「跨 chunk 的半截序列」兜底：Ink 每帧把整段帧（含首尾两个序列）拼成**一次** `write`，
 * 序列不会被切开；为一个不会出现的处境加一个有状态的缓冲，只会让这条链路多一处会挂住的地方。
 */
export function quietCursor<T extends WritableStream>(stream: T): T {
  return new Proxy(stream, {
    get(target, property) {
      if (property === "write") {
        return (chunk: unknown, ...rest: unknown[]): boolean =>
          typeof chunk === "string"
            ? target.write(stripCursorShow(chunk), ...rest)
            : target.write(chunk, ...rest);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as T;
}
