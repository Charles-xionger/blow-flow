require('../scripts/register-typescript.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { imagePresetDimensions, normalizeImageDimension, imageSizeSelection } = require('../lib/generation/image-dimensions.ts');
const limits = { min: 64, max: 8192, step: 8, defaultWidth: 1920, defaultHeight: 1080 };

test('image size presets use the short edge and produce the actual aligned generation dimensions', () => {
  assert.deepEqual(imagePresetDimensions('2k', '16:9', limits), { width: 3640, height: 2048 });
  assert.deepEqual(imagePresetDimensions('1k', '9:16', limits), { width: 1024, height: 1824 });
  assert.deepEqual(imagePresetDimensions('2k', '1:1', limits), { width: 2048, height: 2048 });
  assert.equal(imagePresetDimensions('2k', '16:9', { ...limits, max: 2048 }), null);
});

test('custom dimensions align on commit, restore empty input and do not reinterpret existing sizes', () => {
  assert.equal(normalizeImageDimension('1001', 1920, limits), 1000);
  assert.equal(normalizeImageDimension('', 1920, limits), 1920);
  assert.equal(normalizeImageDimension('invalid', 1920, limits), 1920);
  assert.equal(normalizeImageDimension('9000', 1920, limits), 8192);
  assert.equal(normalizeImageDimension('1', 1920, limits), 64);
  assert.equal(normalizeImageDimension('70', 1920, { ...limits, min: 65 }), 72);
  assert.deepEqual(imageSizeSelection(1920, 1080, limits), { preset: 'custom', ratio: '16:9', label: '16:9' });
  assert.equal(imageSizeSelection(3640, 2048, limits).preset, '2k');
  assert.equal(imageSizeSelection(1024, 1024, limits, 'custom').preset, 'custom');
  assert.equal(imageSizeSelection(1000, 1080, limits).label, '25:27');
});
