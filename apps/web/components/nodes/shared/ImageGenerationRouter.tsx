'use client';
import { useEffect, useState, type ComponentType } from 'react';
import type { Node, NodeProps } from '@xyflow/react';
import type { NodeData } from '@/types';
import type { PublicModel } from '@/lib/generation/types';
import { supportsImageNodeModel } from '@/lib/generation/image-models';
import { generationModels } from '@/lib/generation/client';
import { NodeShell } from '../NodeShell';
import { ImageStage } from './ImageStage';
import { TaskImageNode } from './TaskImageNode';

/** Capability-driven dispatch keeps legacy menus and task protocols compatible. */
export function ImageGenerationRouter({ legacy: Legacy, ...props }: NodeProps<Node<NodeData>> & { legacy: ComponentType<NodeProps<Node<NodeData>>> }) {
  const [models, setModels] = useState<PublicModel[]>();
  useEffect(() => {
    let active = true;
    generationModels().then(models => { if (active) setModels(models); }).catch(() => { if (active) setModels([]); });
    return () => { active = false; };
  }, []);
  if (!models) return <NodeShell {...props} stageTestId="image-preview" console={<div role="status">正在加载生图模型…</div>}><ImageStage data={props.data} /></NodeShell>;
  const model = models.find(model => model.id === props.data.model);
  return model?.capabilities.image?.presets && supportsImageNodeModel(model, props.data.type) ? <TaskImageNode {...props} model={model} models={models} /> : <Legacy {...props} />;
}
