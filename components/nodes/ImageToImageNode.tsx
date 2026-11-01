"use client";

import { memo, useCallback, useMemo, useState, useEffect } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { BaseNode, NodeSurface } from "./BaseNode";
import { promptText } from "@/lib/canvas/prompt";
import { useNodeInputs } from "@/hooks/useNodeInputs";
import { useCanvasStore } from "@/store/useCanvasStore";
import {
  Image as ImageIcon,
  Sparkles,
  AlertCircle,
  Loader2,
  Wand2,
  RefreshCw,
} from "lucide-react";
import type { NodeData } from "@/types";
import { getImageModels } from "@/lib/model-registry";
import { Textarea } from "@/components/ui/textarea";
import { ImageWithActions } from "@/components/ui/image-with-actions";
import { ImageGenerationPanel } from "./shared/ImageGenerationPanel";
import { ImageModelSettings } from "./shared/ImageModelSettings";
import imageStyles from "./shared/ImageGeneration.module.css";

const aspectRatios = [
  { value: "1:1", label: "1:1 方形" },
  { value: "16:9", label: "16:9 横屏" },
  { value: "9:16", label: "9:16 竖屏" },
];

const resolutions = [
  { value: "1024x1024", label: "1K" },
  { value: "2048x2048", label: "2K" },
  { value: "4096x4096", label: "4K" },
];

const ImageToImageNode = (props: NodeProps<Node<NodeData>>) => {
  const { id, data, selected } = props;
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const singleSelected = useCanvasStore((state) => state.selectedNodeIds.length === 1);

  // 获取输入边和节点
  const inputs = useNodeInputs(id);

  // 只有在单选状态下才显示控制面板
  const shouldShowPanel = selected && singleSelected && !props.dragging;

  // 计算输入图片（使用 useMemo 稳定引用）
  const inputImages = useMemo(() => {
    if (inputs.length === 0) return [];

    const images = inputs
      .map((sourceData) => {
        if (!sourceData) return null;

        // 支持角色节点 - 使用角色的第一张参考图
        if (sourceData.characterData?.referenceImages?.[0]) {
          return sourceData.characterData.referenceImages[0];
        }

        // 支持普通图片节点
        return sourceData.imageSrc;
      })
      .filter(Boolean) as string[];

    return images;
  }, [inputs]);

  // 兼容旧代码，第一张图片作为主输入
  const inputImage = inputImages[0] || null;

  const [imageModels, setImageModels] = useState<
    Array<{ value: string; label: string }>
  >([]);

  // 本地状态用于输入框，防止中文输入法问题
  const [localPrompt, setLocalPrompt] = useState(promptText(data.prompt));

  // 加载图片模型列表
  useEffect(() => {
    setImageModels(getImageModels());
  }, []);

  // 同步外部数据变化到本地状态
  useEffect(() => {
    setLocalPrompt(promptText(data.prompt));
  }, [data.prompt]);

  const handleGenerate = useCallback(
    async (skipCache = false) => {
      // 先同步本地输入到 store
      if (localPrompt !== data.prompt) {
        updateNodeData(id, { prompt: localPrompt });
      }

      if (!localPrompt || !inputImage) return;

      updateNodeData(id, { isLoading: true, error: undefined });

      try {
        const response = await fetch("/api/generate/image-to-image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: localPrompt,
            inputImage, // 保持第一张作为主输入（兼容性）
            inputImages, // 传递所有输入图片
            model: data.model || "BananaPro",
            aspectRatio: data.aspectRatio || "1:1",
            resolution: data.resolution || "1024x1024", // 传递分辨率参数
            promptOptimize: data.promptOptimize || false,
            skipCache, // 传递 skipCache 参数
          }),
        });

        const result = await response.json();

        if (result.success && result.data) {
          updateNodeData(id, {
            isLoading: false,
            imageSrc: result.data,
            inputImages: [inputImage],
          });
        } else {
          throw new Error(result.error || "生成失败");
        }
      } catch (error) {
        updateNodeData(id, {
          isLoading: false,
          error: error instanceof Error ? error.message : "生成失败",
        });
      }
    },
    [
      id,
      localPrompt,
      data.model,
      data.aspectRatio,
      data.resolution,
      data.promptOptimize,
      inputImage,
      inputImages,
      data.prompt,
      updateNodeData,
    ],
  );

  const hasResult = !!data.imageSrc && !data.isLoading;

  return (
    <BaseNode {...props}>

      {/* 节点显示区域 */}
      <NodeSurface testId="image-preview">
        {hasResult ? (
          <div className="relative w-full h-full">
            <ImageWithActions
              src={data.imageSrc}
              alt="Generated"
              className="w-full h-full object-contain"
            />
          </div>
        ) : (
          <div role="img" aria-label="尚无生成图片" className="w-full h-full flex items-center justify-center text-zinc-500">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center bg-zinc-800/50 text-zinc-500">
              <ImageIcon size={28} className="opacity-60" aria-hidden />
            </div>
          </div>
        )}

        {data.isLoading && (
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex flex-col items-center justify-center z-20">
            <Loader2 size={32} className="text-purple-500 animate-spin mb-3" />
            <span className="text-white/80 text-sm font-medium">生成中...</span>
          </div>
        )}
      </NodeSurface>

      {/* 控制面板 */}
      {shouldShowPanel && (
        <ImageGenerationPanel>
            {/* 输入图片预览 */}
            {inputImages.length > 0 ? (
              <div>
                <label className="text-xs font-medium text-zinc-400 mb-2 block">
                  输入图片 ({inputImages.length}张)
                  {inputImages.length > 1 && (
                    <span className="ml-2 text-green-400">✓ 支持多图参考</span>
                  )}
                </label>
                <div
                  className={`grid gap-2 ${inputImages.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}
                >
                  {inputImages.map((img, idx) => (
                    <div
                      key={idx}
                      className="relative rounded-lg overflow-hidden h-32 bg-zinc-800/50"
                    >
                      <ImageWithActions
                        src={img}
                        alt={`Input ${idx + 1}`}
                        className="w-full h-full object-contain"
                      />
                      <span className="absolute top-1 left-1 bg-purple-500 text-white text-xs px-1.5 py-0.5 rounded z-20">
                        {idx + 1}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 px-3 py-2 rounded-lg border border-amber-500/20">
                <AlertCircle size={16} />
                <span>请连接图片节点（支持多张图片参考）</span>
              </div>
            )}

            <Textarea
              className={`${imageStyles.prompt} nodrag`}
              placeholder="描述你想要的变化..."
              value={localPrompt}
              onChange={(e) => {
                setLocalPrompt(e.target.value);
                updateNodeData(id, { prompt: e.target.value });
              }}
              onBlur={() => updateNodeData(id, { prompt: localPrompt })}
              onMouseDown={(e) => e.stopPropagation()}
              onWheel={(e) => e.stopPropagation()}
              rows={3}
            />

            <div className={imageStyles.foot}>
              <ImageModelSettings aspectRatio={data.aspectRatio || '1:1'} resolution={data.resolution || '1024x1024'}
                ratios={aspectRatios} resolutions={resolutions} disabled={data.isLoading}
                onChange={settings => updateNodeData(id, settings)} />
              <select aria-label="生图模型" value={data.model || imageModels[0]?.value || ''}
                disabled={data.isLoading} onChange={event => updateNodeData(id, { model: event.target.value })}
                className={imageStyles.model}>
                {imageModels.map(model => <option key={model.value} value={model.value}>{model.label}</option>)}
              </select>
              <button
                className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-all border ${
                  data.promptOptimize
                    ? "text-purple-400 bg-purple-500/20 border-purple-500/30"
                    : "text-zinc-400 hover:text-white border-zinc-700 hover:border-zinc-600 hover:bg-zinc-700"
                }`}
                onClick={() =>
                  updateNodeData(id, { promptOptimize: !data.promptOptimize })
                }
                title="提示词优化"
              >
                <Sparkles
                  size={15}
                  fill={data.promptOptimize ? "currentColor" : "none"}
                />
              </button>
              <div className="flex-1" />
              <button
                onClick={() => handleGenerate(false)}
                disabled={data.isLoading || !localPrompt || !inputImage}
                className={`shrink-0 h-8 px-4 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 whitespace-nowrap transition-all active:scale-[0.98] ${
                  data.isLoading || !localPrompt || !inputImage
                    ? "bg-zinc-800 text-zinc-500 cursor-not-allowed"
                    : "bg-purple-600 hover:bg-purple-500 text-white"
                }`}
              >
                {data.isLoading ? (
                  <Loader2 className="animate-spin" size={15} />
                ) : (
                  <Wand2 size={15} />
                )}
                <span>{data.isLoading ? "生成中" : "生成"}</span>
              </button>

              {hasResult && !data.isLoading && (
                <button
                  onClick={() => handleGenerate(true)}
                  className="shrink-0 h-8 w-8 rounded-lg text-sm font-semibold flex items-center justify-center transition-all active:scale-[0.98] bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white border border-zinc-700 hover:border-zinc-600"
                  title="重新生成（跳过缓存）"
                >
                  <RefreshCw size={15} />
                </button>
              )}
            </div>

            {data.error && (
              <div className="text-xs text-red-400 bg-red-500/10 px-3 py-2 rounded-lg border border-red-500/20">
                {data.error}
              </div>
            )}
        </ImageGenerationPanel>
      )}
    </BaseNode>
  );
};

ImageToImageNode.displayName = "ImageToImageNode";

export default memo(ImageToImageNode);
