import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@ai-zen/agents-sdk";
import { buildUserContent } from "./user-content.js";
import type { ClipboardImage } from "./clipboard.js";

const config = { models: [], endpoints: [], imageModels: [] } as unknown as AppConfig;
const image: ClipboardImage = { base64: "QUJD", mime: "image/png" };

/** 假的转换器：按调用次数返回预置结果 / 抛错 */
function fakeConvert(results: ({ section: any; warning?: string } | Error)[]) {
  return vi.fn(async (input: any) => {
    const next = results.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("unexpected call");
    return { section: next.section, transport: "inline", bytes: input.source.base64.length, warning: next.warning };
  }) as any;
}

const imageSection = { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } };

describe("buildUserContent", () => {
  it("没有图片时原样返回字符串（消息契约不变）", async () => {
    const result = await buildUserContent({ text: "你好", config });
    expect(result).toEqual({ content: "你好", warnings: [] });
  });

  it("有图片时文本段排第一，图片块随后", async () => {
    const convert = fakeConvert([{ section: imageSection }]);
    const result = await buildUserContent({ text: "看这张图", images: [image], config, convert });
    expect(result.content).toEqual([{ type: "text", text: "看这张图" }, imageSection]);
    expect(convert).toHaveBeenCalledTimes(1);
    // 不落盘：交给 SDK 的是内存里的 base64 + 带扩展名的文件名
    expect(convert.mock.calls[0]![0].source).toMatchObject({
      base64: "QUJD",
      mime: "image/png",
      filename: "pasted-1.png",
    });
  });

  it("jpeg 文件名后缀跟着 mime 走", async () => {
    const convert = fakeConvert([{ section: imageSection }]);
    await buildUserContent({ text: "x", images: [{ ...image, mime: "image/jpeg" }], config, convert });
    expect(convert.mock.calls[0]![0].source.filename).toBe("pasted-1.jpeg");
  });

  it("单张转换失败不影响其他张，失败原因进 warnings", async () => {
    const convert = fakeConvert([new Error("内联体积超限"), { section: imageSection }]);
    const result = await buildUserContent({
      text: "两张",
      images: [image, image],
      config,
      convert,
    });
    expect(result.content).toEqual([{ type: "text", text: "两张" }, imageSection]);
    expect(result.warnings).toEqual(["内联体积超限"]);
  });

  it("全部失败时退回纯文本（不静默丢消息）", async () => {
    const convert = fakeConvert([new Error("boom")]);
    const result = await buildUserContent({ text: "只有文字", images: [image], config, convert });
    expect(result.content).toBe("只有文字");
    expect(result.warnings).toHaveLength(1);
  });

  it("SDK 的降级说明（上传失败转内联 / 不支持视觉）原样透传", async () => {
    const convert = fakeConvert([{ section: imageSection, warning: "模型不支持视觉，已改为路径提示" }]);
    const result = await buildUserContent({ text: "x", images: [image], config, convert });
    expect(result.warnings).toEqual(["模型不支持视觉，已改为路径提示"]);
  });
});
