import { NextRequest, NextResponse } from "next/server";
import { generateBananaImage } from "@/lib/ai-services/image/banana";
import { generateFluxImage } from "@/lib/ai-services/image/flux";
import { generateGenericImage } from "@/lib/ai-services/image/generic";
import { generateGeminiImageToImage } from "@/lib/ai-services/image/gemini";
import { getModelConfig as getModelConfigFromDb } from "@/lib/db/model-configs";
import { getCacheKey, getCache, setCache } from "@/lib/db/cache";
import { getOSSClient } from "@/services/ossService";
import { getAllModels } from "@/lib/model-registry";
import type { ModelConfig } from "@/types";

interface ImageToImageRequest {
  prompt: string;
  inputImage: string; // 保持兼容性
  inputImages?: string[]; // 支持多张输入图片
  model?: string;
  aspectRatio?: string;
  promptOptimize?: boolean;
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
    endpoint: "/v1/chat/completions",
  };
}

export async function POST(request: NextRequest) {
  try {
    const body: ImageToImageRequest = await request.json();
    const {
      prompt,
      inputImage,
      inputImages,
      model = "BananaPro",
      aspectRatio = "1:1",
      promptOptimize = false,
      skipCache = false,
    } = body;

    // 使用多张图片或单张图片
    const imagesToUse =
      inputImages && inputImages.length > 0 ? inputImages : [inputImage];

    if (!prompt || !inputImage) {
      return NextResponse.json(
        { success: false, error: "Prompt and input image are required" },
        { status: 400 },
      );
    }

    // 检查是否是 Gemini 模型
    const allModels = getAllModels();
    let modelDef = allModels[model]; // 首先用 key 查找

    // 如果用 key 找不到，尝试用 id 查找
    if (!modelDef) {
      modelDef = Object.values(allModels).find((m) => m.id === model);
    }

    const isGeminiModel = modelDef?.provider === "gemini";

    console.log("[API] Model check for image-to-image:", {
      model,
      modelDef: modelDef?.id,
      isGeminiModel,
    });

    // Gemini 模型直接使用 SDK，不需要配置
    if (isGeminiModel && modelDef) {
      console.log("[API] Using Gemini SDK for image-to-image:", modelDef.id);

      // 检查缓存（除非明确跳过）
      if (!skipCache) {
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
      }

      // 提示词优化
      const finalPrompt = prompt;
      if (promptOptimize && prompt) {
        // TODO: 调用提示词优化服务
      }

      // 使用 Gemini SDK 进行图生图
      const tempImageUrl = await generateGeminiImageToImage(
        modelDef.id,
        finalPrompt,
        imagesToUse,
      );

      // 下载并上传到 OSS
      let imageUrl = tempImageUrl;
      try {
        const ossClient = getOSSClient();
        const result = await ossClient.downloadAndUpload(
          tempImageUrl,
          "images",
          `i2i-${Date.now()}.png`,
        );
        imageUrl = result.url;
        console.log("[API] Image-to-image uploaded to OSS:", imageUrl);
      } catch (ossError) {
        console.error(
          "[API] Failed to upload image-to-image to OSS:",
          ossError,
        );
        // 降级使用临时 URL
      }

      // 保存到缓存
      if (!skipCache) {
        const cacheKey = getCacheKey(model, prompt, {
          inputImage,
          aspectRatio,
        });
        setCache(
          cacheKey,
          model,
          prompt,
          { inputImage, aspectRatio },
          imageUrl,
          {
            ttl: 300, // 5分钟缓存
          },
        );
      }

      return NextResponse.json({
        success: true,
        data: imageUrl,
        cached: false,
      });
    }

    // 非 Gemini 模型，需要从数据库获取配置
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

    // 智能选择生成函数
    const baseUrl = config.baseUrl.toLowerCase();

    if (model.includes("Banana")) {
      generateFn = generateBananaImage;
    } else if (baseUrl.includes("dashscope.aliyuncs.com")) {
      // 阿里云使用通用函数（支持 wan2.6 图生图）
      generateFn = generateGenericImage;
    } else if (model.toLowerCase().includes("flux")) {
      generateFn = generateFluxImage;
    } else {
      // 其他模型使用通用函数
      generateFn = generateGenericImage;
    }

    const tempImageUrl = await generateFn(
      config,
      finalPrompt,
      aspectRatio,
      "1k",
      [inputImage],
    );

    // 下载并上传到自己的 OSS
    let imageUrl = tempImageUrl;
    try {
      const ossClient = getOSSClient();
      const result = await ossClient.downloadAndUpload(
        tempImageUrl,
        "images",
        `i2i-${Date.now()}.png`,
      );
      imageUrl = result.url;
      console.log("[API] Image-to-image uploaded to OSS:", imageUrl);
    } catch (ossError) {
      console.error("[API] Failed to upload image-to-image to OSS:", ossError);
      // 降级使用临时 URL
    }

    // 保存到缓存（图生图使用较短的缓存时间，因为用户通常期望每次生成都是新的）
    if (!skipCache) {
      const cacheKey = getCacheKey(model, prompt, {
        inputImage,
        aspectRatio,
      });
      setCache(cacheKey, model, prompt, { inputImage, aspectRatio }, imageUrl, {
        ttl: 300, // 5分钟缓存，避免短时间内重复请求
      });
    }

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
