import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import {
  Connection,
  Edge,
  EdgeChange,
  Node,
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
  // 画布数据
  nodes: CanvasNode[];
  edges: Edge[];

  // UI 状态
  selectedNodeIds: string[];
  isDarkMode: boolean;
  projectName: string;

  // Actions
  setNodes: (nodes: CanvasNode[]) => void;
  setEdges: (edges: Edge[]) => void;
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;

  // 节点操作
  addNode: (type: NodeType, position?: { x: number; y: number }) => void;
  deleteNode: (nodeId: string) => void;
  updateNodeData: (nodeId: string, data: Partial<NodeData>) => void;
  duplicateNode: (nodeId: string) => void;

  // 选择
  setSelectedNodeIds: (ids: string[]) => void;

  // 主题
  toggleTheme: () => void;

  // 工作流
  setProjectName: (name: string) => void;
  loadWorkflow: (workflow: WorkflowData) => void;
  clearWorkflow: () => void;
  clearCanvas: () => void; // 别名，与原项目保持一致
  exportWorkflow: () => WorkflowData;
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
    persist(
      (set, get) => ({
        // 初始状态
        nodes: [],
        edges: [],
        selectedNodeIds: [],
        isDarkMode: getInitialTheme(),
        projectName: "未命名项目",

        // 节点和边的变化处理
        setNodes: (nodes) => set({ nodes }),
        setEdges: (edges) => set({ edges }),

        onNodesChange: (changes: NodeChange[]) => {
          set({
            nodes: applyNodeChanges(changes, get().nodes) as CanvasNode[],
          });
        },

        onEdgesChange: (changes: EdgeChange[]) => {
          set({
            edges: applyEdgeChanges(changes, get().edges),
          });
        },

        onConnect: (connection: Connection) => {
          set({
            edges: addEdge(connection, get().edges),
          });
        },

        // 添加节点
        addNode: (type: NodeType, position = DEFAULT_NODE_POSITION) => {
          const nodeTypeMap: Record<
            NodeType,
            { label: string; data: Partial<NodeData> }
          > = {
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
            [NodeType.ORIGINAL_IMAGE]: {
              label: "Original Image",
              data: {},
            },
          };

          const config = nodeTypeMap[type];
          const newNode: CanvasNode = {
            id: nanoid(),
            type: type,
            position,
            data: {
              label: config.label,
              type,
              ...config.data,
            },
            style: {
              width: DEFAULT_NODE_WIDTH,
              height: DEFAULT_NODE_HEIGHT,
            },
          };

          set({ nodes: [...get().nodes, newNode] });
        },

        // 删除节点
        deleteNode: (nodeId: string) => {
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
              ...node.data,
              // 清除输出数据
              imageSrc: undefined,
              videoSrc: undefined,
              outputArtifacts: undefined,
              isLoading: false,
              error: undefined,
            },
          };

          set({ nodes: [...get().nodes, newNode] });
        },

        // 选择
        setSelectedNodeIds: (ids: string[]) => {
          set({ selectedNodeIds: ids });
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

        loadWorkflow: (workflow: WorkflowData) => {
          set({
            nodes: workflow.nodes,
            edges: workflow.edges,
            projectName: workflow.name,
          });
        },

        clearWorkflow: () => {
          set({
            nodes: [],
            edges: [],
            selectedNodeIds: [],
            projectName: "未命名项目",
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
      {
        name: "canvas-storage", // localStorage key
        partialize: (state) => ({
          // 只持久化这些字段
          projectName: state.projectName,
          isDarkMode: state.isDarkMode,
          nodes: state.nodes,
          edges: state.edges,
        }),
      },
    ),
    { name: "CanvasStore" },
  ),
);
