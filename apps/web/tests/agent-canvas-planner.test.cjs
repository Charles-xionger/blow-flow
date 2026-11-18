require('../scripts/register-typescript.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planAgentCanvasEdit } = require('../lib/agent/canvas-plan');
const { createCanvasHistory, validateHistory } = require('../lib/canvas/history');

test('Agent canvas operation plan preserves unrelated content and produces undoable history without a database', () => {
  const current = {
    name: '故事',
    nodes: [
      { id: 'a', type: 'text', position: { x: 0, y: 0 }, data: { type: 'text', label: 'A', prompt: '旧稿' } },
      { id: 'b', type: 'text', position: { x: 400, y: 0 }, data: { type: 'text', label: 'B', prompt: '保留' } },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  const planned = planAgentCanvasEdit(current, 'task:call', [
    { kind: 'update', id: 'a', data: { prompt: '新稿' } },
    { kind: 'update', id: 'a', data: { customTitle: '第一幕' } },
  ], '改写剧本');
  assert.equal(planned.snapshot.nodes[0].data.prompt, '新稿');
  assert.equal(planned.snapshot.nodes[1].data.prompt, '保留');
  assert.deepEqual(planned.skipped, []);
  assert.deepEqual(planned.removedNodes, []);
  assert.equal(planned.snapshot.history.undo.length, 1);
  assert.equal(planned.snapshot.history.operations.length, 2);
  let state = { ...planned.snapshot, projectName: planned.snapshot.name, canvasSession: 1 };
  const history = createCanvasHistory(() => state, update => { state = { ...state, ...update }; });
  history.undo();
  assert.equal(state.nodes[0].data.prompt, '旧稿');
  history.redo();
  assert.equal(state.nodes[0].data.customTitle, '第一幕');
  validateHistory(state.history, state);
});
