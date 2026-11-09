require('../scripts/register-typescript.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runStoryboardWorkflow } = require('../lib/script/pipeline/runner');
const { newStoryboardWorkflow } = require('../lib/script/pipeline/types');
const { streamText } = require('../lib/ai-services/text');

for (const model of ['doubao-seed-2-1-pro-260915', 'deepseek-v4-pro-ga-260813']) test(`${model}: storyboard steps request direct answers and complete validated outputs`, async t => {
  const prior = process.env.ARK_API_KEY;
  process.env.ARK_API_KEY = 'test-key';
  t.after(() => { if (prior === undefined) delete process.env.ARK_API_KEY; else process.env.ARK_API_KEY = prior; });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    assert.deepEqual(request.thinking, { type: 'disabled' });
    assert.deepEqual(request.text, { format: { type: 'json_object' } });
    const result = requests.length === 1
      ? { summary: '雨后回家', shots: [{ title: '归家', duration: 15, action: '走进家门', characters: [], scene: '家', props: [] }] }
      : requests.length === 2
        ? { characters: [], scene: [{ name: '家', description: '温暖的客厅' }], props: [] }
        : { shots: [{ id: 'shot-001', visual: '推门入屋', size: '中景', lighting: '暖光', dialogue: '无', sound: '开门声', camera: '跟随' }] };
    return new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: JSON.stringify(result) })}\n\ndata: {"type":"response.completed"}\n\n`);
  });
  const state = newStoryboardWorkflow();
  await runStoryboardWorkflow({ input: { model, requirements: '拆分镜', instruction: '', references: [], storyboard: { duration: 15, maxShots: 1 } }, images: [], signal: new AbortController().signal, stream: streamText, read: () => state, update: fn => fn(state) });
  assert.equal(requests.length, 3);
  assert.ok(state.steps.every(step => step.status === 'completed'));
  assert.match(state.prompts['shot-001'], /推门入屋/);
});

test('ordinary text requests preserve the provider thinking default', async t => {
  const { streamArkText } = require('../lib/ai-services/text/ark');
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(Object.hasOwn(JSON.parse(options.body), 'thinking'), false);
    assert.equal(Object.hasOwn(JSON.parse(options.body), 'text'), false);
    return new Response('data: {"type":"response.output_text.delta","delta":"正文"}\n\ndata: {"type":"response.completed"}\n\n');
  });
  let text = '';
  for await (const delta of streamArkText('doubao-seed-2-1-pro-260915', '写故事', { apiKey: 'test-key' })) text += delta;
  assert.equal(text, '正文');
});
