"use client";

import React from "react";
import { NodeType } from "@/types";
import { useCanvasStore } from "@/store/useCanvasStore";
import {
  Image,
  Video,
  ImagePlus,
  VideoIcon,
  Sparkles,
  FileImage,
  Settings,
} from "lucide-react";

const nodeCategories = [
  {
    title: "图像生成",
    nodes: [
      { type: NodeType.TEXT_TO_IMAGE, icon: Image, label: "文生图" },
      { type: NodeType.IMAGE_TO_IMAGE, icon: ImagePlus, label: "图生图" },
      { type: NodeType.ORIGINAL_IMAGE, icon: FileImage, label: "原始图片" },
    ],
  },
  {
    title: "视频生成",
    nodes: [
      { type: NodeType.TEXT_TO_VIDEO, icon: Video, label: "文生视频" },
      { type: NodeType.IMAGE_TO_VIDEO, icon: VideoIcon, label: "图生视频" },
      {
        type: NodeType.START_END_TO_VIDEO,
        icon: VideoIcon,
        label: "首尾帧生成",
      },
    ],
  },
  {
    title: "工具",
    nodes: [
      { type: NodeType.CREATIVE_DESC, icon: Sparkles, label: "创意描述" },
    ],
  },
];

export default function Sidebar() {
  const { addNode, toggleTheme, isDarkMode, projectName, setProjectName } =
    useCanvasStore();

  const onDragStart = (event: React.DragEvent, nodeType: NodeType) => {
    event.dataTransfer.setData("application/reactflow-nodetype", nodeType);
    event.dataTransfer.effectAllowed = "move";
  };

  return (
    <div className="w-64 h-screen bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 flex flex-col">
      {/* 头部 */}
      <div className="p-4 border-b border-gray-200 dark:border-gray-700">
        <input
          type="text"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
          placeholder="项目名称"
        />
      </div>

      {/* 节点库 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {nodeCategories.map((category) => (
          <div key={category.title}>
            <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 mb-2">
              {category.title}
            </h3>
            <div className="space-y-2">
              {category.nodes.map((node) => {
                const Icon = node.icon;
                return (
                  <div
                    key={node.type}
                    draggable
                    onDragStart={(e) => onDragStart(e, node.type)}
                    onClick={() => addNode(node.type)}
                    className="flex items-center gap-2 p-3 rounded-lg border border-gray-200 dark:border-gray-700 cursor-grab active:cursor-grabbing hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                  >
                    <Icon className="w-5 h-5" />
                    <span className="text-sm font-medium">{node.label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* 底部工具栏 */}
      <div className="p-4 border-t border-gray-200 dark:border-gray-700 space-y-2">
        <button
          onClick={toggleTheme}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
        >
          {isDarkMode ? "🌙" : "☀️"} 主题切换
        </button>
        <button className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
          <Settings className="w-4 h-4" />
          设置
        </button>
      </div>
    </div>
  );
}
