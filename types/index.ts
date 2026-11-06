import type { ImageReference } from '@/lib/generation/image-references';
import type { Prompt } from "@/lib/canvas/prompt";
import type { CreateGeneration, ImageGenerationOptions } from "@/lib/generation/types";
import type { ImageSizePreset } from "@/lib/generation/image-dimensions";
import type { VideoReference, VideoResolution } from "@/lib/generation/video";
import { Edge, Node } from "@xyflow/react";

// 节点类型枚举
export enum NodeType {
  TEXT = "text",
  TEXT_TO_IMAGE = "textToImage",
  TEXT_TO_VIDEO = "textToVideo",
  IMAGE_TO_IMAGE = "imageToImage",
  IMAGE_TO_VIDEO = "imageToVideo",
  START_END_TO_VIDEO = "startEndToVideo",
  SCRIPT = "script",
  CREATIVE_DESC = "creativeDesc",
  STORYBOARD = "storyboard",
  ORIGINAL_IMAGE = "originalImage",
  GROUP = "group",
  CHARACTER = "character",
}

// 节点数据接口
export interface NodeData extends Record<string, unknown> {
  // 基础信息
  label: string;
  type: NodeType;
  displaySize?: { width: number; height: number };
  customTitle?: string; // 用户自定义标题

  // 输入
  prompt?: Prompt;
  inputImages?: string[];

  // 输出
  imageSrc?: string;
  videoSrc?: string;
  outputArtifacts?: string[]; // 历史输出/批量生成

  usesGenerationTasks?: boolean;
  generationTaskId?: string;
  generationNodeId?: string;
  generationContentVersion?: number;
  generationBindingVersion?: number;
  generationRevision?: number;
  generationResultBlocked?: boolean;
  generationResultArtifacts?: string[];
  pendingGeneration?: CreateGeneration;
  generationStatus?: string;
  generationBlocked?: boolean;
  generationCanRetrySave?: boolean;
  generationSaving?: boolean;
  generationWidth?: number;
  generationHeight?: number;
  generationSizePreset?: ImageSizePreset;
  imageOptions?: ImageGenerationOptions;
  imageReferences?: ImageReference[];
  imageReferenceOrder?: string[];
  videoReferences?: VideoReference[];
  videoReferenceOrder?: string[];
  videoReferenceAudio?: Record<string, boolean>;
  videoResolution?: VideoResolution;
  videoAspectRatio?: string;
  videoDuration?: number;
  videoInstanceType?: 'plus';

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

  textPurpose?: import("@/lib/script/publishing-types").TextPurpose;
  scriptSource?: { nodeId: string; versionId: string; draftRevision: number };
  pendingScriptPublish?: import("@/lib/script/publishing-types").PublishScript;
  scriptPreset?: string;
  scriptInstruction?: string;
  scriptTaskId?: string;
  pendingScript?: import("@/lib/script/types").CreateScriptTask;

  // Creative Desc 专用
  optimizedPrompt?: string;

  // Storyboard 专用
  storyboardShots?: Array<{
    shotNumber: number;
    title: string;
    description: string;
    duration?: string;
    cameraMovement?: string;
  }>;
  shotCount?: number;

  // Character 专用
  characterId?: string;
  characterData?: Character;

  // UI 状态
  activeToolbarItem?: string;
}

// React Flow 节点类型
export type CanvasNode = Node<NodeData, NodeType>;
export type CanvasEdge = Edge;

// 工作流数据
export interface WorkflowData {
  history?: import("@/lib/canvas/history").CanvasHistory;
  version?: number;
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

// 角色管理
export interface Character {
  id: string;
  name: string;
  description: string; // 外貌、性格等详细描述
  referenceImages: string[]; // 参考图片URLs（1-5张）
  tags: string[]; // 标签（年龄、性别、风格等）
  loraModelUrl?: string; // LoRA模型文件URL（可选）
  loraWeight?: number; // LoRA权重 0.5-1.0
  loraStatus?: "none" | "pending" | "training" | "ready" | "failed"; // LoRA训练状态
  createdAt: number;
  updatedAt: number;
}
