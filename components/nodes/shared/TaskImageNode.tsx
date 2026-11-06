'use client';
import { useEffect, useRef, useState } from 'react';
import type { Node, NodeProps } from '@xyflow/react';
import type { ImageSizePreset } from '@/lib/generation/image-dimensions';
import type { NodeData } from '@/types';
import type { PublicModel } from '@/lib/generation/types';
import { supportsImageNodeModel, imageModelSelection } from '@/lib/generation/image-models';
import { imageReferences, imagePrompt, type ImageReference } from '@/lib/generation/image-references';
import { resolveImageOptions, validateImageGenerationInput } from '@/lib/generation/image-options';
import { promptSegments } from '@/lib/canvas/prompt';
import { useCanvasStore } from '@/store/useCanvasStore';
import { useUpstreamNodes } from '@/hooks/useUpstreamNodes';
import { useGenerationTask } from '@/hooks/useGenerationTask';
import { mediaUploadLimit } from '@/lib/upload-limits';
import { getImageModels } from '@/lib/model-registry';
import { NodeShell } from '../NodeShell';
import { NodeConsole } from './NodeConsole';
import { NodeConnections } from './NodeConnections';
import { PromptEditor } from './PromptEditor';
import { ImageStage } from './ImageStage';
import { ImageToolbarActions } from './ImageToolbarActions';
import { TaskImageSettings } from './TaskImageSettings';
import { consoleSelectClass } from './ConsoleControls';

export function TaskImageNode({ model, models, ...props }: NodeProps<Node<NodeData>> & { model: PublicModel; models: PublicModel[] }) {
  const { id, data } = props;
  const update = useCanvasStore(state => state.updateNodeData);
  const upstream = useUpstreamNodes(id);
  const task = useGenerationTask(id, data);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploading = useRef(false);
  const [alpha, setAlpha] = useState<{ url: string; supported: boolean }>();
  const references = imageReferences(id, useCanvasStore.getState());
  const single = references.length === 1 ? references[0] : undefined;
  const singleUrl = single?.url, singleHasAlpha = single?.hasAlpha;
  // Uploaded metadata is authoritative; connected originals are inspected without persisting a preview.
  useEffect(() => {
    if (!props.selected || !singleUrl || singleHasAlpha !== undefined) return;
    const controller = new AbortController();
    fetch(singleUrl, { signal: controller.signal }).then(r => { if (!r.ok) throw Error(); return r.arrayBuffer(); }).then(buffer => {
      const bytes = new Uint8Array(buffer), view = new DataView(buffer);
      let supported = false;
      if (bytes.length >= 26 && view.getUint32(0) === 0x89504e47) {
        supported = bytes[25] === 4 || bytes[25] === 6;
        for (let offset = 8; !supported && offset + 12 <= bytes.length;) {
          const length = view.getUint32(offset);
          supported = view.getUint32(offset + 4) === 0x74524e53;
          offset += length + 12;
        }
      } else if (bytes.length >= 25 && view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
        const format = view.getUint32(12);
        supported = format === 0x56503858 ? !!(bytes[20] & 0x10) : format === 0x5650384c && !!(bytes[24] & 0x10);
      }
      if (!controller.signal.aborted) setAlpha({ url: singleUrl, supported });
    }).catch(() => {});
    return () => controller.abort();
  }, [props.selected, singleUrl, singleHasAlpha]);
  const canUseTransparency = !!single && (single.hasAlpha ?? (alpha?.url === single.url && alpha.supported));
  const image = model.capabilities.image!;
  const width = data.generationWidth ?? model.capabilities.dimensions.defaultWidth;
  const height = data.generationHeight ?? model.capabilities.dimensions.defaultHeight;
  const blocked = !!data.isLoading || !!data.pendingGeneration || !!data.generationBlocked;
  const prompt = imagePrompt(id, useCanvasStore.getState(), references);
  const displayUpstream = upstream.map(source => {
    const index = references.findIndex(ref => ref.sourceNodeId === source.id);
    return index < 0 ? source : { ...source, label: `图片${index + 1}` };
  });
  const change = (patch: Partial<NodeData>) => update(id, patch);
  function move(index: number, direction: number) {
    const order = references.map(ref => ref.id);
    [order[index], order[index + direction]] = [order[index + direction], order[index]];
    change({ imageReferenceOrder: order });
  }
  function remove(ref: ImageReference) {
    if (ref.sourceNodeId) {
      const state = useCanvasStore.getState();
      state.deleteElements([], state.edges.filter(edge => edge.target === id && edge.source === ref.sourceNodeId).map(edge => edge.id));
    } else change({ imageReferences: data.imageReferences?.filter(item => item.id !== ref.id), imageReferenceOrder: data.imageReferenceOrder?.filter(item => item !== ref.id) });
  }
  async function upload(files: FileList | null) {
    if (!files?.length || uploading.current) return;
    const batch = Array.from(files);
    if (references.length + batch.length > image.maxImages) { change({ error: `参考图片最多 ${image.maxImages} 张` }); return; }
    if (batch.some(file => !/\.(png|jpe?g|webp)$/i.test(file.name) || !file.size || file.size > mediaUploadLimit)) {
      change({ error: '请上传 PNG、JPEG 或 WebP 图片，每张不超过 30 MB' }); return;
    }
    uploading.current = true;
    const complete = useCanvasStore.getState().beginMediaOperation(id);
    try {
      const added: ImageReference[] = [];
      for (const file of batch) {
        const form = new FormData(); form.set('file', file);
        const response = await fetch('/api/upload/reference', { method: 'POST', body: form });
        const result = await response.json();
        if (!response.ok || result.kind !== 'image') throw Error(result.error || '图片上传失败');
        added.push({ id: crypto.randomUUID(), url: result.url, name: file.name, hasAlpha: result.hasAlpha });
      }
      complete({ imageReferences: [...(data.imageReferences ?? []), ...added], imageReferenceOrder: [...references.map(ref => ref.id), ...added.map(ref => ref.id)] });
    } catch (error) { complete({ error: error instanceof Error ? error.message : '图片上传失败' }); }
    finally { uploading.current = false; if (fileInput.current) fileInput.current.value = ''; }
  }
  async function generate() {
    if (data.pendingGeneration) { await task.start(data.pendingGeneration); return; }
    const state = useCanvasStore.getState();
    const current = state.nodes.find(node => node.id === id)?.data;
    if (!current) return;
    const refs = imageReferences(id, state);
    const input = { prompt: imagePrompt(id, state, refs), width: current.generationWidth ?? model.capabilities.dimensions.defaultWidth,
      height: current.generationHeight ?? model.capabilities.dimensions.defaultHeight,
      imageOptions: resolveImageOptions(current.imageOptions, image), references: refs.map(ref => ({ kind: 'image' as const, url: ref.url })) };
    try {
      if (!input.prompt.trim()) throw Error('请输入提示词');
      if (data.type === 'imageToImage' && !refs.length) throw Error('请上传或连接参考图片');
      validateImageGenerationInput(input, image);
      await task.start({ requestId: crypto.randomUUID(), modelId: model.id, canvasId: state.currentWorkflowId || 'draft', nodeId: id, input });
    } catch (error) { change({ error: error instanceof Error ? error.message : '无法创建生成任务' }); }
  }
  return <NodeShell {...props} stageTestId="image-preview"
    toolbar={<ImageToolbarActions nodeId={id} src={!data.isLoading ? data.imageSrc : undefined} alt="Generated" />}
    console={<NodeConsole data={data} onRun={() => void generate()} onResume={() => void task.resume()} onRetrySave={() => void task.retrySave()}
      runDisabled={!model.configured || !!data.generationBlocked || !prompt.trim() || (data.type === 'imageToImage' && !references.length)}
      notice={!model.configured ? '请管理员配置火山引擎平台连接' : undefined}
      connections={<NodeConnections nodeId={id} upstream={displayUpstream} />}
      editor={<>
        <PromptEditor value={promptSegments(data.prompt)} upstream={displayUpstream} placeholder="描述你想要生成的图片…" onChange={prompt => change({ prompt })} />
        <div className="flex flex-col gap-2 text-xs" aria-label="参考图片">
          {references.map((ref, index) => <div key={ref.id} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate" title={ref.name}>图片{index + 1} · {ref.name}</span>
            <button aria-label={`上移图片${index + 1}`} disabled={blocked || index === 0} onClick={() => move(index, -1)}>↑</button>
            <button aria-label={`下移图片${index + 1}`} disabled={blocked || index === references.length - 1} onClick={() => move(index, 1)}>↓</button>
            <button aria-label={`移除图片${index + 1}`} disabled={blocked} onClick={() => remove(ref)}>移除</button>
          </div>)}
          <input ref={fileInput} type="file" multiple accept="image/png,image/jpeg,image/webp" aria-label="上传参考图片" className="hidden" onChange={e => void upload(e.target.files)} />
          <button type="button" disabled={blocked || references.length >= image.maxImages} onClick={() => fileInput.current?.click()}
            className="rounded-lg border border-zinc-500/30 px-3 py-2 disabled:opacity-40">上传参考图片（{references.length}/{image.maxImages}）</button>
        </div>
      </>}
      config={<>
        <select aria-label="生图模型" value={model.id} disabled={blocked} className={consoleSelectClass}
          onChange={e => change(imageModelSelection(e.target.value, models, data.aspectRatio))}>
          {models.filter(m => supportsImageNodeModel(m, data.type)).map(m => <option key={m.id} value={m.id}>{m.name}{m.configured ? '' : '（未配置）'}</option>)}
          {getImageModels().map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
        <TaskImageSettings model={model} width={width} height={height} options={data.imageOptions} canUseTransparency={canUseTransparency} disabled={blocked}
          onSize={(generationWidth, generationHeight) => {
            const preset = image.presets!.find(p => p.width === generationWidth && p.height === generationHeight)!;
            change({ generationWidth, generationHeight, generationSizePreset: preset.size.toLowerCase() as ImageSizePreset, aspectRatio: preset.ratio });
          }} onOptions={imageOptions => change({ imageOptions })} />
      </>}
    />}><ImageStage data={data} /></NodeShell>;
}
