"use client";

import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  X,
  Search,
  TestTube2,
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { AddModelModal } from "./AddModelModal";
import { getAllModels, type ModelDefinition } from "@/lib/model-registry";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

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
  const [modelRegistry, setModelRegistry] = useState<
    Record<string, ModelDefinition>
  >({});
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [modelToDelete, setModelToDelete] = useState<string | null>(null);
  const [savingModels, setSavingModels] = useState<Set<string>>(new Set());

  // 从数据库和 localStorage 加载配置（使用 useCallback 避免重复创建）
  const loadConfigs = useCallback(
    async (allModels: Record<string, ModelDefinition>) => {
      try {
        // 首先从数据库加载
        console.log("[Settings] Loading configs from database...");
        const response = await fetch("/api/model-config");
        const result = await response.json();

        const newConfigs: Record<string, ModelConfig> = {};
        let dbConfigCount = 0;
        let localConfigCount = 0;

        if (result.success && result.data) {
          console.log("[Settings] Database response:", result);

          // 使用数据库中的配置
          Object.keys(allModels).forEach((key) => {
            const dbConfig = result.data[key];
            if (dbConfig && (dbConfig.baseUrl || dbConfig.key)) {
              // 数据库中有配置，使用数据库配置并同步到 localStorage
              newConfigs[key] = {
                baseUrl: dbConfig.baseUrl,
                key: dbConfig.key,
                modelId: dbConfig.modelId,
                endpoint: dbConfig.endpoint,
              };

              // 同步回 localStorage，确保数据一致性
              if (typeof window !== "undefined") {
                localStorage.setItem(
                  `API_CONFIG_MODEL_${key}`,
                  JSON.stringify(newConfigs[key]),
                );
              }

              dbConfigCount++;
              console.log(`[Settings] Loaded config for ${key} from database`);
            } else {
              // 如果数据库中没有，尝试从 localStorage 加载
              const stored = localStorage.getItem(`API_CONFIG_MODEL_${key}`);
              if (stored) {
                try {
                  const localConfig = JSON.parse(stored);
                  if (localConfig.baseUrl || localConfig.key) {
                    newConfigs[key] = localConfig;
                    localConfigCount++;
                    console.log(
                      `[Settings] Loaded config for ${key} from localStorage`,
                    );
                  } else {
                    newConfigs[key] = {};
                  }
                } catch {
                  newConfigs[key] = {};
                }
              } else {
                newConfigs[key] = {};
              }
            }
          });

          console.log(
            `[Settings] Loaded ${dbConfigCount} configs from database, ${localConfigCount} from localStorage`,
          );
        } else {
          console.log(
            "[Settings] Database load failed, falling back to localStorage",
          );
          // 如果数据库加载失败，从 localStorage 加载
          Object.keys(allModels).forEach((key) => {
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
        }

        setConfigs(newConfigs);
      } catch (error) {
        console.error("[Settings] Failed to load configs:", error);
        // 降级到 localStorage
        const newConfigs: Record<string, ModelConfig> = {};
        Object.keys(allModels).forEach((key) => {
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
    },
    [],
  );

  // 加载配置
  useEffect(() => {
    if (isOpen && typeof window !== "undefined") {
      setGlobalBaseUrl(localStorage.getItem(GLOBAL_BASE_URL_KEY) || "");
      setGlobalApiKey(localStorage.getItem(GLOBAL_API_KEY_KEY) || "");

      // 加载所有模型（内置 + 自定义）
      const allModels = getAllModels();
      setModelRegistry(allModels);

      // 从数据库和 localStorage 加载配置
      loadConfigs(allModels);
    }
  }, [isOpen, loadConfigs]);

  // 保存全局配置
  const saveGlobalConfig = async () => {
    if (typeof window === "undefined") return;
    localStorage.setItem(GLOBAL_BASE_URL_KEY, globalBaseUrl);
    localStorage.setItem(GLOBAL_API_KEY_KEY, globalApiKey);

    // 更新所有使用全局配置的模型到数据库
    try {
      const updatePromises = Object.keys(modelRegistry).map(
        async (modelKey) => {
          const config = configs[modelKey] || {};
          const modelDef = modelRegistry[modelKey];

          // 如果模型没有自己的 baseUrl 或 key，使用全局配置
          const fullConfig = {
            modelId: config.modelId || modelDef.id,
            baseUrl: config.baseUrl || globalBaseUrl,
            key: config.key || globalApiKey,
            endpoint: config.endpoint || modelDef.defaultEndpoint,
          };

          // 只有当有完整配置时才保存
          if (fullConfig.baseUrl && fullConfig.key) {
            await fetch("/api/model-config", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                modelName: modelKey,
                config: fullConfig,
              }),
            });
          }
        },
      );

      await Promise.all(updatePromises);
    } catch (error) {
      console.error("Failed to update configs in database:", error);
    }

    toast.success("全局配置已保存");
  };

  // 更新模型配置（仅更新本地状态，不保存）
  const updateConfig = (
    modelKey: string,
    field: keyof ModelConfig,
    value: string,
  ) => {
    const newConfig = { ...configs[modelKey], [field]: value };

    setConfigs((prev) => ({
      ...prev,
      [modelKey]: newConfig,
    }));
  };

  // 保存模型配置到数据库
  const saveModelConfig = async (modelKey: string) => {
    setSavingModels((prev) => new Set(prev).add(modelKey));

    try {
      const modelDef = modelRegistry[modelKey];
      if (!modelDef) {
        toast.error("模型定义不存在");
        return;
      }

      const config = configs[modelKey];

      // 构建完整的配置对象
      const fullConfig = {
        modelId: config.modelId || modelDef.id,
        baseUrl: config.baseUrl || globalBaseUrl,
        key: config.key || globalApiKey,
        endpoint: config.endpoint || modelDef.defaultEndpoint,
      };

      console.log("[Settings] Saving config to database:", {
        modelKey,
        fullConfig: {
          ...fullConfig,
          key: fullConfig.key ? "***" : "(empty)",
        },
      });

      // 验证必填字段
      if (!fullConfig.baseUrl || !fullConfig.key) {
        toast.error("请填写 Base URL 和 API Key");
        return;
      }

      // 保存到数据库
      const response = await fetch("/api/model-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelName: modelKey,
          config: fullConfig,
        }),
      });

      const result = await response.json();
      console.log("[Settings] Database save result:", result);

      if (result.success) {
        // 保存成功后，同步到 localStorage
        if (typeof window !== "undefined") {
          localStorage.setItem(
            `API_CONFIG_MODEL_${modelKey}`,
            JSON.stringify(config),
          );
        }

        toast.success(
          `"${modelRegistry[modelKey]?.name || modelKey}" 配置已保存`,
        );
      } else {
        throw new Error(result.error || "保存失败");
      }
    } catch (error) {
      console.error("Failed to save config to database:", error);
      toast.error(
        `保存失败：${error instanceof Error ? error.message : "未知错误"}`,
      );
    } finally {
      setSavingModels((prev) => {
        const newSet = new Set(prev);
        newSet.delete(modelKey);
        return newSet;
      });
    }
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
        toast.success(`${modelRegistry[modelKey]?.name || modelKey} 连接成功`, {
          description: "API 密钥可以正常访问服务",
        });
      } else {
        setTestResults((prev) => ({ ...prev, [modelKey]: "error" }));
        toast.error(`${modelRegistry[modelKey]?.name || modelKey} 连接失败`, {
          description: result.error || `状态码: ${result.status}`,
        });
      }
    } catch (e: any) {
      setTestResults((prev) => ({ ...prev, [modelKey]: "error" }));
      toast.error(`${modelRegistry[modelKey]?.name || modelKey} 测试失败`, {
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
    return Object.keys(modelRegistry).filter((key) => {
      const def = modelRegistry[key];

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
  }, [searchTerm, filterType, modelRegistry]);

  // 判断模型是否已配置
  const isConfigured = (key: string) => {
    const config = configs[key];
    return !!(
      (config?.key || globalApiKey) &&
      (config?.baseUrl || globalBaseUrl)
    );
  };

  // 删除模型配置
  const handleDeleteConfig = (modelKey: string) => {
    console.log("[Settings] Delete config clicked for:", modelKey);
    setModelToDelete(modelKey);
    setDeleteConfirmOpen(true);
  };

  // 确认删除
  const confirmDeleteConfig = async () => {
    if (!modelToDelete) return;

    // 保存原始配置用于回滚
    const originalConfig = configs[modelToDelete];

    try {
      // 先调用数据库删除（如果配置存在的话）
      const response = await fetch(
        `/api/model-config?model=${encodeURIComponent(modelToDelete)}`,
        {
          method: "DELETE",
        },
      );

      const result = await response.json();

      // 404 表示配置不存在，这是正常情况（配置可能从未保存过）
      // 只有非 404 的错误才需要抛出异常
      if (!result.success && response.status !== 404) {
        throw new Error(result.error || "数据库删除失败");
      }

      // 数据库删除成功或配置不存在，清除本地状态
      setConfigs((prev) => {
        const newConfigs = { ...prev };
        delete newConfigs[modelToDelete]; // 使用 delete 删除属性而不是设置为空对象
        return newConfigs;
      });

      // 从 localStorage 清除
      if (typeof window !== "undefined") {
        localStorage.removeItem(`API_CONFIG_MODEL_${modelToDelete}`);
      }

      // 清除测试结果
      setTestResults((prev) => {
        const newResults = { ...prev };
        delete newResults[modelToDelete];
        return newResults;
      });

      toast.success(
        `"${modelRegistry[modelToDelete]?.name || modelToDelete}" 配置已删除`,
      );
    } catch (error) {
      console.error("Failed to delete config:", error);
      // 回滚本地状态
      setConfigs((prev) => ({
        ...prev,
        [modelToDelete]: originalConfig || {},
      }));
      toast.error(
        `删除配置失败：${error instanceof Error ? error.message : "未知错误"}`,
      );
    } finally {
      setDeleteConfirmOpen(false);
      setModelToDelete(null);
    }
  };
  // 添加自定义模型
  const handleAddCustomModel = (model: {
    key: string;
    name: string;
    id: string;
    category: "IMAGE" | "VIDEO";
    defaultEndpoint: string;
  }) => {
    // 保存到 localStorage 的自定义模型列表
    const customModelsKey = "CUSTOM_MODELS";
    const stored = localStorage.getItem(customModelsKey);
    const customModels = stored ? JSON.parse(stored) : {};

    customModels[model.key] = {
      id: model.id,
      name: model.name,
      category: model.category,
      defaultEndpoint: model.defaultEndpoint,
    };

    localStorage.setItem(customModelsKey, JSON.stringify(customModels));

    // 更新本地状态
    setModelRegistry((prev) => ({
      ...prev,
      [model.key]: {
        id: model.id,
        name: model.name,
        category: model.category,
        defaultEndpoint: model.defaultEndpoint,
      },
    }));

    // 初始化新模型的配置
    setConfigs((prev) => ({
      ...prev,
      [model.key]: {},
    }));

    // 显示成功提示
    toast.success(`模型 "${model.name}" 添加成功`, {
      description: "模型已添加到列表，可以立即使用",
    });
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
              <button
                type="button"
                onClick={() => setIsAddModelOpen(true)}
                className="shrink-0 px-4 py-2.5 rounded-xl text-sm font-medium bg-blue-500 hover:bg-blue-600 text-white transition-all flex items-center gap-2"
              >
                <Plus size={16} />
                添加模型
              </button>
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
                const def = modelRegistry[key];
                const config = configs[key] || {};
                const isExpanded = expandedModels.has(key);
                const isTesting = testingModels.has(key);
                const isSaving = savingModels.has(key);
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

                        <div className="flex gap-2 mt-2">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              testConnection(key);
                            }}
                            disabled={isTesting}
                            className="flex-1 px-4 py-2 rounded-lg bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 text-sm font-medium transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                          >
                            <TestTube2 size={14} />
                            {isTesting ? "测试中..." : "测试连接"}
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              saveModelConfig(key);
                            }}
                            disabled={isSaving}
                            className="flex-1 px-4 py-2 rounded-lg bg-green-500/10 hover:bg-green-500/20 text-green-400 text-sm font-medium transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                          >
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                              <polyline points="17 21 17 13 7 13 7 21" />
                              <polyline points="7 3 7 8 15 8" />
                            </svg>
                            {isSaving ? "保存中..." : "保存配置"}
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteConfig(key);
                            }}
                            className="px-4 py-2 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 text-sm font-medium transition-colors flex items-center justify-center gap-2"
                            title="删除此模型的配置"
                          >
                            <Trash2 size={14} />
                            删除配置
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* 添加模型弹窗 */}
      <AddModelModal
        isOpen={isAddModelOpen}
        onClose={() => setIsAddModelOpen(false)}
        onAdd={handleAddCustomModel}
      />

      {/* 删除配置确认对话框 */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent
          className="sm:max-w-106.25"
          overlayZIndex={260}
          contentZIndex={270}
        >
          <DialogHeader>
            <DialogTitle>删除模型配置</DialogTitle>
            <DialogDescription>
              确定要删除 &quot;
              {(modelToDelete && modelRegistry[modelToDelete]?.name) ||
                modelToDelete}
              &quot; 的配置吗？
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm text-muted-foreground">
              此操作将清除该模型的所有自定义配置：
            </p>
            <ul className="mt-2 text-sm text-muted-foreground list-disc list-inside space-y-1">
              <li>Base URL</li>
              <li>API Key</li>
              <li>Model ID</li>
              <li>Endpoint</li>
            </ul>
            <p className="mt-3 text-muted-foreground">
              <strong>注意：</strong>
              模型本身不会被删除，您可以随时重新配置。
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setDeleteConfirmOpen(false);
                setModelToDelete(null);
              }}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={confirmDeleteConfig}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              删除配置
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
