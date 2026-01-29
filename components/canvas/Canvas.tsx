"use client";

import React, { useCallback, useRef } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Panel,
  ReactFlowProvider,
  useReactFlow,
  ConnectionMode,
  BackgroundVariant,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { useCanvasStore } from "@/store/useCanvasStore";
import { NodeType } from "@/types";

// 导入节点组件（下一步创建）
import TextToImageNode from "@/components/nodes/TextToImageNode";
import TextToVideoNode from "@/components/nodes/TextToVideoNode";
import ImageToImageNode from "@/components/nodes/ImageToImageNode";
import ImageToVideoNode from "@/components/nodes/ImageToVideoNode";
import StartEndToVideoNode from "@/components/nodes/StartEndToVideoNode";
import CreativeDescNode from "@/components/nodes/CreativeDescNode";
import OriginalImageNode from "@/components/nodes/OriginalImageNode";

// 定义节点类型映射
const nodeTypes = {
  [NodeType.TEXT_TO_IMAGE]: TextToImageNode,
  [NodeType.TEXT_TO_VIDEO]: TextToVideoNode,
  [NodeType.IMAGE_TO_IMAGE]: ImageToImageNode,
  [NodeType.IMAGE_TO_VIDEO]: ImageToVideoNode,
  [NodeType.START_END_TO_VIDEO]: StartEndToVideoNode,
  [NodeType.CREATIVE_DESC]: CreativeDescNode,
  [NodeType.ORIGINAL_IMAGE]: OriginalImageNode,
};

function CanvasInner() {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition } = useReactFlow();

  const {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onConnect,
    addNode,
    isDarkMode,
  } = useCanvasStore();

  // 处理画布点击（添加节点）
  const onPaneClick = useCallback((event: React.MouseEvent) => {
    // 可以在这里添加快捷添加节点的逻辑
  }, []);

  // 处理拖放添加节点
  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      const type = event.dataTransfer.getData(
        "application/reactflow-nodetype",
      ) as NodeType;
      if (!type) return;

      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      addNode(type, position);
    },
    [screenToFlowPosition, addNode],
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  // 默认边样式
  const defaultEdgeOptions = {
    type: "default", // 使用默认曲线
    animated: true,
    style: {
      strokeWidth: 2,
      stroke: isDarkMode ? "#666" : "#b1b1b7",
    },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 20,
      height: 20,
      color: isDarkMode ? "#666" : "#b1b1b7",
    },
  };

  return (
    <div ref={reactFlowWrapper} className="w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onPaneClick={onPaneClick}
        onDrop={onDrop}
        onDragOver={onDragOver}
        nodeTypes={nodeTypes}
        connectionMode={ConnectionMode.Loose}
        defaultEdgeOptions={defaultEdgeOptions}
        fitView
        className={isDarkMode ? "dark" : ""}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={16}
          size={1}
          color={isDarkMode ? "#333" : "#ddd"}
        />
        <Controls />
        <MiniMap
          nodeColor={(node) => {
            switch (node.type) {
              case NodeType.TEXT_TO_IMAGE:
              case NodeType.IMAGE_TO_IMAGE:
                return "#3b82f6"; // blue
              case NodeType.TEXT_TO_VIDEO:
              case NodeType.IMAGE_TO_VIDEO:
              case NodeType.START_END_TO_VIDEO:
                return "#8b5cf6"; // purple
              case NodeType.CREATIVE_DESC:
                return "#10b981"; // green
              case NodeType.ORIGINAL_IMAGE:
                return "#f59e0b"; // amber
              default:
                return "#6b7280"; // gray
            }
          }}
          maskColor={isDarkMode ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.6)"}
        />

        {/* 顶部工具栏 */}
        <Panel position="top-left" className="space-x-2">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-2">
            {/* 工具栏按钮将在后续添加 */}
          </div>
        </Panel>
      </ReactFlow>
    </div>
  );
}

export default function Canvas() {
  return (
    <ReactFlowProvider>
      <div className="w-full h-screen">
        <CanvasInner />
      </div>
    </ReactFlowProvider>
  );
}
