import { NextRequest, NextResponse } from "next/server";
import { generateGenericVideo } from "@/lib/ai-services/video/generic";
import { getModelConfig as getModelConfigFromDb } from "@/lib/db/model-configs";
import { getCacheKey, getCache, setCache } from "@/lib/db/cache";
import type { ModelConfig } from "@/types";

interface ImageToVideoRequest {
  prompt: string;
  inputImage: string;
  model?: string;
  duration?: string;
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
    endpoint: "/v1/video/create",
    queryEndpoint: "/v1/video/query/{id}",
  };
}

export async function POST(request: NextRequest) {
  try {
    const body: ImageToVideoRequest = await request.json();
    const {
      prompt,
      inputImage,
      model = "Kling",
      duration = "5s",
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
      duration,
    });

    const cached = getCache(cacheKey);
    if (cached) {
      console.log("[API] Cache hit for image-to-video generation");
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

    const videoUrl = await generateGenericVideo(
      config,
      finalPrompt,
      "16:9",
      "720p",
      duration,
      [inputImage],
      false,
    );

    // 保存到缓存
    setCache(cacheKey, model, prompt, { inputImage, duration }, videoUrl, {
      ttl: 7200,
    });

    return NextResponse.json({
      success: true,
      data: videoUrl,
      cached: false,
    });
  } catch (error) {
    console.error("[API] Image-to-video generation error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Image-to-video generation failed",
      },
      { status: 500 },
    );
  }
}
