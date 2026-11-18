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
} from '@assistant-ui/react';
import { ArrowDown, ArrowUp, Check, ChevronRight, Copy, FileText, ImagePlus, Loader2, RotateCcw, Square, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { BrandMark } from '@/components/ui/brand-mark';
import type { AgentMessage, AgentReference, AgentStep, AgentTask } from '@/lib/agent/types';
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

type ToolActivity = Pick<AgentStep, 'id' | 'name' | 'status'>;
const emptyToolActivities: ToolActivity[] = [];
const legacyRun = Symbol('legacy-run');
type RunKey = string | typeof legacyRun;

function toolActivities(steps: AgentStep[] = []): ToolActivity[] {
  return steps.map(({ id, name, status }) => ({ id, name, status }));
}

function threadMessages(messages: AgentMessage[], tasks: AgentTask[]): ThreadMessageLike[] {
  const byTask = new Map(tasks.map(task => [task.id, task]));
  const latestByTask = new Map<string, AgentMessage>();
  const latestAssistantByRun = new Map<string, Map<string, string>>();
  const consumedRuns = new Map<string, Set<RunKey>>();
  const markRunConsumed = (taskId: string, runKey: RunKey) => {
    const runs = consumedRuns.get(taskId) ?? new Set<RunKey>();
    runs.add(runKey);
    consumedRuns.set(taskId, runs);
  };
  for (const message of messages) {
    latestByTask.set(message.taskId, message);
    if (message.role === 'assistant' && message.runId) {
      const runs = latestAssistantByRun.get(message.taskId) ?? new Map<string, string>();
      runs.set(message.runId, message.id);
      latestAssistantByRun.set(message.taskId, runs);
    }
  }
  const converted = messages.map(message => {
    const task = byTask.get(message.taskId);
    let tools: ToolActivity[] = [];
    if (message.role === 'assistant' && message.runId && latestAssistantByRun.get(message.taskId)?.get(message.runId) === message.id) {
      tools = toolActivities(task?.steps.filter(step => step.runId === message.runId));
      markRunConsumed(message.taskId, message.runId);
    } else if (message.role === 'assistant' && latestByTask.get(message.taskId)?.id === message.id) {
      tools = toolActivities(task?.steps.filter(step => !step.runId));
      if (tools.length) markRunConsumed(message.taskId, legacyRun);
    }
    return {
      id: message.id,
      role: message.role,
      createdAt: new Date(message.createdAt),
      status: message.role === 'assistant' ? messageStatus(task) : undefined,
      content: [{ type: 'text' as const, text: message.text }],
      metadata: { custom: { references: message.references, taskId: message.taskId, tools } },
    } satisfies ThreadMessageLike;
  });
  for (const task of tasks) {
    const groups = new Map<RunKey, AgentStep[]>();
    for (const step of task.steps) {
      const runId = step.runId ?? legacyRun;
      if (consumedRuns.get(task.id)?.has(runId)) continue;
      const group = groups.get(runId) ?? [];
      group.push(step);
      groups.set(runId, group);
    }
    const orphanRuns = [...groups.entries()];
    for (const [runId, steps] of orphanRuns) {
      const latest = latestByTask.get(task.id);
      const createdAt = steps[0].createdAt ?? (runId === legacyRun && latest ? latest.createdAt + 1 : task.createdAt);
      converted.push({
        id: `task-tools-${task.id}-${runId === legacyRun ? 'legacy' : `run-${runId}`}`,
        role: 'assistant',
        createdAt: new Date(createdAt),
        status: messageStatus(task),
        content: task.error && runId === orphanRuns.at(-1)?.[0] ? [{ type: 'text' as const, text: task.error }] : [],
        metadata: { custom: { taskId: task.id, references: [], tools: toolActivities(steps) } },
      });
    }
    if (!orphanRuns.length && latestByTask.get(task.id)?.role !== 'assistant' && task.status === 'failed') {
      const latest = latestByTask.get(task.id);
      converted.push({
        id: `task-status-${task.id}`,
        role: 'assistant',
        createdAt: new Date((latest?.createdAt ?? task.createdAt) + 1),
        status: messageStatus(task),
        content: task.error ? [{ type: 'text' as const, text: task.error }] : [],
        metadata: { custom: { taskId: task.id, references: [], tools: [] } },
      });
    }
  }
  return converted.toSorted((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
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

function ToolStatusIcon({ status }: Pick<ToolActivity, 'status'>) {
  if (status === 'running') return <Loader2 aria-hidden="true" size={13} className="animate-spin"/>;
  if (status === 'failed') return <X aria-hidden="true" size={13}/>;
  return <Check aria-hidden="true" size={13}/>;
}

function ToolActivityGroup({ tools }: { tools: ToolActivity[] }) {
  if (!tools.length) return null;
  const latest = tools.at(-1)!;
  const failed = tools.findLast(tool => tool.status === 'failed');
  const highlighted = failed ?? latest;
  const label = highlighted.status === 'running'
    ? `正在调用 ${highlighted.name}`
    : highlighted.status === 'failed'
      ? `${highlighted.name} 调用失败`
      : `已调用 ${highlighted.name}`;
  return <details aria-label="工具调用" className={styles.toolActivity} data-error={failed ? true : undefined}>
    <summary>
      <ChevronRight aria-hidden="true" className={styles.toolDisclosure} size={13}/>
      <ToolStatusIcon status={highlighted.status}/>
      <span>{label}</span>
      <small>{tools.length} 个调用</small>
    </summary>
    <div aria-label="工具调用列表" role="list">
      {tools.map(tool => <p key={tool.id} role="listitem">
        <ToolStatusIcon status={tool.status}/>
        <span>{tool.name}</span>
        <small>{tool.status === 'running' ? '执行中' : tool.status === 'failed' ? '失败' : '已完成'}</small>
      </p>)}
    </div>
  </details>;
}

function ChatMessage() {
  const role = useAuiState(state => state.message.role);
  const createdAt = useAuiState(state => state.message.createdAt);
  const references = useAuiState(state => (state.message.metadata.custom?.references as AgentReference[] | undefined) ?? emptyReferences);
  const tools = useAuiState(state => (state.message.metadata.custom?.tools as ToolActivity[] | undefined) ?? emptyToolActivities);
  return <MessagePrimitive.Root className={role === 'user' ? styles.userMessage : styles.assistantMessage}>
    <div className={styles.messageLabel}>
      {role === 'assistant' ? <BrandMark size={16}/> : null}<span>{role === 'user' ? '你' : '创作助手'}</span>
      <time dateTime={createdAt.toISOString()}>{createdAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
    </div>
    <div className={styles.messageBody}>
      <ToolActivityGroup tools={tools}/>
      <MessagePrimitive.Parts components={{ Text: SkillText }}/>
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
