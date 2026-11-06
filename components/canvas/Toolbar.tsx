"use client";

import React, { useState } from "react";
import { Panel } from "@xyflow/react";
import { Save, FolderOpen, Download, Upload, Trash2 } from "lucide-react";
import { canvasAutosave, useCanvasStore } from "@/store/useCanvasStore";
import { toast } from "sonner";

export function Toolbar() {
  const projectName = useCanvasStore((state) => state.projectName);
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);

  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async () => {
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

  const handleExport = () => {
    const workflow = {
      name: projectName,
      nodes,
      edges,
      viewport: { x: 0, y: 0, zoom: 1 },
    };

    const blob = new Blob([JSON.stringify(workflow, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${projectName}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toast.success("导出成功", {
      description: "工作流已导出到本地",
    });
  };

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

        useCanvasStore.getState().importGraph(data.nodes, data.edges, { name: data.name, viewport: data.viewport });
        toast.success("导入成功", {
          description: "工作流已导入",
        });
      } catch (err) {
        console.error("导入失败:", err);
        toast.error("导入失败", {
          description: "文件格式错误",
        });
      }
    };
    input.click();
  };

  const handleClear = () => {
    if (confirm("确定要清空画布吗？此操作不可撤销。")) {
      // TODO: 清空画布
      toast.success("已清空", {
        description: "画布已清空",
      });
    }
  };

  return (
    <Panel position="top-center" className="flex items-center gap-2">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 p-2 flex items-center gap-1">
        <button
          onClick={handleSave}
          disabled={isSaving || nodes.length === 0}
          className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title="保存工作流 (Ctrl+S)"
        >
          <Save className="w-4 h-4" />
        </button>

        <button
          className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
          title="打开工作流"
        >
          <FolderOpen className="w-4 h-4" />
        </button>

        <div className="w-px h-6 bg-gray-300 dark:bg-gray-600 mx-1" />

        <button
          onClick={handleExport}
          disabled={nodes.length === 0}
          className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title="导出工作流"
        >
          <Download className="w-4 h-4" />
        </button>

        <button
          onClick={handleImport}
          className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
          title="导入工作流"
        >
          <Upload className="w-4 h-4" />
        </button>

        <div className="w-px h-6 bg-gray-300 dark:bg-gray-600 mx-1" />

        <button
          onClick={handleClear}
          disabled={nodes.length === 0}
          className="p-2 hover:bg-red-100 dark:hover:bg-red-900/20 text-red-500 rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title="清空画布"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </Panel>
  );
}
