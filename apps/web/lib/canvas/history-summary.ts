import type { Node, Edge } from '@xyflow/react';
import { canonicalJSON } from './save-protocol';

type Content = { nodes: Node[]; edges: Edge[]; name: string };
const fields: Record<string, string> = {
  label: '名称', customTitle: '标题', prompt: '提示词', model: '模型', type: '类型',
  imageSrc: '图片素材', videoSrc: '视频素材', inputImages: '输入图片', outputArtifacts: '生成素材',
  imageOptions: '图片高级设置', imageReferences: '参考图片', imageReferenceOrder: '图片参考顺序',
  videoReferences: '参考素材', videoReferenceOrder: '参考顺序', videoReferenceAudio: '参考音频',
  aspectRatio: '画幅', resolution: '分辨率', duration: '时长', count: '数量', promptOptimize: '提示词优化',
  generationWidth: '生成宽度', generationHeight: '生成高度', generationSizePreset: '尺寸档位',
  videoResolution: '视频分辨率', videoAspectRatio: '视频画幅', videoDuration: '视频时长', videoInstanceType: '视频模式',
  storyboardShots: '分镜内容', shotCount: '镜头数量', optimizedPrompt: '优化后的提示词',
  characterId: '角色', characterData: '角色内容', displaySize: '显示尺寸', usesGenerationTasks: '生成方式',
};
const title = (node: Node) => String(node.data.customTitle || node.data.label || '节点').slice(0, 80);
// Summaries deliberately contain no URLs, binary media, or unbounded prompt text.
export function historyDetails(before: Content, after: Content): string[] {
  const details: string[] = [];
  if (before.name !== after.name) details.push(`项目名称：${before.name.slice(0, 80)} → ${after.name.slice(0, 80)}`);
  const old = new Map(before.nodes.map(node => [node.id, node]));
  const current = new Set(after.nodes.map(node => node.id));
  for (const node of before.nodes) if (!current.has(node.id)) details.push(`删除「${title(node)}」`);
  for (const node of after.nodes) {
    const previous = old.get(node.id);
    if (!previous) { details.push(`创建「${title(node)}」`); continue; }
    if (previous === node) continue;
    const changed: string[] = [];
    for (const key of new Set([...Object.keys(previous.data), ...Object.keys(node.data)])) {
      if (previous.data[key] === node.data[key] || canonicalJSON(previous.data[key]) === canonicalJSON(node.data[key])) continue;
      const field = fields[key] ?? '内容';
      if (key === 'prompt' || key === 'optimizedPrompt' || ['customTitle', 'model', 'aspectRatio', 'duration', 'resolution', 'shotCount'].includes(key)) {
        const preview = (value: unknown): string => {
          if (Array.isArray(value)) return value.slice(0, 10).map(segment => typeof segment?.text === 'string' ? segment.text.slice(0, 80) : segment?.ref ? '@节点引用' : '').join('').slice(0, 120) || '空';
          return typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 120) : '空';
        };
        changed.push(`${field}：${preview(previous.data[key])} → ${preview(node.data[key])}`);
      } else changed.push(field);
    }
    if (canonicalJSON(previous.position) !== canonicalJSON(node.position)) changed.push('位置');
    if (canonicalJSON(previous.style) !== canonicalJSON(node.style)) changed.push('显示样式或尺寸');
    if (previous.parentId !== node.parentId) changed.push('所属分组');
    if (changed.length) details.push(`「${title(node)}」：${[...new Set(changed)].join('、')}`);
  }
  if (canonicalJSON(before.edges) !== canonicalJSON(after.edges)) {
    const previous = new Map(before.edges.map(edge => [edge.id, edge]));
    const next = new Set(after.edges.map(edge => edge.id));
    const names = new Map([...before.nodes, ...after.nodes].map(node => [node.id, title(node)]));
    const connection = (edge: Edge) => `「${names.get(edge.source) ?? '节点'}」 → 「${names.get(edge.target) ?? '节点'}」`;
    for (const edge of before.edges) if (!next.has(edge.id)) details.push(`断开连线：${connection(edge)}`);
    for (const edge of after.edges) if (!previous.has(edge.id)) details.push(`添加连线：${connection(edge)}`);
    if (before.edges.length === after.edges.length && after.edges.every(edge => previous.has(edge.id))) details.push('调整连线或参考顺序');
  }
  return details;
}
