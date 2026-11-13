/**
 * 阿里云通义万相图生视频服务
 * 支持 wan2.6-i2v, wan2.6-i2v-flash 等模型
 */
import { constructUrl, delay } from "../network";
import type { ModelConfig } from "@/types";

interface AliyunVideoRequest {
  model: string;
  input: {
    prompt?: string;
    img_url: string;
    audio_url?: string;
  };
  parameters?: {
    resolution?: string;
    duration?: number;
    prompt_extend?: boolean;
    watermark?: boolean;
    negative_prompt?: string;
    seed?: number;
    shot_type?: "single" | "multi";
  };
}

interface AliyunVideoResponse {
  output: {
    task_id: string;
    task_status: string;
    video_url?: string;
    submit_time?: string;
    scheduled_time?: string;
    end_time?: string;
    orig_prompt?: string;
  };
  usage?: {
    duration?: number;
    input_video_duration?: number;
    output_video_duration?: number;
    SR?: number;
  };
  request_id: string;
  code?: string;
  message?: string;
}

export async function generateAliyunWanxVideo(
  config: ModelConfig,
  prompt: string,
  inputImage: string,
  options: {
    resolution?: string;
    duration?: number;
    promptExtend?: boolean;
    watermark?: boolean;
    negativePrompt?: string;
    audioUrl?: string;
    shotType?: "single" | "multi";
  } = {},
): Promise<string> {
  // 构建创建任务的 URL
  const createUrl = constructUrl(
    config.baseUrl,
    config.endpoint || "/api/v1/services/aigc/video-generation/video-synthesis",
  );

  const {
    resolution = "720P",
    duration = 10,
    promptExtend = true,
    watermark = false,
    negativePrompt = "",
    audioUrl,
    shotType,
  } = options;

  // 构建请求体
  const payload: AliyunVideoRequest = {
    model: config.modelId,
    input: {
      img_url: inputImage,
    },
    parameters: {
      resolution,
      duration,
      prompt_extend: promptExtend,
      watermark,
    },
  };

  // 添加可选参数
  if (prompt) {
    payload.input.prompt = prompt;
  }

  if (audioUrl) {
    payload.input.audio_url = audioUrl;
  }

  if (negativePrompt) {
    payload.parameters!.negative_prompt = negativePrompt;
  }

  if (shotType) {
    payload.parameters!.shot_type = shotType;
  }

  // 创建任务
  console.log("[AliyunWanx] Creating video generation task...", {
    model: config.modelId,
    resolution,
    duration,
    endpoint: createUrl,
  });

  // 为阿里云 API 添加特殊请求头
  const createHeaders: Record<string, string> = {
    Authorization: `Bearer ${config.key}`,
    "X-DashScope-Async": "enable",
    "Content-Type": "application/json",
  };

  console.log(
    "[AliyunWanx] Request payload:",
    JSON.stringify(payload, null, 2),
  );

  const createRes = await fetch(createUrl, {
    method: "POST",
    headers: createHeaders,
    body: JSON.stringify(payload),
  });

  if (!createRes.ok) {
    const errorText = await createRes.text();
    console.error("[AliyunWanx] Create task failed:", errorText);
    throw new Error(`Failed to create task: ${errorText}`);
  }

  const createData: AliyunVideoResponse = await createRes.json();

  if (createData.code || !createData.output?.task_id) {
    throw new Error(
      `Failed to create task: ${createData.message || "Unknown error"}`,
    );
  }

  const taskId = createData.output.task_id;
  console.log(`[AliyunWanx] Task created: ${taskId}`);

  // 构建查询 URL
  const queryUrl = config.queryEndpoint
    ? constructUrl(
        config.baseUrl,
        config.queryEndpoint.replace("{task_id}", taskId),
      )
    : constructUrl(config.baseUrl, `/api/v1/tasks/${taskId}`);

  // 轮询查询结果
  const maxAttempts = 120; // 最多轮询 10 分钟
  const pollInterval = 5000; // 每 5 秒查询一次

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await delay(pollInterval);

    try {
      console.log(
        `[AliyunWanx] Polling task status (${attempt + 1}/${maxAttempts})...`,
      );

      const queryHeaders: Record<string, string> = {
        Authorization: `Bearer ${config.key}`,
        "Content-Type": "application/json",
      };

      const queryResponse = await fetch(queryUrl, {
        method: "GET",
        headers: queryHeaders,
      });

      if (!queryResponse.ok) {
        throw new Error(`Query failed: ${queryResponse.statusText}`);
      }

      const queryRes: AliyunVideoResponse = await queryResponse.json();

      const status = queryRes.output?.task_status;

      if (status === "SUCCEEDED") {
        const videoUrl = queryRes.output.video_url;
        if (!videoUrl) {
          throw new Error("Video URL not found in successful response");
        }
        console.log("[AliyunWanx] Video generation succeeded");
        return videoUrl;
      } else if (status === "FAILED") {
        throw new Error(
          `Video generation failed: ${queryRes.message || "Unknown error"}`,
        );
      } else if (status === "PENDING" || status === "RUNNING") {
        // 继续轮询
        console.log(`[AliyunWanx] Task status: ${status}`);
        continue;
      } else if (status === "CANCELED") {
        throw new Error("Task was canceled");
      } else if (status === "UNKNOWN") {
        throw new Error("Task not found or expired (24 hour limit)");
      } else {
        console.warn(`[AliyunWanx] Unknown status: ${status}`);
        continue;
      }
    } catch (error: any) {
      // 如果是最后几次尝试，抛出错误
      if (attempt >= maxAttempts - 3) {
        throw error;
      }
      // 否则继续轮询
      console.warn(`[AliyunWanx] Query error (will retry): ${error.message}`);
    }
  }

  throw new Error(
    `Video generation timed out after ${(maxAttempts * pollInterval) / 1000} seconds`,
  );
}
