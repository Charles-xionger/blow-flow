import { NextRequest, NextResponse } from "next/server";
import { generateBananaImage } from "@/lib/ai-services/image/banana";
import { generateFluxImage } from "@/lib/ai-services/image/flux";
import { generateGenericImage } from "@/lib/ai-services/image/generic";
import {
  generateGeminiImage,
  generateGeminiImageToImage,
} from "@/lib/ai-services/image/gemini";
import { getModelConfig as getModelConfigFromDb } from "@/lib/db/model-configs";
import { getCacheKey, getCache, setCache } from "@/lib/db/cache";
import { getOSSClient } from "@/services/ossService";
import { getAllModels } from "@/lib/model-registry";
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
  console.log("[API] Getting config for model:", modelName);

  // 优先从数据库读取
  const config = getModelConfigFromDb(modelName);
  if (config) {
    console.log("[API] Found config in database:", {
      modelId: config.modelId,
      baseUrl: config.baseUrl,
      endpoint: config.endpoint,
      hasKey: !!config.key,
    });
    return config;
  }

  console.log("[API] No config in database, using fallback");

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

    // 检查是否是 Gemini 模型
    const allModels = getAllModels();
    let modelDef = allModels[model] as (typeof allModels)[string] | undefined; // 首先用 key 查找

    // 如果用 key 找不到，尝试用 id 查找
    if (!modelDef) {
      modelDef = Object.values(allModels).find((m) => m.id === model);
    }

    const isGeminiModel = modelDef?.provider === "gemini";

    console.log("[API] Model check:", {
      model,
      modelDef: modelDef?.id,
      isGeminiModel,
    });

    // Gemini 模型直接使用 SDK，不需要配置
    if (isGeminiModel && modelDef) {
      console.log("[API] Using Gemini SDK for model:", modelDef.id);

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

      // 提示词优化
      const finalPrompt = prompt;
      if (promptOptimize && prompt) {
        // TODO: 调用提示词优化服务
      }

      // 批量生成
      const results: string[] = [];
      for (let i = 0; i < count; i++) {
        let tempImageUrl: string;

        if (inputImages.length > 0) {
          // 图片转图片
          tempImageUrl = await generateGeminiImageToImage(
            modelDef.id,
            finalPrompt,
            inputImages[0],
          );
        } else {
          // 文本生成图片
          tempImageUrl = await generateGeminiImage(
            modelDef.id,
            finalPrompt,
            aspectRatio,
            resolution,
          );
        }

        // 下载并上传到 OSS
        let imageUrl = tempImageUrl;
        try {
          const ossClient = getOSSClient();
          const result = await ossClient.downloadAndUpload(
            tempImageUrl,
            "generated",
            `${Date.now()}_${i}.png`,
          );
          imageUrl = result.url;
          console.log(
            `[API] OSS 上传成功: ${imageUrl}, 大小: ${result.size} 字节`,
          );
        } catch (ossError) {
          console.warn(
            "[API] OSS upload failed, using original URL:",
            ossError,
          );
        }

        results.push(imageUrl);
      }

      // 缓存结果
      setCache(
        cacheKey,
        model,
        finalPrompt,
        { aspectRatio, resolution, inputImages },
        results,
      );

      return NextResponse.json({
        success: true,
        data: results,
      });
    }

    // 非 Gemini 模型，需要从数据库获取配置
    const config = await getModelConfig(model);

    console.log("[API] Image generation config:", {
      model,
      hasConfig: !!config,
      modelId: config?.modelId,
      baseUrl: config?.baseUrl,
      endpoint: config?.endpoint,
      hasKey: !!config?.key,
    });

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
    const finalPrompt = promptOptimize && prompt ? prompt : prompt;
    // TODO: 调用提示词优化服务

    // 根据模型选择生成函数
    let generateFn: (
      config: ModelConfig,
      prompt: string,
      aspectRatio: string,
      resolution: string,
      inputImages: string[],
    ) => Promise<string>;

    // 智能选择生成函数
    const baseUrl = config.baseUrl.toLowerCase();

    if (model.includes("Banana") && !isGeminiModel) {
      // Banana 系列模型使用专用函数（排除 Nano Banana）
      generateFn = generateBananaImage;
    } else if (baseUrl.includes("dashscope.aliyuncs.com")) {
      // 阿里云使用通用函数
      generateFn = generateGenericImage;
    } else if (model.toLowerCase().includes("flux")) {
      // Flux 系列使用专用函数
      generateFn = generateFluxImage;
    } else {
      // 其他模型使用通用函数（支持标准 OpenAI 格式）
      generateFn = generateGenericImage;
    }

    // 批量生成
    const results: string[] = [];
    for (let i = 0; i < count; i++) {
      const tempImageUrl = await generateFn(
        config,
        finalPrompt,
        aspectRatio,
        resolution,
        inputImages,
      );

      // 下载并上传到自己的 OSS
      let imageUrl = tempImageUrl;
      try {
        const ossClient = getOSSClient();
        const result = await ossClient.downloadAndUpload(
          tempImageUrl,
          "images",
          `image-${Date.now()}-${i}.png`,
        );
        imageUrl = result.url;
        console.log(`[API] Image ${i + 1}/${count} uploaded to OSS:`, imageUrl);
      } catch (ossError) {
        console.error(
          `[API] Failed to upload image ${i + 1} to OSS:`,
          ossError,
        );
        // 降级使用临时 URL
      }

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
