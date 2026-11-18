'use client';

import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
  useExternalStoreRuntime,
  type AppendMessage,
  type TextMessagePartProps,
  type ThreadMessageLike,
  type ToolCallMessagePartProps,
} from '@assistant-ui/react';
import { ArrowDown, ArrowUp, Check, ChevronRight, Copy, FileText, ImagePlus, Loader2, RotateCcw, Square, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { BrandMark } from '@/components/ui/brand-mark';
import type { AgentMessage, AgentReference, AgentTask } from '@/lib/agent/types';
import type { SkillSummary } from '@/lib/agent/skills';
import { AgentComposerEditor, sameSkillSelection } from './AgentComposerEditor';
import styles from './AgentSidebar.module.css';

const skillDirective = /\[\[skill:([^|\]]+)\|([^\]]+)\]\]/g;
const emptyReferences: AgentReference[] = [];

function messageStatus(task?: AgentTask): ThreadMessageLike['status'] {
  if (!task) return { type: 'complete', reason: 'unknown' };
  if (task.status === 'failed') return { type: 'incomplete', reason: 'error', error: task.error };
  if (task.status === 'stopped') return { type: 'incomplete', reason: 'cancelled' };
  if (task.status === 'waiting') return { type: 'requires-action', reason: 'interrupt' };
  if (task.status === 'queued' || task.status === 'running' || task.status === 'interrupted') return { type: 'running' };
  return { type: 'complete', reason: 'stop' };
}

function toolParts(task?: AgentTask) {
  return (task?.steps ?? []).map(step => ({
    type: 'tool-call' as const,
    toolCallId: step.id,
    toolName: step.name,
    argsText: JSON.stringify(step.args),
    ...(step.status === 'completed' ? { result: step.result ?? { ok: true } } : {}),
    ...(step.status === 'failed' ? { result: step.result ?? { error: '工具执行失败' }, isError: true } : {}),
  }));
}

function threadMessages(messages: AgentMessage[], tasks: AgentTask[]): ThreadMessageLike[] {
  const byTask = new Map(tasks.map(task => [task.id, task]));
  const latestByTask = new Map<string, AgentMessage>();
  for (const message of messages) latestByTask.set(message.taskId, message);
  const converted = messages.map(message => {
    const task = byTask.get(message.taskId);
    const tools = message.role === 'assistant' && latestByTask.get(message.taskId)?.id === message.id ? toolParts(task) : [];
    return {
      id: message.id,
      role: message.role,
      createdAt: new Date(message.createdAt),
      status: message.role === 'assistant' ? messageStatus(task) : undefined,
      content: [...tools, { type: 'text' as const, text: message.text }] as Exclude<ThreadMessageLike['content'], string>,
      metadata: { custom: { references: message.references, taskId: message.taskId } },
    } satisfies ThreadMessageLike;
  });
  for (const task of tasks) {
    if (latestByTask.get(task.id)?.role === 'assistant' || (!task.steps.length && task.status !== 'failed')) continue;
    converted.push({
      id: `task-status-${task.id}`,
      role: 'assistant',
      createdAt: new Date(task.createdAt),
      status: messageStatus(task),
      content: [
        ...toolParts(task),
        ...(task.error ? [{ type: 'text' as const, text: task.error }] : []),
      ] as Exclude<ThreadMessageLike['content'], string>,
      metadata: { custom: { taskId: task.id, references: [] } },
    });
  }
  return converted;
}

function SkillText({ text }: TextMessagePartProps) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(skillDirective)) {
    if (match.index! > cursor) parts.push(text.slice(cursor, match.index));
    parts.push(<span className={styles.skillChip} key={`${match.index}-${match[1]}`}>技能：{match[2]}</span>);
    cursor = match.index! + match[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <p>{parts}</p>;
}

function ToolCall({ toolName, result, isError }: ToolCallMessagePartProps) {
  const state = result === undefined ? '执行中' : isError ? '失败' : '已完成';
  return <details aria-label="工具调用" className={styles.toolCall} data-error={isError || undefined}>
    <summary><ChevronRight aria-hidden="true" className={styles.toolDisclosure} size={13}/>{result === undefined ? <Loader2 size={13} className="animate-spin"/> : isError ? <X size={13}/> : <Check size={13}/>}<span>{toolName}</span><small>{state}</small></summary>
    {result !== undefined ? <pre aria-label="工具结果" className={styles.toolResult}>{JSON.stringify(result, null, 2)}</pre> : null}
  </details>;
}

function ChatMessage() {
  const role = useAuiState(state => state.message.role);
  const createdAt = useAuiState(state => state.message.createdAt);
  const references = useAuiState(state => (state.message.metadata.custom?.references as AgentReference[] | undefined) ?? emptyReferences);
  return <MessagePrimitive.Root className={role === 'user' ? styles.userMessage : styles.assistantMessage}>
    <div className={styles.messageLabel}>
      {role === 'assistant' ? <BrandMark size={16}/> : null}<span>{role === 'user' ? '你' : '创作助手'}</span>
      <time dateTime={createdAt.toISOString()}>{createdAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
    </div>
    <div className={styles.messageBody}>
      <MessagePrimitive.Parts components={{ Text: SkillText, tools: { Fallback: ToolCall } }}/>
      {references.length > 0 ? <div className={styles.references}>{references.map((reference, index) => <span key={index}>{reference.nodeId ? <FileText size={12}/> : <ImagePlus size={12}/>}参考：{reference.name || reference.nodeId || '图片'}</span>)}</div> : null}
    </div>
    <ActionBarPrimitive.Root className={styles.messageActions}>
      <ActionBarPrimitive.Copy aria-label="复制消息" title="复制消息"><Copy size={12}/><span>复制</span></ActionBarPrimitive.Copy>
      {role === 'assistant' ? <ActionBarPrimitive.Reload aria-label="重试消息" title="重试消息"><RotateCcw size={12}/><span>重试</span></ActionBarPrimitive.Reload> : null}
    </ActionBarPrimitive.Root>
  </MessagePrimitive.Root>;
}

function EmptyThread({ onStart }: { onStart: (prompt: string) => void }) {
  const aui = useAui();
  const starters = [
    { title: '写一个故事', detail: '把灵感展开成完整剧本', prompt: '帮我写一个故事剧本：' },
    { title: '拆解成分镜', detail: '将故事转化为镜头与画面', prompt: '帮我把画布中的剧本拆解成分镜。' },
    { title: '构思一组画面', detail: '一起探索主题、风格与构图', prompt: '帮我构思一组画面的主题、风格和构图：' },
  ];
  return <div className={styles.empty}>
    <span className={styles.welcomeIcon}><BrandMark size={40}/></span><span className={styles.eyebrow}>你的画布创作伙伴</span><h2>今天，想创作什么？</h2><p>聊聊你的想法，或引用画布中的素材。<br/>我们可以从一个故事、一组分镜开始。</p>
    <div className={styles.starters}>{starters.map(item => <button key={item.title} onClick={() => { aui.composer.setText(item.prompt); onStart(item.prompt); }}><span><strong>{item.title}</strong><small>{item.detail}</small></span><ArrowUp size={15}/></button>)}</div>
  </div>;
}

function RichComposerInput({ disabled, focusRequest, onSkillsChange, selectedSkills, skills, waiting }: {
  disabled: boolean;
  focusRequest: number;
  onSkillsChange: (skills: SkillSummary[]) => void;
  selectedSkills: SkillSummary[];
  skills: SkillSummary[];
  waiting: boolean;
}) {
  const aui = useAui();
  const text = useAuiState(state => state.composer.text);
  return <AgentComposerEditor
    disabled={disabled}
    focusRequest={focusRequest}
    onChange={next => {
      if (next.text !== text) aui.composer.setText(next.text);
      onSkillsChange(next.skills);
    }}
    onSubmit={() => sendRichComposer(aui, text, selectedSkills)}
    selectedSkills={selectedSkills}
    skills={skills}
    value={text}
    waiting={waiting}
  />;
}

function sendRichComposer(aui: ReturnType<typeof useAui>, text: string, selectedSkills: SkillSummary[]) {
  if (text.trim()) aui.composer.send();
  else if (selectedSkills.length) aui.thread.append({ role: 'user', content: [{ type: 'text', text: '' }] });
}

function RichComposerSend({ busy, selectedSkills, waiting }: { busy: boolean; selectedSkills: SkillSummary[]; waiting: boolean }) {
  const aui = useAui();
  const text = useAuiState(state => state.composer.text);
  const canSend = useAuiState(state => state.composer.canSend);
  const threadBlocked = useAuiState(state => state.thread.isDisabled || state.thread.isSendDisabled);
  const enabled = !busy && (canSend || (selectedSkills.length > 0 && !threadBlocked));
  const label = waiting ? '回答 / 修改' : '发送';
  return <button
    aria-label={label}
    title={label}
    className={styles.send}
    disabled={!enabled}
    onClick={() => sendRichComposer(aui, text, selectedSkills)}
    type="button"
  >{busy ? <Loader2 size={17} className="animate-spin"/> : <ArrowUp size={18}/>}</button>;
}

type Props = {
  messages: AgentMessage[];
  tasks: AgentTask[];
  task?: AgentTask;
  skills: SkillSummary[];
  waiting: boolean;
  busy: boolean;
  uploading: boolean;
  error: string;
  references: AgentReference[];
  onRemoveReference: (index: number) => void;
  onSubmit: (text: string) => Promise<void>;
  onRetry: (parentId: string | null) => Promise<void>;
  onStop: () => Promise<void>;
  onResume: () => Promise<void>;
  statusContent: ReactNode;
  picker: ReactNode;
  referenceTools: ReactNode;
  modelControl: ReactNode;
};

function textOf(message: AppendMessage) {
  return message.content.filter(part => part.type === 'text').map(part => part.text).join('');
}

export function AgentAssistantUI(props: Props) {
  const [selectedSkills, setSelectedSkills] = useState<SkillSummary[]>([]);
  const [focusRequest, setFocusRequest] = useState(0);
  const messages = useMemo(() => threadMessages(props.messages, props.tasks), [props.messages, props.tasks]);
  const running = props.task ? ['queued', 'running'].includes(props.task.status) : false;
  const waitingOrInterrupted = props.task ? ['waiting', 'interrupted'].includes(props.task.status) : false;
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: message => message,
    isRunning: running,
    canResume: props.task?.status === 'interrupted',
    isSendDisabled: props.busy || props.uploading,
    onNew: async message => {
      const directives = selectedSkills.map(skill => `[[skill:${skill.id}|${skill.name}]]`).join(' ');
      await props.onSubmit([directives, textOf(message).trim()].filter(Boolean).join(' '));
      setSelectedSkills([]);
    },
    onReload: async parentId => props.onRetry(parentId),
    onCancel: props.onStop,
    onResume: async () => props.onResume(),
  });
  return <AssistantRuntimeProvider runtime={runtime}>
    <ThreadPrimitive.Root className={styles.assistantThread}>
      <ThreadPrimitive.Viewport className={styles.messages} aria-label="助手消息" autoScroll>
        <ThreadPrimitive.Empty><EmptyThread onStart={() => setFocusRequest(request => request + 1)}/></ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages components={{ UserMessage: ChatMessage, AssistantMessage: ChatMessage }}/>
        {props.statusContent}
      </ThreadPrimitive.Viewport>
      <ThreadPrimitive.ScrollToBottom className={styles.jump}><ArrowDown size={13}/>回到最新消息</ThreadPrimitive.ScrollToBottom>
      <footer className={styles.footer}>
        {props.picker}
        {props.task?.status === 'interrupted' ? <ComposerPrimitive.Resume className={styles.resume}>继续创作 <ArrowUp size={14}/></ComposerPrimitive.Resume> : null}
        {props.error ? <p role="alert" className={styles.error}>{props.error}</p> : null}
        <ComposerPrimitive.Root className={styles.composer}>
          {props.references.length > 0 ? <div className={styles.references}>{props.references.map((reference, index) => <button key={index} aria-label={`参考：${reference.name || reference.nodeId} ×`} title="移除参考" onClick={() => props.onRemoveReference(index)}><ImagePlus size={12}/><span>参考：{reference.name || reference.nodeId}</span><X size={12}/></button>)}</div> : null}
          {props.uploading ? <p role="status" className={styles.hint}>正在保存参考图…</p> : null}
          <RichComposerInput
            disabled={props.uploading}
            focusRequest={focusRequest}
            onSkillsChange={next => setSelectedSkills(current => sameSkillSelection(current, next) ? current : next)}
            selectedSkills={selectedSkills}
            skills={props.skills}
            waiting={props.waiting}
          />
          {props.referenceTools}
          <div className={styles.composerBottom}>{props.modelControl}<div className={styles.actions}>
            {running ? <ComposerPrimitive.Cancel aria-label="停止" title="停止" disabled={props.busy}><Square size={14}/></ComposerPrimitive.Cancel> : null}
            {waitingOrInterrupted ? <button type="button" aria-label="停止" title="停止" disabled={props.busy} onClick={() => void props.onStop()}><Square size={14}/></button> : null}
            <RichComposerSend busy={props.busy || props.uploading} selectedSkills={selectedSkills} waiting={props.waiting}/>
          </div></div>
        </ComposerPrimitive.Root>
        <p className={styles.keyboardHint}>Enter 发送 · Shift + Enter 换行 · / 或 $ 选择技能</p>
      </footer>
    </ThreadPrimitive.Root>
  </AssistantRuntimeProvider>;
}
