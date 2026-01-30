import { NextRequest, NextResponse } from "next/server";
import { generateBananaImage } from "@/lib/ai-services/image/banana";
import { generateFluxImage } from "@/lib/ai-services/image/flux";
import { getModelConfig as getModelConfigFromDb } from "@/lib/db/model-configs";
import { getCacheKey, getCache, setCache } from "@/lib/db/cache";
import type { ModelConfig } from "@/types";

interface GenerateImageRequest {
  prompt: string;
  model?: string;
  aspectRatio?: string;
  resolution?: string;
  count?: number;
  inputImages?: string[];
  promptOptimize?: boolean;
}

// 从数据库或配置中获取模型配置
async function getModelConfig(modelName: string): Promise<ModelConfig> {
  // 优先从数据库读取
  const config = getModelConfigFromDb(modelName);
  if (config) {
    return config;
  }

  // 降级到环境变量（用于首次使用或测试）
  return {
    modelId: modelName,
    baseUrl: process.env.DEFAULT_BASE_URL || "",
    key: process.env.DEFAULT_API_KEY || "",
    endpoint: "/v1/chat/completions",
  };
}

export async function POST(request: NextRequest) {
  try {
    const body: GenerateImageRequest = await request.json();
    const {
      prompt,
      model = "BananaPro",
      aspectRatio = "1:1",
      resolution = "1k",
      count = 1,
      inputImages = [],
      promptOptimize = false,
    } = body;

    if (!prompt && inputImages.length === 0) {
      return NextResponse.json(
        { success: false, error: "Prompt or input image is required" },
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
      aspectRatio,
      resolution,
      inputImages,
    });

    const cached = getCache(cacheKey);
    if (cached) {
      console.log("[API] Cache hit for image generation");
      return NextResponse.json({
        success: true,
        data: cached,
        cached: true,
      });
    }

    // 提示词优化（如果启用）
    let finalPrompt = prompt;
    if (promptOptimize && prompt) {
      // TODO: 调用提示词优化服务
    }

    // 根据模型选择生成函数
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

    // 批量生成
    const results: string[] = [];
    for (let i = 0; i < count; i++) {
      const imageUrl = await generateFn(
        config,
        finalPrompt,
        aspectRatio,
        resolution,
        inputImages,
      );
      results.push(imageUrl);
    }

    // 保存到缓存（1小时）
    setCache(
      cacheKey,
      model,
      prompt,
      { aspectRatio, resolution, inputImages },
      results,
      { ttl: 3600 },
    );

    return NextResponse.json({
      success: true,
      data: results,
      cached: false,
    });
  } catch (error: any) {
    console.error("[API] Image generation error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Image generation failed",
      },
      { status: 500 },
    );
  }
}
