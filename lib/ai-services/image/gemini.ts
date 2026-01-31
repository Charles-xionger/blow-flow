/**
 * Google Gemini 图片生成服务（使用 SDK）
 * 支持 Nano Banana 和 Nano Banana Pro
 */
import { GoogleGenAI } from "@google/genai";

// 从环境变量获取 API Key
const getApiKey = () => {
  return process.env.GEMINI_API_KEY || "";
};

/**
 * 下载图片并转换为 base64
 * @param imageUrl 图片 URL
 * @returns base64 编码的图片数据（不含前缀）
 */
async function downloadImageAsBase64(imageUrl: string): Promise<string> {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    return buffer.toString("base64");
  } catch (error) {
    console.error("[Gemini] Failed to download image:", error);
    throw new Error(
      `Failed to download image from URL: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * 生成图片 - Gemini SDK
 * @param model 模型 ID (gemini-2.5-flash-image, gemini-3-pro-image-preview)
 * @param prompt 提示词
 * @param _aspectRatio 宽高比（保留参数兼容性）
 * @param _resolution 分辨率（保留参数兼容性）
 * @returns 图片 base64 URL
 */
export async function generateGeminiImage(
  model: string,
  prompt: string,
  _aspectRatio: string = "1:1",
  _resolution: string = "1024x1024",
): Promise<string> {
  const apiKey = getApiKey();

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not found in environment variables");
  }

  try {
    const ai = new GoogleGenAI({ apiKey });

    // 构建请求内容
    const response = await ai.models.generateContent({
      model: model,
      contents: prompt,
      config: {
        responseModalities: ["image"] as any,
      } as any,
    });

    // 提取图片数据
    if (response.candidates && response.candidates.length > 0) {
      const candidate = response.candidates[0];

      // 查找图片 part
      if (candidate.content?.parts) {
        for (const part of candidate.content.parts) {
          if (part.inlineData) {
            const mimeType = part.inlineData.mimeType || "image/png";
            const data = part.inlineData.data;
            return `data:${mimeType};base64,${data}`;
          }
        }
      }
    }

    throw new Error("未返回图片数据");
  } catch (error) {
    console.error("Gemini image generation error:", error);
    throw error;
  }
}

/**
 * 图片转图片 - 基于输入图片生成新图片（支持多张图片）
 * @param model 模型 ID
 * @param prompt 提示词
 * @param inputImages 输入图片数组（URL 或 base64）
 * @returns 生成的图片 base64 URL
 */
export async function generateGeminiImageToImage(
  model: string,
  prompt: string,
  inputImages: string | string[],
): Promise<string> {
  const apiKey = getApiKey();

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not found in environment variables");
  }

  try {
    const ai = new GoogleGenAI({ apiKey });

    // 兼容单张或多张图片
    const imageArray = Array.isArray(inputImages) ? inputImages : [inputImages];

    console.log(`[Gemini] Processing ${imageArray.length} input image(s)`);

    // 处理所有输入图片
    const imageDataPromises = imageArray.map(async (img) => {
      let base64Data: string;
      if (img.startsWith("http://") || img.startsWith("https://")) {
        // 如果是 URL，先下载并转换为 base64
        console.log("[Gemini] Downloading image from URL:", img);
        base64Data = await downloadImageAsBase64(img);
      } else {
        // 如果是 base64，提取纯数据部分
        base64Data = img.includes(",") ? img.split(",")[1] : img;
      }
      return base64Data;
    });

    const base64DataArray = await Promise.all(imageDataPromises);

    // 构建 contents 数组：先文本，然后所有图片
    const contents: any[] = [
      { text: prompt },
      ...base64DataArray.map((data) => ({
        inlineData: {
          mimeType: "image/jpeg",
          data: data,
        },
      })),
    ];

    const response = await ai.models.generateContent({
      model: model,
      contents: contents,
      config: {
        responseModalities: ["image"] as any,
      } as any,
    });

    console.log(
      "[Gemini] Image-to-image response:",
      JSON.stringify(response, null, 2),
    );

    // 提取图片数据
    if (response.candidates && response.candidates.length > 0) {
      const candidate = response.candidates[0];

      if (candidate.content?.parts) {
        for (const part of candidate.content.parts) {
          if (part.inlineData) {
            const mimeType = part.inlineData.mimeType || "image/png";
            const data = part.inlineData.data;
            return `data:${mimeType};base64,${data}`;
          }
        }
      }
    }

    console.error("[Gemini] Response structure:", {
      hasCandidates: !!response.candidates,
      candidatesLength: response.candidates?.length,
      firstCandidate: response.candidates?.[0],
    });

    throw new Error("未返回图片数据");
  } catch (error) {
    console.error("Gemini image-to-image error:", error);
    throw error;
  }
}
