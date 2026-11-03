"use client";

import { CanvasPreview } from "@/components/ui/canvas-preview";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  appendPromptText,
  promptIsEmpty,
  promptSegments,
  promptWithLabels,
  type UpstreamNode,
} from "@/lib/canvas/prompt";
import { mediaUploadLimit } from "@/lib/upload-limits";
import type { Node, NodeProps } from "@xyflow/react";
import { createVideoSourcesSelector } from "@/lib/canvas/video-sources";
import { canvasExperimentDisabled } from "@/lib/canvas/performance-experiment";
import { Upload, ArrowUp, ArrowDown, X } from "lucide-react";
import { NodeShell } from "../NodeShell";
import { useCanvasStore } from "@/store/useCanvasStore";
import type { NodeData } from "@/types";
import type { PublicModel } from "@/lib/generation/types";
import { validGenerationDimensions } from "@/lib/generation/dimensions";
import {
  orderReferences,
  referenceLabels,
  videoDimensions,
  videoDuration,
  videoRatios,
  videoResolutions,
  type VideoReference,
  type VideoResolution,
} from "@/lib/generation/video";
import type { useGenerationTask } from "@/hooks/useGenerationTask";
import {
  consoleSelectClass,
  narrowConsoleSelectClass,
} from "./ConsoleControls";
import { NodeConsole } from "./NodeConsole";
import { PromptEditor } from "./PromptEditor";
import { VideoStage } from "./VideoStage";
import { VideoToolbarActions } from "./VideoToolbarActions";
import styles from "./TaskVideoNode.module.css";

interface Props {
  node: NodeProps<Node<NodeData>>;
  model?: PublicModel;
  models: { id: string; label: string; task?: boolean }[];
  task: ReturnType<typeof useGenerationTask>;
}
const emptyReferences: VideoReference[] = [];
const emptyOrder: string[] = [];

export function TaskVideoNode({ node, model, models, task }: Props) {
  const { id, data } = node;
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_CANVAS_PERF_EXPERIMENT === "1") performance.mark("canvas:video-content-render");
  });
  const update = useCanvasStore((s) => s.updateNodeData);
  const selectSources = useMemo(() => createVideoSourcesSelector(id, { includeGeometry: canvasExperimentDisabled('subscriptions') }), [id]);
  const sources = useCanvasStore(selectSources);
  const [uploading, setUploading] = useState(false);
  const uploadingRef = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploads = data.videoReferences || emptyReferences;
  const order = data.videoReferenceOrder || emptyOrder;
  const references = useMemo(() => {
    const connected: VideoReference[] = [];
    for (const source of sources) {
      const url = source.url;
      if (!url) continue;
      const kind = source.kind;
      const refId = `node:${source.id}`;
      connected.push({
        id: refId,
        sourceNodeId: source.id,
        name: source.name,
        kind,
        url,
        ...(kind === "video"
          ? { useAudio: data.videoReferenceAudio?.[refId] !== false }
          : {}),
      });
    }
    return orderReferences(uploads, connected, order);
  }, [sources, uploads, order, data.videoReferenceAudio]);
  const labels = referenceLabels(references);
  // H3 reads references in its own format, and a connected reference's first tag names it.
  const firstTag = (index: number) => labels[index].match(/<[^>]+>/)![0];
  const connected = references.flatMap((reference, index) =>
    reference.sourceNodeId ? [{ reference, tag: firstTag(index) }] : [],
  );
  const tags = new Map(
    connected.map(({ reference, tag }) => [reference.sourceNodeId!, tag]),
  );
  const upstream = connected.map(
    ({ reference, tag }): UpstreamNode => ({
      id: reference.sourceNodeId!,
      kind: reference.kind === "video" ? "video" : "image",
      label: tag,
      name: reference.name,
      ...(reference.kind === "image" ? { src: reference.url } : {}),
    }),
  );
  // A connected node with no material yet is not numbered, so a reference to it reads as its name.
  for (const source of sources)
    if (!tags.has(source.id)) {
      const name = source.name;
      tags.set(source.id, name);
      upstream.push({ id: source.id, kind: "image", label: name, name });
    }
  const prompt = promptWithLabels(data.prompt, tags);
  const segments = promptSegments(data.prompt);
  const resolution = data.videoResolution || "720p";
  const ratio = data.videoAspectRatio || "16:9";
  const duration =
    data.videoDuration ?? model?.capabilities.video?.defaultDuration ?? 7;
  const dims = videoDimensions(resolution, ratio);
  const capabilities = model?.capabilities.video;
  const counts = {
    image: references.filter((r) => r.kind === "image").length,
    video: references.filter((r) => r.kind === "video").length,
    audio: references.filter((r) => r.kind === "audio").length,
  };
  const tooMany =
    counts.image > (capabilities?.maxImages ?? 9) ||
    counts.video > (capabilities?.maxVideos ?? 3) ||
    counts.audio > (capabilities?.maxAudios ?? 3);
  const invalidSize =
    !!model &&
    !validGenerationDimensions(
      model.capabilities.dimensions,
      dims.width,
      dims.height,
    );
  const busy = uploading || !!data.isLoading;
  const blocked =
    !model?.configured || !!data.generationBlocked || tooMany || invalidSize;
  const change = (value: Partial<NodeData>) => update(id, value);

  function move(index: number, delta: number) {
    const next = references.map((r) => r.id);
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    change({ videoReferenceOrder: next });
  }
  function remove(reference: VideoReference) {
    if (reference.sourceNodeId) {
      const state = useCanvasStore.getState();
      state.onEdgesChange(
        state.edges
          .filter((e) => e.source === reference.sourceNodeId && e.target === id)
          .map((e) => ({ type: "remove", id: e.id })),
      );
    } else
      change({ videoReferences: uploads.filter((r) => r.id !== reference.id) });
    change({
      videoReferenceOrder: references
        .filter((r) => r.id !== reference.id)
        .map((r) => r.id),
    });
  }
  function toggleAudio(reference: VideoReference, useAudio: boolean) {
    if (reference.sourceNodeId)
      change({
        videoReferenceAudio: {
          ...data.videoReferenceAudio,
          [reference.id]: useAudio,
        },
      });
    else
      change({
        videoReferences: uploads.map((r) =>
          r.id === reference.id ? { ...r, useAudio } : r,
        ),
      });
  }
  async function upload(files: FileList | null) {
    if (!files?.length || uploadingRef.current) return;
    uploadingRef.current = true;
    setUploading(true);
    change({ error: undefined });
    const canvasId = useCanvasStore.getState().currentWorkflowId;
    const batch = Array.from(files);
    const nextCounts = { ...counts };
    try {
      for (const file of batch) {
        const kind = /\.(jpe?g|png|webp)$/i.test(file.name)
          ? "image"
          : /\.(mp4|avi|mov|mkv)$/i.test(file.name)
            ? "video"
            : /\.(mp3|wav|flac)$/i.test(file.name)
              ? "audio"
              : undefined;
        if (!kind || file.size > mediaUploadLimit)
          throw new Error("请上传支持格式的素材，单文件不超过 30 MB");
        if (
          ++nextCounts[kind] >
          {
            image: capabilities?.maxImages ?? 9,
            video: capabilities?.maxVideos ?? 3,
            audio: capabilities?.maxAudios ?? 3,
          }[kind]
        )
          throw new Error("参考素材最多支持 9 张图片、3 段视频和 3 段独立音频");
      }
      for (const file of batch) {
        const form = new FormData();
        form.set("file", file);
        const response = await fetch("/api/upload/reference", {
          method: "POST",
          body: form,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "素材上传失败");
        const state = useCanvasStore.getState();
        const current = state.nodes.find((n) => n.id === id);
        if (!current || state.currentWorkflowId !== canvasId) return;
        const reference: VideoReference = {
          id: crypto.randomUUID(),
          name: file.name,
          kind: result.kind,
          url: result.url,
          ...(result.kind === "video"
            ? { hasAudio: result.hasAudio, useAudio: result.hasAudio }
            : {}),
        };
        update(id, {
          videoReferences: [...(current.data.videoReferences || []), reference],
          videoReferenceOrder: [
            ...(current.data.videoReferenceOrder ||
              references.map((r) => r.id)),
            reference.id,
          ],
        });
      }
    } catch (error) {
      if (useCanvasStore.getState().currentWorkflowId === canvasId)
        change({
          error: error instanceof Error ? error.message : "素材上传失败",
        });
    } finally {
      uploadingRef.current = false;
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  async function generate() {
    if (busy) return;
    if (data.pendingGeneration) {
      await task.start(data.pendingGeneration);
      return;
    }
    if (!model || blocked || promptIsEmpty(prompt)) return;
    await task.start({
      requestId: crypto.randomUUID(),
      modelId: model.id,
      canvasId: useCanvasStore.getState().currentWorkflowId || "draft",
      nodeId: id,
      input: {
        prompt,
        ...dims,
        duration,
        references: references.map(({ kind, url, useAudio }) => ({
          kind,
          url,
          ...(kind === "video" ? { useAudio: !!useAudio } : {}),
        })),
      },
    });
  }

  function insertTag(reference: VideoReference, tag: string) {
    // A connected reference stays a node reference, so its number follows reordering.
    change({
      prompt:
        reference.sourceNodeId && tags.get(reference.sourceNodeId) === tag
          ? [...segments, { ref: reference.sourceNodeId }]
          : appendPromptText(data.prompt, tag),
    });
  }

  return (
    <NodeShell
      {...node}
      stageTestId="video-preview"
      toolbar={
        <VideoToolbarActions src={data.isLoading ? undefined : data.videoSrc} />
      }
      console={
        <NodeConsole
          data={data}
          onRun={() => void generate()}
          runDisabled={
            busy ||
            (!data.pendingGeneration && (blocked || promptIsEmpty(prompt)))
          }
          onResume={() => void task.resume()}
          onRetrySave={() => void task.retrySave()}
          connections={
            <div className={styles.panel}>
              <div className={styles.heading}>
                <span>参考素材</span>
                <span className={styles.muted}>
                  {counts.image}/9 图 · {counts.video}/3 视频 · {counts.audio}/3
                  音频
                </span>
              </div>
              <div className={styles.references}>
                {references.map((ref, index) => (
                  <div
                    className={styles.reference}
                    key={ref.id}
                    data-testid="video-reference"
                  >
                    <div className={styles.preview}>
                      {ref.kind === "image" ? (
                        <CanvasPreview compact className="h-16 w-[108px]" src={ref.url} alt={ref.name} />
                      ) : ref.kind === "video" ? (
                        <video src={ref.url} controls preload="metadata" />
                      ) : (
                        <audio src={ref.url} controls preload="metadata" />
                      )}
                    </div>
                    <div className={styles.referenceInfo}>
                      <div className={styles.tags}>
                        {labels[index].match(/<[^>]+>/g)?.map((tag) => (
                          <button
                            type="button"
                            key={tag}
                            title="插入提示词"
                            onClick={() => insertTag(ref, tag)}
                          >
                            {tag}
                          </button>
                        ))}
                      </div>
                      <span className={styles.name} title={ref.name}>
                        {ref.name}
                        {ref.sourceNodeId ? " · 连线" : ""}
                      </span>
                      {ref.kind === "video" ? (
                        <label className={styles.muted}>
                          <input
                            type="checkbox"
                            checked={!!ref.useAudio}
                            disabled={ref.hasAudio === false}
                            aria-label={`${labels[index].split(" · ")[0]} 参考原声`}
                            onChange={(e) => toggleAudio(ref, e.target.checked)}
                          />{" "}
                          {ref.hasAudio === false ? "无音轨" : "参考原声"}
                        </label>
                      ) : null}
                    </div>
                    <div className={styles.actions}>
                      <button
                        type="button"
                        aria-label={`上移素材 ${index + 1}`}
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                      >
                        <ArrowUp size={13} />
                      </button>
                      <button
                        type="button"
                        aria-label={`下移素材 ${index + 1}`}
                        disabled={index === references.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <ArrowDown size={13} />
                      </button>
                      <button
                        type="button"
                        aria-label={`移除素材 ${index + 1}`}
                        onClick={() => remove(ref)}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              {!references.length ? (
                <p className={styles.muted}>
                  连接画布中的图片或视频，或上传参考素材。也可仅输入提示词。
                </p>
              ) : null}
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                accept=".jpg,.jpeg,.png,.webp,.mp4,.avi,.mov,.mkv,.mp3,.wav,.flac"
                data-testid="reference-file-input"
                onChange={(e) => void upload(e.target.files)}
              />
              <button
                type="button"
                className={styles.upload}
                disabled={uploading}
                onClick={() => fileInput.current?.click()}
              >
                <Upload size={14} />
                {uploading ? "正在上传素材…" : "上传图片 / 视频 / 音频"}
              </button>
            </div>
          }
          editor={
            <>
              <PromptEditor
                value={segments}
                upstream={upstream}
                placeholder="描述视频内容，输入 @ 引用连接的素材…"
                onChange={(value) => change({ prompt: value })}
              />
              {!model ? (
                <p className={styles.error}>模型目录暂时不可用</p>
              ) : !model.configured ? (
                <p className={styles.error}>请先配置 RunningHub 平台连接</p>
              ) : null}
              {tooMany ? (
                <p className={styles.error}>参考素材数量超限，请移除多余素材</p>
              ) : null}
              {invalidSize ? (
                <p className={styles.error}>
                  此画幅与分辨率组合超出模型尺寸范围
                </p>
              ) : null}
            </>
          }
          config={
            <>
              <select
                aria-label="视频模型"
                value={data.model || ""}
                disabled={
                  busy || !!data.pendingGeneration || !!data.generationBlocked
                }
                className={consoleSelectClass}
                onChange={(e) =>
                  change({
                    model: e.target.value,
                    usesGenerationTasks: !!models.find(
                      (m) => m.id === e.target.value,
                    )?.task,
                  })
                }
              >
                {models.map((m) => (
                  <option value={m.id} key={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <select
                aria-label="视频分辨率"
                value={resolution}
                className={narrowConsoleSelectClass}
                onChange={(e) =>
                  change({ videoResolution: e.target.value as VideoResolution })
                }
              >
                {videoResolutions.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              <select
                aria-label="视频画幅"
                value={ratio}
                className={narrowConsoleSelectClass}
                onChange={(e) => change({ videoAspectRatio: e.target.value })}
              >
                {videoRatios.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              <select
                aria-label="视频目标时长"
                value={duration}
                className={narrowConsoleSelectClass}
                onChange={(e) =>
                  change({ videoDuration: Number(e.target.value) })
                }
              >
                {Array.from(
                  {
                    length:
                      (capabilities?.maxDuration ?? 15) -
                      (capabilities?.minDuration ?? 5) +
                      1,
                  },
                  (_, i) => i + (capabilities?.minDuration ?? 5),
                ).map((value) => (
                  <option key={value} value={value}>
                    {value} 秒
                  </option>
                ))}
              </select>
            </>
          }
        />
      }
    >
      <VideoStage data={data} emptyLabel="H3 参考生视频" />
    </NodeShell>
  );
}
