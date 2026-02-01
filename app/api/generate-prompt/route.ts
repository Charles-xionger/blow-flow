import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { getAllModelConfigs } from "@/lib/db/model-configs";
import { getModelsByCategory } from "@/lib/model-registry";

interface GeneratePromptRequest {
  nodeType: "startEndToVideo" | "imageToVideo" | "textToVideo" | "textToImage";
  currentPrompt?: string;
  context: {
    // For startEndToVideo
    startImage?: string;
    endImage?: string;
    duration?: string;
    resolution?: string;

    // For imageToVideo
    inputImage?: string;

    // For textToVideo
    aspectRatio?: string;

    // Common
    model?: string;
  };
}

export async function POST(request: NextRequest) {
  try {
    const body: GeneratePromptRequest = await request.json();
    const { nodeType, currentPrompt, context } = body;

    if (!nodeType) {
      return NextResponse.json(
        { success: false, error: "nodeType is required" },
        { status: 400 },
      );
    }

    console.log("[API] Generate prompt request:", { nodeType, context });

    // 获取所有配置的模型
    const allConfigs = await getAllModelConfigs();
    const textModels = getModelsByCategory("TEXT");

    // 查找可用的 Gemini 文本模型
    let selectedModel = "gemini-2.5-pro";
    let apiKey: string | undefined;

    // 优先使用数据库配置的模型
    if (allConfigs && Object.keys(allConfigs).length > 0) {
      // 查找 Gemini 模型
      for (const [name, config] of Object.entries(allConfigs)) {
        // 跳过非 TEXT 类别的模型（这里目前只有 IMAGE 和 VIDEO）
        if (
          name.toLowerCase().includes("gemini") ||
          config.modelId?.toLowerCase().includes("gemini")
        ) {
          selectedModel = config.modelId || name;
          apiKey = config.key;
          console.log(`[API] Using configured Gemini model: ${selectedModel}`);
          break;
        }
      }
    }

    // 如果没找到配置的模型，使用内置模型
    if (!apiKey) {
      const geminiModel = textModels.find((m) =>
        m.id.toLowerCase().includes("gemini"),
      );
      if (geminiModel) {
        selectedModel = geminiModel.id;
      }
      // 从环境变量获取 API Key
      apiKey = process.env.GEMINI_API_KEY;
    }

    if (!apiKey) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Gemini API key not found. Please set GEMINI_API_KEY environment variable.",
        },
        { status: 400 },
      );
    }

    // 根据节点类型生成系统提示
    const systemPrompt = generateSystemPrompt(nodeType, currentPrompt, context);

    console.log("[API] Using model:", selectedModel);
    console.log("[API] System prompt length:", systemPrompt.length);

    // 使用 Gemini SDK 生成提示词
    const ai = new GoogleGenAI({ apiKey, apiVersion: "v1alpha" });

    // 准备内容，如果有图片则包含图片数据
    const contents = await prepareContents(systemPrompt, nodeType, context);

    const result = await ai.models.generateContent({
      model: selectedModel,
      contents: [{ parts: contents }],
    });
    const generatedPrompt = result.text || "";

    console.log("[API] Generated prompt:", generatedPrompt);

    return NextResponse.json({
      success: true,
      data: generatedPrompt,
      model: selectedModel,
    });
  } catch (error: any) {
    console.error("[API] Prompt generation error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Failed to generate prompt",
      },
      { status: 500 },
    );
  }
}

async function prepareContents(
  systemPrompt: string,
  nodeType: string,
  context: any,
) {
  const parts: any[] = [{ text: systemPrompt }];

  // 根据节点类型添加相应的图片
  if (nodeType === "startEndToVideo") {
    if (context.startImage) {
      const imageData = await getImageData(context.startImage);
      if (imageData) {
        parts.push({
          text: "\n\nStart Frame Image:",
        });
        parts.push({
          inlineData: {
            mimeType: imageData.mimeType,
            data: imageData.base64Data,
          },
          mediaResolution: {
            level: "media_resolution_high",
          },
        });
      }
    }
    if (context.endImage) {
      const imageData = await getImageData(context.endImage);
      if (imageData) {
        parts.push({
          text: "\n\nEnd Frame Image:",
        });
        parts.push({
          inlineData: {
            mimeType: imageData.mimeType,
            data: imageData.base64Data,
          },
          mediaResolution: {
            level: "media_resolution_high",
          },
        });
      }
    }
  } else if (nodeType === "imageToVideo" && context.inputImage) {
    const imageData = await getImageData(context.inputImage);
    if (imageData) {
      parts.push({
        text: "\n\nInput Image:",
      });
      parts.push({
        inlineData: {
          mimeType: imageData.mimeType,
          data: imageData.base64Data,
        },
        mediaResolution: {
          level: "media_resolution_high",
        },
      });
    }
  }

  return parts;
}

async function getImageData(imageSource: string): Promise<{
  mimeType: string;
  base64Data: string;
} | null> {
  try {
    // 情况1: data URL 格式 (data:image/jpeg;base64,...)
    if (imageSource.startsWith("data:")) {
      const match = imageSource.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        return {
          mimeType: match[1],
          base64Data: match[2],
        };
      }
    }

    // 情况2: HTTP/HTTPS URL，需要下载并转换为 base64
    if (
      imageSource.startsWith("http://") ||
      imageSource.startsWith("https://")
    ) {
      console.log("[API] Downloading image from URL:", imageSource);
      const response = await fetch(imageSource);
      if (!response.ok) {
        console.error("[API] Failed to download image:", response.statusText);
        return null;
      }

      // 从 URL 推断 MIME 类型
      let mimeType = response.headers.get("content-type") || "";

      // 如果 Content-Type 不可靠，从文件扩展名推断
      if (!mimeType || mimeType === "application/octet-stream") {
        mimeType = getMimeTypeFromUrl(imageSource);
      }

      // 将图片转换为 base64
      const arrayBuffer = await response.arrayBuffer();
      const base64Data = Buffer.from(arrayBuffer).toString("base64");

      console.log(
        "[API] Image downloaded and converted to base64, size:",
        base64Data.length,
        "mimeType:",
        mimeType,
      );
      return {
        mimeType,
        base64Data,
      };
    }

    // 情况3: 纯 base64 字符串（不推荐，但作为兜底）
    // 假设是 JPEG 格式
    console.log("[API] Treating as raw base64 data");
    return {
      mimeType: "image/jpeg",
      base64Data: imageSource,
    };
  } catch (error) {
    console.error("[API] Error processing image:", error);
    return null;
  }
}

function getMimeTypeFromUrl(url: string): string {
  const lowerUrl = url.toLowerCase();

  if (lowerUrl.includes(".png")) {
    return "image/png";
  } else if (lowerUrl.includes(".jpg") || lowerUrl.includes(".jpeg")) {
    return "image/jpeg";
  } else if (lowerUrl.includes(".gif")) {
    return "image/gif";
  } else if (lowerUrl.includes(".webp")) {
    return "image/webp";
  } else if (lowerUrl.includes(".bmp")) {
    return "image/bmp";
  } else if (lowerUrl.includes(".svg")) {
    return "image/svg+xml";
  }

  // 默认返回 jpeg
  return "image/jpeg";
}

function generateSystemPrompt(
  nodeType: string,
  currentPrompt: string | undefined,
  context: any,
): string {
  const hasExistingPrompt = !!(
    currentPrompt && currentPrompt.trim().length > 0
  );

  switch (nodeType) {
    case "startEndToVideo":
      return generateStartEndToVideoPrompt(
        currentPrompt,
        hasExistingPrompt,
        context,
      );

    case "imageToVideo":
      return generateImageToVideoPrompt(
        currentPrompt,
        hasExistingPrompt,
        context,
      );

    case "textToVideo":
      return generateTextToVideoPrompt(
        currentPrompt,
        hasExistingPrompt,
        context,
      );

    case "textToImage":
      return generateTextToImagePrompt(
        currentPrompt,
        hasExistingPrompt,
        context,
      );

    default:
      return "Generate a creative and detailed prompt for video generation.";
  }
}

function generateStartEndToVideoPrompt(
  currentPrompt: string | undefined,
  hasExistingPrompt: boolean,
  context: any,
): string {
  const duration = context.duration || "5";
  const resolution = context.resolution || "720P";
  const hasImages = context.startImage && context.endImage;

  if (hasExistingPrompt) {
    return `You are a professional video production expert specializing in camera movements and transitions.

The user has provided an initial prompt: "${currentPrompt}"

${hasImages ? "Analyze the provided start and end frame images carefully." : ""}

Task: Enhance this prompt with professional cinematography details for a start-frame to end-frame video transition.

Video Specifications:
- Duration: ${duration} seconds
- Resolution: ${resolution}
- Type: Transition from start frame to end frame

Requirements:
1. ${hasImages ? "Based on the visual content of the images, describe the transition between the two frames" : "Keep the original creative intent but make it more professional"}
2. Add specific camera movements (e.g., "smooth dolly forward", "pan left to right", "crane up")
3. Include transition pacing for ${duration} seconds (${duration === "5" ? "quick, dynamic" : "smooth, gradual"})
4. ${hasImages ? "Describe how elements in the start frame transform or move to become the end frame" : "Add lighting or atmosphere transitions if applicable"}
5. Use cinematic terminology
6. Output ONLY the enhanced prompt in English, no explanations

Enhanced Prompt:`;
  }

  return `You are a professional video production expert specializing in camera movements and transitions.

${hasImages ? "Carefully analyze the provided start frame and end frame images." : ""}

Task: Generate a detailed, professional prompt for creating a video that transitions from a start frame to an end frame.

Video Specifications:
- Duration: ${duration} seconds
- Resolution: ${resolution}
- Type: ${hasImages ? "Image-based transition (analyze the 2 frames provided below)" : "Creative transition"}

Requirements:
1. ${hasImages ? "Describe what you see in both images and how to smoothly transition between them" : "Create a cinematic transition description with specific camera movements"}
2. Include movement type: dolly, pan, tilt, crane, zoom, orbit, or combinations
3. Describe the pacing: ${duration === "5" ? "quick and dynamic" : "smooth and gradual"} over ${duration} seconds
4. ${hasImages ? "Explain how subjects, objects, lighting, and composition change from start to end" : "Add lighting or atmosphere changes during transition"}
5. Use professional cinematography terms
6. Keep it concise but detailed (50-100 words)
7. Output ONLY the prompt in English, no introductions or explanations

${!hasImages ? 'Example style: "Smooth dolly forward with subtle pan right, camera gradually rises revealing the full scene, golden hour lighting transitions to blue hour, gentle depth of field shift from foreground to background, cinematic motion blur, 4K quality"' : ""}

Generated Prompt:`;
}

function generateImageToVideoPrompt(
  currentPrompt: string | undefined,
  hasExistingPrompt: boolean,
  context: any,
): string {
  const duration = context.duration || "5";
  const hasImage = !!context.inputImage;

  if (hasExistingPrompt) {
    return `You are a professional video animator specializing in bringing static images to life.

The user has provided an initial prompt: "${currentPrompt}"

${hasImage ? "Carefully analyze the provided input image." : ""}

Task: Enhance this prompt with professional animation and camera movement details for image-to-video generation.

Video Specifications:
- Duration: ${duration} seconds
- Type: Animate a single image into a video

Requirements:
1. ${hasImage ? "Based on the image content, describe specific animations that would bring it to life naturally" : "Keep the original creative intent"}
2. Add specific animation details (parallax, camera movements, element animations)
3. Include cinematic camera work suitable for ${duration} seconds
4. ${hasImage ? "Identify which elements in the image could move (water, clouds, people, objects, etc.)" : "Use professional animation terminology"}
5. Output ONLY the enhanced prompt in English, no explanations

Enhanced Prompt:`;
  }

  return `You are a professional video animator specializing in bringing static images to life.

${hasImage ? "Carefully analyze the provided input image to understand its content, composition, and elements." : ""}

Task: Generate a detailed prompt for animating a single image into a dynamic video.

Video Specifications:
- Duration: ${duration} seconds
- Type: Image-to-video animation

Requirements:
1. ${hasImage ? "Describe what you see in the image and which elements should animate" : "Describe camera movements: orbit, dolly, zoom, parallax effects"}
2. ${hasImage ? "Suggest natural movements based on the scene (e.g., wind effects, water flow, character movements)" : "Include element animations if applicable (flowing water, moving clouds, etc.)"}
3. Add depth and dimension effects with appropriate camera movements
4. Keep motion ${duration === "5" ? "dynamic and noticeable" : "smooth and subtle"}
5. Use cinematic terms
6. 50-100 words, concise and detailed
7. Output ONLY the prompt in English, no explanations

${!hasImage ? 'Example: "Slow camera orbit around the subject, subtle parallax effect creating depth, gentle zoom in on focal point, atmospheric elements like dust particles floating, cinematic motion blur, smooth 60fps motion"' : ""}

Generated Prompt:`;
}

function generateTextToVideoPrompt(
  currentPrompt: string | undefined,
  hasExistingPrompt: boolean,
  context: any,
): string {
  const duration = context.duration || "5";
  const aspectRatio = context.aspectRatio || "16:9";

  if (hasExistingPrompt) {
    return `You are a professional video director and storyteller.

The user has provided an initial idea: "${currentPrompt}"

Task: Enhance this into a professional video generation prompt with cinematic details.

Video Specifications:
- Duration: ${duration} seconds
- Aspect Ratio: ${aspectRatio}
- Type: Text-to-video generation

Requirements:
1. Expand the creative vision with visual details
2. Add camera work and shot composition for ${aspectRatio} format
3. Include lighting, mood, and atmosphere
4. Add movement and action suitable for ${duration} seconds
5. Use cinematic vocabulary
6. Output ONLY the enhanced prompt in English, no explanations

Enhanced Prompt:`;
  }

  return `You are a professional video director creating shot descriptions for ${duration}-second video clips.

Task: Generate a detailed, cinematic prompt for text-to-video generation.

Video Specifications:
- Duration: ${duration} seconds
- Aspect Ratio: ${aspectRatio}

Requirements:
1. Describe the scene, subject, and action
2. Include camera angle and movement
3. Specify lighting and mood
4. Add visual style (realistic, cinematic, anime, etc.)
5. Consider ${aspectRatio} composition (${aspectRatio === "16:9" ? "widescreen cinematic" : aspectRatio === "9:16" ? "vertical mobile" : "square format"})
6. 50-120 words
7. Output ONLY the prompt in English, no explanations

Example: "Wide cinematic shot of a lone astronaut walking across a red Martian landscape during sunset, camera slowly dollies forward following the subject, dramatic rim lighting from the setting sun, dust particles visible in volumetric god rays, photorealistic style, epic scale, 4K quality"

Generated Prompt:`;
}

function generateTextToImagePrompt(
  currentPrompt: string | undefined,
  hasExistingPrompt: boolean,
  context: any,
): string {
  const resolution = context.resolution || "2k";

  if (hasExistingPrompt) {
    return `You are a professional AI image generation expert and art director.

The user has provided: "${currentPrompt}"

Task: Enhance this into a detailed image generation prompt.

Image Specifications:
- Resolution: ${resolution}
- Type: Text-to-image generation

Requirements:
1. Expand with visual details (composition, lighting, style)
2. Add artistic style and technique details
3. Include quality modifiers
4. Keep the original creative intent
5. Use professional art terminology
6. Output ONLY the enhanced prompt in English, no explanations

Enhanced Prompt:`;
  }

  return `You are a professional AI image generation expert.

Task: Generate a detailed prompt for high-quality image generation.

Image Specifications:
- Resolution: ${resolution}

Requirements:
1. Describe subject, composition, and framing
2. Include artistic style (photorealistic, illustration, 3D render, etc.)
3. Specify lighting and color palette
4. Add quality terms (highly detailed, sharp focus, etc.)
5. 50-100 words
6. Output ONLY the prompt in English, no explanations

Example: "Portrait of a cyberpunk warrior in neon-lit city street, dramatic side lighting with purple and blue tones, highly detailed mechanical augmentations, photorealistic style, bokeh background, professional photography, 8K resolution, sharp focus"

Generated Prompt:`;
}
