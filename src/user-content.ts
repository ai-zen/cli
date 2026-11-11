/**
 * 「用户输入 + 粘贴的图片」→ 发给 core 的消息内容（`MessageContent`）。
 *
 * ## 为什么单独一个文件
 *
 * 这里是 `Ctrl+V` 粘贴图片链路的**唯一决策点**：几张图、失败一张怎么办、全失败怎么办 ——
 * 都是纯逻辑（字节怎么变成内容块由服务端的 `content.upload` 决定，且可注入），因此能脱离
 * 终端与网络单测。
 *
 * ## 转换不在这里
 *
 * 「这批字节该上传成 `file_id`、还是 base64 内联、还是退化成文本提示」取决于**这一段会话
 * 此刻用的端点与模型**，那是服务端的事实（唯一实现是 SDK 的 `fileToContentSection`，跑在
 * 会话所在的那一侧）。这里只递字节（`upload`），拿回一块内容。
 *
 * ## 三态输出，绝不「假成功」
 *
 *   · 一张图都没转成功 → **退回纯文本**（用户至少把话说出去了，不会静默丢消息）；
 *   · 部分成功 → 发成功的那几张，失败原因进 `warnings`；
 *   · 降级（上传失败转内联、模型不支持视觉转文本提示）→ 照发，服务端给的说明进 `warnings`。
 *
 * 文本段永远排在**第一个**：`formatHistory()` 原样把内容块发给 API，而多数端点
 * 对「图在文前」的处理是把提示词放到图片之后，指令容易被图片切断。
 */
import type {
  ContentUploadResult,
  MessageContent,
  MessageContentBlock,
  UploadContentInput,
} from "./server-client/index.js";
import type { ClipboardImage } from "./clipboard.js";

export interface BuildUserContentInput {
  text: string;
  images?: readonly ClipboardImage[];
  /** 一批字节 → 一块内容（生产是 `channel.uploadContent`，用例注入假件） */
  upload: (input: UploadContentInput) => Promise<ContentUploadResult>;
}

export interface BuildUserContentResult {
  content: MessageContent;
  /** 降级 / 失败说明（供通知栏），无问题时为空数组 */
  warnings: string[];
}

/** `image/png` → `png`（文件名后缀，部分端点按扩展名判类型） */
function extOf(mime: string): string {
  const slash = mime.indexOf("/");
  return slash < 0 ? "png" : mime.slice(slash + 1);
}

/** 粘贴的图片 → 内容块；失败的那张跳过并记一条说明 */
export async function buildUserContent(
  input: BuildUserContentInput,
): Promise<BuildUserContentResult> {
  const images = input.images ?? [];
  if (images.length === 0) return { content: input.text, warnings: [] };

  const sections: MessageContentBlock[] = [];
  const warnings: string[] = [];
  for (const [index, image] of images.entries()) {
    try {
      const result = await input.upload({
        bytes: Buffer.from(image.base64, "base64"),
        mime: image.mime,
        filename: `pasted-${index + 1}.${extOf(image.mime)}`,
      });
      sections.push(result.section);
      if (result.warning) warnings.push(result.warning);
    } catch (error: any) {
      // 单张失败不影响其他张：体积超上限、端点拒绝上传、会话没了都在这里收敛
      warnings.push(error?.message ? String(error.message) : String(error));
    }
  }

  if (sections.length === 0) return { content: input.text, warnings };
  return { content: [{ type: "text", text: input.text }, ...sections], warnings };
}
