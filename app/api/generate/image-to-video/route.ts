import { NextRequest, NextResponse } from "next/server";
import { generateGenericVideo } from "@/lib/ai-services/video/generic";
import { generateAliyunWanxVideo } from "@/lib/ai-services/video/aliyun-wanx";
import { generateGeminiImageToVideo } from "@/lib/ai-services/video/gemini-veo";
import { getModelConfig as getModelConfigFromDb } from "@/lib/db/model-configs";
import { getCacheKey, getCache, setCache } from "@/lib/db/cache";
import { getOSSClient } from "@/services/ossService";
import { getAllModels } from "@/lib/model-registry";
import type { ModelConfig } from "@/types";

interface ImageToVideoRequest {
  prompt: string;
  inputImage: string;
  model?: string;
  duration?: string | number;
  resolution?: string;
  aspectRatio?: string;
  promptOptimize?: boolean;
  audioUrl?: string;
  negativePrompt?: string;
  watermark?: boolean;
  shotType?: "single" | "multi";
  skipCache?: boolean; // 跳过缓存，强制重新生成
}

async function getModelConfig(modelName: string): Promise<ModelConfig> {
  // 如果是万相模型，使用统一的配置 key
  const configKey = modelName.startsWith("wan2.6")
    ? "阿里云百炼-万相"
    : modelName;

  // 优先从数据库读取
  const config = getModelConfigFromDb(configKey);
  if (config) {
    return {
      ...config,
      modelId: modelName, // 保持实际的模型 ID
    };
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
      aspectRatio = "16:9",
      promptOptimize = false,
      audioUrl,
      negativePrompt = "",
      watermark = false,
      shotType,
      skipCache = false,
    } = body;

    if (!prompt || !inputImage) {
      return NextResponse.json(
        { success: false, error: "Prompt and input image are required" },
        { status: 400 },
      );
    }

    // 检查是否是 Gemini 模型
    const allModels = getAllModels();
    let modelDef = allModels[model] as (typeof allModels)[string] | undefined; // 首先用 key 查找

    // 如果用 key 找不到，尝试用 id 查找
    if (!modelDef) {
      modelDef = Object.values(allModels).find((m) => m.id === model);
    }

    const isGeminiModel = modelDef?.provider === "gemini";

    console.log("[API Image-to-Video] Model check:", {
      model,
      hasModelDef: !!modelDef,
      modelDefId: modelDef?.id,
      isGeminiModel,
    });

    // Gemini 模型直接使用 SDK，不需要配置
    if (isGeminiModel && modelDef) {
      console.log("[API] Using Gemini SDK for image-to-video:", modelDef.id);

      // 检查缓存
      if (!skipCache) {
        const cacheKey = getCacheKey(model, prompt, {
          inputImage,
          duration,
          resolution,
          aspectRatio,
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
      }

      // 解析时长
      const durationSeconds =
        typeof duration === "number"
          ? duration
          : parseInt(String(duration).replace("s", "")) || 10;

      // 生成视频（返回本地文件路径）
      const tempVideoPath = await generateGeminiImageToVideo(
        modelDef.id,
        prompt,
        inputImage,
        durationSeconds,
        resolution,
        aspectRatio,
      );

      // 上传到 OSS
      let videoUrl = "";
      try {
        const ossClient = getOSSClient();
        const fs = await import("fs");
        const videoBuffer = fs.readFileSync(tempVideoPath);

        // 生成 OSS 对象键
        const objectKey = `generated/video-${Date.now()}.mp4`;

        // 上传视频
        const result = await ossClient.uploadObject(objectKey, videoBuffer, {
          "Content-Type": "video/mp4",
        });
        videoUrl = result.url;

        // 清理临时文件
        fs.unlinkSync(tempVideoPath);

        console.log("[API] Video uploaded to OSS successfully:", videoUrl);
      } catch (ossError) {
        console.error("[API] OSS upload failed:", ossError);
        throw new Error(
          `Failed to upload video to OSS: ${ossError instanceof Error ? ossError.message : "Unknown error"}`,
        );
      }

      // 缓存结果
      if (!skipCache) {
        const cacheKey = getCacheKey(model, prompt, {
          inputImage,
          duration,
          resolution,
          aspectRatio,
        });
        setCache(
          cacheKey,
          model,
          prompt,
          { inputImage, duration, resolution, aspectRatio },
          [videoUrl],
        );
      }

      return NextResponse.json({
        success: true,
        data: [videoUrl],
      });
    }

    // 非 Gemini 模型，使用原有逻辑
    const config = await getModelConfig(model);

    if (!config.key) {
      return NextResponse.json(
        { success: false, error: "API Key not configured for this model" },
        { status: 400 },
      );
    }

    // 检查缓存（除非明确跳过）
    if (!skipCache) {
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
    }

    // 生成缓存键
    const cacheKey = `${model}:${prompt}:${JSON.stringify({ inputImage, duration })}`;

    const finalPrompt = prompt;
    if (promptOptimize && prompt) {
      // TODO: 调用提示词优化服务
    }

    let videoUrl: string;

    // 判断是否是阿里云万相模型（检查 modelId 而不是 model 名称）
    const isAliyunWanx =
      config.modelId.startsWith("wan") ||
      config.modelId.includes("wanx") ||
      config.modelId.includes("aliyun");

    console.log("[API] Model detection:", {
      model,
      modelId: config.modelId,
      isAliyunWanx,
    });

    if (isAliyunWanx) {
      // 使用阿里云万相 API
      console.log("[API] Using Aliyun Wanx service for i2v");
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

    // 将视频保存到 OSS（从临时 URL 下载并上传）
    let persistedVideoUrl = videoUrl;
    try {
      const oss = getOSSClient();
      const result = await oss.downloadAndUpload(
        videoUrl,
        "videos",
        `video-${Date.now()}.mp4`,
      );
      persistedVideoUrl = result.url;
      console.log("[API] Video persisted to OSS:", persistedVideoUrl);

      // 更新缓存为持久化 URL
      setCache(
        cacheKey,
        model,
        prompt,
        { inputImage, duration },
        persistedVideoUrl,
        {
          ttl: 7200,
        },
      );
    } catch (ossError) {
      // OSS 保存失败不影响返回原始 URL
      console.error("[API] Failed to persist video to OSS:", ossError);
    }

    return NextResponse.json({
      success: true,
      data: persistedVideoUrl,
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
