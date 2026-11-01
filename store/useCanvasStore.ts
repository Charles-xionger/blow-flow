import { createCanvasAutosave, type SaveStatus } from "@/lib/canvas/autosave";
import { CanvasStorageError } from "@/lib/canvas/storage-error";
import { clearedGenerationAssociation, deleteNodeGeneration, generationAssociation } from "@/lib/generation/recovery";
import { isValidCanvasConnection } from "@/lib/canvas/connections";
import { toast } from "sonner";
import { create } from "zustand";
import { devtools } from "zustand/middleware";
import {
  Connection,
  Edge,
  EdgeChange,
  NodeChange,
  addEdge,
  OnNodesChange,
  OnEdgesChange,
  OnConnect,
  applyNodeChanges,
  applyEdgeChanges,
} from "@xyflow/react";
import { nanoid } from "nanoid";
import { NodeData, NodeType, CanvasNode, WorkflowData } from "@/types";

interface CanvasState {
  recovery?: import('@/lib/canvas/local-repository').CanvasDraft['recovery'];
  generationRecoveryReadOnly?: string[];
  recoveryCopies?: { id: string; name: string }[];
  // 画布数据
  nodes: CanvasNode[];
  edges: Edge[];
  viewport: { x: number; y: number; zoom: number };

  // UI 状态
  selectedNodeIds: string[];
  isDarkMode: boolean;
  projectName: string;
  currentWorkflowId: string | null;
  canvasSession: number;
  serverVersion: number;
  persistenceReady: boolean;
  saveStatus: SaveStatus;
  saveError: string | null;
  contextMenu: {
    show: boolean;
    x: number;
    y: number;
    type: "node" | "pane";
    nodeId?: string;
  } | null;

  // Actions
  setNodes: (nodes: CanvasNode[]) => void;
  importGraph: (nodes: CanvasNode[], edges: Edge[]) => void;
  setEdges: (edges: Edge[]) => void;
  setViewport: (viewport: { x: number; y: number; zoom: number }) => void;
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;

  // 节点操作
  addNode: (type: NodeType, position?: { x: number; y: number }) => string;
  addConnectedNode: (
    type: NodeType,
    sourceNodeId: string,
    position?: { x: number; y: number },
  ) => void;
  addMultipleConnectedNodes: (
    nodes: Array<{ type: NodeType; data: Partial<NodeData> }>,
    sourceNodeId: string,
    startPosition: { x: number; y: number },
  ) => string[];
  deleteNode: (nodeId: string) => void;
  updateNodeData: (nodeId: string, data: Partial<NodeData>) => void;
  duplicateNode: (nodeId: string) => void;
  deleteSelectedNodes: () => void;
  groupNodes: (nodeIds: string[]) => void;
  ungroupNodes: (groupId: string) => void;

  // 选择
  setSelectedNodeIds: (ids: string[]) => void;

  // 右键菜单
  showContextMenu: (
    x: number,
    y: number,
    type: "node" | "pane",
    nodeId?: string,
  ) => void;
  hideContextMenu: () => void;

  // 主题
  toggleTheme: () => void;

  // 工作流
  setProjectName: (name: string) => void;
  setCurrentWorkflowId: (id: string | null) => void;
  loadWorkflow: (workflow: WorkflowData) => void;
  clearWorkflow: () => void;
  clearCanvas: () => void; // 别名，与原项目保持一致
  exportWorkflow: () => WorkflowData;
}

function withoutTaskAssociation(data: NodeData): NodeData {
  return { ...data, ...clearedGenerationAssociation, isLoading: false, error: undefined };
}

function cancelDeletedNodes(nodes: CanvasNode[], canvasId: string | null) {
  for (const node of nodes) {
    if (!node.data.generationTaskId && !node.data.pendingGeneration &&
      (typeof localStorage === "undefined" || !generationAssociation(node.id))) continue;
    try { deleteNodeGeneration(node.id, canvasId || "draft", node.data); }
    catch { toast.error("无法保存取消请求，请恢复本地存储后重试删除"); throw new Error("无法保存取消请求"); }
  }
}

function createCanvasNode(type: NodeType, position: { x: number; y: number }, data: Partial<NodeData> = {}): CanvasNode {
  const nodeTypeMap: Record<
    NodeType,
    { label: string; data: Partial<NodeData> }
  > = {
    [NodeType.TEXT]: {
      label: "Text",
      data: {},
    },
    [NodeType.TEXT_TO_IMAGE]: {
      label: "Text to Image",
      data: {
        model: "BananaPro",
        aspectRatio: "1:1",
        resolution: "1k",
        count: 1,
      },
    },
    [NodeType.TEXT_TO_VIDEO]: {
      label: "Text to Video",
      data: {
        model: "Sora 2",
        aspectRatio: "16:9",
        resolution: "720p",
        duration: "5s",
        count: 1,
      },
    },
    [NodeType.IMAGE_TO_IMAGE]: {
      label: "Image to Image",
      data: {
        model: "BananaPro",
        aspectRatio: "1:1",
        resolution: "1k",
        count: 1,
      },
    },
    [NodeType.IMAGE_TO_VIDEO]: {
      label: "Image to Video",
      data: {
        model: "Sora 2",
        aspectRatio: "16:9",
        resolution: "720p",
        duration: "5s",
        count: 1,
      },
    },
    [NodeType.START_END_TO_VIDEO]: {
      label: "Start-End to Video",
      data: {
        model: "Sora 2",
        aspectRatio: "16:9",
        resolution: "720p",
        duration: "5s",
        count: 1,
        swapFrames: false,
      },
    },
    [NodeType.CREATIVE_DESC]: {
      label: "Creative Description",
      data: { model: "BananaPro" },
    },
    [NodeType.STORYBOARD]: {
      label: "Storyboard",
      data: {},
    },
    [NodeType.ORIGINAL_IMAGE]: {
      label: "Original Image",
      data: {},
    },
    [NodeType.CHARACTER]: {
      label: "Character",
      data: {},
    },
    [NodeType.GROUP]: {
      label: "Group",
      data: {},
    },
  };

  const config = nodeTypeMap[type];
  return {
    id: nanoid(),
    type: type,
    position,
    data: {
      label: config.label,
      type,
      ...config.data,
      ...data,
    },
    style: {
      width: DEFAULT_NODE_WIDTH,
      height: DEFAULT_NODE_HEIGHT,
    },
  };


}

const DEFAULT_NODE_POSITION = { x: 250, y: 150 };
// 节点默认尺寸
const DEFAULT_NODE_WIDTH = 320;
const DEFAULT_NODE_HEIGHT = 240;

// 从 localStorage 读取初始主题
const getInitialTheme = (): boolean => {
  if (typeof window === "undefined") return false;
  const saved = localStorage.getItem("canvas-theme");
  if (saved !== null) {
    return saved === "dark";
  }
  // 检查系统偏好
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
};

export const useCanvasStore = create<CanvasState>()(
  devtools(
      (set, get) => ({
        // 初始状态
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 0.8 },
        selectedNodeIds: [],
        isDarkMode: getInitialTheme(),
        projectName: "未命名项目",
        currentWorkflowId: null,
        canvasSession: 0,
        serverVersion: 0,
        persistenceReady: false,
        saveStatus: "loading",
        saveError: null,
        contextMenu: null,

        // 节点和边的变化处理
        setNodes: (nodes) => set({ nodes }),
        importGraph: (nodes, edges) => {
          get().clearWorkflow();
          const ids = new Map(nodes.map(node => [node.id, nanoid()]));
          set({
            nodes: nodes.map(node => ({ ...node, id: ids.get(node.id)!,
              parentId: node.parentId ? ids.get(node.parentId) : undefined,
              data: withoutTaskAssociation(node.data) })),
            edges: edges.filter(edge => ids.has(edge.source) && ids.has(edge.target))
              .map(edge => ({ ...edge, id: nanoid(), source: ids.get(edge.source)!, target: ids.get(edge.target)! })),
            selectedNodeIds: [],
          });
        },
        setEdges: (edges) => set({ edges }),
        setViewport: (viewport) => set({ viewport }),

        onNodesChange: (changes: NodeChange[]) => {
          cancelDeletedNodes(get().nodes.filter(node => changes.some(change => change.type === "remove" && change.id === node.id)), get().currentWorkflowId);
          const updatedNodes = applyNodeChanges(
            changes,
            get().nodes,
          ) as CanvasNode[];

          // 更新选中的节点ID列表
          const selectedIds = changes.some((change) => ["select", "remove", "add", "replace"].includes(change.type)) ? updatedNodes
            .filter((node) => node.selected)
            .map((node) => node.id) : get().selectedNodeIds;

          set({
            nodes: updatedNodes,
            selectedNodeIds: selectedIds.length === get().selectedNodeIds.length &&
              selectedIds.every((id, i) => id === get().selectedNodeIds[i])
              ? get().selectedNodeIds : selectedIds,
          });
        },

        onEdgesChange: (changes: EdgeChange[]) => {
          set({
            edges: applyEdgeChanges(changes, get().edges),
          });
        },

        onConnect: (connection: Connection) => {
          if (!isValidCanvasConnection(connection, get().nodes, get().edges)) return;
          set({
            edges: addEdge(connection, get().edges),
          });
        },

        // 添加节点
        addNode: (type: NodeType, position = DEFAULT_NODE_POSITION) => {
          const newNode = createCanvasNode(type, position);
          set({ nodes: [...get().nodes, newNode] });
          return newNode.id;
        },

        // 添加连接节点（自动创建边）
        addConnectedNode: (
          type: NodeType,
          sourceNodeId: string,
          position = DEFAULT_NODE_POSITION,
        ) => {
          get().addMultipleConnectedNodes([{ type, data: {} }], sourceNodeId, position);
        },

        // Build the complete graph change before notifying subscribers.
        addMultipleConnectedNodes: (configs, sourceNodeId, startPosition) => {
          if (!configs.length) return [];
          const newNodes = configs.map((config, index) => createCanvasNode(
            config.type,
            { x: startPosition.x, y: startPosition.y + index * 300 },
            config.data,
          ));
          const newEdges = newNodes.map((node) => ({
            id: `edge-${sourceNodeId}-${node.id}`,
            source: sourceNodeId,
            target: node.id,
            sourceHandle: "output",
            targetHandle: null,
          }));
          const allNodes = [...get().nodes, ...newNodes];
          const validEdges = newEdges.filter((edge) => isValidCanvasConnection(edge, allNodes, get().edges));
          set({ nodes: allNodes, edges: [...get().edges, ...validEdges] });
          return newNodes.map((node) => node.id);
        },

        // 删除节点
        deleteNode: (nodeId: string) => {
          cancelDeletedNodes(get().nodes.filter(node => node.id === nodeId), get().currentWorkflowId);
          set({
            nodes: get().nodes.filter((node) => node.id !== nodeId),
            edges: get().edges.filter(
              (edge) => edge.source !== nodeId && edge.target !== nodeId,
            ),
          });
        },

        // 更新节点数据
        updateNodeData: (nodeId: string, data: Partial<NodeData>) => {
          set({
            nodes: get().nodes.map((node) =>
              node.id === nodeId
                ? { ...node, data: { ...node.data, ...data } }
                : node,
            ),
          });
        },

        // 复制节点
        duplicateNode: (nodeId: string) => {
          const node = get().nodes.find((n) => n.id === nodeId);
          if (!node) return;

          const newNode: CanvasNode = {
            ...node,
            id: nanoid(),
            position: {
              x: node.position.x + 50,
              y: node.position.y + 50,
            },
            data: {
              ...withoutTaskAssociation(node.data),
              // 清除输出数据
              imageSrc: undefined,
              videoSrc: undefined,
              outputArtifacts: undefined,
            },
          };

          set({ nodes: [...get().nodes, newNode] });
        },

        // 选择
        setSelectedNodeIds: (ids: string[]) => {
          set({ selectedNodeIds: ids });
        },

        // 删除选中的节点
        deleteSelectedNodes: () => {
          const selectedIds = get().selectedNodeIds;
          if (selectedIds.length === 0) return;
          cancelDeletedNodes(get().nodes.filter(node => selectedIds.includes(node.id)), get().currentWorkflowId);

          set({
            nodes: get().nodes.filter((node) => !selectedIds.includes(node.id)),
            edges: get().edges.filter(
              (edge) =>
                !selectedIds.includes(edge.source) &&
                !selectedIds.includes(edge.target),
            ),
            selectedNodeIds: [],
          });
        },

        // 分组节点
        groupNodes: (nodeIds: string[]) => {
          if (nodeIds.length === 0) return;

          const nodesToGroup = get().nodes.filter((n) =>
            nodeIds.includes(n.id),
          );
          if (nodesToGroup.length === 0) return;

          // 计算包围盒
          const minX = Math.min(...nodesToGroup.map((n) => n.position.x));
          const minY = Math.min(...nodesToGroup.map((n) => n.position.y));
          const maxX = Math.max(
            ...nodesToGroup.map(
              (n) =>
                n.position.x +
                (n.measured?.width ?? (typeof n.style?.width === "number"
                  ? n.style.width
                  : Number(n.style?.width) || DEFAULT_NODE_WIDTH)),
            ),
          );
          const maxY = Math.max(
            ...nodesToGroup.map(
              (n) =>
                n.position.y +
                (n.measured?.height ?? (typeof n.style?.height === "number"
                  ? n.style.height
                  : Number(n.style?.height) || DEFAULT_NODE_HEIGHT)),
            ),
          );

          const padding = 40;
          const groupId = nanoid();

          // 创建分组节点
          const groupNode: CanvasNode = {
            id: groupId,
            type: NodeType.GROUP,
            position: { x: minX - padding, y: minY - padding },
            data: {
              label: "Group",
              type: NodeType.GROUP,
            },
            style: {
              width: maxX - minX + padding * 2,
              height: maxY - minY + padding * 2,
            },
            draggable: true,
          };

          // 更新子节点的位置和父节点关系
          const updatedNodes = get().nodes.map((node) => {
            if (nodeIds.includes(node.id)) {
              return {
                ...node,
                position: {
                  x: node.position.x - minX + padding,
                  y: node.position.y - minY + padding,
                },
                parentId: groupId,
                extent: "parent" as const,
              };
            }
            return node;
          });

          set({
            nodes: [groupNode, ...updatedNodes],
          });
        },

        // 取消分组
        ungroupNodes: (groupId: string) => {
          const groupNode = get().nodes.find((n) => n.id === groupId);
          if (!groupNode) return;

          // 更新子节点的位置，移除父节点关系
          const updatedNodes = get()
            .nodes.filter((n) => n.id !== groupId)
            .map((node) => {
              if (node.parentId === groupId) {
                return {
                  ...node,
                  position: {
                    x: node.position.x + groupNode.position.x,
                    y: node.position.y + groupNode.position.y,
                  },
                  parentId: undefined,
                  extent: undefined,
                };
              }
              return node;
            });

          set({ nodes: updatedNodes });
        },

        // 显示右键菜单
        showContextMenu: (
          x: number,
          y: number,
          type: "node" | "pane",
          nodeId?: string,
        ) => {
          set({
            contextMenu: { show: true, x, y, type, nodeId },
          });
        },

        // 隐藏右键菜单
        hideContextMenu: () => {
          set({ contextMenu: null });
        },

        // 主题切换
        toggleTheme: () => {
          const isDark = get().isDarkMode;
          const newTheme = !isDark;
          set({ isDarkMode: newTheme });

          // 更新 DOM 和 localStorage
          if (typeof window !== "undefined") {
            document.documentElement.classList.toggle("dark", newTheme);
            localStorage.setItem("canvas-theme", newTheme ? "dark" : "light");
          }
        },

        // 工作流管理
        setProjectName: (name: string) => {
          set({ projectName: name });
        },

        setCurrentWorkflowId: (id: string | null) => {
          set({ currentWorkflowId: id });
        },

        loadWorkflow: (workflow: WorkflowData) => {
          set({
            canvasSession: get().canvasSession + 1,
            selectedNodeIds: [],
            contextMenu: null,
            nodes: workflow.nodes,
            edges: workflow.edges,
            projectName: workflow.name,
            currentWorkflowId: workflow.id,
            serverVersion: workflow.version ?? 0,
            viewport: workflow.viewport || { x: 0, y: 0, zoom: 0.8 },
          });
        },

        clearWorkflow: () => {
          set({
            canvasSession: get().canvasSession + 1,
            nodes: [],
            edges: [],
            selectedNodeIds: [],
            projectName: "未命名项目",
            currentWorkflowId: null,
            serverVersion: 0,
            recovery: undefined,
            generationRecoveryReadOnly: undefined,
            saveStatus: "idle",
            saveError: null,
          });
        },

        // 别名方法
        clearCanvas: () => {
          get().clearWorkflow();
        },

        exportWorkflow: (): WorkflowData => {
          const state = get();
          return {
            id: nanoid(),
            name: state.projectName,
            nodes: state.nodes,
            edges: state.edges,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
        },
      }),
    { name: "CanvasStore", enabled: process.env.NODE_ENV !== "production" },
  ),
);

export const canvasAutosave = createCanvasAutosave(useCanvasStore, (error) => {
  // Storage failures remain visible with retry/export actions in the editor;
  // automatic retries should not repeatedly interrupt editing with a toast.
  if (error instanceof CanvasStorageError) return;
  toast.error("自动保存失败，请检查网络后点击保存重试", {
    id: "canvas-autosave-error",
    description: error instanceof Error ? error.message : "未知错误",
  });
});

// Existing interaction and generation hooks use the same coordinator.
export const canvasDraftStorage = {
  flush: () => { void canvasAutosave.flush().catch(() => {}); },
  beginInteraction: canvasAutosave.beginInteraction,
  endInteraction: canvasAutosave.endInteraction,
};
