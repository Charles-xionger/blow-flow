import { NextRequest, NextResponse } from "next/server";
import { generateBananaImage } from "@/lib/ai-services/image/banana";
import { generateFluxImage } from "@/lib/ai-services/image/flux";
import { getModelConfig as getModelConfigFromDb } from "@/lib/db/model-configs";
import { getCacheKey, getCache, setCache } from "@/lib/db/cache";
import type { ModelConfig } from "@/types";

interface ImageToImageRequest {
  prompt: string;
  inputImage: string;
  model?: string;
  aspectRatio?: string;
  promptOptimize?: boolean;
}

async function getModelConfig(modelName: string): Promise<ModelConfig> {
  // 优先从数据库读取
  const config = getModelConfigFromDb(modelName);
  if (config) {
    return config;
  }

  // 降级到环境变量
  return {
    modelId: modelName,
    baseUrl: process.env.DEFAULT_BASE_URL || "",
    key: process.env.DEFAULT_API_KEY || "",
    endpoint: "/v1/chat/completions",
  };
}

export async function POST(request: NextRequest) {
  try {
    const body: ImageToImageRequest = await request.json();
    const {
      prompt,
      inputImage,
      model = "BananaPro",
      aspectRatio = "1:1",
      promptOptimize = false,
    } = body;

    if (!prompt || !inputImage) {
      return NextResponse.json(
        { success: false, error: "Prompt and input image are required" },
        { status: 400 },
      );
    }

    const config = await getModelConfig(model);

    if (!config.key) {
      return NextResponse.json(
        { success: false, error: "API Key not configured for this model" },
        { status: 400 },
      );
    }

    // 检查缓存
    const cacheKey = getCacheKey(model, prompt, {
      inputImage,
      aspectRatio,
    });

    const cached = getCache(cacheKey);
    if (cached) {
      console.log("[API] Cache hit for image-to-image generation");
      return NextResponse.json({
        success: true,
        data: cached,
        cached: true,
      });
    }

    const finalPrompt = prompt;
    if (promptOptimize && prompt) {
      // TODO: 调用提示词优化服务
    }

    let generateFn: (
      config: ModelConfig,
      prompt: string,
      aspectRatio: string,
      resolution: string,
      inputImages: string[],
    ) => Promise<string>;

    if (model.includes("Banana")) {
      generateFn = generateBananaImage;
    } else {
      generateFn = generateFluxImage;
    }

    const imageUrl = await generateFn(config, finalPrompt, aspectRatio, "1k", [
      inputImage,
    ]);

    // 保存到缓存
    setCache(cacheKey, model, prompt, { inputImage, aspectRatio }, imageUrl, {
      ttl: 3600,
    });

    return NextResponse.json({
      success: true,
      data: imageUrl,
      cached: false,
    });
  } catch (error) {
    console.error("[API] Image-to-image generation error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Image-to-image generation failed",
      },
      { status: 500 },
    );
  }
}
