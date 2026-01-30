import { NextRequest, NextResponse } from "next/server";
import { generateGenericVideo } from "@/lib/ai-services/video/generic";
import { getModelConfig as getModelConfigFromDb } from "@/lib/db/model-configs";
import { getCacheKey, getCache, setCache } from "@/lib/db/cache";
import type { ModelConfig } from "@/types";

interface GenerateVideoRequest {
  prompt: string;
  model?: string;
  aspectRatio?: string;
  resolution?: string;
  duration?: string;
  count?: number;
  inputImages?: string[];
  promptOptimize?: boolean;
  isStartEndMode?: boolean;
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
    endpoint: "/v1/video/create",
    queryEndpoint: "/v1/video/query/{id}",
  };
}

export async function POST(request: NextRequest) {
  try {
    const body: GenerateVideoRequest = await request.json();
    const {
      prompt,
      model = "Sora 2",
      aspectRatio = "16:9",
      resolution = "720p",
      duration = "5s",
      count = 1,
      inputImages = [],
      promptOptimize = false,
      isStartEndMode = false,
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
      duration,
      inputImages,
      isStartEndMode,
    });

    const cached = getCache(cacheKey);
    if (cached) {
      console.log("[API] Cache hit for video generation");
      return NextResponse.json({
        success: true,
        data: cached,
        cached: true,
      });
    }

    // 提示词优化（如果启用）
    const finalPrompt = prompt;
    if (promptOptimize && prompt) {
      // TODO: 调用提示词优化服务
    }

    // 批量生成
    const results: string[] = [];
    for (let i = 0; i < count; i++) {
      const videoUrl = await generateGenericVideo(
        config,
        finalPrompt,
        aspectRatio,
        resolution,
        duration,
        inputImages,
        isStartEndMode,
      );
      results.push(videoUrl);
    }

    // 保存到缓存（视频缓存2小时，因为生成耗时长）
    setCache(
      cacheKey,
      model,
      prompt,
      { aspectRatio, resolution, duration, inputImages, isStartEndMode },
      results,
      { ttl: 7200 },
    );

    return NextResponse.json({
      success: true,
      data: results,
      cached: false,
    });
  } catch (error) {
    console.error("[API] Video generation error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Video generation failed",
      },
      { status: 500 },
    );
  }
}
