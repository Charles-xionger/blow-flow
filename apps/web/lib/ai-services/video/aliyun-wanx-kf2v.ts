/**
 * 阿里云通义万相首尾帧生成视频服务
 * 支持 wan2.2-kf2v-flash 模型
 * 基于首帧图像、尾帧图像和文本提示词，生成平滑过渡视频
 */
import { constructUrl, delay } from "../network";
import type { ModelConfig } from "@/types";

interface AliyunKf2vRequest {
  model: string;
  input: {
    first_frame_url: string;
    last_frame_url: string;
    prompt: string;
  };
  parameters?: {
    resolution?: "480P" | "720P" | "1080P";
    prompt_extend?: boolean;
  };
}

interface AliyunKf2vResponse {
  output: {
    task_id: string;
    task_status: string;
    video_url?: string;
    submit_time?: string;
    scheduled_time?: string;
    end_time?: string;
  };
  usage?: {
    duration?: number;
  };
  request_id: string;
  code?: string;
  message?: string;
}

/**
 * 生成首尾帧过渡视频
 * @param config 模型配置
 * @param prompt 文本提示词
 * @param firstFrameUrl 首帧图片URL
 * @param lastFrameUrl 尾帧图片URL
 * @param options 可选参数
 * @returns 生成的视频URL
 */
export async function generateAliyunKf2v(
  config: ModelConfig,
  prompt: string,
  firstFrameUrl: string,
  lastFrameUrl: string,
  options: {
    resolution?: "480P" | "720P" | "1080P";
    promptExtend?: boolean;
  } = {},
): Promise<string> {
  const { resolution = "720P", promptExtend = true } = options;

  // 构建创建任务的 URL
  const createUrl = constructUrl(
    config.baseUrl,
    config.endpoint || "/api/v1/services/aigc/image2video/video-synthesis",
  );

  // 构建请求体
  const payload: AliyunKf2vRequest = {
    model: config.modelId,
    input: {
      first_frame_url: firstFrameUrl,
      last_frame_url: lastFrameUrl,
      prompt: prompt,
    },
    parameters: {
      resolution,
      prompt_extend: promptExtend,
    },
  };

  console.log("[AliyunKf2v] Creating keyframe-to-video task...", {
    model: config.modelId,
    resolution,
    promptExtend,
  });

  // 创建任务
  const createHeaders: Record<string, string> = {
    Authorization: `Bearer ${config.key}`,
    "X-DashScope-Async": "enable",
    "Content-Type": "application/json",
  };

  const createRes = await fetch(createUrl, {
    method: "POST",
    headers: createHeaders,
    body: JSON.stringify(payload),
  });

  if (!createRes.ok) {
    const errorText = await createRes.text();
    console.error("[AliyunKf2v] Failed to create task:", errorText);
    throw new Error(`Failed to create task: ${createRes.status} ${errorText}`);
  }

  const createData: AliyunKf2vResponse = await createRes.json();

  if (createData.code || !createData.output?.task_id) {
    console.error("[AliyunKf2v] Task creation failed:", createData);
    throw new Error(
      `Failed to create task: ${createData.message || "Unknown error"}`,
    );
  }

  const taskId = createData.output.task_id;
  console.log(`[AliyunKf2v] Task created successfully: ${taskId}`);

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
        `[AliyunKf2v] Polling task status (${attempt + 1}/${maxAttempts})...`,
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
        console.warn(
          `[AliyunKf2v] Query failed: ${queryResponse.status} ${queryResponse.statusText}`,
        );
        continue;
      }

      const queryRes: AliyunKf2vResponse = await queryResponse.json();
      const status = queryRes.output?.task_status;

      console.log(`[AliyunKf2v] Task status: ${status}`);

      if (status === "SUCCEEDED") {
        const videoUrl = queryRes.output.video_url;
        if (!videoUrl) {
          throw new Error("Video URL not found in successful response");
        }
        console.log("[AliyunKf2v] Video generation succeeded:", videoUrl);
        return videoUrl;
      } else if (status === "FAILED") {
        throw new Error(
          `Video generation failed: ${queryRes.message || "Unknown error"}`,
        );
      } else if (status === "PENDING" || status === "RUNNING") {
        // 继续轮询
        continue;
      } else if (status === "CANCELED") {
        throw new Error("Task was canceled");
      } else if (status === "UNKNOWN") {
        throw new Error("Task not found or expired (24 hour limit)");
      } else {
        console.warn(`[AliyunKf2v] Unknown status: ${status}, continuing...`);
        continue;
      }
    } catch (error) {
      // 如果是最后几次尝试，抛出错误
      if (attempt >= maxAttempts - 3) {
        throw error;
      }
      // 否则继续轮询
      console.warn(`[AliyunKf2v] Polling error, retrying...`, error);
    }
  }

  throw new Error(
    "Video generation timed out after 10 minutes. Task may still be processing.",
  );
}
