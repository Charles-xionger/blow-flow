"use client";

import { memo } from "react";
import React, { useState, useEffect } from "react";
import { useReactFlow, useStore } from "@xyflow/react";
import { canvasAutosave, canvasDraftStorage, useCanvasStore } from "@/store/useCanvasStore";
import {
  Sparkles,
  Download,
  Upload,
  Save,
  Sun,
  Moon,
  Settings as SettingsIcon,
  Trash2,
} from "lucide-react";
import { SettingsModal } from "@/components/settings/SettingsModal";
import { toast } from "sonner";

export const TopBar = memo(function TopBar() {
  const reactFlowInstance = useReactFlow();
  const zoom = useStore((state) => Math.round(state.transform[2] * 100));
  const projectName = useCanvasStore((state) => state.projectName);
  const setProjectName = useCanvasStore((state) => state.setProjectName);
  const isDarkMode = useCanvasStore((state) => state.isDarkMode);
  const toggleTheme = useCanvasStore((state) => state.toggleTheme);
  const nodeCount = useCanvasStore((state) => state.nodes.length);
  const clearCanvas = useCanvasStore((state) => state.clearCanvas);
  const importGraph = useCanvasStore((state) => state.importGraph);

  const [isEditingProjectName, setIsEditingProjectName] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [mounted, setMounted] = useState(false);

  // 等待客户端挂载完成，避免 hydration 错误
  useEffect(() => {
    setMounted(true);
  }, []);

  // 从 viewport hook 获取实时缩放值


  const isDark = isDarkMode;

  // 保存工作流到数据库
  const handleSave = async () => {
    canvasDraftStorage.flush();
    setIsSaving(true);
    try {
      await canvasAutosave.save();
      toast.success("保存成功");
    } catch (error) {
      toast.error("保存失败", {
        description: error instanceof Error ? error.message : "未知错误",
      });
    } finally {
      setIsSaving(false);
    }
  };

  // 下载/导出工作流
  const handleExport = () => {
    const { nodes, edges } = useCanvasStore.getState();
    try {
      const workflow = {
        projectName,
        nodes,
        edges,
        version: "1.0.0",
        createdAt: new Date().toISOString(),
      };

      const dataStr = JSON.stringify(workflow, null, 2);
      const dataUri =
        "data:application/json;charset=utf-8," + encodeURIComponent(dataStr);

      const exportFileDefaultName = `${projectName || "workflow"}_${
        new Date().toISOString().split("T")[0]
      }.json`;

      const linkElement = document.createElement("a");
      linkElement.setAttribute("href", dataUri);
      linkElement.setAttribute("download", exportFileDefaultName);
      linkElement.click();

      toast.success("导出成功", {
        description: `已导出为 ${exportFileDefaultName}`,
      });
    } catch (error) {
      toast.error("导出失败", {
        description: error instanceof Error ? error.message : "未知错误",
      });
    }
  };

  // 导入工作流
  const handleImport = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      try {
        const text = await file.text();
        const data = JSON.parse(text);

        // 导入工作流到 store
        if (data.nodes && data.edges) {
          importGraph(data.nodes, data.edges);
          if (data.projectName) {
            setProjectName(data.projectName);
          }
          if (data.viewport && reactFlowInstance) {
            reactFlowInstance.setViewport(data.viewport);
          }
          toast.success("导入成功", {
            description: `已导入工作流 "${data.projectName || "未命名"}"`,
          });
        } else {
          throw new Error("文件格式不正确");
        }
      } catch (err) {
        console.error("导入失败:", err);
        toast.error("导入失败", {
          description: "文件格式错误",
        });
      }
    };
    input.click();
  };

  // 清空画布
  const handleClear = () => {
    if (nodeCount === 0) {
      toast.info("画布已经是空的");
      return;
    }

    const confirmed = window.confirm(
      `确定要清空画布吗？\n这将删除所有 ${nodeCount} 个节点。`,
    );

    if (confirmed) {
      clearCanvas();
      toast.success("画布已清空");
    }
  };

  // Prevent hydration mismatch by not rendering theme-dependent content until mounted
  if (!mounted) {
    return null;
  }

  return (
    <>
      {/* 左上角：项目名称 */}
      <div className="absolute top-4 left-4 z-50">
        <div
          className={`flex items-center gap-2.5 px-2 py-1.5 rounded-2xl backdrop-blur-xl border transition-all duration-300 ${
            isDark
              ? "bg-[#18181b]/90 border-zinc-800 shadow-xl"
              : "bg-white/90 border-gray-200 shadow-lg"
          }`}
        >
          {/* Logo */}
          <div
            className={`w-8 h-8 rounded-xl flex items-center justify-center ${
              isDark
                ? "bg-blue-500/20 text-blue-400"
                : "bg-blue-100 text-blue-600"
            }`}
          >
            <Sparkles size={16} />
          </div>

          {/* 项目名称 */}
          {isEditingProjectName ? (
            <input
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              onBlur={() => setIsEditingProjectName(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setIsEditingProjectName(false);
                if (e.key === "Escape") setIsEditingProjectName(false);
              }}
              autoFocus
              className={`w-36 px-2 py-1 rounded-lg text-sm font-medium border-0 outline-none bg-transparent ${
                isDark ? "text-white" : "text-gray-900"
              }`}
              placeholder="项目名称..."
            />
          ) : (
            <button
              onClick={() => setIsEditingProjectName(true)}
              className={`text-sm font-medium max-w-35 truncate transition-colors ${
                isDark
                  ? "text-gray-200 hover:text-white"
                  : "text-gray-800 hover:text-black"
              }`}
            >
              {projectName}
            </button>
          )}
        </div>
      </div>

      {/* 右上角：工具栏 */}
      <div className="absolute top-4 right-4 z-50">
        <div
          className={`flex items-center gap-1 px-2 py-1.5 rounded-2xl backdrop-blur-xl border transition-all ${
            isDark
              ? "bg-[#18181b]/90 border-zinc-800 shadow-xl"
              : "bg-white/90 border-gray-200 shadow-lg"
          }`}
        >
          {/* 缩放显示 */}
          <span
            className={`px-3 py-1.5 text-sm font-medium tabular-nums ${
              isDark ? "text-gray-300" : "text-gray-700"
            }`}
          >
            {zoom}%
          </span>

          <div
            className={`w-px h-5 ${isDark ? "bg-zinc-700" : "bg-gray-200"}`}
          />

          {/* 保存 */}
          <button
            onClick={handleSave}
            disabled={isSaving}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
              isDark
                ? "text-gray-400 hover:text-white hover:bg-white/5"
                : "text-gray-600 hover:text-gray-900 hover:bg-gray-100"
            }`}
          >
            <Save size={15} />
            <span>保存</span>
          </button>

          {/* 下载 */}
          <button
            onClick={handleExport}
            disabled={nodeCount === 0}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
              isDark
                ? "text-gray-400 hover:text-white hover:bg-white/5"
                : "text-gray-600 hover:text-gray-900 hover:bg-gray-100"
            }`}
          >
            <Download size={15} />
            <span>导出</span>
          </button>

          {/* 导入 */}
          <button
            onClick={handleImport}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium transition-all ${
              isDark
                ? "text-gray-400 hover:text-white hover:bg-white/5"
                : "text-gray-600 hover:text-gray-900 hover:bg-gray-100"
            }`}
          >
            <Upload size={15} />
            <span>导入</span>
          </button>

          <div
            className={`w-px h-5 ${isDark ? "bg-zinc-700" : "bg-gray-200"}`}
          />

          {/* 主题切换 */}
          <button
            onClick={toggleTheme}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium transition-all ${
              isDark
                ? "text-gray-400 hover:text-white hover:bg-white/5"
                : "text-gray-600 hover:text-gray-900 hover:bg-gray-100"
            }`}
            suppressHydrationWarning
          >
            {mounted ? (
              <>
                {isDark ? <Moon size={15} /> : <Sun size={15} />}
                <span>{isDark ? "暗色" : "亮色"}</span>
              </>
            ) : (
              <span className="w-16 h-4" />
            )}
          </button>

          {/* 清空 */}
          <button
            onClick={handleClear}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium transition-all ${
              isDark
                ? "text-gray-400 hover:text-white hover:bg-white/5"
                : "text-gray-600 hover:text-gray-900 hover:bg-gray-100"
            }`}
          >
            <Trash2 size={15} />
            <span>清空</span>
          </button>

          {/* API 设置 */}
          <button
            onClick={() => setIsSettingsOpen(true)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-medium transition-all ${
              isDark
                ? "text-gray-400 hover:text-white hover:bg-white/5"
                : "text-gray-600 hover:text-gray-900 hover:bg-gray-100"
            }`}
          >
            <SettingsIcon size={15} />
            <span>API 设置</span>
          </button>
        </div>
      </div>

      {/* 设置模态框 */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
      />
    </>
  );
});
