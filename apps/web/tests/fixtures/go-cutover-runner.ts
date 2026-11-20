import type { AssistantMessage } from '@mariozechner/pi-ai';
import { GoAgentRunClient } from '../../lib/agent/go-runner-client';
import { runGoAgentTask } from '../../lib/agent/go-runner-host';

const [taskId, phase, batchId] = process.argv.slice(2);
const baseURL = process.env.REHEARSAL_GO_URL;
const key = process.env.AGENT_RUNNER_KEY;
if (!taskId || !baseURL || !key || !['prepare', 'finish'].includes(phase)) throw new Error('Disposable rehearsal runner arguments required');
let turn = 0;
const nodes = [
  { id: 'rehearsal-image', type: 'textToImage', data: { type: 'textToImage', prompt: 'A paper city' } },
  { id: 'rehearsal-video', type: 'textToVideo', data: { type: 'textToVideo', prompt: 'A moving paper city' } },
  { id: 'rehearsal-script', type: 'script', data: { type: 'script', prompt: [{ text: 'Write a scene' }] } },
];
async function main() {
const { createAssistantMessageEventStream } = await import('@mariozechner/pi-ai');
await runGoAgentTask(new GoAgentRunClient(baseURL!, key!), taskId, undefined, undefined, {
  apiKey: 'rehearsal-fake-model-key',
  streamFn: model => {
    const stream = createAssistantMessageEventStream();
    turn++;
    let content: AssistantMessage['content'];
    if (phase === 'prepare' && turn === 1) content = [{ type: 'toolCall', id: 'rehearsal-create-nodes', name: 'edit_canvas', arguments: { label: 'Create rehearsal nodes', operations: nodes.map(node => ({ kind: 'create', node })) } }];
    else if (phase === 'prepare' && turn === 2) content = [{ type: 'toolCall', id: 'rehearsal-generate', name: 'prepare_generation', arguments: { items: [
      { nodeId: 'rehearsal-image', modelId: 'runninghub/krea2', input: { prompt: 'A paper city', width: 1024, height: 1024 } },
      { nodeId: 'rehearsal-video', modelId: 'runninghub/h3', input: { prompt: 'A moving paper city', width: 1280, height: 736, duration: 7 } },
    ] } }];
    else if (phase === 'finish' && turn === 1) content = [{ type: 'toolCall', id: 'rehearsal-read-results', name: 'generation_results', arguments: { batchId } }];
    else content = [{ type: 'text', text: 'The paper city image and video are ready.' }];
    const toolUse = content[0]?.type === 'toolCall';
    const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason: toolUse ? 'toolUse' : 'stop', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: 'done', reason: toolUse ? 'toolUse' : 'stop', message });
    return stream;
  },
});
if (phase === 'prepare' && turn < 2) throw new Error(`Pi stream ended before tool chain; turns=${turn}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
