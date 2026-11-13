/**
 * Google Gemini 文本生成服务
 * 使用 @google/genai SDK
 */
import { GoogleGenAI } from "@google/genai";

// 从环境变量获取 API Key
const getApiKey = () => {
  return process.env.GEMINI_API_KEY || "";
};

/**
 * 生成文本内容
 * @param model 模型名称 (如 "gemini-3-pro-preview")
 * @param prompt 提示词
 * @returns 生成的文本
 */
export async function generateGeminiText(
  model: string,
  prompt: string,
): Promise<string> {
  const apiKey = getApiKey();

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not found in environment variables");
  }

  try {
    // 初始化客户端
    const ai = new GoogleGenAI({ apiKey });

    // 调用生成接口
    const response = await ai.models.generateContent({
      model: model,
      contents: prompt,
    });

    // 返回生成的文本
    return response.text || "";
  } catch (error) {
    console.error("Gemini text generation error:", error);
    throw error;
  }
}

/**
 * 流式生成文本内容
 * @param model 模型名称
 * @param prompt 提示词
 * @param onChunk 接收文本块的回调函数
 */
export async function streamGeminiText(
  model: string,
  prompt: string,
  onChunk: (text: string) => void,
): Promise<void> {
  const apiKey = getApiKey();

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not found in environment variables");
  }

  try {
    const ai = new GoogleGenAI({ apiKey });

    const stream = await ai.models.generateContentStream({
      model: model,
      contents: prompt,
    });

    // 处理流式响应
    for await (const chunk of stream) {
      if (chunk.text) {
        onChunk(chunk.text);
      }
    }
  } catch (error) {
    console.error("Gemini stream generation error:", error);
    throw error;
  }
}
