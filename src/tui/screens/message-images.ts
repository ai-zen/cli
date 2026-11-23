/**
 * 消息里的图片：**终端说得出的事实**，以及「打得开的那几张」。
 *
 * ## 为什么终端里不画图，但也不能只说「有图」
 *
 * 终端没有内联图片这条路：一张截图内联成 base64 常有几十万字符，铺到转录里会撑爆一行，还会
 * 把整帧拖慢（`messages-view.ts` 的取舍是占位，不是渲染）。但占位不该只说「有图」——
 * 手里已经有的那几样事实要说出来：这是这一条里的第几张、多大、叫什么。
 *
 * ## 尺寸与文件名：有就给，没有就说「不知道多大」
 *
 * Asset 的宽高是宿主**上传时量过的**，落在 Asset 行上（`asset.upload` 那一行，
 * `prd/09-attachments.md` 的「尺寸」一条）；而 `asset.get` 那个口回来的是字节，里面不带尺寸。
 * 消息的段上只有本地标记 `__asset_id`（那一册：那只是本地标记，用在客户端回显），段本身要按
 * 原样入库，所以客户端把上传那一刻的事实留在本机（`user-content.ts` 的 `localAssetFactsOf`）。
 * 于是三件事：
 *
 *   · 段上自带的（别的客户端写下来的那种）优先，它说什么就是什么；
 *   · 段上没带的，查本机记的那一份 —— 这一段如果不是本进程传的（别的客户端、重启之前），
 *     查不到就老实说「不知道多大」；
 *   · 哪一个都不为尺寸另开一次请求。
 *
 * ## 「打得开」只看带 Asset id 的那几张
 *
 * 打开走的是 `asset.get`（客户端本地没有副本，只有 id），所以能打开的就是带 `__asset_id`
 * 的图片段；内联 base64 与远程 URL 那两种不在这一条路上（前者本地就有字节、后者根本不在宿主
 * 里），不给一个点了会失败的入口。
 */

import type { AgentNS } from "@ai-zen/agents-core";
import { t } from "../../i18n/index.js";
import { localAssetFactsOf } from "../../user-content.js";

/**
 * 段上的本地标记：指回数据根下的一份 Asset。
 *
 * 写它的是 `user-content.ts`（`contentOfInput`），宿主 `ASSET_ID_KEY` 是同一个词；这里只读，
 * 不造第二个名字。
 */
const ASSET_ID_KEY = "__asset_id";

/** 一个图片段手里已有的事实（全都可以没有：没有就是不知道，不编） */
export interface ImageFacts {
  /** Asset id（段上的本地标记）；内联 base64 / 远程 URL 没有 */
  assetId?: string;
  /** Asset 宽高（宿主上传时量过；段上与本机都没有就是不知道） */
  width?: number;
  height?: number;
  /** 文件名（段上带着、或本机上传那一刻记下过） */
  name?: string;
}

/** 一个图片段长什么样（`AgentNS.MessageContentSection` 的 `image_url` 那一支，加本机扩展键） */
export type ImageSection = { type: string; image_url?: { url?: string } } & Record<string, unknown>;

/**
 * 一个图片段 → 手里已有的事实（全都可以没有：没有就是不知道，不编）。
 *
 * 段上自带的优先（别的客户端上传时写下来的那一种）；段上没带的，按 Asset id 查本机上传那一刻
 * 记下的那一份。两处都没有（别的客户端传的、进程重启过）就到此为止 —— 不推断、不发请求。
 */
export function imageFactsOf(section: ImageSection): ImageFacts {
  const facts: ImageFacts = {};
  const assetId = section[ASSET_ID_KEY];
  if (typeof assetId === "string" && assetId.length > 0) facts.assetId = assetId;
  const width = section.width;
  const height = section.height;
  if (typeof width === "number" && typeof height === "number") {
    facts.width = width;
    facts.height = height;
  }
  const name = section.name;
  if (typeof name === "string" && name.length > 0) facts.name = name;

  const local = facts.assetId === undefined ? undefined : localAssetFactsOf(facts.assetId);
  if (local !== undefined) {
    if (facts.width === undefined && local.width !== undefined && local.height !== undefined) {
      facts.width = local.width;
      facts.height = local.height;
    }
    if (facts.name === undefined && local.name !== undefined) facts.name = local.name;
  }
  return facts;
}

/** 是内联 base64 的图片（`data:` URL）还是普通（远程）图片 */
function isInlineImage(section: ImageSection): boolean {
  return (section.image_url?.url ?? "").startsWith("data:");
}

/**
 * 一个图片段 → 占位那几行（**每条事实一行**，不把它们塞成一句）。
 *
 * 第一行说的是「这是哪一张、终端里怎么对待它」；之后尺寸一行，文件名**有才有一行**。
 */
export function imagePlaceholderLines(section: ImageSection, index: number): string[] {
  const facts = imageFactsOf(section);
  const url = section.image_url?.url ?? "";
  const lines: string[] = [];
  if (facts.assetId !== undefined) {
    lines.push(t("msg.imageAssetHeader", { n: index }));
  } else if (isInlineImage(section)) {
    lines.push(t("msg.imageInlineHeader", { n: index }));
  } else {
    // 远程图片：地址本身就是一条事实，照旧带上（这一种没有 Asset，也没有尺寸）
    lines.push(t("msg.imageUrlHeader", { url }));
  }
  lines.push(
    facts.width !== undefined && facts.height !== undefined
      ? t("msg.imageSize", { width: facts.width, height: facts.height })
      : t("msg.imageSizeUnknown"),
  );
  if (facts.name !== undefined) lines.push(t("msg.imageName", { name: facts.name }));
  return lines;
}

/** 转录里的一张「打得开」的图片：它在哪一条消息、那一条里的第几张 */
export interface OpenableImage {
  /** 在这段转录里是第几条消息（0 起，序号即渲染顺序） */
  messageIndex: number;
  /** 这一条消息里的第几张图片（0 起） */
  imageIndex: number;
  assetId: string;
  facts: ImageFacts;
}

/**
 * 一段转录里**打得开**的那些图片（带 Asset id 的），按出现顺序。
 *
 * 不去重：同一张图在同一条消息里放两次就是两个位置，用户选的是「哪一张」，不是「哪个 id」。
 */
export function openableImages(messages: readonly AgentNS.Message[]): OpenableImage[] {
  const out: OpenableImage[] = [];
  messages.forEach((message, messageIndex) => {
    const content = message.content;
    if (content == null || typeof content === "string") return;
    let imageIndex = 0;
    for (const section of content) {
      if (section.type !== "image_url") continue;
      const facts = imageFactsOf(section as ImageSection);
      if (facts.assetId !== undefined) {
        out.push({ messageIndex, imageIndex, assetId: facts.assetId, facts });
      }
      imageIndex += 1;
    }
  });
  return out;
}

/** 选择器里那一行的标签：第几条消息、这一条里的第几张 */
export function openableImageLabel(image: OpenableImage): string {
  return t("notice.imagePickItem", {
    message: image.messageIndex + 1,
    image: image.imageIndex + 1,
  });
}

/** 选择器里那一行的提示：手里有的事实（尺寸 / 文件名），没有就说不知道多大 */
export function openableImageHint(image: OpenableImage): string {
  const size =
    image.facts.width !== undefined && image.facts.height !== undefined
      ? `${image.facts.width} × ${image.facts.height}`
      : t("msg.imageSizeUnknownValue");
  return image.facts.name === undefined ? size : `${size} · ${image.facts.name}`;
}
