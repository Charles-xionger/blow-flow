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

  // 检测是否是阿里云 DashScope API
  const isAliyunDashScope = targetUrl.includes("dashscope.aliyuncs.com");

  let payload: any;

  if (isAliyunDashScope) {
    // 阿里云格式：使用 input 和 parameters 结构
    const durationNum = parseInt(duration.replace("s", "")) || 5;

    // 转换分辨率格式：720P -> 1280*720
    let sizeValue = "1280*720"; // 默认值
    if (resolution.includes("1080")) {
      sizeValue = "1920*1080";
    } else if (resolution.includes("480")) {
      sizeValue = "640*480";
    }

    payload = {
      model: config.modelId,
      input: {
        prompt: prompt,
      },
      parameters: {
        size: sizeValue,
        duration: durationNum,
        prompt_extend: true,
        watermark: false,
      },
    };

    // 添加图片输入
    if (inputImages.length > 0) {
      payload.input.img_url = inputImages[0];
      if (isStartEndMode && inputImages.length > 1) {
        payload.input.last_frame_image = inputImages[inputImages.length - 1];
      }
    }
  } else {
    // 通用格式
    payload = {
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
  }

  const res = await fetchThirdParty(targetUrl, "POST", payload, config.key, {
    timeout: 900000, // 15 分钟
    retries: 3,
  });

  // 如果直接返回 URL
  if (res.url || res.data?.url) {
    return res.url || res.data.url;
  }

  // 否则进入轮询 - 支持多种任务 ID 格式
  const taskId =
    res.output?.task_id || // 阿里云格式
    res.id ||
    res.task_id ||
    res.data?.id ||
    res.data?.task_id;

  if (!taskId) {
    console.error("[Generic Video] No task ID in response:", res);
    throw new Error("No Task ID returned from API");
  }

  console.log(`[Generic Video] Task created: ${taskId}`);

  // 构建查询 URL
  let queryUrl: string;

  if (config.queryEndpoint) {
    // 使用配置的查询端点
    queryUrl = constructUrl(
      config.baseUrl,
      config.queryEndpoint.replace("{id}", taskId).replace("{task_id}", taskId),
    );
  } else if (isAliyunDashScope) {
    // 阿里云专用查询端点
    queryUrl = constructUrl(config.baseUrl, `/api/v1/tasks/${taskId}`);
  } else {
    // 通用后备方案
    queryUrl = `${targetUrl}/${taskId}`;
  }

  console.log(`[Generic Video] Query URL: ${queryUrl}`);

  // 轮询查询结果
  for (let attempt = 0; attempt < 120; attempt++) {
    await delay(5000); // 每 5 秒查询一次

    try {
      const check = await fetchThirdParty(queryUrl, "GET", null, config.key, {
        timeout: 10000,
      });

      // 支持多种状态字段格式
      const status = (
        check.output?.task_status || // 阿里云格式
        check.status ||
        check.task_status ||
        check.state ||
        ""
      )
        .toString()
        .toUpperCase();

      console.log(`[Generic Video] Task ${taskId} status: ${status}`);

      if (["SUCCESS", "SUCCEEDED", "COMPLETED", "OK"].includes(status)) {
        // 尝试多种可能的 URL 字段（包括阿里云格式）
        const videoUrl =
          check.output?.video_url || // 阿里云格式
          check.url ||
          check.output?.url ||
          check.result?.url ||
          check.data?.url ||
          check.data?.video?.url ||
          check.video?.url ||
          check.data?.[0]?.url;

        if (videoUrl) {
          console.log(
            `[Generic Video] Video generated successfully: ${videoUrl}`,
          );
          return videoUrl;
        }
        throw new Error("Video URL not found in response");
      } else if (["FAIL", "FAILED", "FAILURE", "ERROR"].includes(status)) {
        const errorMsg =
          check.output?.message ||
          check.fail_reason ||
          check.error ||
          check.message ||
          "Unknown error";
        throw new Error(`Video generation failed: ${errorMsg}`);
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
