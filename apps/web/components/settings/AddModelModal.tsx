"use client";

import React, { useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";

interface AddModelModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (model: {
    key: string;
    name: string;
    id: string;
    category: "IMAGE" | "VIDEO";
    defaultEndpoint: string;
  }) => void;
}

export function AddModelModal({ isOpen, onClose, onAdd }: AddModelModalProps) {
  const [modelName, setModelName] = useState("");
  const [modelId, setModelId] = useState("");
  const [category, setCategory] = useState<"IMAGE" | "VIDEO">("IMAGE");
  const [endpoint, setEndpoint] = useState("");

  const handleAdd = (e?: React.FormEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    if (!modelName.trim()) {
      toast.error("请输入模型名称");
      return;
    }

    if (!modelId.trim()) {
      toast.error("请输入模型 ID");
      return;
    }

    // 生成模型 key（使用名称或 ID）
    const key = modelName.trim();

    // 使用默认端点
    const finalEndpoint =
      endpoint.trim() ||
      (category === "IMAGE"
        ? "/v1/images/generations"
        : "/v1/videos/generations");

    onAdd({
      key,
      name: modelName.trim(),
      id: modelId.trim(),
      category,
      defaultEndpoint: finalEndpoint,
    });

    // 重置表单
    setModelName("");
    setModelId("");
    setCategory("IMAGE");
    setEndpoint("");

    onClose();
  };

  const handleCancel = () => {
    setModelName("");
    setModelId("");
    setCategory("IMAGE");
    setEndpoint("");
    onClose();
  };

  if (!isOpen) return null;

  // 主题样式
  const bgCard = "bg-[#18181b]";
  const borderColor = "border-[#27272a]";
  const textMain = "text-white";
  const textSub = "text-gray-400";
  const inputBg = "bg-[#0f0f11]";

  return (
    <div
      className="fixed inset-0 z-300 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={handleCancel}
    >
      <div
        className={`w-full max-w-lg rounded-2xl overflow-hidden shadow-2xl border ${bgCard} ${borderColor} flex flex-col animate-in zoom-in-95 duration-200`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className={`px-6 py-4 border-b ${borderColor} flex items-center justify-between`}
        >
          <h2 className={`text-lg font-bold ${textMain}`}>添加自定义模型</h2>
          <button
            onClick={handleCancel}
            className="p-2 rounded-lg transition-colors hover:bg-white/5 text-gray-400"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          {/* 模型名称 */}
          <div className="space-y-2">
            <label className={`text-sm font-medium ${textSub}`}>模型名称</label>
            <input
              type="text"
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              className={`w-full px-4 py-3 rounded-xl text-sm border ${borderColor} ${inputBg} ${textMain} outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/50 transition-all`}
              placeholder="My Custom Model"
            />
          </div>

          {/* 模型 ID */}
          <div className="space-y-2">
            <label className={`text-sm font-medium ${textSub}`}>模型 ID</label>
            <input
              type="text"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              className={`w-full px-4 py-3 rounded-xl text-sm border ${borderColor} ${inputBg} ${textMain} outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/50 transition-all`}
              placeholder="custom-model-v1"
            />
          </div>

          {/* 模型类型 */}
          <div className="space-y-2">
            <label className={`text-sm font-medium ${textSub}`}>模型类型</label>
            <div className="flex gap-3">
              <button
                onClick={() => setCategory("IMAGE")}
                className={`flex-1 px-4 py-3 rounded-xl text-sm font-medium transition-all border ${
                  category === "IMAGE"
                    ? "bg-blue-500 text-white border-blue-500"
                    : `${borderColor} ${textSub} hover:bg-white/5`
                }`}
              >
                图像生成
              </button>
              <button
                onClick={() => setCategory("VIDEO")}
                className={`flex-1 px-4 py-3 rounded-xl text-sm font-medium transition-all border ${
                  category === "VIDEO"
                    ? "bg-purple-500 text-white border-purple-500"
                    : `${borderColor} ${textSub} hover:bg-white/5`
                }`}
              >
                视频生成
              </button>
            </div>
          </div>

          {/* Endpoint (可选) */}
          <div className="space-y-2">
            <label className={`text-sm font-medium ${textSub}`}>
              Endpoint（可选）
            </label>
            <input
              type="text"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              className={`w-full px-4 py-3 rounded-xl text-sm border ${borderColor} ${inputBg} ${textMain} outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/50 transition-all`}
              placeholder={
                category === "IMAGE"
                  ? "/v1/images/generations"
                  : "/v1/videos/generations"
              }
            />
            <p className={`text-xs ${textSub}`}>留空将使用默认端点</p>
          </div>
        </div>

        {/* Footer */}
        <div className={`px-6 py-4 border-t ${borderColor} flex gap-3`}>
          <button
            type="button"
            onClick={handleCancel}
            className={`flex-1 px-4 py-3 rounded-xl text-sm font-medium border ${borderColor} ${textSub} hover:bg-white/5 transition-all`}
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleAdd}
            className="flex-1 px-4 py-3 rounded-xl text-sm font-medium bg-blue-500 hover:bg-blue-600 text-white transition-all"
          >
            添加
          </button>
        </div>
      </div>
    </div>
  );
}
