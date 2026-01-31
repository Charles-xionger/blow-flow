import { NextRequest, NextResponse } from "next/server";
import { generateGenericVideo } from "@/lib/ai-services/video/generic";
import { generateAliyunKf2v } from "@/lib/ai-services/video/aliyun-wanx-kf2v";
import { generateGeminiStartEndVideo } from "@/lib/ai-services/video/gemini";
import { getModelConfig as getModelConfigFromDb } from "@/lib/db/model-configs";
import { getCacheKey, getCache, setCache } from "@/lib/db/cache";
import { getOSSClient } from "@/services/ossService";
import { getAllModels } from "@/lib/model-registry";
import type { ModelConfig } from "@/types";

interface StartEndToVideoRequest {
  prompt: string;
  startImage: string;
  endImage: string;
  model?: string;
  duration?: string | number;
  resolution?: "480P" | "720P" | "1080P";
  promptOptimize?: boolean;
}

async function getModelConfig(modelName: string): Promise<ModelConfig> {
  console.log("[API] Getting model config for:", modelName);

  // 优先从数据库读取
  const config = getModelConfigFromDb(modelName);
  if (config) {
    console.log("[API] Model config found in database:", {
      modelId: config.modelId,
      hasKey: !!config.key,
      baseUrl: config.baseUrl,
    });
    return config;
  }

  console.log("[API] Model not found in database, using environment variables");
  console.log("[API] Environment check:", {
    hasDefaultBaseUrl: !!process.env.DEFAULT_BASE_URL,
    hasDefaultApiKey: !!process.env.DEFAULT_API_KEY,
  });

  // 降级到环境变量
  return {
    modelId: modelName,
    baseUrl: process.env.DEFAULT_BASE_URL || "",
    key: process.env.DEFAULT_API_KEY || "",
    endpoint: "/v1/video/create",
    queryEndpoint: "/v1/video/query/{id}",
  };
}

/**
 * 判断是否为阿里云万相首尾帧模型
 */
function isAliyunKf2vModel(modelId: string): boolean {
  return modelId.includes("kf2v") || modelId.includes("wan2.2-kf2v");
}

export async function POST(request: NextRequest) {
  try {
    const body: StartEndToVideoRequest = await request.json();
    const {
      prompt,
      startImage,
      endImage,
      model = "Kling",
      duration = "5",
      resolution = "720P",
      promptOptimize = false,
    } = body;

    console.log("[API] Start-end-to-video request received:", {
      model,
      prompt: prompt?.substring(0, 50) + "...",
      hasStartImage: !!startImage,
      hasEndImage: !!endImage,
      duration,
      resolution,
      promptOptimize,
    });

    if (!prompt || !startImage || !endImage) {
      console.error("[API] Missing required fields:", {
        hasPrompt: !!prompt,
        hasStartImage: !!startImage,
        hasEndImage: !!endImage,
      });
      return NextResponse.json(
        {
          success: false,
          error: "Prompt, start image and end image are required",
        },
        { status: 400 },
      );
    }

    // 生成缓存键（在检查 Gemini 模型之前）
    const cacheKey = getCacheKey(model, prompt, {
      startImage,
      endImage,
      duration,
      resolution,
    });

    // 检查是否是 Gemini 模型
    const allModels = getAllModels();
    let modelDef = allModels[model];
    if (!modelDef) {
      modelDef = Object.values(allModels).find((m) => m.id === model);
    }

    const isGeminiModel = modelDef?.provider === "gemini";

    // 如果是 Gemini 模型，使用 SDK 直接生成
    if (isGeminiModel && modelDef) {
      console.log("[API] Using Gemini Veo SDK for model:", modelDef.id);

      try {
        // 调用 Gemini Veo SDK 生成视频（返回 Buffer）
        const videoBuffer = await generateGeminiStartEndVideo(
          modelDef.id,
          prompt,
          startImage,
          endImage,
          {
            aspectRatio: "16:9",
            duration: typeof duration === "number" ? `${duration}s` : duration,
          },
        );

        console.log("[API] Gemini Veo video generated, uploading to OSS...");

        // 上传到 OSS
        try {
          const ossClient = getOSSClient();
          const fileName = `veo-${Date.now()}.mp4`;
          const result = await ossClient.uploadBuffer(
            videoBuffer,
            "videos",
            fileName,
          );

          console.log("[API] Video uploaded to OSS successfully:", result.url);

          // 保存到缓存
          setCache(
            cacheKey,
            model,
            prompt,
            { startImage, endImage, duration, resolution },
            result.url,
            { ttl: 7200 },
          );

          return NextResponse.json({
            success: true,
            data: result.url,
            cached: false,
            provider: "gemini",
          });
        } catch (ossError) {
          console.error("[API] Failed to upload to OSS:", ossError);
          return NextResponse.json(
            {
              success: false,
              error: `Failed to upload video to OSS: ${ossError instanceof Error ? ossError.message : "Unknown error"}`,
            },
            { status: 500 },
          );
        }
      } catch (geminiError) {
        console.error("[API] Gemini Veo generation failed:", geminiError);
        return NextResponse.json(
          {
            success: false,
            error:
              geminiError instanceof Error
                ? geminiError.message
                : "Gemini Veo video generation failed",
          },
          { status: 500 },
        );
      }
    }

    console.log("[API] Fetching model config for:", model);
    const config = await getModelConfig(model);

    console.log("[API] Model config retrieved:", {
      modelId: config.modelId,
      baseUrl: config.baseUrl,
      hasKey: !!config.key,
      keyLength: config.key?.length || 0,
      endpoint: config.endpoint,
      queryEndpoint: config.queryEndpoint,
    });

    if (!config.key) {
      console.error("[API] No API key configured for model:", model);
      console.error("[API] Config details:", {
        modelId: config.modelId,
        baseUrl: config.baseUrl,
        endpoint: config.endpoint,
      });
      return NextResponse.json(
        { success: false, error: "API Key not configured for this model" },
        { status: 400 },
      );
    }

    // 检查缓存
    const cached = getCache(cacheKey);
    if (cached) {
      console.log("[API] Cache hit for start-end-to-video generation");
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

    // 根据模型类型选择不同的生成服务
    if (isAliyunKf2vModel(config.modelId)) {
      // 使用阿里云万相首尾帧专用服务
      console.log("[API] Using Aliyun Kf2v service for model:", config.modelId);
      const tempVideoUrl = await generateAliyunKf2v(
        config,
        finalPrompt,
        startImage,
        endImage,
        {
          resolution: resolution as "480P" | "720P" | "1080P",
          promptExtend: promptOptimize,
        },
      );

      // 下载并上传到自己的 OSS
      console.log(
        "[API] Downloading video from Aliyun and uploading to OSS...",
      );
      try {
        const ossClient = getOSSClient();
        const result = await ossClient.downloadAndUpload(
          tempVideoUrl,
          "videos",
          `kf2v-${Date.now()}.mp4`,
        );
        videoUrl = result.url;
        console.log("[API] Video uploaded to OSS successfully:", videoUrl);
      } catch (ossError) {
        console.error(
          "[API] Failed to upload to OSS, using temporary URL:",
          ossError,
        );
        // 如果 OSS 上传失败，降级使用临时 URL
        videoUrl = tempVideoUrl;
      }
    } else {
      // 使用通用视频生成服务
      console.log(
        "[API] Using generic video service for model:",
        config.modelId,
      );
      const durationStr =
        typeof duration === "number" ? `${duration}s` : duration;
      const tempVideoUrl = await generateGenericVideo(
        config,
        finalPrompt,
        "16:9",
        resolution.toLowerCase().replace("p", ""),
        durationStr,
        [startImage, endImage],
        true, // isStartEndMode
      );

      // 下载并上传到自己的 OSS
      console.log("[API] Downloading video and uploading to OSS...");
      try {
        const ossClient = getOSSClient();
        const result = await ossClient.downloadAndUpload(
          tempVideoUrl,
          "videos",
          `video-${Date.now()}.mp4`,
        );
        videoUrl = result.url;
        console.log("[API] Video uploaded to OSS successfully:", videoUrl);
      } catch (ossError) {
        console.error(
          "[API] Failed to upload to OSS, using temporary URL:",
          ossError,
        );
        videoUrl = tempVideoUrl;
      }
    }

    // 保存到缓存
    setCache(
      cacheKey,
      model,
      prompt,
      { startImage, endImage, duration, resolution },
      videoUrl,
      { ttl: 7200 },
    );

    return NextResponse.json({
      success: true,
      data: videoUrl,
      cached: false,
    });
  } catch (error) {
    console.error("[API] Start-end-to-video generation error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Start-end-to-video generation failed",
      },
      { status: 500 },
    );
  }
}
