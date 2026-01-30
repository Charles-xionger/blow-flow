import {
  constructUrl,
  fetchThirdParty,
  extractUrlFromContent,
} from "../network";
import type { ModelConfig } from "@/types";

export async function generateBananaImage(
  config: ModelConfig,
  prompt: string,
  aspectRatio: string,
  resolution: string,
  inputImages: string[] = [],
): Promise<string> {
  const hasInputImages = inputImages.length > 0;
  const needsHighRes = resolution !== "1k";

  // 自动选择端点格式
  let endpoint = config.endpoint;
  if (needsHighRes && endpoint.includes("/chat/completions")) {
    endpoint = `/v1beta/models/${config.modelId}:generateContent`;
  }

  const targetUrl = constructUrl(config.baseUrl, endpoint);
  const isNativeGemini = endpoint.includes("generateContent");

  if (isNativeGemini) {
    // Gemini 原生格式
    const parts: any[] = [];

    if (hasInputImages) {
      const imgData = inputImages[0];
      if (imgData.startsWith("data:")) {
        const [header, base64Data] = imgData.split(",");
        const mimeType = header.match(/data:([^;]+)/)?.[1] || "image/png";
        parts.push({
          inlineData: {
            mimeType,
            data: base64Data,
          },
        });
      }
      parts.push({
        text: `请根据这张参考图片进行创作。要求：${prompt}。输出比例：${aspectRatio}`,
      });
    } else {
      parts.push({ text: prompt });
    }

    const payload = {
      contents: [{ role: "user", parts }],
      generationConfig: {
        imageConfig: {
          imageSize: resolution.toUpperCase(),
          aspectRatio: aspectRatio.replace(":", "_"),
        },
      },
    };

    const res = await fetchThirdParty(targetUrl, "POST", payload, config.key);
    const content = res.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return extractUrlFromContent(content);
  } else {
    // OpenAI 格式
    const messages: any[] = [];

    if (hasInputImages) {
      messages.push({
        role: "user",
        content: [
          { type: "image_url", image_url: { url: inputImages[0] } },
          { type: "text", text: prompt },
        ],
      });
    } else {
      messages.push({ role: "user", content: prompt });
    }

    const payload = {
      model: config.modelId,
      messages,
      aspect_ratio: aspectRatio,
    };

    const res = await fetchThirdParty(targetUrl, "POST", payload, config.key);
    const content = res.choices?.[0]?.message?.content || "";
    return extractUrlFromContent(content);
  }
}
