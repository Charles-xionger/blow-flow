'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileArchive, Loader2, UploadCloud, X } from 'lucide-react';
import { useDropzone, type FileRejection } from 'react-dropzone';
import styles from './skills.module.css';

type UploadResponse = { success: boolean; data?: { id: string }; error?: string };
type Limits = { packageMb: number; fileMb: number; expandedMb: number };

function fileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function SkillUploadForm({ limits }: { limits: Limits }) {
  const router = useRouter();
  const [file, setFile] = useState<File>();
  const [uploading, setUploading] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string }>();
  const packageLimit = Number.isInteger(limits.packageMb) ? limits.packageMb : limits.packageMb.toFixed(1);

  function accept(files: File[]) {
    setFile(files[0]);
    setFeedback(undefined);
  }

  function reject(rejections: FileRejection[]) {
    const tooLarge = rejections.some(rejection => rejection.errors.some(error => error.code === 'file-too-large'));
    setFile(undefined);
    setFeedback({ kind: 'error', text: tooLarge ? `技能包不能超过 ${packageLimit} MB` : '请选择 SKILL.md 或 ZIP 文件' });
  }

  const { getRootProps, getInputProps, isDragActive, isDragReject } = useDropzone({
    accept: {
      'text/markdown': ['.md'],
      'text/plain': ['.md'],
      'application/zip': ['.zip'],
      'application/x-zip-compressed': ['.zip'],
    },
    maxFiles: 1,
    maxSize: Math.floor(limits.packageMb * 1024 * 1024),
    multiple: false,
    disabled: uploading,
    onDropAccepted: accept,
    onDropRejected: reject,
  });

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    setUploading(true);
    setFeedback(undefined);
    try {
      const form = new FormData();
      form.append('file', file);
      const response = await fetch('/api/personal/skills', { method: 'POST', body: form });
      const result = await response.json() as UploadResponse;
      if (!response.ok || !result.success || !result.data) throw new Error(result.error || '上传失败，请重试');
      setFeedback({ kind: 'success', text: `${result.data.id} 上传成功，可立即在所有项目中使用` });
      setFile(undefined);
      router.replace(`/personal/skills?skill=${encodeURIComponent(result.data.id)}`);
      router.refresh();
    } catch (error) {
      setFeedback({ kind: 'error', text: error instanceof Error ? error.message : '上传失败，请重试' });
    } finally {
      setUploading(false);
    }
  }

  return <form className={styles.upload} onSubmit={upload} aria-busy={uploading}>
    <div className={styles.uploadIntro}><h2>上传创作技能</h2><p>支持 SKILL.md 或带配套资源的 ZIP。技能包 {packageLimit} MB、单文件 {limits.fileMb} MB、解压后 {limits.expandedMb} MB；额度可由部署配置调整。</p></div>
    <div className={styles.uploadPicker}>
      <div {...getRootProps({ role: 'button', 'aria-label': '选择或拖放技能包', className: styles.dropzone, 'data-active': isDragActive || undefined, 'data-reject': isDragReject || undefined })}>
        <input {...getInputProps({ 'aria-label': '选择 SKILL.md 或 ZIP' })}/>
        <UploadCloud size={20}/><span>{isDragActive ? '松开即可选择' : '拖放 SKILL.md 或 ZIP'}</span><small>或点击浏览文件</small>
      </div>
      {file ? <div aria-label="已选择文件" className={styles.selectedFile}><FileArchive size={17}/><span><strong>{file.name}</strong><small>{fileSize(file.size)}</small></span><button type="button" aria-label={`移除 ${file.name}`} disabled={uploading} onClick={() => setFile(undefined)}><X size={15}/></button></div> : null}
    </div>
    <button type="submit" className={styles.uploadButton} disabled={!file || uploading}>{uploading ? <><Loader2 size={14} className={styles.spin}/>上传中…</> : '上传技能'}</button>
    {uploading ? <div role="progressbar" aria-label="技能上传进度" className={styles.uploadProgress}><span/></div> : null}
    {feedback ? <p role="status" className={feedback.kind === 'error' ? styles.uploadError : styles.uploadSuccess}>{feedback.text}</p> : null}
  </form>;
}
