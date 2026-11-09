import type { TextGenerationInput } from '../../ai-services/text';
import { TextStreamError } from '../../ai-services/text/stream-types';
import { abortableStream } from '../abortable-stream';
import { defaultStoryboardLimits } from '../storyboard';
import type { ScriptInput } from '../types';
import { assetsPrompt, detailsPrompt, planPrompt } from './prompts';
import { assemblePrompts, parseStepJSON, validateAssets, validateDetails, validatePlan, WorkflowError } from './outputs';
import type { StoryboardWorkflow } from './types';

interface Execution {
  input: ScriptInput; images: string[]; signal: AbortSignal;
  stream: (input: TextGenerationInput) => AsyncIterable<string>;
  read: () => StoryboardWorkflow;
  update: (change: (workflow: StoryboardWorkflow) => void, allowStopping?: boolean) => void;
}

/** Fixed workflow. Each validated result is committed before a dependent step can start. */
export async function runStoryboardWorkflow(execution: Execution) {
  const { input, signal, read, update } = execution;
  async function step<T>(key: string, prompt: string, validate: (value: unknown) => T, commit: (state: StoryboardWorkflow, value: T) => void) {
    signal.throwIfAborted();
    if (read().steps.find(item => item.key === key)?.status === 'completed') return;
    update(state => {
      const item = state.steps.find(item => item.key === key)!;
      Object.assign(item, { status: 'running', attempts: item.attempts + 1, startedAt: Date.now(), finishedAt: undefined, error: undefined, draft: '', phase: 'connecting' });
    });
    const label = read().steps.find(item => item.key === key)!.label;
    const local = new AbortController();
    const combined = AbortSignal.any([signal, local.signal]);
    const timeout = (message: string) => local.abort(new WorkflowError(`${label}：${message}，已保存的步骤保留，可继续执行`));
    const totalTimer = setTimeout(() => timeout('单次执行超过 120 秒'), 120_000);
    const firstTimer = setTimeout(() => timeout('60 秒内未收到正文'), 60_000);
    const connectTimer = setTimeout(() => timeout('连接超过 20 秒'), 20_000);
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let raw = ''; let lastSaved = 0; let phase = 'connecting';
    const persistDraft = () => {
      update(state => { state.steps.find(item => item.key === key)!.draft = raw; });
      lastSaved = Date.now();
    };
    try {
      for await (const delta of abortableStream(execution.stream({ model: input.model, prompt,
        // Each step has a bounded JSON contract; provider-default deep thinking can
        // exhaust the first-body deadline before producing any usable output.
        thinking: 'disabled',
        outputFormat: 'json',
        images: key === 'plan' || key === 'assets' ? execution.images : [], signal: combined,
        onPhase: next => {
          if (combined.aborted) return;
          if (next !== 'connecting') clearTimeout(connectTimer);
          if (next === phase) return;
          phase = next;
          update(state => { state.steps.find(item => item.key === key)!.phase = next; });
        },
      }), combined)) {
        combined.throwIfAborted();
        if (!delta) continue;
        clearTimeout(connectTimer); clearTimeout(firstTimer); clearTimeout(idleTimer);
        idleTimer = setTimeout(() => timeout('正文输出停滞超过 30 秒'), 30_000);
        raw += delta;
        if (raw.length > 200_000) throw new WorkflowError(`${label}：输出超过大小限制`);
        if (Date.now() - lastSaved >= 500) persistDraft();
      }
      combined.throwIfAborted();
      const value = validate(parseStepJSON(raw));
      update(state => {
        commit(state, value);
        Object.assign(state.steps.find(item => item.key === key)!, { status: 'completed', finishedAt: Date.now(), draft: raw, error: undefined, phase: 'writing' });
      });
    } catch (error) {
      const failure = local.signal.aborted ? local.signal.reason : error;
      const message = failure instanceof WorkflowError || failure instanceof TextStreamError ? failure.message : `${label}连接异常，草稿已保留，可重试该步骤`;
      if (signal.aborted) {
        try { update(state => { Object.assign(state.steps.find(item => item.key === key)!, { status: 'pending', draft: raw.slice(0, 200_000) }); }, true); } catch { /* Expired owners cannot persist late drafts. */ }
      } else {
        update(state => { Object.assign(state.steps.find(item => item.key === key)!, { status: 'failed', finishedAt: Date.now(), draft: raw.slice(0, 200_000), error: message }); });
      }
      throw new WorkflowError(message);
    } finally {
      clearTimeout(totalTimer); clearTimeout(firstTimer); clearTimeout(connectTimer); clearTimeout(idleTimer);
      local.abort();
    }
  }

  await step('plan', planPrompt(input), value => validatePlan(value, input.storyboard ?? defaultStoryboardLimits), (state, plan) => {
    state.plan = plan;
    const batches = [];
    for (let offset = 0; offset < plan.shots.length; offset += 2) batches.push({ key: `details-${offset / 2}`, label: `完善镜头 ${offset + 1}–${Math.min(offset + 2, plan.shots.length)}`, status: 'pending' as const, attempts: 0, shotIds: plan.shots.slice(offset, offset + 2).map(shot => shot.id) });
    state.steps.splice(2, 0, ...batches);
  });
  const plan = read().plan!;
  await step('assets', assetsPrompt(input, plan), value => validateAssets(value, plan), (state, assets) => { state.assets = assets; });

  const batches = read().steps.filter(item => item.key.startsWith('details-') && item.status !== 'completed');
  let next = 0; let failed = false;
  const results = await Promise.allSettled(Array.from({ length: Math.min(2, batches.length) }, async () => {
    while (!failed && next < batches.length) {
      signal.throwIfAborted();
      const batch = batches[next++];
      const shots = plan.shots.filter(shot => batch.shotIds!.includes(shot.id));
      try {
        await step(batch.key, detailsPrompt(input, plan, read().assets!, shots), value => validateDetails(value, shots), (state, details) => {
          for (const detail of details) state.details[detail.id] = detail;
        });
      } catch (error) { failed = true; throw error; }
    }
  }));
  const failure = results.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  signal.throwIfAborted();
  update(state => {
    state.prompts = assemblePrompts(state);
    Object.assign(state.steps.find(item => item.key === 'prompts')!, { status: 'completed', attempts: 1, startedAt: Date.now(), finishedAt: Date.now() });
  });
}
