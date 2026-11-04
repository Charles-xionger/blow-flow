import type { CanvasHistory, HistoryOperation } from './history';

export interface HistoryBatchView {
  id: string;
  label: string;
  time?: number;
  status: string;
  operations: HistoryOperation[];
}
export type HistorySource = Pick<CanvasHistory, 'records' | 'operations' | 'undo' | 'redo'>;
const views = new WeakMap<HistorySource, HistoryBatchView[]>();
/** Index only identities/metadata. Patches and original media are never decoded for viewing. */
export function historyBatches(history: HistorySource): HistoryBatchView[] {
  const cached = views.get(history);
  if (cached) return cached;
  const groups = new Map<string, HistoryBatchView>();
  const records = new Map(history.records.map(record => [record.id, record]));
  for (const operation of history.operations ?? []) {
    const id = operation.batchId ?? operation.id;
    let group = groups.get(id);
    if (!group) {
      const record = records.get(id);
      group = { id, label: record?.label ?? operation.label ?? '编辑', time: operation.time ?? record?.time, status: '', operations: [] };
      groups.set(id, group);
    }
    group.operations.push(operation);
  }
  // Old envelopes may predate the internal operation log.
  for (const record of history.records) if (!groups.has(record.id)) groups.set(record.id, {
    id: record.id, label: record.label, time: record.time, status: '', operations: [],
  });
  const undo = new Set(history.undo), redo = new Set(history.redo);
  for (const group of groups.values()) {
    const last = group.operations.at(-1)?.kind;
    group.status = undo.has(group.id) ? last === 'redo' ? '已重做 · 在撤销序列中' : '已应用 · 在撤销序列中'
      : redo.has(group.id) ? '已撤销 · 可按顺序重做'
      : last === 'undo' ? '已撤销 · 重做分支已失效'
      : !records.has(group.id) ? '无净变更 · 仅供追溯' : '历史记录 · 不在当前撤销序列';
  }
  const result = [...groups.values()].reverse();
  views.set(history, result);
  return result;
}
export function operationDetails(operation: HistoryOperation): string[] {
  if (operation.details) return operation.details;
  // Legacy data has no trustworthy node title/time metadata. Describe affected
  // areas without inventing a timestamp or resolving historical originals.
  const areas = new Set(operation.patches.map(patch => patch.path[0] === 'name' ? '项目名称'
    : patch.path[0] === 'edges' ? '连线或参考顺序' : '节点内容、位置或结构'));
  return [...areas].map(area => `${area}（旧记录）`);
}
