"use client";

import React, { useState, useEffect, useMemo } from "react";
import {
  X,
  Search,
  TestTube2,
  ChevronDown,
  ChevronRight,
  Plus,
} from "lucide-react";
import { toast } from "sonner";

interface ModelConfig {
  baseUrl?: string;
  key?: string;
  modelId?: string;
  endpoint?: string;
}

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

// 全局配置 Key
const GLOBAL_BASE_URL_KEY = "GLOBAL_BASE_URL";
const GLOBAL_API_KEY_KEY = "GLOBAL_API_KEY";

// 模型注册表
const MODEL_REGISTRY: Record<
  string,
  {
    id: string;
    name: string;
    category: "IMAGE" | "VIDEO";
    defaultEndpoint: string;
  }
> = {
  "阿里云百炼-万相": {
    id: "wan2.6-i2v",
    name: "阿里云百炼（万相 i2v）",
    category: "VIDEO",
    defaultEndpoint: "/api/v1/services/aigc/video-generation/video-synthesis",
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

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [globalBaseUrl, setGlobalBaseUrl] = useState("");
  const [globalApiKey, setGlobalApiKey] = useState("");
  const [configs, setConfigs] = useState<Record<string, ModelConfig>>({});
  const [expandedModels, setExpandedModels] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState("");
  const [filterType, setFilterType] = useState<"all" | "image" | "video">(
    "all",
  );
  const [testingModels, setTestingModels] = useState<Set<string>>(new Set());
  const [testResults, setTestResults] = useState<
    Record<string, "success" | "error" | null>
  >({});
  const [isAddModelOpen, setIsAddModelOpen] = useState(false);
  const [newModel, setNewModel] = useState({
    name: "",
    id: "",
    category: "IMAGE" as "IMAGE" | "VIDEO",
    endpoint: "",
  });
  const [customModels, setCustomModels] = useState<
    Record<string, (typeof MODEL_REGISTRY)[string]>
  >({});

  // 加载配置
  useEffect(() => {
    if (isOpen && typeof window !== "undefined") {
      setGlobalBaseUrl(localStorage.getItem(GLOBAL_BASE_URL_KEY) || "");
      setGlobalApiKey(localStorage.getItem(GLOBAL_API_KEY_KEY) || "");

      const newConfigs: Record<string, ModelConfig> = {};
      Object.keys(MODEL_REGISTRY).forEach((key) => {
        const stored = localStorage.getItem(`API_CONFIG_MODEL_${key}`);
        if (stored) {
          try {
            newConfigs[key] = JSON.parse(stored);
          } catch {
            newConfigs[key] = {};
          }
        } else {
          newConfigs[key] = {};
        }
      });
      setConfigs(newConfigs);
    }
  }, [isOpen]);

  // 保存全局配置
  const saveGlobalConfig = () => {
    if (typeof window === "undefined") return;
    localStorage.setItem(GLOBAL_BASE_URL_KEY, globalBaseUrl);
    localStorage.setItem(GLOBAL_API_KEY_KEY, globalApiKey);

    toast.success("全局配置已保存");
  };

  // 更新模型配置
  const updateConfig = (
    modelKey: string,
    field: keyof ModelConfig,
    value: string,
  ) => {
    setConfigs((prev) => {
      const newConfig = { ...prev[modelKey], [field]: value };
      if (typeof window !== "undefined") {
        localStorage.setItem(
          `API_CONFIG_MODEL_${modelKey}`,
          JSON.stringify(newConfig),
        );
      }
      return { ...prev, [modelKey]: newConfig };
    });
  };

  // 切换展开状态
  const toggleExpand = (key: string) => {
    setExpandedModels((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(key)) {
        newSet.delete(key);
      } else {
        newSet.add(key);
      }
      return newSet;
    });
  };

  // 测试连接
  const testConnection = async (modelKey: string) => {
    setTestingModels((prev) => new Set(prev).add(modelKey));
    setTestResults((prev) => ({ ...prev, [modelKey]: null }));

    try {
      const config = configs[modelKey];
      const baseUrl = (config?.baseUrl || globalBaseUrl || "").replace(
        /\/$/,
        "",
      );
      const apiKey = config?.key || globalApiKey;

      if (!baseUrl || !apiKey) {
        throw new Error("缺少 Base URL 或 API Key");
      }

      // 通过后端 API 测试连接，避免 CORS 问题
      const response = await fetch("/api/test-connection", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          baseUrl,
          apiKey,
          modelKey,
        }),
      });

      const result = await response.json();

      if (result.success) {
        setTestResults((prev) => ({ ...prev, [modelKey]: "success" }));
        toast.success(`${MODEL_REGISTRY[modelKey].name} 连接成功`, {
          description: "API 密钥可以正常访问服务",
        });
      } else {
        setTestResults((prev) => ({ ...prev, [modelKey]: "error" }));
        toast.error(`${MODEL_REGISTRY[modelKey].name} 连接失败`, {
          description: result.error || `状态码: ${result.status}`,
        });
      }
    } catch (e: any) {
      setTestResults((prev) => ({ ...prev, [modelKey]: "error" }));
      toast.error(`${MODEL_REGISTRY[modelKey].name} 测试失败`, {
        description: e.message,
      });
    } finally {
      setTestingModels((prev) => {
        const newSet = new Set(prev);
        newSet.delete(modelKey);
        return newSet;
      });
    }
  };

  // 过滤模型列表
  const filteredModels = useMemo(() => {
    return Object.keys(MODEL_REGISTRY).filter((key) => {
      const def = MODEL_REGISTRY[key];

      const matchesSearch =
        !searchTerm ||
        def.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        def.id.toLowerCase().includes(searchTerm.toLowerCase());

      const matchesType =
        filterType === "all" ||
        (filterType === "image" && def.category === "IMAGE") ||
        (filterType === "video" && def.category === "VIDEO");

      return matchesSearch && matchesType;
    });
  }, [searchTerm, filterType]);

  // 判断模型是否已配置
  const isConfigured = (key: string) => {
    const config = configs[key];
    return !!(
      (config?.key || globalApiKey) &&
      (config?.baseUrl || globalBaseUrl)
    );
  };

  if (!isOpen) return null;

  // 主题样式 - 固定为暗色主题
  const bgCard = "bg-[#18181b]";
  const borderColor = "border-[#27272a]";
  const textMain = "text-white";
  const textSub = "text-gray-400";
  const textMuted = "text-gray-600";
  const inputBg = "bg-[#0f0f11]";

  return (
    <div
      className="fixed inset-0 z-250 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className={`w-full max-w-3xl max-h-[90vh] rounded-2xl overflow-hidden shadow-2xl border ${bgCard} ${borderColor} flex flex-col animate-in zoom-in-95 duration-200`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className={`px-6 py-4 border-b ${borderColor} flex items-center justify-between shrink-0`}
        >
          <h2 className={`text-lg font-bold ${textMain}`}>模型接口配置</h2>
          <button
            onClick={onClose}
            className="p-2 rounded-lg transition-colors hover:bg-white/5 text-gray-400"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto custom-scrollbar">
          <div className="p-6 space-y-6">
            {/* 全局配置 */}
            <div className="space-y-4">
              <div className="space-y-2">
                <label
                  className={`text-xs font-medium uppercase tracking-wider ${textSub}`}
                >
                  GLOBAL BASE URL（全局 API 地址）
                </label>
                <input
                  type="text"
                  value={globalBaseUrl}
                  onChange={(e) => setGlobalBaseUrl(e.target.value)}
                  onBlur={saveGlobalConfig}
                  className={`w-full px-4 py-3 rounded-xl text-sm border ${borderColor} ${inputBg} ${textMain} outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/50 transition-all`}
                  placeholder="https://api.example.com"
                />
                <p className={`text-xs ${textMuted}`}>
                  修改后将作为所有模型的默认 BASE URL
                </p>
              </div>

              <div className="space-y-2">
                <label
                  className={`text-xs font-medium uppercase tracking-wider ${textSub}`}
                >
                  GLOBAL API KEY（可选，全局默认 KEY）
                </label>
                <input
                  type="password"
                  value={globalApiKey}
                  onChange={(e) => setGlobalApiKey(e.target.value)}
                  onBlur={saveGlobalConfig}
                  className={`w-full px-4 py-3 rounded-xl text-sm border ${borderColor} ${inputBg} ${textMain} outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/50 transition-all`}
                  placeholder="sk-..."
                />
              </div>
            </div>

            {/* 分隔线 */}
            <div className={`border-t ${borderColor}`}></div>

            {/* 搜索和筛选 */}
            <div className="flex items-center gap-3">
              <div className="flex-1 relative">
                <Search
                  size={16}
                  className={`absolute left-3 top-1/2 -translate-y-1/2 ${textMuted}`}
                />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className={`w-full pl-10 pr-4 py-2.5 rounded-xl text-sm border ${borderColor} ${inputBg} ${textMain} outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/50 transition-all`}
                  placeholder="搜索模型..."
                />
              </div>
              <div
                className={`flex p-1 rounded-xl border ${borderColor} bg-[#0f0f11]`}
              >
                {(["all", "image", "video"] as const).map((type) => (
                  <button
                    key={type}
                    onClick={() => setFilterType(type)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                      filterType === type
                        ? "bg-blue-500 text-white shadow-sm"
                        : "text-gray-400 hover:text-white"
                    }`}
                  >
                    {type === "all"
                      ? "全部"
                      : type === "image"
                        ? "图片"
                        : "视频"}
                  </button>
                ))}
              </div>
            </div>

            {/* 模型列表 */}
            <div className="space-y-2">
              {filteredModels.map((key) => {
                const def = MODEL_REGISTRY[key];
                const config = configs[key] || {};
                const isExpanded = expandedModels.has(key);
                const isTesting = testingModels.has(key);
                const testResult = testResults[key];
                const configured = isConfigured(key);

                return (
                  <div
                    key={key}
                    className={`rounded-xl border ${borderColor} overflow-hidden ${bgCard}`}
                  >
                    {/* Header */}
                    <button
                      onClick={() => toggleExpand(key)}
                      className="w-full px-4 py-3 flex items-center gap-3 hover:bg-white/5 transition-colors"
                    >
                      {isExpanded ? (
                        <ChevronDown size={16} className={textSub} />
                      ) : (
                        <ChevronRight size={16} className={textSub} />
                      )}
                      <div
                        className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                          def.category === "IMAGE"
                            ? "bg-blue-500/10 text-blue-400"
                            : "bg-purple-500/10 text-purple-400"
                        }`}
                      >
                        <span className="text-xs font-bold">
                          {def.category === "IMAGE" ? "图" : "视"}
                        </span>
                      </div>
                      <div className="flex-1 text-left">
                        <div className={`text-sm font-semibold ${textMain}`}>
                          {def.name}
                        </div>
                        <div className={`text-xs ${textMuted}`}>{def.id}</div>
                      </div>
                      {configured && (
                        <div className="px-2 py-1 rounded-md bg-emerald-500/10 text-emerald-400 text-xs font-medium">
                          已配置
                        </div>
                      )}
                      {testResult === "success" && (
                        <div className="w-2 h-2 rounded-full bg-emerald-400"></div>
                      )}
                      {testResult === "error" && (
                        <div className="w-2 h-2 rounded-full bg-red-400"></div>
                      )}
                    </button>

                    {/* Expanded Content */}
                    {isExpanded && (
                      <div
                        className={`px-4 pb-4 space-y-3 border-t ${borderColor}`}
                      >
                        <div className="space-y-2 pt-3">
                          <label className={`text-xs font-medium ${textSub}`}>
                            Base URL (留空使用全局)
                          </label>
                          <input
                            type="text"
                            value={config.baseUrl || ""}
                            onChange={(e) =>
                              updateConfig(key, "baseUrl", e.target.value)
                            }
                            className={`w-full px-3 py-2 rounded-lg text-sm border ${borderColor} ${inputBg} ${textMain} outline-none focus:ring-2 focus:ring-blue-500/20`}
                            placeholder={
                              globalBaseUrl || "https://api.example.com"
                            }
                          />
                        </div>

                        <div className="space-y-2">
                          <label className={`text-xs font-medium ${textSub}`}>
                            API Key (留空使用全局)
                          </label>
                          <input
                            type="password"
                            value={config.key || ""}
                            onChange={(e) =>
                              updateConfig(key, "key", e.target.value)
                            }
                            className={`w-full px-3 py-2 rounded-lg text-sm border ${borderColor} ${inputBg} ${textMain} outline-none focus:ring-2 focus:ring-blue-500/20`}
                            placeholder="sk-..."
                          />
                        </div>

                        <div className="space-y-2">
                          <label className={`text-xs font-medium ${textSub}`}>
                            Model ID
                          </label>
                          <input
                            type="text"
                            value={config.modelId || ""}
                            onChange={(e) =>
                              updateConfig(key, "modelId", e.target.value)
                            }
                            className={`w-full px-3 py-2 rounded-lg text-sm border ${borderColor} ${inputBg} ${textMain} outline-none focus:ring-2 focus:ring-blue-500/20`}
                            placeholder={def.id}
                          />
                        </div>

                        <div className="space-y-2">
                          <label className={`text-xs font-medium ${textSub}`}>
                            Endpoint
                          </label>
                          <input
                            type="text"
                            value={config.endpoint || ""}
                            onChange={(e) =>
                              updateConfig(key, "endpoint", e.target.value)
                            }
                            className={`w-full px-3 py-2 rounded-lg text-sm border ${borderColor} ${inputBg} ${textMain} outline-none focus:ring-2 focus:ring-blue-500/20`}
                            placeholder={def.defaultEndpoint}
                          />
                        </div>

                        <button
                          onClick={() => testConnection(key)}
                          disabled={isTesting}
                          className="w-full mt-2 px-4 py-2 rounded-lg bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 text-sm font-medium transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                        >
                          <TestTube2 size={14} />
                          {isTesting ? "测试中..." : "测试连接"}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
