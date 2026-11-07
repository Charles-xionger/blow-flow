import { expandPrompt, nodeName, referenceMaterials, type PromptGraph } from '../canvas/prompt';
import type { NodeData } from '@/types';
import type { ScriptInput } from './types';

export const scriptPresets = [
  { id: 'free', label: '自由创作', description: '故事创意、文案与自由写作', instruction: '结合全部参考和创作要求完成文字创作。保留用户的创作意图，直接输出正文。' },
  { id: 'screenplay', label: '写剧本', description: '将想法写成场景、行动与对白', instruction: '结合全部参考创作完整剧本，清晰呈现人物、场景、行动和对白，保持情节与人物动机一致。直接输出可编辑的剧本文本。' },
  { id: 'storyboard', label: '拆分镜', description: '每个镜头生成一个独立文本节点', instruction: '结合全部参考把故事拆成独立、连续的镜头，每个镜头分别描述场景、景别、构图、人物行动、镜头运动、对白、声音和建议时长。一场戏可包含多个镜头，保持叙事与人物特征连续。' },
  { id: 'extract', label: '提取素材', description: '整理角色、场景和道具描述', instruction: '从全部参考中提取角色、场景和道具，分别整理名称、描述与创作特征；区分原文事实与补充建议。只输出可编辑文本，不创建素材或制作台。' },
] as const;

/** Called after autosave: original image identities and fully expanded text are frozen together. */
export function buildScriptInput(nodeId: string, graph: PromptGraph): ScriptInput {
  const node = graph.nodes.find(n => n.id === nodeId);
  if (!node) throw new Error('脚本节点不存在');
  const data = node.data as NodeData;
  const preset = scriptPresets.find(p => p.id === data.scriptPreset) || scriptPresets[0];
  const references: ScriptInput['references'] = [];
  const seen = new Set<string>();
  for (const edge of graph.edges.filter(e => e.target === nodeId)) {
    if (seen.has(edge.source)) continue;
    seen.add(edge.source);
    const source = graph.nodes.find(n => n.id === edge.source);
    if (!source) throw new Error('连接的参考节点已不存在');
    const label = nodeName(source.data);
    if (source.data.type === 'text') references.push({ nodeId: source.id, label, type: 'text', content: expandPrompt(source.id, graph) });
    else {
      const images = referenceMaterials(nodeId, graph).filter(m => m.source === source.id);
      if (!images.length || source.data.type === 'script') throw new Error(`参考「${label}」没有可读取的文本或原始图片`);
      for (const image of images) references.push({ nodeId: source.id, label, type: 'image', content: image.src });
    }
  }
  return { model: data.model || 'deepseek-v4-pro-ga-260813', requirements: expandPrompt(nodeId, graph),
    instruction: data.scriptInstruction ?? preset.instruction, preset: preset.id, references, ...(preset.id === 'storyboard' ? { outputMode: 'shots' as const } : {}) };
}

export function scriptPrompt(input: ScriptInput): string {
  let image = 0;
  return [input.instruction, ...input.references.map((ref, index) => `参考 ${index + 1}「${ref.label}」${ref.type === 'text' ? ':\n' + ref.content : `（图片${++image}）`}`), input.requirements.trim() ? `创作要求：\n${input.requirements}` : '', input.outputMode === 'shots' ? '输出格式要求：按独立、连续的镜头拆分，不要以一整场戏代替一个镜头。每个镜头必须以独占一行的“## 镜头 001｜简短标题”开头，编号从 001 连续递增，标题后换行写正文。每个镜头分别写清场景、景别与构图、人物行动、镜头运动、对白、声音和建议时长。人物与场景描述应足够独立，便于该镜头单独生成视频。不要使用代码块、表格、开场说明或结尾总结；不要在正文中使用同格式的镜头标题。' : ''].filter(Boolean).join('\n\n');
}
