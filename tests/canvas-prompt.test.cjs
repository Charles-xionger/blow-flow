require('../scripts/register-typescript.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { promptIsEmpty, promptSegments, promptText } = require('../lib/canvas/prompt.ts');

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
