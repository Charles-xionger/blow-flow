import { constructUrl, fetchThirdParty } from "../network";
import type { ModelConfig } from "@/types";

/**
 * 通用图片生成函数 - 自动识别平台格式
 */
export async function generateGenericImage(
  config: ModelConfig,
  prompt: string,
  aspectRatio: string,
  resolution: string,
  inputImages: string[] = [],
): Promise<string> {
  const baseUrl = config.baseUrl.toLowerCase();
  let targetUrl: string;
  let payload: any;
  let res: any;

  console.log("[Generic Image] Config:", {
    modelId: config.modelId,
    baseUrl: config.baseUrl,
    endpoint: config.endpoint,
  });

  // 阿里云 DashScope 格式
  if (baseUrl.includes("dashscope.aliyuncs.com")) {
    // 阿里云文生图 API
    // wan2.6 模型使用新协议（需要 /api/v1 前缀）
    // 旧版 wan 模型使用旧协议（不需要 /api/v1 前缀）

    let endpoint = config.endpoint;

    // 如果没有配置端点，根据模型ID自动选择
    if (!endpoint) {
      if (config.modelId.includes("wan2.6")) {
        // wan2.6 使用新协议同步接口
        endpoint = "/api/v1/services/aigc/multimodal-generation/generation";
      } else {
        // 旧版使用旧协议
        endpoint = "/services/aigc/text2image/image-synthesis";
      }
      console.log(
        `[Generic Image] Auto-selected endpoint: ${endpoint} for model: ${config.modelId}`,
      );
    }

    targetUrl = constructUrl(config.baseUrl, endpoint);
    console.log("[Generic Image] Aliyun target URL:", targetUrl);

    // 构建请求 payload - 根据模型版本使用不同格式
    if (config.modelId.includes("wan2.6")) {
      // wan2.6 新协议：使用 messages 格式
      payload = {
        model: config.modelId,
        input: {
          messages: [
            {
              role: "user",
              content: [
                {
                  text: prompt,
                },
              ],
            },
          ],
        },
        parameters: {
          size: convertToAliyunSize(aspectRatio),
          n: 1,
        },
      };

      // 图生图：添加图片到 content
      if (inputImages.length > 0) {
        payload.input.messages[0].content.unshift({
          image: inputImages[0],
        });
      }
    } else {
      // 旧版协议：使用 prompt 格式
      payload = {
        model: config.modelId,
        input: {
          prompt: prompt,
        },
        parameters: {
          size: convertToAliyunSize(aspectRatio),
          n: 1,
        },
      };

      if (inputImages.length > 0) {
        payload.input.ref_img = inputImages[0];
      }
    }

    console.log(
      "[Generic Image] Aliyun payload:",
      JSON.stringify(payload, null, 2),
    );

    res = await fetchThirdParty(targetUrl, "POST", payload, config.key);

    console.log(
      "[Generic Image] Aliyun response:",
      JSON.stringify(res, null, 2),
    );

    // 阿里云返回格式处理
    // wan2.6 新协议格式：output.choices[0].message.content[0].image
    if (res.output?.choices?.[0]?.message?.content?.[0]?.image) {
      console.log("[Generic Image] Found image URL in new format (wan2.6)");
      return res.output.choices[0].message.content[0].image;
    }
    // 旧协议格式：output.results[0].url
    else if (res.output?.results?.[0]?.url) {
      console.log("[Generic Image] Found image URL in old format");
      return res.output.results[0].url;
    }
    // 异步任务
    else if (res.output?.task_id) {
      console.log(
        `[Generic Image] Aliyun async task, polling task_id: ${res.output.task_id}`,
      );
      return await pollAliyunTask(
        config.baseUrl,
        config.key,
        res.output.task_id,
      );
    }
    // 错误响应
    else if (res.code) {
      throw new Error(
        `Aliyun API Error ${res.code}: ${res.message || JSON.stringify(res)}`,
      );
    }
  }
  // 标准 OpenAI 格式
  else {
    targetUrl = constructUrl(config.baseUrl, config.endpoint);

    payload = {
      model: config.modelId,
      prompt: prompt,
      size: convertToOpenAISize(aspectRatio, resolution),
      n: 1,
    };

    if (inputImages.length > 0) {
      payload.image = inputImages[0];
    }

    res = await fetchThirdParty(targetUrl, "POST", payload, config.key);

    // OpenAI 格式返回
    if (res.data?.[0]?.url) {
      return res.data[0].url;
    } else if (res.data?.[0]?.b64_json) {
      return `data:image/png;base64,${res.data[0].b64_json}`;
    }
  }

  throw new Error("No image URL or data returned from API");
}

/**
 * 轮询阿里云异步任务结果
 */
async function pollAliyunTask(
  baseUrl: string,
  apiKey: string,
  taskId: string,
  maxAttempts: number = 60,
  interval: number = 2000,
): Promise<string> {
  const queryEndpoint = "/api/v1/tasks/" + taskId;
  const queryUrl = constructUrl(baseUrl, queryEndpoint);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    console.log(
      `[Generic Image] Polling attempt ${attempt + 1}/${maxAttempts}`,
    );

    const result = await fetchThirdParty(queryUrl, "GET", null, apiKey);

    console.log("[Generic Image] Task status:", result.output?.task_status);

    // 任务成功完成
    if (
      result.output?.task_status === "SUCCEEDED" &&
      result.output?.results?.[0]?.url
    ) {
      console.log("[Generic Image] Task completed successfully");
      return result.output.results[0].url;
    }

    // 任务失败
    if (result.output?.task_status === "FAILED") {
      throw new Error(
        `Aliyun task failed: ${result.output?.message || "Unknown error"}`,
      );
    }

    // 任务还在处理中，等待后重试
    if (
      result.output?.task_status === "PENDING" ||
      result.output?.task_status === "RUNNING"
    ) {
      await new Promise((resolve) => setTimeout(resolve, interval));
      continue;
    }

    // 未知状态
    throw new Error(
      `Unexpected task status: ${result.output?.task_status || "unknown"}`,
    );
  }

  throw new Error(
    `Task polling timeout after ${maxAttempts} attempts (${(maxAttempts * interval) / 1000}s)`,
  );
}

/**
 * 转换为阿里云支持的尺寸格式
 */
function convertToAliyunSize(aspectRatio: string): string {
  const sizeMap: Record<string, string> = {
    "1:1": "1024*1024",
    "16:9": "1280*720",
    "9:16": "720*1280",
    "4:3": "1024*768",
    "3:4": "768*1024",
    "3:2": "1152*768",
    "2:3": "768*1152",
  };

  return sizeMap[aspectRatio] || "1024*1024";
}

/**
 * 转换为 OpenAI 支持的尺寸格式
 */
function convertToOpenAISize(aspectRatio: string, resolution: string): string {
  const baseSize =
    resolution === "4k" ? "2048" : resolution === "2k" ? "1536" : "1024";

  const sizeMap: Record<string, string> = {
    "1:1": `${baseSize}x${baseSize}`,
    "16:9": "1792x1024",
    "9:16": "1024x1792",
    "4:3": "1536x1024",
    "3:4": "1024x1536",
  };

  return sizeMap[aspectRatio] || "1024x1024";
}
