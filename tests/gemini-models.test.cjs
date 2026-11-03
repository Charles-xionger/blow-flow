require('../scripts/register-typescript.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getModelsByCategory, getImageModels, getModelDefinition } = require('../lib/model-registry.ts');

// IDs verified against Google's model catalog on 2026-11-03.
test('current Gemini models can be selected and old project selections still resolve', () => {
  const textModels = getModelsByCategory('TEXT');
  assert.equal(textModels[0].id, 'gemini-3.8-flash');
  for (const id of ['gemini-3.8-flash', 'gemini-4-argon']) {
    assert.equal(textModels.find(model => model.id === id)?.provider, 'gemini');
  }
  for (const [name, id] of [
    ['Gemini 3 Flash Preview', 'gemini-3-flash-preview'],
  ]) {
    assert.equal(getModelDefinition(name)?.id, id);
    assert.equal(getModelDefinition(id)?.name, name);
    assert.ok(textModels.some(model => model.name === name));
  }
  assert.equal(getModelDefinition('Gemini 3 Pro Preview')?.id, 'gemini-3.8-flash');
  assert.equal(getModelDefinition('gemini-3-pro-preview')?.id, 'gemini-3.8-flash');
  assert.equal(textModels.some(model => model.name === 'Gemini 3 Pro Preview'), false);
  assert.equal(getModelDefinition('Gemini 2.5 Pro')?.id, 'gemini-3.8-flash');
  assert.equal(getModelDefinition('gemini-2.5-pro')?.id, 'gemini-3.8-flash');
  assert.equal(textModels.some(model => model.name === 'Gemini 2.5 Pro'), false);
  assert.equal(textModels.some(model => /lite/i.test(model.id)), false);
  const imageModels = getImageModels();
  assert.equal(imageModels[0].value, 'Nano Banana 2.1');
  for (const [name, id] of [
    ['Nano Banana 2.1', 'gemini-nano-banana-2.1'],
    ['Nano Banana 2', 'gemini-3.1-flash-image'],
    ['Nano Banana Pro', 'gemini-3-pro-image'],
    ['Nano Banana', 'gemini-2.5-flash-image'],
  ]) {
    assert.ok(imageModels.some(model => model.value === name));
    assert.equal(getModelDefinition(name)?.id, id);
    assert.equal(getModelDefinition(id)?.name, name);
  }
  assert.equal(getModelDefinition('gemini-3-pro-image-preview')?.id, 'gemini-3-pro-image');
  assert.equal(getModelDefinition('BananaPro')?.id, 'banana-pro');
  assert.equal(getModelDefinition('Veo 3.1 Generate Preview')?.id, 'veo-3.1-generate-preview');
  assert.equal(getModelDefinition('unknown-model'), undefined);
});
