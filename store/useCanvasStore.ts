import { assertCanvasGraph, descendants, groupGraphNodes, parentFirst, ungroupGraphNodes } from '@/lib/canvas/graph';
import { createCanvasHistory, type CanvasHistory } from '@/lib/canvas/history';
import { createCanvasAutosave, type SaveStatus } from "@/lib/canvas/autosave";
import { CanvasStorageError } from "@/lib/canvas/storage-error";
import { clearedGenerationAssociation, deleteNodeGeneration, generationAssociation } from "@/lib/generation/recovery";
import { isValidCanvasConnection } from "@/lib/canvas/connections";
import { detachReferences, remapPromptReferences, syncReferences } from "@/lib/canvas/prompt";
import { remapReferenceIds } from '@/lib/generation/video';
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
  history?: CanvasHistory;
  beginEdit: (key: string) => void;
  endEdit: (key?: string) => void;
  undo: () => void;
  redo: () => void;
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
  importGraph: (nodes: CanvasNode[], edges: Edge[], options?: { name?: string; viewport?: WorkflowData["viewport"] }) => void;
  setEdges: (edges: Edge[]) => void;
  setViewport: (viewport: { x: number; y: number; zoom: number }) => void;
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  reorderUpstream: (nodeId: string, sourceIds: string[]) => void;

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
  deleteElements: (nodeIds: string[], edgeIds?: string[]) => void;
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

function hasGeneration(node: CanvasNode): boolean {
  return !!(node.data.generationTaskId || node.data.pendingGeneration || node.data.isLoading ||
    (typeof localStorage !== 'undefined' && generationAssociation(node.id)));
}

function cancelDeletedNodes(nodes: CanvasNode[], canvasId: string | null) {
  for (const node of nodes) {
    if (!node.data.generationTaskId && !node.data.pendingGeneration &&
      (typeof localStorage === "undefined" || !generationAssociation(node.id))) continue;
    try { deleteNodeGeneration(node.id, canvasId || "draft", node.data); }
    catch { toast.error("无法保存取消请求，请恢复本地存储后重试删除"); throw new Error("无法保存取消请求"); }
  }
}

const edgesWithoutNodes = (edges: Edge[], nodeIds: ReadonlySet<string>) =>
  edges.filter((edge) => !nodeIds.has(edge.source) && !nodeIds.has(edge.target));

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

const editableData = new Set(['label', 'customTitle', 'prompt', 'model', 'aspectRatio', 'resolution', 'duration', 'count',
  'promptOptimize', 'generationWidth', 'generationHeight', 'generationSizePreset', 'usesGenerationTasks',
  'videoResolution', 'videoAspectRatio', 'videoDuration', 'videoInstanceType', 'shotCount']);

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
      (rawSet, get) => {
        const edits = createCanvasHistory(get, update => rawSet(update as Partial<CanvasState>), next => {
          try {
            assertCanvasGraph(next.nodes as CanvasNode[], next.edges);
            const current = get().nodes;
            const beforeIds = new Set(current.map(node => node.id));
            const afterIds = new Set(next.nodes.map(node => node.id));
            return ![...current.filter(node => !afterIds.has(node.id)),
              ...(next.nodes as CanvasNode[]).filter(node => !beforeIds.has(node.id))].some(hasGeneration);
          } catch { return false; }
        });
        const set = (update: Partial<CanvasState>) => edits.change(update);
        const commitGraph = (update: Partial<CanvasState>, label: string) => {
          const before = get();
          const nodes = update.nodes ?? before.nodes;
          assertCanvasGraph(nodes, update.edges ?? before.edges);
          const beforeIds = new Set(before.nodes.map(node => node.id));
          const afterIds = new Set(nodes.map(node => node.id));
          const removed = before.nodes.filter(node => !afterIds.has(node.id));
          const added = nodes.filter(node => !beforeIds.has(node.id));
          const record = ![...removed, ...added].some(hasGeneration);
          cancelDeletedNodes(removed, before.currentWorkflowId);
          edits.end();
          edits.change({ ...update, selectedNodeIds: (update.selectedNodeIds ?? before.selectedNodeIds).filter(id => afterIds.has(id)) } as Partial<CanvasState>, { record, label });
        };
        return ({
        beginEdit: edits.begin,
        endEdit: edits.end,
        undo: () => { if (get().persistenceReady) edits.undo(); },
        redo: () => { if (get().persistenceReady) edits.redo(); },
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
        importGraph: (nodes, edges, options = {}) => {
          // Legacy exports may contain edges to omitted nodes; detach those references.
          if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new Error('画布节点与连线格式错误');
          const sourceIds = new Set(nodes.map(node => node?.id));
          edges = edges.filter(edge => !edge || sourceIds.has(edge.source) && sourceIds.has(edge.target));
          assertCanvasGraph(nodes, edges);
          if (options.name !== undefined && (typeof options.name !== 'string' || !options.name.trim())) throw new Error('项目名称无效');
          if (options.viewport && (![options.viewport.x, options.viewport.y, options.viewport.zoom].every(Number.isFinite) || options.viewport.zoom <= 0)) throw new Error('画布视口无效');
          const ids = new Map(nodes.map(node => [node.id, nanoid()]));
          const importedNodes = parentFirst(nodes).map(node => ({ ...node, id: ids.get(node.id)!, selected: false,
            parentId: node.parentId ? ids.get(node.parentId) : undefined,
            data: { ...withoutTaskAssociation(node.data),
              prompt: remapPromptReferences(detachReferences(node.data.prompt, nodes,
                ref => !edges.some(edge => edge.source === ref && edge.target === node.id)), ids),
              ...remapReferenceIds(node.data.videoReferenceOrder, node.data.videoReferenceAudio, ids) } }));
          const importedEdges = edges.map(edge => ({ ...edge, id: nanoid(), selected: false,
            source: ids.get(edge.source)!, target: ids.get(edge.target)! }));
          // Existing import semantics create an independent project. Validate and
          // allocate identities first, then record one import in the new project.
          get().clearWorkflow();
          commitGraph({ nodes: importedNodes, edges: importedEdges, selectedNodeIds: [],
            projectName: options.name?.trim() || '未命名项目',
            ...(options.viewport ? { viewport: options.viewport } : {}) }, '导入画布');
        },
        setEdges: (edges) => set({ edges }),
        setViewport: (viewport) => set({ viewport }),

        onNodesChange: (changes: NodeChange[]) => {
          const geometry = changes.every(change => ['position', 'dimensions', 'select'].includes(change.type));
          if (changes.some(change => change.type === 'position' && change.dragging || change.type === 'dimensions' && change.resizing)) edits.begin('geometry');
          const removedIds = descendants(get().nodes, changes.flatMap((change) => change.type === "remove" ? [change.id] : []));
          const edges = removedIds.size ? edgesWithoutNodes(get().edges, removedIds) : get().edges;
          let updatedNodes = applyNodeChanges(
            changes,
            syncReferences(get().nodes, get().edges, edges).filter(node => !removedIds.has(node.id)),
          ) as CanvasNode[];

          // Measurement events are transient. Only explicit resize gestures persist dimensions.
          for (const change of changes) {
            if (change.type !== 'dimensions' || !change.setAttributes || !change.dimensions) continue;
            updatedNodes = updatedNodes.map(node => node.id === change.id ? { ...node,
              data: { ...node.data, displaySize: change.dimensions },
              style: { ...node.style, width: change.dimensions!.width, height: change.dimensions!.height } } : node);
          }

          // 更新选中的节点ID列表
          const selectedIds = changes.some((change) => ["select", "remove", "add", "replace"].includes(change.type)) ? updatedNodes
            .filter((node) => node.selected)
            .map((node) => node.id) : get().selectedNodeIds;

          const update: Partial<CanvasState> = {
            nodes: updatedNodes,
            edges,
            selectedNodeIds: selectedIds.length === get().selectedNodeIds.length &&
              selectedIds.every((id, i) => id === get().selectedNodeIds[i])
              ? get().selectedNodeIds : selectedIds,
          };
          if (geometry) edits.change(update, { record: true, label: '移动或调整节点尺寸' });
          else commitGraph(update, '编辑节点结构');
          if (changes.some(change => change.type === 'position' && change.dragging === false || change.type === 'dimensions' && change.resizing === false)) edits.end('geometry');
        },

        onEdgesChange: (changes: EdgeChange[]) => {
          const edges = applyEdgeChanges(changes, get().edges);
          if (changes.every(change => change.type === 'select')) { edits.change({ edges }); return; }
          commitGraph({ edges, nodes: syncReferences(get().nodes, get().edges, edges) }, '编辑连线');
        },

        onConnect: (connection: Connection) => {
          if (!isValidCanvasConnection(connection, get().nodes, get().edges)) return;
          const edges = addEdge(connection, get().edges);
          commitGraph({ edges, nodes: syncReferences(get().nodes, get().edges, edges) }, '编辑连线');
        },

        // 只重排目标节点的连入连线，它们在数组里占的位置不变，其他节点的顺序不受影响
        reorderUpstream: (nodeId, sourceIds) => {
          const incoming = get().edges.filter(edge => edge.target === nodeId);
          if (sourceIds.length !== incoming.length || new Set(sourceIds).size !== sourceIds.length ||
              incoming.some(edge => !sourceIds.includes(edge.source))) return;
          const ordered = incoming
            .sort((a, b) => sourceIds.indexOf(a.source) - sourceIds.indexOf(b.source));
          commitGraph({ edges: get().edges.map((edge) => edge.target === nodeId ? ordered.shift()! : edge) }, '调整上游顺序');
        },

        // 添加节点
        addNode: (type: NodeType, position = DEFAULT_NODE_POSITION) => {
          const newNode = createCanvasNode(type, position);
          commitGraph({ nodes: [...get().nodes, newNode] }, '创建节点');
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
          if (!configs.length || !get().nodes.some(node => node.id === sourceNodeId)) return [];
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
          if (validEdges.length !== newEdges.length) return [];
          const edges = [...get().edges, ...validEdges];
          // A node created with its own content, such as a storyboard shot, gets no reference to its source.
          const filled = new Set(newNodes.filter((_, index) => configs[index].data.prompt !== undefined).map((node) => node.id));
          commitGraph({ nodes: syncReferences(allNodes, get().edges, edges.filter((edge) => !filled.has(edge.target))), edges }, '批量创建关联节点');
          return newNodes.map((node) => node.id);
        },

        // Nodes, incident edges and detached prompt references publish together.
        deleteElements: (nodeIds, edgeIds = []) => {
          const removed = descendants(get().nodes, nodeIds);
          const removedEdges = new Set(edgeIds);
          const edges = edgesWithoutNodes(get().edges, removed).filter(edge => !removedEdges.has(edge.id));
          commitGraph({ nodes: syncReferences(get().nodes, get().edges, edges).filter(node => !removed.has(node.id)), edges,
            selectedNodeIds: get().selectedNodeIds.filter(id => !removed.has(id)) }, '删除节点或连线');
        },
        deleteNode: (nodeId: string) => get().deleteElements([nodeId]),

        // 更新节点数据
        updateNodeData: (nodeId: string, data: Partial<NodeData>) => {
          let nodes = get().nodes.map(node => node.id === nodeId ? { ...node, data: { ...node.data, ...data } } : node);
          const beforeEdges = get().edges;
          const edges = data.model === undefined && data.type === undefined ? beforeEdges : beforeEdges.filter(edge =>
            edge.source !== nodeId && edge.target !== nodeId ||
            isValidCanvasConnection(edge, nodes, beforeEdges.filter(other => other.id !== edge.id)));
          if (edges.length !== beforeEdges.length) nodes = syncReferences(nodes, beforeEdges, edges);
          edits.change({ nodes, edges }, { record: Object.keys(data).every(key => editableData.has(key)), label: '编辑节点内容或参数' });
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
              // 副本没有连线，不能再指向上游节点
              prompt: detachReferences(node.data.prompt, get().nodes),
              // 清除输出数据
              imageSrc: undefined,
              videoSrc: undefined,
              outputArtifacts: undefined,
            },
          };

          commitGraph({ nodes: [...get().nodes, { ...newNode, selected: false }] }, '复制节点');
        },

        // 选择
        setSelectedNodeIds: (ids: string[]) => {
          set({ selectedNodeIds: ids });
        },

        // 删除选中的节点
        deleteSelectedNodes: () => get().deleteElements(get().selectedNodeIds),

        groupNodes: (nodeIds: string[]) => {
          commitGraph({ nodes: groupGraphNodes(get().nodes, nodeIds, nanoid()) }, '分组节点');
        },
        ungroupNodes: (groupId: string) => {
          commitGraph({ nodes: ungroupGraphNodes(get().nodes, groupId) }, '取消分组');
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
            history: workflow.history,
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
            history: undefined,
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
      }); },
    { name: "CanvasStore", enabled: process.env.NODE_ENV !== "production" },
  ),
);

export const canvasAutosave = createCanvasAutosave(useCanvasStore, (error) => {
  // Storage failures remain visible with retry/export actions in the editor;
  // automatic retries should not repeatedly interrupt editing with a toast.
  if (error instanceof CanvasStorageError) return;
  toast.error("自动保存失败，请查看错误详情", {
    id: "canvas-autosave-error",
    description: error instanceof Error ? error.message : "未知错误",
  });
}, undefined, undefined, undefined, { history: true });

// Existing interaction and generation hooks use the same coordinator.
export const canvasDraftStorage = {
  flush: () => { void canvasAutosave.flush().catch(() => {}); },
  beginInteraction: (key: string) => {
    if (key !== 'viewport') useCanvasStore.getState().beginEdit('geometry');
    canvasAutosave.beginInteraction(key);
  },
  endInteraction: (key: string) => {
    if (key !== 'viewport') useCanvasStore.getState().endEdit('geometry');
    canvasAutosave.endInteraction(key);
  },
};
