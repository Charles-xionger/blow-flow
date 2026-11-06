'use client';

import { useState } from 'react';
import { Check, Copy, FileText, ImagePlus } from 'lucide-react';
import type { AgentMessage as Message } from '@/lib/agent/types';
import styles from './AgentSidebar.module.css';
import { BrandMark } from '@/components/ui/brand-mark';

export function AgentMessage({ message }: { message: Message }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  async function copy() {
    try { await navigator.clipboard.writeText(message.text); setCopyState('copied'); }
    catch { setCopyState('failed'); }
  }
  return <article className={message.role === 'user' ? styles.userMessage : styles.assistantMessage}>
    <div className={styles.messageLabel}>
      {message.role === 'assistant' && <BrandMark size={16}/>}
      <span>{message.role === 'user' ? '你' : '创作助手'}</span>
      <time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
    </div>
    <div className={styles.messageBody}>
      <p>{message.text}</p>
      {message.references.length > 0 && <div className={styles.references}>{message.references.map((reference, index) => <span key={index}>{reference.nodeId ? <FileText size={12}/> : <ImagePlus size={12}/>}参考：{reference.name || reference.nodeId || '图片'}</span>)}</div>}
    </div>
    <div className={styles.messageActions}><button aria-label="复制消息" title="复制消息" onClick={() => void copy()}>{copyState === 'copied' ? <Check size={12}/> : <Copy size={12}/>}<span>{copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败，请重试' : '复制'}</span></button></div>
  </article>;
}
