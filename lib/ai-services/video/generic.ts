import { constructUrl, fetchThirdParty, delay } from "../network";
import type { ModelConfig } from "@/types";

export async function generateGenericVideo(
  config: ModelConfig,
  prompt: string,
  aspectRatio: string,
  resolution: string,
  duration: string,
  inputImages: string[] = [],
  isStartEndMode: boolean = false,
): Promise<string> {
  const targetUrl = constructUrl(config.baseUrl, config.endpoint);

  const payload: any = {
    model: config.modelId,
    prompt,
    aspect_ratio: aspectRatio,
    resolution,
    duration: parseInt(duration),
  };

  if (inputImages.length > 0) {
    payload.image_url = inputImages[0];
    if (isStartEndMode && inputImages.length > 1) {
      payload.last_frame_image = inputImages[inputImages.length - 1];
      payload.tail_image = inputImages[inputImages.length - 1];
    }
  }

  const res = await fetchThirdParty(targetUrl, "POST", payload, config.key, {
    timeout: 900000, // 15 分钟
    retries: 3,
  });

  // 如果直接返回 URL
  if (res.url || res.data?.url) {
    return res.url || res.data.url;
  }

  // 否则进入轮询
  const taskId = res.id || res.task_id || res.data?.id;
  if (!taskId) {
    throw new Error("No Task ID returned from API");
  }

  const queryUrl = config.queryEndpoint
    ? constructUrl(config.baseUrl, config.queryEndpoint.replace("{id}", taskId))
    : `${targetUrl}/${taskId}`;

  // 轮询查询结果
  for (let attempt = 0; attempt < 120; attempt++) {
    await delay(5000); // 每 5 秒查询一次

    try {
      const check = await fetchThirdParty(queryUrl, "GET", null, config.key, {
        timeout: 10000,
      });

      const status = (check.status || check.task_status || check.state || "")
        .toString()
        .toUpperCase();

      if (["SUCCESS", "SUCCEEDED", "COMPLETED", "OK"].includes(status)) {
        // 尝试多种可能的 URL 字段
        const videoUrl =
          check.url ||
          check.output?.url ||
          check.result?.url ||
          check.data?.url ||
          check.data?.video?.url ||
          check.video?.url ||
          check.data?.[0]?.url;

        if (videoUrl) return videoUrl;
        throw new Error("Video URL not found in response");
      } else if (["FAIL", "FAILED", "FAILURE", "ERROR"].includes(status)) {
        throw new Error(
          `Video generation failed: ${check.fail_reason || check.error || "Unknown error"}`,
        );
      }
    } catch (error: any) {
      if (attempt > 10 && error.isNonRetryable) {
        throw error;
      }
      // 继续轮询
    }
  }

  throw new Error("Video generation timed out after 10 minutes");
}
