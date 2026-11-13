/**
 * Google Gemini Veo 视频生成服务（使用 SDK）
 * 支持 Veo 3.1 模型
 */
import { GoogleGenAI } from "@google/genai";

// 从环境变量获取 API Key
const getApiKey = () => {
  return process.env.GEMINI_API_KEY || "";
};

/**
 * 下载图片并转换为 base64
 * @param imageUrl 图片 URL
 * @returns base64 编码的图片数据（不含前缀）
 */
async function downloadImageAsBase64(imageUrl: string): Promise<string> {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    return buffer.toString("base64");
  } catch (error) {
    console.error("[Gemini Veo] Failed to download image:", error);
    throw new Error(
      `Failed to download image from URL: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * 生成视频 - Gemini Veo 3.1 with start-end frames
 * @param model 模型 ID (veo-3.1-generate-preview)
 * @param prompt 提示词
 * @param startImage 起始帧（URL或base64）
 * @param endImage 结束帧（URL或base64）
 * @param options 可选参数
 * @returns 视频 URL
 */
export async function generateGeminiStartEndVideo(
  model: string,
  prompt: string,
  startImage: string,
  endImage: string,
  options: {
    aspectRatio?: "16:9" | "9:16";
    duration?: string;
  } = {},
): Promise<Buffer> {
  const apiKey = getApiKey();

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not configured in environment variables");
  }

  console.log("[Gemini Veo] Starting start-end video generation:", {
    model,
    prompt: prompt.substring(0, 100) + "...",
    hasStartImage: !!startImage,
    hasEndImage: !!endImage,
    aspectRatio: options.aspectRatio || "16:9",
  });

  try {
    const ai = new GoogleGenAI({ apiKey });

    // 处理起始帧：如果是 URL 则下载，否则提取 base64
    let startBase64: string;
    if (startImage.startsWith("http://") || startImage.startsWith("https://")) {
      console.log("[Gemini Veo] Downloading start image from URL:", startImage);
      startBase64 = await downloadImageAsBase64(startImage);
    } else {
      startBase64 = startImage.includes(",")
        ? startImage.split(",")[1]
        : startImage;
    }

    // 处理结束帧：如果是 URL 则下载，否则提取 base64
    let endBase64: string;
    if (endImage.startsWith("http://") || endImage.startsWith("https://")) {
      console.log("[Gemini Veo] Downloading end image from URL:", endImage);
      endBase64 = await downloadImageAsBase64(endImage);
    } else {
      endBase64 = endImage.includes(",") ? endImage.split(",")[1] : endImage;
    }

    // 确定图片类型（假设为 PNG，可以根据实际情况调整）
    const startMimeType = "image/png";
    const endMimeType = "image/png";

    const firstImageObject = {
      imageBytes: startBase64,
      mimeType: startMimeType,
    };

    const lastImageObject = {
      imageBytes: endBase64,
      mimeType: endMimeType,
    };

    console.log("[Gemini Veo] Starting video generation operation...");

    // 调用 Veo 3.1 API
    let operation = await ai.models.generateVideos({
      model: model || "veo-3.1-generate-preview",
      prompt: prompt,
      image: firstImageObject, // 起始帧作为主输入
      config: {
        lastFrame: lastImageObject, // 结束帧作为配置约束
        // aspectRatio: options.aspectRatio || "16:9", // 可选：指定宽高比
      },
    });

    console.log("[Gemini Veo] Operation started, polling for completion...");

    // 轮询操作状态直到视频生成完成
    let pollCount = 0;
    const maxPolls = 120; // 最多等待 20 分钟（每次 10 秒）

    while (!operation.done && pollCount < maxPolls) {
      console.log(
        `[Gemini Veo] Waiting for video generation... (${pollCount + 1}/${maxPolls})`,
      );
      await new Promise((resolve) => setTimeout(resolve, 10000)); // 等待 10 秒

      operation = await ai.operations.getVideosOperation({
        operation: operation,
      });

      pollCount++;
    }

    if (!operation.done) {
      throw new Error(
        "Video generation timed out after 20 minutes. Please try again.",
      );
    }

    console.log("[Gemini Veo] Video generation completed!");

    // 获取生成的视频
    if (
      !operation.response?.generatedVideos ||
      operation.response.generatedVideos.length === 0
    ) {
      throw new Error("No video generated in the response");
    }

    const videoFile = operation.response.generatedVideos[0].video;

    if (!videoFile) {
      throw new Error("Video file not found in response");
    }

    console.log("[Gemini Veo] Video file reference:", videoFile);

    // 下载视频：需要使用 API key 进行认证下载
    // Gemini API 返回的 URI 需要 API key 才能访问，所以我们需要用 SDK 下载
    console.log("[Gemini Veo] Downloading video with authentication...");

    const videoBuffer = await downloadGeminiVideoToBuffer(videoFile);

    console.log(
      "[Gemini Veo] Video downloaded successfully, size:",
      videoBuffer.length,
    );

    // 返回 buffer 供上传到 OSS
    return videoBuffer;
  } catch (error) {
    console.error("[Gemini Veo] Video generation error:", error);
    throw new Error(
      `Gemini Veo video generation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * 下载 Gemini 生成的视频文件到 Buffer
 * @param file 文件引用
 * @returns 视频文件的 Buffer
 */
async function downloadGeminiVideoToBuffer(file: any): Promise<Buffer> {
  const apiKey = getApiKey();

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not configured in environment variables");
  }

  try {
    console.log("[Gemini Veo] Extracting file URI from response...");

    // 文件对象可能包含 uri 或 name
    let fileUri: string;

    if (typeof file === "string") {
      fileUri = file;
    } else if (file.uri) {
      fileUri = file.uri;
    } else if (file.name) {
      // 如果只有 name，需要构建完整的下载 URL
      const fileName = file.name.split("/").pop();
      fileUri = `https://generativelanguage.googleapis.com/v1beta/files/${fileName}`;
    } else {
      throw new Error("Unable to extract file URI from video file object");
    }

    console.log("[Gemini Veo] File URI:", fileUri);

    // 构建下载 URL（添加 alt=media 参数以获取文件内容）
    let downloadUrl: string;
    if (fileUri.includes("?")) {
      downloadUrl = `${fileUri}&alt=media&key=${apiKey}`;
    } else {
      // 如果 URI 不包含下载路径，添加 :download 端点
      if (!fileUri.includes(":download")) {
        downloadUrl = `${fileUri}:download?alt=media&key=${apiKey}`;
      } else {
        downloadUrl = `${fileUri}?alt=media&key=${apiKey}`;
      }
    }

    console.log("[Gemini Veo] Downloading from:", downloadUrl);

    // 使用 API key 进行认证下载
    const response = await fetch(downloadUrl);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to download video: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    console.log("[Gemini Veo] Download successful, converting to buffer...");
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error) {
    console.error("[Gemini Veo] Video download error:", error);
    throw new Error(
      `Failed to download video: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * 下载 Gemini 生成的视频文件（已废弃，使用 downloadGeminiVideoToBuffer）
 * @param file 文件引用
 * @param downloadPath 保存路径
 */
export async function downloadGeminiVideo(
  file: any,
  downloadPath: string,
): Promise<void> {
  const apiKey = getApiKey();

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not configured in environment variables");
  }

  try {
    const ai = new GoogleGenAI({ apiKey });

    console.log("[Gemini Veo] Downloading video to:", downloadPath);

    await ai.files.download({
      file: file,
      downloadPath: downloadPath,
    });

    console.log("[Gemini Veo] Video downloaded successfully");
  } catch (error) {
    console.error("[Gemini Veo] Video download error:", error);
    throw new Error(
      `Failed to download video: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}
