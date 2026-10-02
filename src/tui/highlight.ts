/**
 * 语法高亮**数据层** —— 只负责产出「带 scope 的 token」，不关心颜色（颜色与 Ink 渲染
 * 由 UI 层负责）。这样把「高亮数据（190+ 语言）」这件事交给专业库，
 * 我们只写渲染，避免自造轮子在语言覆盖上以卵击石。
 *
 * 数据来源：**highlight.js**（经 **lowlight** 产出 **hast** 树）。
 * 这与业界同类 Ink/React TUI（如 Google Gemini CLI 依赖 `highlight.js` + `lowlight`）
 * 的做法一致：库给结构化的 `hljs-*` scope，我们逐段映射成 Ink `<Text>` 颜色。
 */
import { createLowlight, common } from "lowlight";
import type { Root, RootContent } from "hast";

/** 单例：注册 highlight.js 的 ~37 种常用语言（json / bash / ts / py / go / rust …） */
const lowlight = createLowlight(common);

/** 一段带 scope 的文本；`scope` 为归一化后的 highlight.js 类别（去掉 `hljs-` 前缀） */
export interface HlToken {
  text: string;
  scope: string;
}

/** 围栏代码块切分结果 */
export type CodeSegment =
  | { type: "text"; text: string }
  | { type: "code"; lang?: string; text: string };

function shortScope(className: string): string {
  return className.replace(/^hljs-/, "");
}

/** 深度优先展平 hast：文本节点继承「最内层」元素的 scope（更具体者优先） */
function walk(nodes: RootContent[], scope: string, out: HlToken[]): void {
  for (const node of nodes) {
    if (node.type === "text") {
      if (node.value) out.push({ text: node.value, scope });
    } else if (node.type === "element") {
      const classNames = (node.properties?.className as string[] | undefined) ?? [];
      const next = classNames.length ? shortScope(classNames[classNames.length - 1]!) : scope;
      walk(node.children as RootContent[], next, out);
    }
  }
}

/** 结果缓存：完成态内容在一次会话里反复渲染（滚动 / 每次按键），命中缓存避免重复高亮 */
const cache = new Map<string, HlToken[]>();
const CACHE_LIMIT = 512;

function memo(key: string, produce: () => HlToken[]): HlToken[] {
  const hit = cache.get(key);
  if (hit) return hit;
  const value = produce();
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, value);
  return value;
}

/**
 * 按语言把代码切成带 scope 的 token。
 *
 * - 语言已注册：走 highlight.js 词法；
 * - 语言缺失 / 未注册（含 ` ``` ` 无标注）：**原样返回**为单段 `plain`，不做猜测
 *   （`highlightAuto` 在短片段上容易误判，宁可不着色也不误导）。
 */
export function highlightCode(code: string, lang?: string): HlToken[] {
  const language = (lang ?? "").trim().toLowerCase();
  if (!language || !code) return code ? [{ text: code, scope: "" }] : [];
  return memo(`${language}\u0000${code}`, () => {
    try {
      const root = lowlight.highlight(language, code) as unknown as Root;
      const out: HlToken[] = [];
      walk(root.children, "", out);
      return out.length ? out : [{ text: code, scope: "" }];
    } catch {
      // 未注册语言：不高亮
      return [{ text: code, scope: "" }];
    }
  });
}

/** JSON 高亮（工具调用参数）：等价于 `highlightCode(code, "json")` */
export function highlightJson(code: string): HlToken[] {
  return highlightCode(code, "json");
}

/** 已注册语言列表（供文档 / 调试） */
export function supportedLanguages(): string[] {
  return lowlight.listLanguages().sort();
}

// ==================== 围栏切分 ====================

const FENCE_RE = /^\s*```(.*)$/;

/**
 * 把正文切成「普通文本 / 围栏代码块」两类片段。
 *
 * 围栏行（``` 与 ```lang）本身作为分隔符**丢弃**，不进入任何片段 —— 渲染时代码块以
 * 高亮行呈现，无需再显示裸围栏。
 */
export function splitFences(text: string): CodeSegment[] {
  const segments: CodeSegment[] = [];
  let buf: string[] = [];
  let mode: "text" | "code" = "text";
  let lang: string | undefined;
  const flush = () => {
    if (buf.length) {
      segments.push(
        mode === "code"
          ? { type: "code", lang, text: buf.join("\n") }
          : { type: "text", text: buf.join("\n") },
      );
    }
    buf = [];
  };
  for (const line of text.split("\n")) {
    const m = FENCE_RE.exec(line);
    if (m) {
      flush();
      if (mode === "text") {
        mode = "code";
        lang = m[1]!.trim() || undefined;
      } else {
        mode = "text";
        lang = undefined;
      }
    } else {
      buf.push(line);
    }
  }
  flush();
  return segments;
}
