import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSuite } from './suite';
test('production storyboard validator satisfies the versioned evaluation cases', () => {
  assert.equal(runSuite().score, 1);
});
test('evaluation gate rejects a broken validator instead of reporting green', () => {
  assert.ok(runSuite(() => true).score < 1);
  assert.ok(runSuite(() => false).score < 1);
});
