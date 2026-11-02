require('../scripts/register-typescript.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { expandPrompt, promptIsEmpty, promptSegments, promptText, referenceImages, upstreamNodes } = require('../lib/canvas/prompt.ts');

test('an old prompt string reads as one text segment and an absent prompt as none', () => {
  assert.deepEqual(promptSegments('一朵花'), [{ text: '一朵花' }]);
  assert.deepEqual(promptSegments(''), []);
  assert.deepEqual(promptSegments(undefined), []);
});

test('saved segments read back unchanged', () => {
  const saved = [{ text: '一朵' }, { ref: 'upstream' }, { text: '花' }];
  assert.deepEqual(promptSegments(saved), saved);
});

test('the text to send joins text segments in order, keeping line breaks', () => {
  assert.equal(promptText([{ text: '第一行\n' }, { text: '第二行' }]), '第一行\n第二行');
  assert.equal(promptText('一朵花'), '一朵花');
});

test('a prompt that expands to nothing but whitespace is empty, so it cannot run', () => {
  assert.equal(promptIsEmpty([{ text: ' \n ' }]), true);
  assert.equal(promptIsEmpty(undefined), true);
  assert.equal(promptIsEmpty([]), true);
  assert.equal(promptIsEmpty([{ text: ' 花 ' }]), false);
});

const text = (id, prompt, extra = {}) => ({ id, data: { type: 'text', label: id, prompt, ...extra } });
const character = (id, name, referenceImages) => ({ id, data: { type: 'character', label: name, characterData: { name, referenceImages } } });
const original = (id, imageSrc) => ({ id, data: { type: 'originalImage', label: id, imageSrc } });
const target = prompt => ({ id: 'target', data: { type: 'textToImage', label: '文生图', prompt } });
const link = (...sources) => sources.map(source => ({ source, target: 'target' }));

test('upstream nodes number reference material by connection order, and text is not numbered', () => {
  const graph = { nodes: [target([]), original('b', 'b.png'), text('t', '花园', { customTitle: '场景' }), original('a', 'a.png')], edges: link('a', 't', 'b') };
  assert.deepEqual(upstreamNodes('target', graph), [
    { id: 'a', kind: 'image', label: '图片1', name: 'a', src: 'a.png' },
    { id: 't', kind: 'text', label: '场景', name: '场景' },
    { id: 'b', kind: 'image', label: '图片2', name: 'b', src: 'b.png' },
  ]);
});

test('a character counts as image material, and numbers stay true to the images actually sent', () => {
  const graph = { nodes: [target([]), character('c', '小明', ['1.png', '2.png']), original('a', 'a.png')], edges: link('c', 'a') };
  assert.deepEqual(upstreamNodes('target', graph).map(node => node.label), ['图片1', '图片3']);
  assert.deepEqual(referenceImages('target', graph), ['1.png', '2.png', 'a.png']);
});

test('an image node with no result is not material and keeps its name', () => {
  const graph = { nodes: [target([{ ref: 'empty' }]), original('empty', undefined), original('a', 'a.png')], edges: link('empty', 'a') };
  assert.deepEqual(upstreamNodes('target', graph).map(node => node.label), ['empty', '图片1']);
  assert.equal(expandPrompt('target', graph), 'empty');
  assert.deepEqual(referenceImages('target', graph), ['a.png']);
});

test('expanding sends handwritten text with image numbers and the current upstream text', () => {
  const graph = { nodes: [target([{ text: '参考' }, { ref: 'a' }, { text: '画' }, { ref: 't' }]), original('a', 'a.png'), text('t', '花园')], edges: link('a', 't') };
  assert.equal(expandPrompt('target', graph), '参考图片1画花园');
});

test('unreferenced material is still used, and unreferenced text is not sent', () => {
  const graph = { nodes: [target('手写'), original('a', 'a.png'), text('t', '花园')], edges: link('a', 't') };
  assert.equal(expandPrompt('target', graph), '手写');
  assert.deepEqual(referenceImages('target', graph), ['a.png']);
});

test('upstream text expands level by level, and the same text may be referenced twice', () => {
  const graph = { nodes: [target([{ ref: 'outer' }, { text: '/' }, { ref: 'inner' }]), text('outer', [{ text: '外' }, { ref: 'inner' }]), text('inner', '内')],
    edges: [...link('outer', 'inner'), { source: 'inner', target: 'outer' }] };
  assert.equal(expandPrompt('target', graph), '外内/内');
});

test('a reference cycle ends at the name of the repeated node', () => {
  const graph = { nodes: [target([{ ref: 'a' }]), text('a', [{ text: 'A' }, { ref: 'b' }], { customTitle: 'a' }), text('b', [{ text: 'B' }, { ref: 'a' }], { customTitle: 'b' })],
    edges: [...link('a'), { source: 'b', target: 'a' }, { source: 'a', target: 'b' }] };
  assert.equal(expandPrompt('target', graph), 'ABa');
});

test('a reference to a node that is no longer connected sends nothing', () => {
  const graph = { nodes: [target([{ text: '花' }, { ref: 'gone' }]), text('gone', '不发送')], edges: [] };
  assert.equal(expandPrompt('target', graph), '花');
});

test('a character with no reference images falls back to its own image', () => {
  const graph = { nodes: [target([]), { id: 'c', data: { type: 'character', label: '小明', imageSrc: 'own.png', characterData: { referenceImages: [] } } }], edges: link('c') };
  assert.deepEqual(referenceImages('target', graph), ['own.png']);
});
