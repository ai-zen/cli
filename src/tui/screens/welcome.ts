// 欢迎块 —— 空对话时对话区顶部的品牌区（logo + 标语 + 版本）
//
// 它是**对话区的普通内容**：不阻塞、随消息自然上滚、滚回来还能看到。渐变相位固定为 0
// （静态），不持有任何定时器。
import { CLI_VERSION, CORE_VERSION, SDK_VERSION } from "../../version.js";
import { t } from "../../i18n/index.js";
import { displayWidth } from "../text.js";
import { logoGradientColors, pickLogo, theme } from "../theme.js";
import { spanLine, type RLine, type Span } from "./lines.js";

/**
 * 品牌区各行 —— 纯函数，不依赖 Ink（渲染交给 `LineView`）。
 *
 * 宽度取 `pickLogo()` 的判据：能放下宽版 6 行 logo 就用宽版，否则退化成单行
 * `◢ AI · ZEN ◣`。整块按终端宽度居中。所有行都带 `spans`（颜色逐段给），
 * 因此 `kind` 只取中性的 `content`。
 */
export function welcomeLines({ columns }: { columns: number }): RLine[] {
  const logo = pickLogo(columns);
  const colors = logoGradientColors(logo, 0);
  const tagline = t("welcome.tagline");
  const versions = `v${CLI_VERSION} · sdk ${SDK_VERSION} · core ${CORE_VERSION}`;

  /** 逐行居中（不按最宽行对齐 —— 否则 logo 会因版本行更长而看起来偏左） */
  const center = (text: string) =>
    " ".repeat(Math.max(0, Math.floor((columns - displayWidth(text)) / 2)));

  const lines: RLine[] = logo.map((line, i) => {
    const spans: Span[] = [{ text: center(line) }];
    for (const [x, ch] of [...line].entries()) spans.push({ text: ch, color: colors[i]?.[x] });
    return spanLine(`welcome-logo-${i}`, "content", spans);
  });

  lines.push({ key: "welcome-gap", kind: "gap", text: "" });
  lines.push(
    spanLine("welcome-tagline", "content", [
      { text: center(tagline) },
      { text: tagline, color: theme.accent },
    ]),
  );
  lines.push(
    spanLine("welcome-versions", "content", [
      { text: center(versions) },
      { text: versions, color: theme.dim },
    ]),
  );
  return lines;
}
