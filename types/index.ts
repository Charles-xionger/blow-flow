import { Edge, Node } from "@xyflow/react";

// 节点类型枚举
export enum NodeType {
  TEXT_TO_IMAGE = "textToImage",
  TEXT_TO_VIDEO = "textToVideo",
  IMAGE_TO_IMAGE = "imageToImage",
  IMAGE_TO_VIDEO = "imageToVideo",
  START_END_TO_VIDEO = "startEndToVideo",
  CREATIVE_DESC = "creativeDesc",
  ORIGINAL_IMAGE = "originalImage",
  GROUP = "group",
}

// 节点数据接口
export interface NodeData extends Record<string, unknown> {
  // 基础信息
  label: string;
  type: NodeType;
  customTitle?: string; // 用户自定义标题

  // 输入
  prompt?: string;
  inputImages?: string[];

  // 输出
  imageSrc?: string;
  videoSrc?: string;
  outputArtifacts?: string[]; // 历史输出/批量生成

  // 状态
  isLoading?: boolean;
  isStackOpen?: boolean;
  error?: string;

  // 配置
  model?: string;
  aspectRatio?: string;
  resolution?: string;
  duration?: string;
  count?: number;
  promptOptimize?: boolean;
  swapFrames?: boolean; // START_END_TO_VIDEO 专用

  // Creative Desc 专用
  optimizedPrompt?: string;

  // UI 状态
  activeToolbarItem?: string;
}

// React Flow 节点类型
export type CanvasNode = Node<NodeData, NodeType>;
export type CanvasEdge = Edge;

// 工作流数据
export interface WorkflowData {
  id: string;
  name: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport?: { x: number; y: number; zoom: number };
  createdAt: number;
  updatedAt: number;
}

// 模型配置
export interface ModelConfig {
  modelId: string;
  baseUrl: string;
  key: string;
  endpoint: string;
  queryEndpoint?: string;
  downloadEndpoint?: string;
  category?: "IMAGE" | "VIDEO";
}

// 模型定义
export interface ModelDef {
  id: string;
  name: string;
  type:
    | "CHAT"
    | "IMAGE_GEN"
    | "VIDEO_GEN_CHAT"
    | "VIDEO_GEN_STD"
    | "VIDEO_GEN_MINIMAX"
    | "KLING"
    | "KLING_OMNI"
    | "ALIYUN_WANX"
    | "MJ_MODAL";
  category: "IMAGE" | "VIDEO";
  defaultEndpoint: string;
  defaultQueryEndpoint?: string;
  defaultDownloadEndpoint?: string;
}

// API 请求/响应类型
export interface GenerateImageRequest {
  prompt: string;
  model: string;
  aspectRatio?: string;
  resolution?: string;
  count?: number;
  inputImages?: string[];
  promptOptimize?: boolean;
}

export interface GenerateVideoRequest {
  prompt: string;
  model: string;
  aspectRatio?: string;
  resolution?: string;
  duration?: string;
  count?: number;
  inputImages?: string[];
  promptOptimize?: boolean;
  isStartEndMode?: boolean;
}

export interface GenerateResponse {
  success: boolean;
  data?: string[];
  error?: string;
}

// 缓存条目
export interface CacheEntry {
  cacheKey: string;
  modelName: string;
  prompt: string;
  params: string;
  result: string;
  createdAt: number;
  expiresAt: number;
}
