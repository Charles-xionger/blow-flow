import { NextRequest, NextResponse } from "next/server";
import { generateGenericVideo } from "@/lib/ai-services/video/generic";
import {
  generateGeminiVideo,
  generateGeminiImageToVideo,
} from "@/lib/ai-services/video/gemini-veo";
import { getModelConfig as getModelConfigFromDb } from "@/lib/db/model-configs";
import { getCacheKey, getCache, setCache } from "@/lib/db/cache";
import { getOSSClient } from "@/services/ossService";
import { getAllModels } from "@/lib/model-registry";
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
  skipCache?: boolean; // 跳过缓存，强制重新生成
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
      skipCache = false,
    } = body;

    if (!prompt && inputImages.length === 0) {
      return NextResponse.json(
        { success: false, error: "Prompt or input image is required" },
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

    console.log("[API Video] Model check:", {
      model,
      hasModelDef: !!modelDef,
      modelDefId: modelDef?.id,
      isGeminiModel,
    });

    // Gemini 模型直接使用 SDK，不需要配置
    if (isGeminiModel && modelDef) {
      console.log("[API] Using Gemini SDK for video model:", modelDef.id);

      // 检查缓存
      if (!skipCache) {
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
      }

      // 提示词优化
      const finalPrompt = prompt;
      if (promptOptimize && prompt) {
        // TODO: 调用提示词优化服务
      }

      // 解析时长
      const durationSeconds = parseInt(duration.replace("s", "")) || 5;

      // 批量生成
      const results: string[] = [];
      for (let i = 0; i < count; i++) {
        // 生成视频（返回本地文件路径）
        let tempVideoPath: string;
        if (inputImages.length > 0) {
          // 图片转视频
          tempVideoPath = await generateGeminiImageToVideo(
            modelDef.id,
            finalPrompt,
            inputImages[0],
            durationSeconds,
            resolution,
            aspectRatio,
          );
        } else {
          // 文本生成视频
          tempVideoPath = await generateGeminiVideo(
            modelDef.id,
            finalPrompt,
            durationSeconds,
            resolution,
            aspectRatio,
          );
        }

        // 上传到 OSS
        let videoUrl = "";
        try {
          const ossClient = getOSSClient();
          const fs = await import("fs");
          const videoBuffer = fs.readFileSync(tempVideoPath);

          // 生成 OSS 对象键
          const objectKey = `generated/video-${Date.now()}_${i}.mp4`;

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

        results.push(videoUrl);
      }

      // 缓存结果
      if (!skipCache) {
        const cacheKey = getCacheKey(model, prompt, {
          aspectRatio,
          resolution,
          duration,
          inputImages,
          isStartEndMode,
        });
        setCache(
          cacheKey,
          model,
          finalPrompt,
          { aspectRatio, resolution, duration, inputImages, isStartEndMode },
          results,
        );
      }

      return NextResponse.json({
        success: true,
        data: results,
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
    }

    // 提示词优化（如果启用）
    const finalPrompt = prompt;
    if (promptOptimize && prompt) {
      // TODO: 调用提示词优化服务
    }

    // 批量生成
    const results: string[] = [];
    for (let i = 0; i < count; i++) {
      const tempVideoUrl = await generateGenericVideo(
        config,
        finalPrompt,
        aspectRatio,
        resolution,
        duration,
        inputImages,
        isStartEndMode,
      );

      // 下载并上传到自己的 OSS
      let videoUrl = tempVideoUrl;
      try {
        const ossClient = getOSSClient();
        const result = await ossClient.downloadAndUpload(
          tempVideoUrl,
          "videos",
          `text-video-${Date.now()}-${i}.mp4`,
        );
        videoUrl = result.url;
        console.log(`[API] Video ${i + 1}/${count} uploaded to OSS:`, videoUrl);
      } catch (ossError) {
        console.error(
          `[API] Failed to upload video ${i + 1} to OSS:`,
          ossError,
        );
        throw new Error("生成已完成，但原始素材保存失败；未将平台临时链接写入画布");
      }

      results.push(videoUrl);
    }

    // 保存到缓存（视频缓存2小时，因为生成耗时长）
    const cacheKey = getCacheKey(model, prompt, {
      aspectRatio,
      resolution,
      duration,
      inputImages,
      isStartEndMode,
    });
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
