import { historyBatches, operationDetails, type HistorySource } from './history-view';
import type { HistoryOperation } from './history';

export interface HistoryPage {
  name: string;
  version: number;
  total: number;
  batches?: { id: string; label: string; time?: number; status: string; operationCount: number }[];
  operations?: { id: string; kind: HistoryOperation['kind']; time?: number; detailCount: number }[];
  details?: string[];
}
export function historyPage(history: HistorySource | undefined, page: number, batchId?: string, operationId?: string): Omit<HistoryPage, 'name' | 'version'> | undefined {
  const batches = history ? historyBatches(history) : [];
  const start = page * 20;
  if (!batchId) return { total: batches.length, batches: batches.slice(start, start + 20).map(batch => ({
    id: batch.id, label: batch.label, time: batch.time, status: batch.status, operationCount: batch.operations.length,
  })) };
  const batch = batches.find(batch => batch.id === batchId);
  if (!batch) return;
  if (!operationId) return { total: batch.operations.length, operations: batch.operations.slice(start, start + 20).map(op => ({
    id: op.id, kind: op.kind, time: op.time, detailCount: operationDetails(op).length,
  })) };
  const operation = batch.operations.find(op => op.id === operationId);
  if (!operation) return;
  const details = operationDetails(operation);
  return { total: details.length, details: details.slice(start, start + 20) };
}
