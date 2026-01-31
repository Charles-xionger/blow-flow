/**
 * Google Gemini Veo 视频生成服务（使用 SDK）
 * 支持 Veo 3.1 Generate Preview
 */
import { GoogleGenAI } from "@google/genai";
import { readFileSync, unlinkSync } from "fs";

// 从环境变量获取 API Key
const getApiKey = () => {
  return process.env.GEMINI_API_KEY || "";
};

/**
 * 从 URL 下载图片并转换为 base64
 */
async function urlToBase64(url: string): Promise<string> {
  try {
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    return buffer.toString("base64");
  } catch (error) {
    console.error("Failed to download image from URL:", error);
    throw new Error(
      `Failed to download image: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * 轮询操作直到完成
 */
async function pollOperation(ai: any, operation: any): Promise<any> {
  let currentOperation = operation;
  const maxAttempts = 120; // 最多等待 20 分钟 (120 * 10s)
  let attempts = 0;

  while (!currentOperation.done && attempts < maxAttempts) {
    console.log(
      `[Gemini Veo] Waiting for video generation... (${attempts * 10}s)`,
    );
    await new Promise((resolve) => setTimeout(resolve, 10000)); // 等待 10 秒

    // 刷新操作状态
    currentOperation = await ai.operations.getVideosOperation({
      operation: currentOperation,
    });

    attempts++;
  }

  if (!currentOperation.done) {
    throw new Error("Video generation timeout after 20 minutes");
  }

  return currentOperation;
}

/**
 * 生成视频 - Veo 3.1
 * @param model 模型 ID (veo-3.1-generate-preview)
 * @param prompt 提示词
 * @param _duration 时长（秒，保留参数兼容性）
 * @returns 视频 URL 或 base64
 */
export async function generateGeminiVideo(
  model: string,
  prompt: string,
  _duration: number = 5,
): Promise<string> {
  const apiKey = getApiKey();

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not found in environment variables");
  }

  try {
    const ai = new GoogleGenAI({ apiKey });

    console.log("[Gemini Veo] Starting video generation with model:", model);

    // 启动视频生成操作
    let operation = await ai.models.generateVideos({
      model: model,
      prompt: prompt,
    });

    // 轮询直到完成
    operation = await pollOperation(ai, operation);

    console.log("[Gemini Veo] Video generation completed");

    // 提取视频数据
    if (
      operation.response &&
      operation.response.generatedVideos &&
      operation.response.generatedVideos.length > 0
    ) {
      const video = operation.response.generatedVideos[0].video;

      if (!video) {
        throw new Error("未返回视频数据");
      }

      // 如果有 videoBytes，直接使用
      if (video.videoBytes) {
        return `data:video/mp4;base64,${Buffer.from(video.videoBytes).toString("base64")}`;
      }

      // 如果有 URI，使用 SDK 下载
      if (video.uri) {
        console.log("[Gemini Veo] Downloading video from URI...");
        const tempPath = `/tmp/gemini-video-${Date.now()}.mp4`;

        try {
          await ai.files.download({ file: video, downloadPath: tempPath });

          // 读取下载的文件
          const videoBuffer = readFileSync(tempPath);
          const base64Video = videoBuffer.toString("base64");

          // 清理临时文件
          unlinkSync(tempPath);

          return `data:video/mp4;base64,${base64Video}`;
        } catch (downloadError) {
          console.error("[Gemini Veo] Download failed:", downloadError);
          // 如果下载失败，尝试使用 videoBytes
          if (video.videoBytes) {
            return `data:video/mp4;base64,${Buffer.from(video.videoBytes).toString("base64")}`;
          }
          throw downloadError;
        }
      }
    }

    throw new Error("未返回视频数据");
  } catch (error) {
    console.error("Gemini video generation error:", error);
    throw error;
  }
}

/**
 * 图片转视频 - Veo 3.1
 * @param model 模型 ID
 * @param prompt 提示词
 * @param inputImage 输入图片 (base64, data URL, or HTTP URL)
 * @param _duration 时长（秒，保留参数兼容性）
 * @returns 视频 URL 或 base64
 */
export async function generateGeminiImageToVideo(
  model: string,
  prompt: string,
  inputImage: string,
  _duration: number = 5,
): Promise<string> {
  const apiKey = getApiKey();

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not found in environment variables");
  }

  try {
    const ai = new GoogleGenAI({ apiKey });

    // 处理输入图片 - 支持 URL 或 base64
    let imageBytes: Buffer;

    console.log("[Gemini I2V] Input image type:", inputImage.substring(0, 100));

    if (inputImage.startsWith("http://") || inputImage.startsWith("https://")) {
      // 从 URL 下载并转换
      console.log("[Gemini I2V] Downloading image from URL:", inputImage);
      const base64Data = await urlToBase64(inputImage);
      imageBytes = Buffer.from(base64Data, "base64");
      console.log(
        "[Gemini I2V] Successfully downloaded, size:",
        imageBytes.length,
        "bytes",
      );
    } else {
      // 提取 base64 数据（移除 data URL 前缀）
      const base64Data = inputImage.includes(",")
        ? inputImage.split(",")[1]
        : inputImage;
      imageBytes = Buffer.from(base64Data, "base64");
      console.log(
        "[Gemini I2V] Using provided image, size:",
        imageBytes.length,
        "bytes",
      );
    }

    console.log(
      "[Gemini I2V] Starting image-to-video generation with model:",
      model,
    );

    // 启动图片到视频生成操作
    let operation = await ai.models.generateVideos({
      model: model,
      prompt: prompt,
      image: {
        imageBytes: imageBytes.toString("base64"),
        mimeType: "image/jpeg",
      },
    });

    // 轮询直到完成
    operation = await pollOperation(ai, operation);

    console.log("[Gemini I2V] Video generation completed");

    // 提取视频数据
    if (
      operation.response &&
      operation.response.generatedVideos &&
      operation.response.generatedVideos.length > 0
    ) {
      const video = operation.response.generatedVideos[0].video;

      if (!video) {
        throw new Error("未返回视频数据");
      }

      // 如果有 videoBytes，直接使用
      if (video.videoBytes) {
        return `data:video/mp4;base64,${Buffer.from(video.videoBytes).toString("base64")}`;
      }

      // 如果有 URI，使用 SDK 下载
      if (video.uri) {
        console.log("[Gemini I2V] Downloading video from URI...");
        const tempPath = `/tmp/gemini-i2v-${Date.now()}.mp4`;

        try {
          await ai.files.download({ file: video, downloadPath: tempPath });

          // 读取下载的文件
          const videoBuffer = readFileSync(tempPath);
          const base64Video = videoBuffer.toString("base64");

          // 清理临时文件
          unlinkSync(tempPath);

          return `data:video/mp4;base64,${base64Video}`;
        } catch (downloadError) {
          console.error("[Gemini I2V] Download failed:", downloadError);
          // 如果下载失败，尝试使用 videoBytes
          if (video.videoBytes) {
            return `data:video/mp4;base64,${Buffer.from(video.videoBytes).toString("base64")}`;
          }
          throw downloadError;
        }
      }
    }

    throw new Error("未返回视频数据");
  } catch (error) {
    console.error("Gemini image-to-video error:", error);
    throw error;
  }
}
