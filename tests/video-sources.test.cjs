require('../scripts/register-typescript.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyNodeChanges } = require('@xyflow/react');
const { createVideoSourcesSelector } = require('../lib/canvas/video-sources.ts');

test('upstream movement preserves the video material subscription, while material, name and edge order changes publish immediately', () => {
  const select = createVideoSourcesSelector('h3');
  let state = { nodes: [
    { id: 'image', position: { x: 0, y: 0 }, data: { imageSrc: 'original.png', label: '图' } },
    { id: 'character', position: { x: 100, y: 0 }, data: { label: '角色', characterData: { referenceImages: ['character.png'] } } },
  ], edges: [{ source: 'image', target: 'h3' }, { source: 'character', target: 'h3' }] };
  const original = select(state);
  state = { ...state, nodes: applyNodeChanges([{ id: 'image', type: 'position', position: { x: 50, y: 50 }, dragging: true }], state.nodes) };
  assert.equal(select(state), original);
  state.nodes = state.nodes.map(n => n.id === 'image' ? { ...n, data: { ...n.data, imageSrc: 'generated.png', customTitle: '新图' } } : n);
  const changed = select(state);
  assert.notEqual(changed, original);
  assert.deepEqual(changed[0], { id: 'image', name: '新图', kind: 'image', url: 'generated.png' });
  assert.equal(changed[1].url, 'character.png');
  state.edges.reverse();
  assert.deepEqual(select(state).map(s => s.id), ['character', 'image']);
  state.nodes = state.nodes.map(n => n.id === 'character' ? { ...n, data: { ...n.data, characterData: { referenceImages: ['new-character.png'] } } } : n);
  assert.equal(select(state)[0].url, 'new-character.png');
  state.edges.pop();
  assert.equal(select(state).length, 1);
  state.nodes = [];
  assert.deepEqual(select(state), []);
});
