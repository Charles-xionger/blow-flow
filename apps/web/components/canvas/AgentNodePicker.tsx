'use client';

import { useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { Check, Crosshair, FileText, Image, Layers, Search, Video, X } from 'lucide-react';
import { useCanvasStore } from '@/store/useCanvasStore';
import type { AgentReference } from '@/lib/agent/types';
import styles from './AgentSidebar.module.css';

export function AgentNodePicker({ references, onChange, close }: {
  references: AgentReference[];
  onChange: (references: AgentReference[]) => void;
  close: () => void;
}) {
  const nodes = useCanvasStore(state => state.nodes);
  const { fitView } = useReactFlow();
  const [query, setQuery] = useState('');
  const visible = nodes.filter(node => `${node.data.customTitle || node.data.label || node.type} ${node.id}`.toLowerCase().includes(query.toLowerCase()));
  const selected = new Set(references.map(ref => ref.nodeId));

  function locate(id: string) {
    const state = useCanvasStore.getState();
    state.onNodesChange(state.nodes.map(node => ({ type: 'select' as const, id: node.id, selected: node.id === id })));
    void fitView({ nodes: [{ id }], duration: 250, padding: 0.6, maxZoom: 1 });
  }

  return <section aria-label="选择画布节点" className={styles.nodePicker}>
    <div className={styles.pickerHeading}><strong>引用画布节点</strong><span>{references.length}/8</span><button aria-label="关闭节点选择" onClick={close}><X size={15}/></button></div>
    <label className={styles.nodeSearch}><Search size={14}/><input autoFocus aria-label="搜索画布节点" placeholder="搜索节点名称…" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') close(); }}/></label>
    <div className={styles.nodeList}>
      {visible.length === 0 && <p>{nodes.length ? '没有匹配的节点' : '画布还没有节点，添加节点后即可引用。'}</p>}
      {visible.map(node => {
        const name = node.data.customTitle || node.data.label || node.type || '节点';
        const checked = selected.has(node.id);
        const Icon = node.type?.toLowerCase().includes('video') ? Video : node.type?.toLowerCase().includes('image') ? Image : node.type === 'group' ? Layers : FileText;
        return <div key={node.id} className={styles.nodeRow}>
          <button role="checkbox" aria-checked={checked} aria-label={name} disabled={!checked && references.length >= 8} onClick={() => onChange(checked ? references.filter(ref => ref.nodeId !== node.id) : [...references, { nodeId: node.id, name }])}>
            <span className={styles.nodeCheck} data-checked={checked}>{checked && <Check size={11}/>}</span><Icon size={16}/><span>{name}<small>{node.selected ? '画布中已选中' : '画布节点'}</small></span>
          </button>
          <button aria-label={`定位节点：${name}`} title="在画布中定位并选中" onClick={() => locate(node.id)}><Crosshair size={15}/></button>
        </div>;
      })}
    </div>
    <div className={styles.pickerFoot}><span>引用的节点会随消息发送给助手</span><button onClick={close}>完成</button></div>
  </section>;
}
