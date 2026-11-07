import type { ScriptTask } from './types';

export function hasScriptShotHeading(text: string): boolean {
  return /^## 镜头 \d+[^\r\n]*\r?\n/m.test(text);
}

/** A heading is a boundary only once its newline arrives, even across streaming chunks. */
export function splitScriptShots(text: string): string[] {
  const headings = [...text.matchAll(/^## 镜头 \d+[^\r\n]*\r?\n/gm)];
  if (!headings.length) return [text];
  return headings.map((heading, index) => text.slice(index === 0 ? 0 : heading.index, headings[index + 1]?.index).trimEnd());
}

export function scriptOutputIds(task: ScriptTask): string[] {
  if (!task.outputNodeId) return [];
  const count = task.input.outputMode === 'shots' ? splitScriptShots(task.text).length : 1;
  return Array.from({ length: count }, (_, index) => index ? `${task.outputNodeId}-shot-${index + 1}` : task.outputNodeId!);
}

export function scriptOutputText(task: ScriptTask, nodeId: string): string {
  const index = scriptOutputIds(task).indexOf(nodeId);
  if (index < 0) return '';
  return task.input.outputMode === 'shots' ? splitScriptShots(task.text)[index] || '' : task.text;
}
