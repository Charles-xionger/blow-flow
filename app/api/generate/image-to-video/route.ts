import { NextRequest, NextResponse } from "next/server";
import { generateGenericVideo } from "@/lib/ai-services/video/generic";
import { generateAliyunWanxVideo } from "@/lib/ai-services/video/aliyun-wanx";
import { getModelConfig as getModelConfigFromDb } from "@/lib/db/model-configs";
import { getCacheKey, getCache, setCache } from "@/lib/db/cache";
import type { ModelConfig } from "@/types";

interface ImageToVideoRequest {
  prompt: string;
  inputImage: string;
  model?: string;
  duration?: string | number;
  resolution?: string;
  promptOptimize?: boolean;
  audioUrl?: string;
  negativePrompt?: string;
  watermark?: boolean;
  shotType?: "single" | "multi";
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
    baseUrl:
      process.env.ALIYUN_WANX_BASE_URL ||
      process.env.DEFAULT_BASE_URL ||
      "https://dashscope.aliyuncs.com",
    key: process.env.ALIYUN_WANX_API_KEY || process.env.DEFAULT_API_KEY || "",
    endpoint: "/api/v1/services/aigc/video-generation/video-synthesis",
    queryEndpoint: "/api/v1/tasks/{task_id}",
  };
}

export async function POST(request: NextRequest) {
  try {
    const body: ImageToVideoRequest = await request.json();
    const {
      prompt,
      inputImage,
      model = "wan2.6-i2v-flash",
      duration = 10,
      resolution = "720P",
      promptOptimize = false,
      audioUrl,
      negativePrompt = "",
      watermark = false,
      shotType,
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

    let videoUrl: string;

    // 判断是否是阿里云万相模型
    const isAliyunWanx =
      model.startsWith("wan") ||
      model.includes("wanx") ||
      model.includes("aliyun");

    if (isAliyunWanx) {
      // 使用阿里云万相 API
      const durationNum =
        typeof duration === "string" ? parseInt(duration) : duration;

      videoUrl = await generateAliyunWanxVideo(
        config,
        finalPrompt,
        inputImage,
        {
          resolution,
          duration: durationNum,
          promptExtend: promptOptimize,
          watermark,
          negativePrompt,
          audioUrl,
          shotType,
        },
      );
    } else {
      // 使用通用视频生成 API
      const durationStr =
        typeof duration === "number" ? `${duration}s` : duration;

      videoUrl = await generateGenericVideo(
        config,
        finalPrompt,
        "16:9",
        resolution || "720p",
        durationStr,
        [inputImage],
        false,
      );
    }

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
