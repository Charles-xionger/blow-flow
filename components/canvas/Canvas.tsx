"use client";

import React, { useCallback, useRef, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  ReactFlowProvider,
  useReactFlow,
  ConnectionMode,
  BackgroundVariant,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { useCanvasStore } from "@/store/useCanvasStore";
import { NodeType } from "@/types";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { toast } from "sonner";

// 导入节点组件（下一步创建）
import TextToImageNode from "@/components/nodes/TextToImageNode";
import TextToVideoNode from "@/components/nodes/TextToVideoNode";
import ImageToImageNode from "@/components/nodes/ImageToImageNode";
import ImageToVideoNode from "@/components/nodes/ImageToVideoNode";
import StartEndToVideoNode from "@/components/nodes/StartEndToVideoNode";
import CreativeDescNode from "@/components/nodes/CreativeDescNode";
import OriginalImageNode from "@/components/nodes/OriginalImageNode";
import { GroupNode } from "@/components/nodes/GroupNode";

// 导入右键菜单组件
import { NodeContextMenu } from "./NodeContextMenu";
import { PaneContextMenu } from "./PaneContextMenu";

// 定义节点类型映射
const nodeTypes = {
  [NodeType.TEXT_TO_IMAGE]: TextToImageNode,
  [NodeType.TEXT_TO_VIDEO]: TextToVideoNode,
  [NodeType.IMAGE_TO_IMAGE]: ImageToImageNode,
  [NodeType.IMAGE_TO_VIDEO]: ImageToVideoNode,
  [NodeType.START_END_TO_VIDEO]: StartEndToVideoNode,
  [NodeType.CREATIVE_DESC]: CreativeDescNode,
  [NodeType.ORIGINAL_IMAGE]: OriginalImageNode,
  [NodeType.GROUP]: GroupNode,
};

function CanvasInner() {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition, getViewport } = useReactFlow();
  const router = useRouter();
  const searchParams = useSearchParams();

  const {
    nodes,
    edges,
    viewport,
    setViewport,
    onNodesChange,
    onEdgesChange,
    onConnect,
    addNode,
    isDarkMode,
    projectName,
    currentWorkflowId,
    contextMenu,
    showContextMenu,
    hideContextMenu,
    loadWorkflow,
  } = useCanvasStore();

  const setCurrentWorkflowId = useCanvasStore(
    (state) => state.setCurrentWorkflowId,
  );

  // 从 URL 加载项目
  useEffect(() => {
    const projectId = searchParams.get("project");
    console.log(
      "[URL Load] projectId from URL:",
      projectId,
      "currentWorkflowId:",
      currentWorkflowId,
    );
    if (projectId && projectId !== currentWorkflowId) {
      console.log("[URL Load] Loading project from URL:", projectId);
      // 从 API 加载项目
      fetch(`/api/workflow/${projectId}`)
        .then((res) => res.json())
        .then((result) => {
          if (result.success && result.data) {
            loadWorkflow(result.data);
          }
        })
        .catch((err) =>
          console.error("Failed to load workflow from URL:", err),
        );
    }
  }, [searchParams, currentWorkflowId, loadWorkflow]);

  // 同步 currentWorkflowId 到 URL
  useEffect(() => {
    const currentProjectId = searchParams.get("project");
    console.log(
      "[URL Sync] currentWorkflowId:",
      currentWorkflowId,
      "URL projectId:",
      currentProjectId,
    );

    if (currentWorkflowId && currentProjectId !== currentWorkflowId) {
      console.log("[URL Sync] Updating URL to:", currentWorkflowId);
      router.push(`/?project=${currentWorkflowId}`, { scroll: false });
    } else if (!currentWorkflowId && currentProjectId) {
      console.log("[URL Sync] Clearing URL");
      router.push("/", { scroll: false });
    }
  }, [currentWorkflowId, router, searchParams]);

  // 同步主题到 DOM
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.classList.toggle("dark", isDarkMode);
    }
  }, [isDarkMode]);

  // 键盘快捷键：保存工作流
  const handleSave = useCallback(async () => {
    if (nodes.length === 0) {
      toast.error("无法保存", {
        description: "画布为空",
      });
      return;
    }

    console.log("[Save] Current workflowId:", currentWorkflowId);

    try {
      const workflow = {
        name: projectName,
        nodes,
        edges,
        viewport: getViewport(),
      };

      // 如果有 currentWorkflowId，使用 PUT 更新；否则使用 POST 创建
      const url = currentWorkflowId
        ? `/api/workflow/${currentWorkflowId}`
        : "/api/workflow";
      const method = currentWorkflowId ? "PUT" : "POST";

      console.log("[Save] Using method:", method, "URL:", url);

      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(workflow),
      });

      const result = await response.json();

      if (result.success) {
        console.log("[Save] Success, result:", result.data);
        // 如果是新建项目（POST），保存返回的 ID
        if (!currentWorkflowId && result.data?.id) {
          console.log("[Save] Setting new workflowId:", result.data.id);
          setCurrentWorkflowId(result.data.id);
        }
        toast.success("保存成功", {
          description: `工作流 "${projectName}" 已保存`,
        });
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      toast.error("保存失败", {
        description: error instanceof Error ? error.message : "未知错误",
      });
    }
  }, [
    nodes,
    edges,
    projectName,
    currentWorkflowId,
    getViewport,
    setCurrentWorkflowId,
  ]);

  useKeyboardShortcuts(handleSave);

  // 处理节点右键菜单
  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: any) => {
      event.preventDefault();
      showContextMenu(event.clientX, event.clientY, "node", node.id);
    },
    [showContextMenu],
  );

  // 处理多选右键菜单
  const onSelectionContextMenu = useCallback(
    (event: React.MouseEvent, nodes: any[]) => {
      event.preventDefault();
      if (nodes.length > 0) {
        // 使用第一个节点的 ID 来显示菜单
        showContextMenu(event.clientX, event.clientY, "node", nodes[0].id);
      }
    },
    [showContextMenu],
  );

  // 处理画布右键菜单
  const onPaneContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      showContextMenu(event.clientX, event.clientY, "pane");
    },
    [showContextMenu],
  );

  // 处理画布点击（添加节点）
  const onPaneClick = useCallback(() => {
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
        onNodeContextMenu={onNodeContextMenu}
        onSelectionContextMenu={onSelectionContextMenu}
        onPaneContextMenu={onPaneContextMenu}
        nodeTypes={nodeTypes}
        connectionMode={ConnectionMode.Loose}
        defaultEdgeOptions={defaultEdgeOptions}
        viewport={viewport}
        onViewportChange={(newViewport) => setViewport(newViewport)}
        fitView={nodes.length === 0}
        className={isDarkMode ? "dark" : ""}
        selectionOnDrag={true}
        panOnDrag={[1, 2]}
        selectionMode="partial"
        multiSelectionKeyCode="Shift"
        minZoom={0.1}
        maxZoom={4}
        fitViewOptions={{ padding: 0.2 }}
        nodesDraggable={true}
        nodesConnectable={true}
        elementsSelectable={true}
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
              case NodeType.GROUP:
                return "#6b7280"; // gray
              default:
                return "#6b7280"; // gray
            }
          }}
          maskColor={isDarkMode ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.6)"}
        />

        {/* 保留原工具栏（在底部） - 可选删除 */}
        {/* <Toolbar /> */}
      </ReactFlow>

      {/* 右键菜单 */}
      {contextMenu?.show && (
        <>
          {contextMenu.type === "node" && contextMenu.nodeId && (
            <NodeContextMenu
              nodeId={contextMenu.nodeId}
              x={contextMenu.x}
              y={contextMenu.y}
              onClose={hideContextMenu}
            />
          )}
          {contextMenu.type === "pane" && (
            <PaneContextMenu
              x={contextMenu.x}
              y={contextMenu.y}
              onClose={hideContextMenu}
            />
          )}
        </>
      )}

      {/* 侧边栏 */}
      <Sidebar />

      {/* 顶部栏（项目名称 + 工具栏） */}
      <TopBar />
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
