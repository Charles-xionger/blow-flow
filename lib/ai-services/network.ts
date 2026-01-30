export interface FetchOptions {
  timeout?: number;
  retries?: number;
  isFormData?: boolean;
}

export const constructUrl = (baseUrl: string, endpointPath: string): string => {
  const base = baseUrl ? baseUrl.replace(/\/$/, "") : "";
  let path = endpointPath.replace(/^\//, "");

  if (base.endsWith("/v1") && path.startsWith("v1/")) {
    path = path.substring(3);
  }
  if (!base) return `/${path}`;
  return `${base}/${path}`;
};

export const fetchThirdParty = async (
  url: string,
  method: string,
  body: any,
  apiKey: string,
  options: FetchOptions = {},
): Promise<any> => {
  const { timeout = 60000, retries = 0, isFormData = false } = options;

  console.log("[Network] Fetching URL:", url);

  if (!apiKey) {
    throw new Error("API Key missing. Please configure it in settings.");
  }

  const headers: Record<string, string> = {};

  // 根据不同平台设置认证头
  if (url.includes("dashscope.aliyuncs.com")) {
    // 阿里云 DashScope 使用专用的 API Key 头
    headers["Authorization"] = `Bearer ${apiKey}`;
    headers["X-DashScope-SSE"] = "disable"; // 禁用 SSE
  } else {
    // 其他平台使用标准 Bearer token
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  if (!isFormData && method.toUpperCase() !== "GET") {
    headers["Content-Type"] = "application/json";
  }

  let lastError: any = new Error("Request failed");

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const fetchOptions: RequestInit = {
      method,
      headers,
      signal: controller.signal,
    };

    if (body && method.toUpperCase() !== "GET") {
      fetchOptions.body = isFormData ? body : JSON.stringify(body);
    }

    try {
      const response = await fetch(url, fetchOptions);
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text();
        let errMsg = errText;

        try {
          const jsonErr = JSON.parse(errText);
          if (jsonErr.error?.message) {
            errMsg = jsonErr.error.message;
          } else if (jsonErr.message) {
            errMsg = jsonErr.message;
          } else if (jsonErr.fail_reason) {
            errMsg = jsonErr.fail_reason;
          }
        } catch (e) {
          // 保持原始错误消息
        }

        const error: any = new Error(`API Error ${response.status}: ${errMsg}`);

        // 4xx 错误（除了 429 和 408）不重试
        if (
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 429 &&
          response.status !== 408
        ) {
          error.isNonRetryable = true;
        }

        throw error;
      }

      const text = await response.text();

      try {
        if (!text) return {};
        return JSON.parse(text);
      } catch (e) {
        const preview = text.slice(0, 200);
        if (preview.trim().startsWith("<")) {
          throw new Error(
            `Server returned HTML instead of JSON. Check your Base URL and Endpoint. Preview: ${preview}...`,
          );
        }
        throw new Error(
          `Received invalid JSON response from server. Content: ${preview}...`,
        );
      }
    } catch (error: any) {
      clearTimeout(timeoutId);
      lastError = error;

      if (error.name === "AbortError") {
        lastError = new Error(`Request timed out after ${timeout / 1000}s`);
      }

      // 如果是最后一次重试或者是不可重试的错误，直接抛出
      if (attempt === retries || error.isNonRetryable) {
        throw lastError;
      }

      // 等待后重试（指数退避）
      await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
    }
  }

  throw lastError;
};

export const extractUrlFromContent = (content: string): string => {
  if (!content) return "";

  // Markdown 图片格式
  const mdMatch = content.match(/!\[.*?\]\((.*?)\)/);
  if (mdMatch && mdMatch[1]) return mdMatch[1];

  // Data URL
  const dataUrlMatch = content.match(/data:image\/[a-zA-Z]+;base64,[^"'\s)]+/);
  if (dataUrlMatch) return dataUrlMatch[0];

  // HTTP URL
  const httpMatch = content.match(/https?:\/\/[^\s)"]+/);
  if (httpMatch) return httpMatch[0];

  return content.trim();
};

export const delay = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};
