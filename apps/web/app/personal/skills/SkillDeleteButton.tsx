'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import styles from './skills.module.css';

export function SkillDeleteButton({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function remove() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/personal/skills', {
        method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '删除失败，请重试');
      setOpen(false);
      router.replace('/personal/skills');
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  return <>
    <button type="button" className={styles.deleteButton} aria-label={`删除 ${name}`} onClick={() => setOpen(true)}><Trash2 size={14} />删除</button>
    <Dialog open={open} onOpenChange={next => { if (!busy) { setOpen(next); if (!next) setError(''); } }}>
      <DialogContent className={styles.deleteDialog} showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>删除创作技能 {name}？</DialogTitle>
          <DialogDescription className={styles.deleteDescription}>
            删除后，{name} 及其全部配套资源会立即从个人技能库、新的技能发现与读取中消失。已记录在助手任务中的历史内容会保留。
          </DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className={styles.deleteError}>{error}</p>}
        <DialogFooter>
          <button type="button" className={styles.cancelButton} disabled={busy} onClick={() => setOpen(false)}>取消</button>
          <button type="button" className={styles.confirmDeleteButton} disabled={busy} onClick={() => void remove()}>
            {busy ? <Loader2 size={14} className={styles.spin} /> : <Trash2 size={14} />}{busy ? '删除中…' : '确认删除'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
