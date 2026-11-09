/**
 * 「用户输入 + 粘贴的图片」→ 发给 core 的消息内容（`MessageContent`）。
 *
 * ## 为什么单独一个文件
 *
 * 这里是 `Ctrl+V` 粘贴图片链路的**唯一决策点**：几张图、走 Files API 还是内联、
 * 模型不支持视觉时怎么办、转换失败要不要放弃 —— 全是纯逻辑（IO 由 SDK 的
 * `fileToContentSection()` 负责，且可注入），因此可以脱离终端与网络单测。
 *
 * ## 三态输出，绝不「假成功」
 *
 *   · 一张图都没转成功 → **退回纯文本**（用户至少把话说出去了，不会静默丢消息）；
 *   · 部分成功 → 发成功的那几张，失败原因进 `warnings`；
 *   · 传输降级（上传失败转内联、模型不支持视觉转文本提示）→ 照发，SDK 的
 *     `warning` 透传给通知栏。
 *
 * 文本段永远排在**第一个**：`formatHistory()` 原样把内容块发给 API，而多数端点
 * 对「图在文前」的处理是把提示词放到图片之后，指令容易被图片切断。
 */
import type { AgentNS } from "@ai-zen/agents-core";
import { fileToContentSection, resolveModelAndEndpoint } from "@ai-zen/agents-sdk";
import type { AppConfig, FileSource } from "@ai-zen/agents-sdk";
import type { ClipboardImage } from "./clipboard.js";

export interface BuildUserContentInput {
  text: string;
  images?: readonly ClipboardImage[];
  /** 当前配置（用于按模型反查端点与视觉能力） */
  config: AppConfig;
  /** 发给 API 的模型名（core 的 `agent.model`）——`file_id` 是端点维度资源，必须按实发模型定位 */
  apiModelName?: string;
  /** 依赖注入（测试用）；默认走 SDK 的统一转换入口 */
  convert?: typeof fileToContentSection;
}

export interface BuildUserContentResult {
  content: AgentNS.MessageContent;
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

  const convert = input.convert ?? fileToContentSection;
  const { model, endpoint } = resolveModelAndEndpoint(input.config, input.apiModelName);

  const sections: AgentNS.MessageContentSection[] = [];
  const warnings: string[] = [];
  for (const [index, image] of images.entries()) {
    const source: FileSource = {
      base64: image.base64,
      mime: image.mime,
      filename: `pasted-${index + 1}.${extOf(image.mime)}`,
    };
    try {
      const result = await convert({ source, endpoint, model });
      sections.push(result.section);
      if (result.warning) warnings.push(result.warning);
    } catch (error: any) {
      // 单张失败不影响其他张：体积超内联上限、端点拒绝上传等都在这里收敛
      warnings.push(error?.message ? String(error.message) : String(error));
    }
  }

  if (sections.length === 0) return { content: input.text, warnings };
  return { content: [{ type: "text", text: input.text }, ...sections], warnings };
}
