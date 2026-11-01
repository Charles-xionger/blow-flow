"use client";

import { GenerationNotificationsProvider } from "./GenerationNotificationsProvider";
import { retryGenerationDeletions } from "@/lib/generation/recovery";
import React, { useCallback, useRef, useEffect, useMemo } from "react";
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
  SelectionMode,
  type Connection,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { CanvasRecovery } from "./CanvasRecovery";
import { canvasAutosave, useCanvasStore } from "@/store/useCanvasStore";
import { isValidCanvasConnection } from "@/lib/canvas/connections";
import { NodeType } from "@/types";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { useCanvasInteractions } from "@/hooks/useCanvasInteractions";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { toast } from "sonner";

// 导入节点组件（下一步创建）
import TextNode from "@/components/nodes/TextNode";
import TextToImageNode from "@/components/nodes/TextToImageNode";
import TextToVideoNode from "@/components/nodes/TextToVideoNode";
import ImageToImageNode from "@/components/nodes/ImageToImageNode";
import ImageToVideoNode from "@/components/nodes/ImageToVideoNode";
import StartEndToVideoNode from "@/components/nodes/StartEndToVideoNode";
import CreativeDescNode from "@/components/nodes/CreativeDescNode";
import OriginalImageNode from "@/components/nodes/OriginalImageNode";
import CharacterNode from "@/components/nodes/CharacterNode";
import { GroupNode } from "@/components/nodes/GroupNode";

// 导入右键菜单组件
import { NodeContextMenu } from "./NodeContextMenu";
import { PaneContextMenu } from "./PaneContextMenu";

// 定义节点类型映射
const nodeTypes = {
  [NodeType.TEXT]: TextNode,
  [NodeType.TEXT_TO_IMAGE]: TextToImageNode,
  [NodeType.TEXT_TO_VIDEO]: TextToVideoNode,
  [NodeType.IMAGE_TO_IMAGE]: ImageToImageNode,
  [NodeType.IMAGE_TO_VIDEO]: ImageToVideoNode,
  [NodeType.START_END_TO_VIDEO]: StartEndToVideoNode,
  [NodeType.CREATIVE_DESC]: CreativeDescNode,
  [NodeType.STORYBOARD]: CreativeDescNode, // 使用同一个组件
  [NodeType.ORIGINAL_IMAGE]: OriginalImageNode,
  [NodeType.CHARACTER]: CharacterNode,
  [NodeType.GROUP]: GroupNode,
};

function CanvasInner() {
  useEffect(() => {
    const stop = canvasAutosave.start();
    const flush = () => { void canvasAutosave.flush().catch(() => {}); };
    const onHidden = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("online", flush);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("online", flush);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHidden);
      stop();
    };
  }, []);
  useEffect(() => {
    const retry = () => { void retryGenerationDeletions().catch(() => {}); };
    retry();
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, []);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const interactionHandlers = useCanvasInteractions();

  const { screenToFlowPosition } = useReactFlow();
  const router = useRouter();
  const searchParams = useSearchParams();

  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const viewport = useCanvasStore((state) => state.viewport);
  const setViewport = useCanvasStore((state) => state.setViewport);
  const onNodesChange = useCanvasStore((state) => state.onNodesChange);
  const onEdgesChange = useCanvasStore((state) => state.onEdgesChange);
  const onConnect = useCanvasStore((state) => state.onConnect);
  const addNode = useCanvasStore((state) => state.addNode);
  const isDarkMode = useCanvasStore((state) => state.isDarkMode);
  const currentWorkflowId = useCanvasStore((state) => state.currentWorkflowId);
  const contextMenu = useCanvasStore((state) => state.contextMenu);
  const showContextMenu = useCanvasStore((state) => state.showContextMenu);
  const hideContextMenu = useCanvasStore((state) => state.hideContextMenu);
  const persistenceReady = useCanvasStore(state => state.persistenceReady);
  const mounted = persistenceReady;
  const saveError = useCanvasStore(state => state.saveError);
  const projectId = searchParams.get("project");
  const isLoadingRef = useRef(false);

  useEffect(() => {
    if (useCanvasStore.getState().persistenceReady && projectId === useCanvasStore.getState().currentWorkflowId) return;
    isLoadingRef.current = true;
    void canvasAutosave.open(projectId).finally(() => { isLoadingRef.current = false; });
  }, [projectId]);

  useEffect(() => {
    if (!persistenceReady || isLoadingRef.current) return;
    if (currentWorkflowId !== projectId) {
      router.replace(currentWorkflowId ? `/?project=${encodeURIComponent(currentWorkflowId)}` : "/", { scroll: false });
    }
  }, [currentWorkflowId, persistenceReady, projectId, router]);

  // 同步主题到 DOM
  useEffect(() => {
    if (mounted && typeof document !== "undefined") {
      document.documentElement.classList.toggle("dark", isDarkMode);
    }
  }, [isDarkMode, mounted]);

  // 键盘快捷键：保存工作流
  const handleSave = useCallback(async () => {
    // Node editors commit their input on blur; keyboard save must include it.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    try {
      await canvasAutosave.save();
      toast.success("保存成功");
    } catch (error) {
      toast.error("保存失败", {
        description: error instanceof Error ? error.message : "未知错误",
      });
    }
  }, []);

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
    (event: React.MouseEvent | MouseEvent) => {
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
      if (!Object.values(NodeType).includes(type) || type === NodeType.GROUP) return;

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

  const isValidConnection = useCallback((connection: Connection | Edge) => {
    const { nodes, edges } = useCanvasStore.getState();
    return isValidCanvasConnection(connection, nodes, edges);
  }, []);

  // 默认边样式
  const defaultEdgeOptions = useMemo(() => ({
    type: "default", // 使用默认曲线
    animated: true,
    style: {
      strokeWidth: 2,
      stroke: mounted && isDarkMode ? "#666" : "#b1b1b7",
    },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 20,
      height: 20,
      color: mounted && isDarkMode ? "#666" : "#b1b1b7",
    },
  }), [mounted, isDarkMode]);

  if (!persistenceReady) return (
    <div className="flex h-full items-center justify-center" role="status">
      {saveError || "正在恢复画布…"}
      <CanvasRecovery />
    </div>
  );

  return (
    <div ref={reactFlowWrapper} className="w-full h-full">
      <CanvasRecovery />
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
        connectionMode={ConnectionMode.Strict}
        isValidConnection={isValidConnection}
        nodeDragThreshold={3}
        defaultEdgeOptions={defaultEdgeOptions}
        viewport={viewport}
        onViewportChange={setViewport}
        {...interactionHandlers}
        fitView={nodes.length === 0}
        className={mounted && isDarkMode ? "dark" : ""}
        selectionOnDrag={true}
        panOnDrag={[1, 2]}
        selectionMode={SelectionMode.Partial}
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
          color={mounted && isDarkMode ? "#333" : "#ddd"}
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
          maskColor={
            mounted && isDarkMode ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.6)"
          }
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
        <GenerationNotificationsProvider><CanvasInner /></GenerationNotificationsProvider>
      </div>
    </ReactFlowProvider>
  );
}
