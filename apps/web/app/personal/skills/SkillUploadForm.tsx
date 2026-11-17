'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from './skills.module.css';

type UploadResponse = { success: boolean; data?: { id: string }; error?: string };

export function SkillUploadForm() {
  const router = useRouter();
  const [file, setFile] = useState<File>();
  const [uploading, setUploading] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string }>();

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file) {
      setFeedback({ kind: 'error', text: '请先选择 SKILL.md 或 ZIP 文件' });
      return;
    }
    setUploading(true);
    setFeedback(undefined);
    try {
      const form = new FormData();
      form.append('file', file);
      const response = await fetch('/api/personal/skills', { method: 'POST', body: form });
      const result = await response.json() as UploadResponse;
      if (!response.ok || !result.success || !result.data) throw new Error(result.error || '上传失败，请重试');
      setFeedback({ kind: 'success', text: `${result.data.id} 上传成功，可立即在所有项目中使用` });
      router.replace(`/personal/skills?skill=${encodeURIComponent(result.data.id)}`);
      router.refresh();
    } catch (error) {
      setFeedback({ kind: 'error', text: error instanceof Error ? error.message : '上传失败，请重试' });
    } finally {
      setUploading(false);
    }
  }

  return <form className={styles.upload} onSubmit={upload}>
    <div><h2>上传创作技能</h2><p>选择 SKILL.md，或包含该文件与配套资源的 ZIP；包不超过 20 MB，单文件不超过 5 MB。</p></div>
    <label><span>选择 SKILL.md 或 ZIP</span><input type="file" accept=".md,.zip,text/markdown,application/zip" disabled={uploading}
      onChange={event => setFile(event.target.files?.[0])} /></label>
    <button type="submit" disabled={uploading}>{uploading ? '上传中…' : '上传技能'}</button>
    {feedback && <p role="status" className={feedback.kind === 'error' ? styles.uploadError : styles.uploadSuccess}>{feedback.text}</p>}
  </form>;
}
