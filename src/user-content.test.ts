import { describe, expect, it, vi } from "vitest";
import { buildUserContent } from "./user-content.js";
import type { ContentUploadResult, UploadContentInput } from "./server-client/index.js";
import type { ClipboardImage } from "./clipboard.js";

const image: ClipboardImage = { base64: "QUJD", mime: "image/png" };

const imageSection = {
  type: "image_url",
  image_url: { url: "data:image/png;base64,QUJD" },
} as const;

/** 假的上传：按调用次数返回预置结果 / 抛错（真实现是服务端的 `content.upload`） */
function fakeUpload(results: (Partial<ContentUploadResult> | Error)[]) {
  return vi.fn(async (_input: UploadContentInput) => {
    const next = results.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("unexpected call");
    return { section: imageSection, ...next } as ContentUploadResult;
  });
}

describe("buildUserContent", () => {
  it("没有图片时原样返回字符串（消息契约不变，也不碰上传）", async () => {
    const upload = fakeUpload([]);
    const result = await buildUserContent({ text: "你好", upload });
    expect(result).toEqual({ content: "你好", warnings: [] });
    expect(upload).not.toHaveBeenCalled();
  });

  it("有图片时文本段排第一，图片块随后", async () => {
    const upload = fakeUpload([{}]);
    const result = await buildUserContent({ text: "看这张图", images: [image], upload });
    expect(result.content).toEqual([{ type: "text", text: "看这张图" }, imageSection]);
    expect(upload).toHaveBeenCalledTimes(1);
    // 不落盘：交上去的是内存里的字节 + 带扩展名的文件名
    const input = upload.mock.calls[0]![0];
    expect(Buffer.from(input.bytes)).toEqual(Buffer.from("ABC"));
    expect(input.mime).toBe("image/png");
    expect(input.filename).toBe("pasted-1.png");
  });

  it("jpeg 文件名后缀跟着 mime 走", async () => {
    const upload = fakeUpload([{}]);
    await buildUserContent({ text: "x", images: [{ ...image, mime: "image/jpeg" }], upload });
    expect(upload.mock.calls[0]![0].filename).toBe("pasted-1.jpeg");
  });

  it("单张失败不影响其他张，失败原因进 warnings", async () => {
    const upload = fakeUpload([new Error("内联体积超限"), {}]);
    const result = await buildUserContent({ text: "两张", images: [image, image], upload });
    expect(result.content).toEqual([{ type: "text", text: "两张" }, imageSection]);
    expect(result.warnings).toEqual(["内联体积超限"]);
  });

  it("全部失败时退回纯文本（不静默丢消息）", async () => {
    const upload = fakeUpload([new Error("boom")]);
    const result = await buildUserContent({ text: "只有文字", images: [image], upload });
    expect(result.content).toBe("只有文字");
    expect(result.warnings).toHaveLength(1);
  });

  it("服务端的降级说明（上传失败转内联 / 不支持视觉）原样透传", async () => {
    const upload = fakeUpload([{ warning: "模型不支持视觉，已改为路径提示" }]);
    const result = await buildUserContent({ text: "x", images: [image], upload });
    expect(result.warnings).toEqual(["模型不支持视觉，已改为路径提示"]);
  });
});
