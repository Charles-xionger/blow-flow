/**
 * 模型注册表 - 统一管理所有模型配置
 */

export interface ModelDefinition {
  id: string;
  name: string;
  category: "IMAGE" | "VIDEO" | "TEXT";
  defaultEndpoint: string;
  provider?: "gemini" | "other"; // 用于标识是否使用 Gemini SDK
}

// Verified 2026-11-03: https://ai.google.dev/gemini-api/docs/models
// Keep retired names/IDs resolvable for saved projects, but out of new selections.
const LEGACY_MODEL_KEYS: Record<string, string> = {
  "Gemini 2.5 Pro": "Gemini 3.8 Flash",
  "gemini-2.5-pro": "Gemini 3.8 Flash",
  "Gemini 3 Pro Preview": "Gemini 3.8 Flash",
  "gemini-3-pro-preview": "Gemini 3.8 Flash",
  "gemini-3-pro-image-preview": "Nano Banana Pro",
};

// 内置模型配置
const BUILTIN_MODELS: Record<string, ModelDefinition> = {
  // === 文本模型 (Gemini) ===
  "Gemini 3.8 Flash": {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    category: "TEXT",
    defaultEndpoint: "",
    provider: "gemini",
  },
  "Gemini 4 Argon": {
    id: "gemini-4-argon",
    name: "Gemini 4 Argon",
    category: "TEXT",
    defaultEndpoint: "",
    provider: "gemini",
  },
  // 保留仍可用的旧文本型号，让用户自行选择成本与效果。
  "Gemini 3 Flash Preview": {
    id: "gemini-3-flash-preview",
    name: "Gemini 3 Flash Preview",
    category: "TEXT",
    defaultEndpoint: "",
    provider: "gemini",
  },

  // === 图片模型 ===
  "Nano Banana 2.1": {
    id: "gemini-nano-banana-2.1",
    name: "Nano Banana 2.1",
    category: "IMAGE",
    defaultEndpoint: "",
    provider: "gemini",
  },
  "Nano Banana Pro": {
    id: "gemini-3-pro-image",
    name: "Nano Banana Pro",
    category: "IMAGE",
    defaultEndpoint: "",
    provider: "gemini",
  },
  "Nano Banana 2": {
    id: "gemini-3.1-flash-image",
    name: "Nano Banana 2",
    category: "IMAGE",
    defaultEndpoint: "",
    provider: "gemini",
  },
  "Nano Banana": {
    id: "gemini-2.5-flash-image",
    name: "Nano Banana",
    category: "IMAGE",
    defaultEndpoint: "",
    provider: "gemini",
  },
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

  // === 视频模型 ===
  "Veo 3.1 Generate Preview": {
    id: "veo-3.1-generate-preview",
    name: "Veo 3.1 Generate Preview",
    category: "VIDEO",
    defaultEndpoint: "",
    provider: "gemini",
  },
  "Sora 2": {
    id: "sora-2",
    name: "Sora 2",
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
 * 根据类别获取模型列表
 */
export function getModelsByCategory(
  category: "IMAGE" | "VIDEO" | "TEXT",
): ModelDefinition[] {
  const allModels = getAllModels();
  return Object.values(allModels).filter(
    (model) => model.category === category,
  );
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
  return allModels[key]
    || Object.values(allModels).find(model => model.id === key)
    || allModels[LEGACY_MODEL_KEYS[key]];
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
