/**
 * 消息里图片的占位与「打得开的那几张」—— 纯函数，不碰 React、不发请求。
 *
 * 这一组钉的是**事实**：占位那块把手里已有的事实说出来（第几张、尺寸、文件名）。事实有两个
 * 来源：段上自带的（别的客户端写下来的那种）优先，段上没带的查本机上传那一刻记下的那一份；
 * 两处都没有（别的客户端传的、进程重启过）就写「不知道多大」，也不为了尺寸另开一次请求。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentNS } from "@ai-zen/agents-core";
import { DEFAULT_LOCALE, setLocale } from "../../i18n/index.js";
import { forgetAssetFacts, rememberAssetFacts } from "../../user-content.js";
import type { Asset } from "../../server-client/index.js";
import {
  imagePlaceholderLines,
  openableImageHint,
  openableImageLabel,
  openableImages,
} from "./message-images.js";

// 这些断言都是中文文案：显式锁语言（本仓用例共享一个进程，别的文件会把语言改走），跑完还原
beforeEach(() => {
  setLocale("zh");
  // 本机那份 Asset 事实也是进程级状态：每一份用例从「刚启动」开始（其余用例也不被这一份带着走）
  forgetAssetFacts();
});
afterEach(() => {
  setLocale(DEFAULT_LOCALE);
  forgetAssetFacts();
});

/** 宿主上传时回来的 Asset 行（`asset.upload` 的出参，带量过的宽高与文件名） */
const uploaded = (id: string, name: string, width: number, height: number): Asset => ({
  id,
  sha256: `sha-${id}`,
  mime: "image/png",
  name,
  createdAt: 1,
  width,
  height,
});

/** 一条带 Asset 的图片段（今天的客户端写出来的就是这一种：只有本地标记） */
const assetPart = (assetId: string, extra: Record<string, unknown> = {}) => ({
  type: "image_url" as const,
  image_url: { url: "" },
  __asset_id: assetId,
  ...extra,
});

/** 一条内联 base64 的图片段（`Ctrl+V` 粘进来、随消息一起落库的那一种） */
const inlinePart = { type: "image_url" as const, image_url: { url: "data:image/png;base64,QUJD" } };

/** 一条远程图片段 */
const urlPart = { type: "image_url" as const, image_url: { url: "http://x/y.png" } };

const userMessage = (id: string, content: unknown): AgentNS.Message =>
  ({
    id,
    createdAt: 1,
    role: AgentNS.Role.User,
    content,
  }) as AgentNS.Message;

describe("imagePlaceholderLines（占位那块说得出的事实）", () => {
  it("有尺寸与文件名：各占一行，且写明这是第几张", () => {
    const lines = imagePlaceholderLines(
      assetPart("a-1", { width: 1024, height: 768, name: "cat.png" }),
      2,
    );
    expect(lines[0]).toContain("图片 2");
    // 尺寸与文件名分开写（不塞成一句话）
    expect(lines).toContain("尺寸：1024 × 768");
    expect(lines).toContain("文件名：cat.png");
  });

  it("只有 `__asset_id` 且本机也没记过（今天客户端写的就是这一种）：尺寸那行写「不知道多大」，没有文件名那行", () => {
    const lines = imagePlaceholderLines(assetPart("a-1"), 1);
    expect(lines).toContain("尺寸：不知道多大");
    // 没有就是没有：不编一个文件名，也不为尺寸另开一次请求（这里根本不发请求）
    expect(lines.some((line) => line.includes("文件名"))).toBe(false);
  });

  it("上传过的那一张：段上只有 `__asset_id`，本机记的那一份把尺寸与文件名说出来", () => {
    rememberAssetFacts([uploaded("a-1", "shot.png", 1280, 720)]);
    const lines = imagePlaceholderLines(assetPart("a-1"), 1);
    expect(lines).toContain("尺寸：1280 × 720");
    expect(lines).toContain("文件名：shot.png");
  });

  it("本机这一份是空的（进程重启过 / 别的客户端传的）：照旧说不知道多大", () => {
    // `beforeEach` 刚清空过，就是重启之后的样子
    const lines = imagePlaceholderLines(assetPart("a-9"), 1);
    expect(lines).toContain("尺寸：不知道多大");
    expect(lines.some((line) => line.includes("文件名"))).toBe(false);
  });

  it("段上自带的优先：别的客户端写下的尺寸不被本机那份盖掉", () => {
    rememberAssetFacts([uploaded("a-1", "shot.png", 1280, 720)]);
    const lines = imagePlaceholderLines(
      assetPart("a-1", { width: 640, height: 480, name: "other.png" }),
      1,
    );
    expect(lines).toContain("尺寸：640 × 480");
    expect(lines).toContain("文件名：other.png");
  });

  it("内联 base64：说的是「内联在消息里」，尺寸同样不知道", () => {
    const lines = imagePlaceholderLines(inlinePart, 1);
    expect(lines[0]).toContain("内联在消息里");
    expect(lines).toContain("尺寸：不知道多大");
  });

  it("远程图片：地址照旧带上（这一种没有素材，也没有尺寸）", () => {
    const lines = imagePlaceholderLines(urlPart, 1);
    expect(lines[0]).toBe("[图片：http://x/y.png]");
    expect(lines).toContain("尺寸：不知道多大");
  });
});

describe("openableImages（哪几张打得开）", () => {
  it("只挑带素材 id 的那几张，按出现顺序，并标出是第几条消息的第几张", () => {
    const messages = [
      userMessage("u-1", [
        { type: "text", text: "看图" },
        assetPart("a-1"),
        inlinePart,
        assetPart("a-2", { width: 10, height: 20, name: "two.png" }),
      ]),
      userMessage("u-2", "纯文字"),
      userMessage("u-3", [assetPart("a-1")]),
    ];

    const images = openableImages(messages);

    // 同一张 Asset 出现两次就是两个位置（用户选的是「哪一张」，不是「哪个 id」）
    expect(images.map((image) => image.assetId)).toEqual(["a-1", "a-2", "a-1"]);
    expect(images.map((image) => [image.messageIndex, image.imageIndex])).toEqual([
      [0, 0],
      [0, 2],
      [2, 0],
    ]);
    expect(openableImageLabel(images[1]!)).toBe("第 1 条消息 · 第 3 张");
  });

  it("选择器那一行的提示：有尺寸与文件名就给，没有就说不知道多大", () => {
    const [withFacts, withoutFacts] = openableImages([
      userMessage("u-1", [
        assetPart("a-1", { width: 640, height: 480, name: "one.png" }),
        assetPart("a-2"),
      ]),
    ]);
    expect(openableImageHint(withFacts!)).toBe("640 × 480 · one.png");
    expect(openableImageHint(withoutFacts!)).toBe("不知道多大");
  });

  it("选择器那一行的提示也用本机那份：上传过的那张说得真实尺寸与文件名", () => {
    rememberAssetFacts([uploaded("a-1", "shot.png", 1280, 720)]);
    const [image] = openableImages([userMessage("u-1", [assetPart("a-1")])]);
    expect(openableImageHint(image!)).toBe("1280 × 720 · shot.png");
    // 打得开与否只看段上有没有 Asset id，与手里那份事实无关
    expect(image!.assetId).toBe("a-1");
  });

  it("一张带素材的都没有：空数组（不弹一个点了会失败的选择器）", () => {
    expect(openableImages([userMessage("u-1", [inlinePart, urlPart])])).toEqual([]);
    expect(openableImages([userMessage("u-2", "纯文字")])).toEqual([]);
  });
});

// 这一组的断言都是中文文案：锁语言由文件头的钩子管

describe("imagePlaceholderLines（英文词典也有这几条）", () => {
  it("切到英文：尺寸与文件名照样分开写", () => {
    setLocale("en");
    try {
      const lines = imagePlaceholderLines(
        assetPart("a-1", { width: 8, height: 9, name: "x.png" }),
        1,
      );
      expect(lines).toContain("Size: 8 × 9");
      expect(lines).toContain("File name: x.png");
    } finally {
      setLocale(DEFAULT_LOCALE);
    }
  });
});
