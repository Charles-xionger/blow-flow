import type { SaveStatus } from './autosave';
export const saveStatusText: Record<SaveStatus, string> = {
  loading: '正在恢复', idle: '尚未保存', saving: '保存中', pending: '已保存到本地，待同步',
  syncing: '同步中', synced: '已同步', 'local-error': '本地保存失败', 'sync-error': '同步失败/冲突',
  recovery: '待选择恢复方式', 'migration-error': '旧草稿迁移失败',
};
