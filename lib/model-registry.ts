/**
 * 模型注册表 - 统一管理所有模型配置
 */

export interface ModelDefinition {
  id: string;
  name: string;
  category: "IMAGE" | "VIDEO";
  defaultEndpoint: string;
}

// 内置模型配置
const BUILTIN_MODELS: Record<string, ModelDefinition> = {
  BananaPro: {
    id: "banana-pro",
    name: "Banana Pro",
    category: "IMAGE",
    defaultEndpoint: "/v1/images/generations",
  },
  Flux2: {
    id: "flux-2",
    name: "Flux 2",
    category: "IMAGE",
    defaultEndpoint: "/v1/images/generations",
  },
  "Sora 2": {
    id: "sora-2",
    name: "Sora 2",
    category: "VIDEO",
    defaultEndpoint: "/v1/videos",
  },
  "Veo 3.1 Fast": {
    id: "veo-3.1-fast",
    name: "Veo 3.1 Fast",
    category: "VIDEO",
    defaultEndpoint: "/v1/videos",
  },
  Kling: {
    id: "kling-v1",
    name: "Kling",
    category: "VIDEO",
    defaultEndpoint: "/v1/videos/generations",
  },
  MiniMax: {
    id: "minimax-v1",
    name: "MiniMax",
    category: "VIDEO",
    defaultEndpoint: "/v1/video/generation",
  },
};

/**
 * 从 localStorage 加载自定义模型
 */
function loadCustomModels(): Record<string, ModelDefinition> {
  if (typeof window === "undefined") return {};

  try {
    const stored = localStorage.getItem("CUSTOM_MODELS");
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (error) {
    console.error("Failed to load custom models:", error);
  }

  return {};
}

/**
 * 获取所有模型（内置 + 自定义）
 */
export function getAllModels(): Record<string, ModelDefinition> {
  const customModels = loadCustomModels();
  return { ...BUILTIN_MODELS, ...customModels };
}

/**
 * 获取图片模型列表（用于下拉选择）
 */
export function getImageModels(): Array<{ value: string; label: string }> {
  const allModels = getAllModels();
  return Object.entries(allModels)
    .filter(([, model]) => model.category === "IMAGE")
    .map(([key, model]) => ({
      value: key,
      label: model.name,
    }));
}

/**
 * 获取视频模型列表（用于下拉选择）
 * 优先从数据库读取配置的模型
 */
export function getVideoModels(): Array<{
  value: string;
  label: string;
  id: string;
}> {
  const models: Array<{ value: string; label: string; id: string }> = [];

  // 1. 从数据库读取已配置的模型
  if (typeof window === "undefined") {
    // 服务端：只返回内置模型
    const allModels = getAllModels();
    return Object.entries(allModels)
      .filter(([, model]) => model.category === "VIDEO")
      .map(([key, model]) => ({
        id: model.id,
        value: key,
        label: model.name,
      }));
  }

  try {
    // 客户端：从数据库API获取配置的模型
    // 注意：这是同步调用，需要在组件中异步获取
    const allModels = getAllModels();
    Object.entries(allModels)
      .filter(([, model]) => model.category === "VIDEO")
      .forEach(([key, model]) => {
        models.push({
          value: key,
          label: model.name,
          id: model.id,
        });
      });
  } catch (error) {
    console.error("Failed to load video models:", error);
  }

  return models;
}

/**
 * 获取特定模型的定义
 */
export function getModelDefinition(key: string): ModelDefinition | undefined {
  const allModels = getAllModels();
  return allModels[key];
}

/**
 * 检查模型是否已配置（有 API Key 和 Base URL）
 */
export function isModelConfigured(key: string): boolean {
  if (typeof window === "undefined") return false;

  const globalBaseUrl = localStorage.getItem("GLOBAL_BASE_URL");
  const globalApiKey = localStorage.getItem("GLOBAL_API_KEY");

  const configStr = localStorage.getItem(`API_CONFIG_MODEL_${key}`);
  let config: any = {};

  if (configStr) {
    try {
      config = JSON.parse(configStr);
    } catch {
      config = {};
    }
  }

  const hasBaseUrl = !!(config.baseUrl || globalBaseUrl);
  const hasApiKey = !!(config.key || globalApiKey);

  return hasBaseUrl && hasApiKey;
}
