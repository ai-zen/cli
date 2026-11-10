/**
 * 生成过程的 token 速率统计 —— 纯逻辑，不依赖 React / Ink / SDK
 *
 * 需求是「每秒接收多少 token」，而 SDK 只在**每个请求的最后一个 chunk** 才给出
 * `usage`（`stream_options.include_usage`），拿不到逐 token 的用量。所以这里分两路：
 *
 *   - **实时速率**：按增量字符估算 token，用 2 秒滑动窗口算（`live`）。它必须靠估算，
 *     否则要等一整轮结束才有数字，就谈不上「实时」；
 *   - **本轮平均**：一轮结束时优先用真实 `completion_tokens`（累加多轮工具调用），
 *     除以「首字 → 末字」的时间跨度（`average`）。这段时间不含开头的等待首字。
 *
 * 两者口径不同，展示上也分开（生成中显示实时，结束后显示本轮平均）——把估算值
 * 和精确值混成一个数字才是真的误导。
 */

/** 实时速率的滑动窗口：取值越小越「跳」，越大越迟钝 */
export const LIVE_WINDOW_MS = 2000;

/** 计算速率的最小时间跨度：太短会把「首包爆发」放大成离谱的高速率 */
export const MIN_SPAN_MS = 400;

/** 全角 / CJK 字符范围（这些字符在主流分词器里约占 0.7 个 token） */
const CJK = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef\uac00-\ud7af]/;

/**
 * 按字符估算 token 数（浮点，调用方决定何时取整）。
 *
 * 权重取值依据：中文/全角约 0.7 token 一个字（DeepSeek / GLM 系分词器实测区间
 * 0.6~0.8），其余非空白字符约 0.25（≈4 字符一个 token），空白约 0.1（多半与前词
 * 合并，但不为零）。这是**估算**，用于实时速率；精确值一律以 `usage` 为准。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  for (const char of text) {
    if (/\s/.test(char)) tokens += 0.1;
    else tokens += CJK.test(char) ? 0.7 : 0.25;
  }
  return tokens;
}

/**
 * 从流式 chunk 里取出「本次新增的输出文本」：正文 + 思考 + 工具参数。
 *
 * 三者都是模型实打实吐出来的 token，只统计正文会低估（尤其推理模型的思考段）。
 */
export function deltaText(chunk: any): string {
  const delta = chunk?.choices?.[0]?.delta;
  if (!delta) return "";

  let text = "";
  const content = delta.content;
  if (typeof content === "string") {
    text += content;
  } else if (Array.isArray(content)) {
    for (const section of content) {
      if (section && typeof section.text === "string") text += section.text;
    }
  }
  if (typeof delta.reasoning_content === "string") text += delta.reasoning_content;
  if (Array.isArray(delta.tool_calls)) {
    for (const call of delta.tool_calls) {
      if (typeof call?.function?.name === "string") text += call.function.name;
      if (typeof call?.function?.arguments === "string") text += call.function.arguments;
    }
  }
  return text;
}

/** 一次快照：生成中看 `live`，结束后看 `average` */
export interface RateSample {
  /** 实时速率（token/秒，最近窗口估算）；无数据时为 null */
  live: number | null;
  /** 本轮平均速率（token/秒，优先真实 usage）；一轮未结束时为 null */
  average: number | null;
  /** 本轮是否仍在生成 */
  running: boolean;
}

/** 无数据的快照（状态栏据此不显示速率段） */
export const IDLE_RATE: RateSample = { live: null, average: null, running: false };

interface Sample {
  /** 采样时刻 */
  t: number;
  /** 截至该时刻的累计估算 token 数 */
  tokens: number;
}

/**
 * 速率统计器。
 *
 * 生命周期由调用方驱动：`begin()`（一轮开始）→ 若干个 `addDelta()` / `addExact()`
 * → `finish()`（一轮结束）。时间一律可注入，便于单测不依赖真实时钟。
 */
export class TokenRateMeter {
  private samples: Sample[] = [];
  /** 估算的累计输出 token */
  private estimated = 0;
  /** 真实 `completion_tokens` 累加（多轮工具调用逐轮相加） */
  private exact = 0;
  private startedAt: number | null = null;
  private firstOutputAt: number | null = null;
  private lastOutputAt: number | null = null;
  private finished = false;
  private averageValue: number | null = null;

  /** 一轮开始：清空上一轮的所有状态 */
  begin(now: number = Date.now()): void {
    this.samples = [];
    this.estimated = 0;
    this.exact = 0;
    this.startedAt = now;
    this.firstOutputAt = null;
    this.lastOutputAt = null;
    this.finished = false;
    this.averageValue = null;
  }

  /** 收到一段增量文本：累加估算 token 并打点 */
  addDelta(text: string, now: number = Date.now()): void {
    const tokens = estimateTokens(text);
    if (tokens <= 0) return;
    if (this.startedAt == null) this.begin(now);
    this.estimated += tokens;
    this.firstOutputAt ??= now;
    this.lastOutputAt = now;
    this.samples.push({ t: now, tokens: this.estimated });
    this.trim(now);
  }

  /** 收到真实用量（流末 chunk 的 `usage.completion_tokens`），多轮累加 */
  addExact(completionTokens: number | undefined | null): void {
    if (typeof completionTokens !== "number" || !Number.isFinite(completionTokens)) return;
    if (completionTokens <= 0) return;
    this.exact += completionTokens;
  }

  /**
   * 一轮结束：算本轮平均速率。
   *
   * 分子优先用真实 `completion_tokens`；分母是「首字 → 末字」的跨度，即真正在接收
   * 内容的那段时间 —— 不含开头的排队等首字，也避免把整轮的思考停顿算成慢。
   */
  finish(now: number = Date.now()): void {
    this.finished = true;
    const tokens = this.exact > 0 ? this.exact : this.estimated;
    const from = this.firstOutputAt ?? this.startedAt;
    const to = this.lastOutputAt ?? now;
    if (tokens <= 0 || from == null) {
      this.averageValue = null;
      return;
    }
    const spanMs = to - from;
    this.averageValue = spanMs >= MIN_SPAN_MS ? tokens / (spanMs / 1000) : null;
  }

  /** 当前快照（供状态栏直接渲染） */
  snapshot(now: number = Date.now()): RateSample {
    if (this.startedAt == null) return IDLE_RATE;
    if (this.finished) return { live: null, average: this.averageValue, running: false };
    return { live: this.liveRate(now), average: null, running: true };
  }

  /** 清空（退出 / 重建会话时调用） */
  reset(): void {
    this.samples = [];
    this.estimated = 0;
    this.exact = 0;
    this.startedAt = null;
    this.firstOutputAt = null;
    this.lastOutputAt = null;
    this.finished = false;
    this.averageValue = null;
  }

  /** 最近窗口的估算速率；窗口内没动静时返回 0（停顿本来就该显示 0，而不是上一秒的高值） */
  private liveRate(now: number): number | null {
    if (this.samples.length === 0) return null;
    // 跨度从**首字**算起：把等首字的排队时间算进来会把速率稀释成端到端吞吐，
    // 首字之后才开始计时间，同时也顺手挡掉了「首包爆发」被放大成离谱高值的问题。
    const from = this.firstOutputAt ?? this.startedAt!;
    const windowStart = Math.max(from, now - LIVE_WINDOW_MS);
    const spanMs = now - windowStart;
    if (spanMs < MIN_SPAN_MS) return null;

    // 窗口起点对应的累计值：取最后一个不晚于窗口起点的采样
    let base = 0;
    for (const sample of this.samples) {
      if (sample.t <= windowStart) base = sample.tokens;
      else break;
    }
    return Math.max(0, this.estimated - base) / (spanMs / 1000);
  }

  /** 丢掉窗口外的采样（保留一个窗口起点之前的锚点，用于算基准值） */
  private trim(now: number): void {
    const cutoff = now - LIVE_WINDOW_MS;
    let keepFrom = 0;
    for (let i = 0; i < this.samples.length; i += 1) {
      if (this.samples[i]!.t <= cutoff) keepFrom = i;
      else break;
    }
    if (keepFrom > 0) this.samples = this.samples.slice(keepFrom);
  }
}
