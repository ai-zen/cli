/**
 * 「用户输入 + 粘贴的图片」→ 一次投递的 `content`（core 的内容段数组）。
 *
 * ## 为什么图片要折成内容段
 *
 * 宿主这一版收的是一条**已经拼好的** `content`（`string`，或 `AgentNS.MessageContentSection[]`）：
 * Asset 怎么变成厂商要的形状（Files API 的 `file_id` 还是内联 base64）由它在**发出那一刻**按实发
 * 模型决定，而它认的是段上的本地标记 `__asset_id`。所以客户端能做的只有一件：把「用了哪几张」
 * 写成带那个标记的段，其余一概不碰。
 *
 * ## 三态输出，绝不「假成功」
 *
 *   · 一张图都没传上去 → **退回纯文本**（用户至少把话说出去了，不会静默丢消息）；
 *   · 部分成功 → 发成功的那几张，失败原因进 `warnings`；
 *   · 全成功 → 文字 + 各段，顺序即用户摆放的顺序。
 *
 * ## Asset 的宽高与文件名不写进段里
 *
 * 它们只在 `asset.upload` 回来的那一行上，而消息段要按原样入库（`dev-docs/prd/09-attachments.md`：
 * 落库那份就是发给厂商那份，一个字都不清理）。所以上传成功那一刻把那一行里的事实留在客户端
 * 本地（{@link rememberAssetFacts}），段上的形状一个字不动。
 */

import type { AgentNS } from "@ai-zen/agents-core";
import type {
  Asset,
  AssetSource,
  AssetFailure,
  UploadAssetsResult,
} from "./server-client/index.js";
import type { ClipboardImage } from "./clipboard.js";
import type { MessageInput } from "./session/types.js";

/** 段上的本地标记：指回数据根下的一份 Asset（宿主 `ASSET_ID_KEY` 是同一个词） */
const ASSET_ID_KEY = "__asset_id";

/** 一行文字 + N 段 Asset 引用 */
export type ContentSection = AgentNS.MessageContentSection & { [ASSET_ID_KEY]?: string };

/**
 * {@link MessageInput} → 真正投出去的那份 `content`。
 *
 * 只有文字时给纯字符串（最常见的那一种，不必包成一段 `text`）；有 Asset 时给段数组：文字在最前
 * （用户先打字、再贴图，读起来也是这个顺序），之后每张一段。
 */
export function contentOfInput(input: MessageInput): AgentNS.MessageContent {
  const assetIds = input.assetIds ?? [];
  if (assetIds.length === 0) return input.content;

  const sections: ContentSection[] = [];
  for (const section of typeof input.content === "string" ? [] : input.content) {
    sections.push(section);
  }
  if (typeof input.content === "string" && input.content.length > 0) {
    sections.unshift({ type: "text", text: input.content });
  }
  for (const assetId of assetIds) {
    sections.push({ type: "image_url", image_url: { url: "" }, [ASSET_ID_KEY]: assetId });
  }
  return sections;
}

export interface BuildMessageInputOptions {
  text: string;
  images?: readonly ClipboardImage[];
  /** 一批字节 → 上传结果（生产是 `uploadAssets(connection, …)`，用例注入假件） */
  upload: (sources: readonly AssetSource[]) => Promise<UploadAssetsResult>;
}

export interface BuildMessageInputResult {
  /** 交给 `agent.send` 的那一份（`content` 已折好） */
  input: AgentNS.MessageContent;
  /** 失败 / 降级说明（供通知栏），无问题时为空数组 */
  warnings: string[];
}

/** `image/png` → `png`（文件名后缀） */
function extOf(mime: string): string {
  const slash = mime.indexOf("/");
  return slash < 0 ? "png" : mime.slice(slash + 1);
}

/** 粘贴的图片 → 内容段；失败的那张跳过并记一条说明 */
export async function buildMessageInput(
  options: BuildMessageInputOptions,
): Promise<BuildMessageInputResult> {
  const images = options.images ?? [];
  if (images.length === 0) return { input: options.text, warnings: [] };

  const sources: AssetSource[] = images.map((image, index) => ({
    // 不落盘：剪贴板读到的就是字节
    data: Buffer.from(image.base64, "base64"),
    mime: image.mime,
    name: `pasted-${index + 1}.${extOf(image.mime)}`,
  }));

  const { assets, failures } = await options.upload(sources);
  // Asset 行里的事实（宽高、文件名）只有这里有：先记在本机，占位与 Ctrl+O 的列表从那里读
  rememberAssetFacts(assets);
  const warnings = failures.map(describeFailure);
  if (assets.length === 0) {
    // 一张都没上去：文字照发，附件逐张说明（不静默丢消息）
    return { input: options.text, warnings };
  }
  return {
    input: contentOfInput({ content: options.text, assetIds: assets.map((asset) => asset.id) }),
    warnings,
  };
}

/** 一张没上传成的附件的说明：第几张 + 原因（原因是宿主/库渲染好的那句，原样用） */
function describeFailure(failure: AssetFailure): string {
  const name = failure.name ?? `#${failure.index + 1}`;
  return `${name}: ${failure.error.message}`;
}

/** 本机记住的一份 Asset 事实：宿主在上传时量过的宽高与用户给的文件名 */
export interface LocalAssetFacts {
  width?: number;
  height?: number;
  name?: string;
}

/**
 * 本机手里那份 Asset 事实，按 Asset id 认。
 *
 * 三件事说清它是什么：
 *   · 只挑不推 —— `id` 是宿主给的，宽高与文件名是那一行上的原值（可能为空：解不出文件头就是空，
 *     宿主不猜，这里也不编）；
 *   · 只活在本进程 —— 写的时候是上传成功那一刻，进程结束就没了。别的客户端传的、重启之前传的
 *     都查不到，那时占位照实说「不知道多大」；
 *   · 不是第二份真相 —— 它不进消息段、不落库，也不为它发任何请求（`asset.list` 那条路不走）。
 */
const localAssetFacts = new Map<string, LocalAssetFacts>();

/** 上传成功那一刻记下这几行里的事实 */
export function rememberAssetFacts(assets: readonly Asset[]): void {
  for (const asset of assets) {
    localAssetFacts.set(asset.id, {
      width: asset.width,
      height: asset.height,
      name: asset.name ?? undefined,
    });
  }
}

/** 按 Asset id 查本机记住的那份事实；没有就是没有（不返回一份空的去凑数） */
export function localAssetFactsOf(assetId: string): LocalAssetFacts | undefined {
  return localAssetFacts.get(assetId);
}

/**
 * 清空这份记忆。
 *
 * 只有用例用：本仓所有用例共享一个进程与一张模块图（`vitest.config.ts` 的 `isolate: false`），
 * 上一份用例记下的 Asset 会串到下一份。进程里的生产代码没有需要清空的时候 —— 重启就是清空。
 */
export function forgetAssetFacts(): void {
  localAssetFacts.clear();
}
