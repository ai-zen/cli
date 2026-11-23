/**
 * 「用户输入 + 粘贴的图片」→ 一次投递的 `content`。
 *
 * 四件事要钉住：
 *   1. 没有图片时**只交文字**（`content` 就是那一串，不包成一段 `text`）；
 *   2. 图片变成的是**带 `__asset_id` 的内容段**（Asset 怎么变成厂商要的形状由宿主按实发模型决定，
 *      客户端只说「用了哪几张」）；
 *   3. 一张都没上去时文字照发，失败原因逐张进 `warnings`（绝不假成功、也不静默丢消息）；
 *   4. 上传成功那一刻，Asset 行里的事实（宽高、文件名）留在本机，而段上不多一个字。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMessageInput,
  contentOfInput,
  forgetAssetFacts,
  localAssetFactsOf,
} from "./user-content.js";
import type { AssetFailure, AssetSource, UploadAssetsResult } from "./server-client/index.js";
import { ClientError } from "./server-client/index.js";
import type { ClipboardImage } from "./clipboard.js";

// 本机那份 Asset 事实是进程级状态：每一份用例从「刚启动」开始，也不把状态留给下一份用例
beforeEach(() => forgetAssetFacts());

const image: ClipboardImage = { base64: Buffer.from("ABC").toString("base64"), mime: "image/png" };

/** 宿主回的 Asset 行（`asset.upload` 的出参；`id` 就是内容段上那个 `__asset_id`） */
function assetRef(id: string, name = "pasted-1.png") {
  return { id, sha256: `sha-${id}`, mime: "image/png", name, createdAt: 1, width: 1, height: 1 };
}

function failure(index: number, message: string, name: string | null = null): AssetFailure {
  return { index, name, error: new ClientError("invalid_params", message) };
}

/** 假的上传：按调用次数返回预置结果（真实现是 `@ai-zen/agents-client` 的 `asset.upload`） */
function fakeUpload(results: UploadAssetsResult[]) {
  return vi.fn(async (_sources: readonly AssetSource[]) => {
    const next = results.shift();
    if (!next) throw new Error("unexpected call");
    return next;
  });
}

describe("contentOfInput", () => {
  it("只有文字时给字符串（最常见的那一种，不包成一段 `text`）", () => {
    expect(contentOfInput({ content: "你好" })).toBe("你好");
  });

  it("有素材时给段数组：文字在最前，之后每张一段（带 `__asset_id`）", () => {
    expect(contentOfInput({ content: "看", assetIds: ["a-1"] })).toEqual([
      { type: "text", text: "看" },
      { type: "image_url", image_url: { url: "" }, __asset_id: "a-1" },
    ]);
  });
});

describe("buildMessageInput", () => {
  it("没有图片：只交文字，也不碰上传", async () => {
    const upload = fakeUpload([]);
    const result = await buildMessageInput({ text: "你好", upload });

    expect(result).toEqual({ input: "你好", warnings: [] });
    expect(upload).not.toHaveBeenCalled();
  });

  it("有图片：交的是带 `__asset_id` 的内容段（怎么变成厂商形状由宿主决定）", async () => {
    const upload = fakeUpload([{ assets: [assetRef("a-1")], failures: [] }]);
    const result = await buildMessageInput({ text: "看这张图", images: [image], upload });

    expect(result).toEqual({
      input: [
        { type: "text", text: "看这张图" },
        { type: "image_url", image_url: { url: "" }, __asset_id: "a-1" },
      ],
      warnings: [],
    });
    // 不落盘：交上去的是内存里的字节 + 带扩展名的文件名
    const source = upload.mock.calls[0]![0][0]!;
    if (!("data" in source)) throw new Error("这条用例只走字节那条路");
    expect(Buffer.from(source.data)).toEqual(Buffer.from("ABC"));
    expect(source.mime).toBe("image/png");
    expect(source.name).toBe("pasted-1.png");
  });

  it("jpeg 文件名后缀跟着 mime 走", async () => {
    const upload = fakeUpload([{ assets: [assetRef("a-1")], failures: [] }]);
    await buildMessageInput({ text: "x", images: [{ ...image, mime: "image/jpeg" }], upload });
    expect(upload.mock.calls[0]![0][0]!.name).toBe("pasted-1.jpeg");
  });

  it("部分失败：成功的那几张照发，失败原因逐张进 warnings", async () => {
    const upload = fakeUpload([
      {
        assets: [assetRef("a-1", "pasted-1.png")],
        failures: [failure(1, "内联体积超限", "pasted-2.png")],
      },
    ]);
    const result = await buildMessageInput({ text: "两张", images: [image, image], upload });

    expect(result.input).toEqual([
      { type: "text", text: "两张" },
      { type: "image_url", image_url: { url: "" }, __asset_id: "a-1" },
    ]);
    expect(result.warnings).toEqual(["pasted-2.png: 内联体积超限"]);
  });

  it("全部失败：退回纯文本（不静默丢消息）", async () => {
    const upload = fakeUpload([
      { assets: [], failures: [failure(0, "服务端拒了", "pasted-1.png")] },
    ]);
    const result = await buildMessageInput({ text: "只有文字", images: [image], upload });

    expect(result.input).toBe("只有文字");
    expect(result.warnings).toEqual(["pasted-1.png: 服务端拒了"]);
  });

  it("失败项没有文件名时用序号说话（不让用户去猜是哪一张）", async () => {
    const upload = fakeUpload([{ assets: [], failures: [failure(0, "空文件")] }]);
    const result = await buildMessageInput({ text: "x", images: [image], upload });

    expect(result.warnings).toEqual(["#1: 空文件"]);
  });

  it("上传成功那一刻：素材行的事实留在本机，消息段里多一个字都没有", async () => {
    const upload = fakeUpload([
      {
        assets: [
          {
            id: "f-1",
            sha256: "sha-f-1",
            mime: "image/png",
            name: "shot.png",
            createdAt: 1,
            width: 1280,
            height: 720,
          },
        ],
        failures: [],
      },
    ]);
    const result = await buildMessageInput({ text: "看图", images: [image], upload });

    // 段：文字 + 一段带本地标记的图片 —— 落库那份就是发给厂商那份，宽高与文件名不进段
    expect(result.input).toEqual([
      { type: "text", text: "看图" },
      { type: "image_url", image_url: { url: "" }, __asset_id: "f-1" },
    ]);
    // 本机：宿主那一行里的事实原样记下（占位与 Ctrl+O 的列表从这里读）
    expect(localAssetFactsOf("f-1")).toEqual({ width: 1280, height: 720, name: "shot.png" });
  });

  it("宿主没量出宽高也是事实：记下空的那两格，不编一个尺寸", async () => {
    const upload = fakeUpload([
      {
        assets: [{ id: "f-2", sha256: "sha-f-2", mime: "image/webp", name: null, createdAt: 1 }],
        failures: [],
      },
    ]);
    await buildMessageInput({ text: "x", images: [image], upload });

    expect(localAssetFactsOf("f-2")).toEqual({
      width: undefined,
      height: undefined,
      name: undefined,
    });
  });
});
