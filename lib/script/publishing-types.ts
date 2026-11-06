export const textPurposes = { idea:'创意', script:'剧本', storyboard:'分镜文稿', material:'素材描述' } as const;
export type TextPurpose = keyof typeof textPurposes;
export interface PublishScript {
  requestId: string; canvasId: string; nodeId: string; versionId: string;
  expectedDraftRevision: number; purpose: TextPurpose; mode: 'new' | 'update';
  targetId?: string; reviewedTargetRevision?: string;
}
export interface PublishTarget { id: string; text: string; revision: string; changed: boolean; deleted: boolean }
export interface PublishResult { targetId: string; version: number }
