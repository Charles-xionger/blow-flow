require('../scripts/register-typescript.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GenerationNotifications } = require('../lib/generation/notifications.ts');
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const task = (id, revision = 0, status = 'running') => ({ id, revision, status, saveStatus: 'pending', artifacts: [] });

test('one canvas shares a stream, reopens with new subscriptions and ignores obsolete connection updates', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const streams = [];
  const client = new GenerationNotifications({
    stream: async (ids, signal, message) => { streams.push({ ids, signal, message }); await new Promise(resolve => signal.addEventListener('abort', resolve)); },
    get: async id => task(id),
  });
  t.after(() => client.close());
  const a = [], b = [];
  const offA = client.subscribe('a', value => a.push(value));
  const offB = client.subscribe('b', value => b.push(value));
  await flush();
  assert.equal(streams.length, 1);
  assert.deepEqual(streams[0].ids.sort(), ['a', 'b']);
  streams[0].message('snapshot', [task('a'), task('b')]);
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  offA();
  await flush();
  assert.equal(streams[0].signal.aborted, true);
  streams[0].message('tasks', [task('b', 9)]);
  streams[1].message('snapshot', [task('b', 1)]);
  assert.equal(b.at(-1).revision, 1);
  offB();
  await flush();
  assert.equal(streams[1].signal.aborted, true);
});

test('15 seconds without a snapshot activates 10 second polling; recovery discards stale in-flight results', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const streams = [], states = [], received = [], pending = [];
  const client = new GenerationNotifications({
    stream: async (ids, signal, message) => { streams.push({ signal, message }); await new Promise(resolve => signal.addEventListener('abort', resolve)); },
    get: async () => new Promise(resolve => pending.push(resolve)),
  }, state => states.push(state));
  t.after(() => client.close());
  client.subscribe('a', value => received.push(value));
  await flush();
  t.mock.timers.tick(14_000); await flush();
  assert.equal(pending.length, 0);
  t.mock.timers.tick(1000); await flush();
  assert.equal(states.at(-1), 'polling');
  assert.equal(pending.length, 1);
  pending[0](task('a', 1)); await flush();
  t.mock.timers.tick(10_000); await flush();
  assert.equal(pending.length, 2);
  streams.at(-1).message('snapshot', [task('a', 3, 'succeeded')]);
  pending[1](task('a', 2)); await flush();
  assert.equal(states.at(-1), 'connected');
  assert.equal(received.at(-1).revision, 3);
  t.mock.timers.tick(10_000); await flush();
  assert.equal(pending.length, 2);
  client.close();
  t.mock.timers.tick(60_000); await flush();
  assert.equal(pending.length, 2);
});

test('failed connections retry without resetting the fallback deadline and stalled streams reconnect', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const streams = [], states = [], received = [];
  let fail = true;
  const client = new GenerationNotifications({
    stream: async (ids, signal, message) => {
      streams.push({ signal, message });
      if (fail) throw new Error('offline');
      await new Promise(resolve => signal.addEventListener('abort', resolve));
    },
    get: async id => task(id, 1, 'succeeded'),
  }, state => states.push(state));
  t.after(() => client.close());
  client.subscribe('a', value => received.push(value));
  await flush();
  for (let i = 0; i < 5; i++) { t.mock.timers.tick(3000); await flush(); }
  assert.equal(states.at(-1), 'polling');
  assert.equal(received.at(-1).status, 'succeeded');
  fail = false;
  t.mock.timers.tick(3000); await flush();
  streams.at(-1).message('snapshot', [task('a', 2, 'succeeded')]);
  assert.equal(states.at(-1), 'connected');
  const old = streams.at(-1);
  t.mock.timers.tick(25_000); await flush();
  assert.equal(old.signal.aborted, true);
  assert.equal(states.at(-1), 'polling');
  streams.at(-1).message('snapshot', [task('a', 2, 'succeeded')]);
  assert.equal(states.at(-1), 'connected');
});

test('saving keeps fallback active, and retrying a terminal task resumes tracking on its original ID', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const streams = [], received = [];
  let queries = 0;
  const client = new GenerationNotifications({
    stream: async (ids, signal, message) => { streams.push({ signal, message }); await new Promise(resolve => signal.addEventListener('abort', resolve)); },
    get: async id => {
      queries++;
      return { ...task(id, queries, 'succeeded'), saveStatus: queries === 1 ? 'saving' : 'saved' };
    },
  });
  t.after(() => client.close());
  client.subscribe('a', value => received.push(value));
  await flush();
  t.mock.timers.tick(15_000); await flush();
  assert.equal(received.at(-1).saveStatus, 'saving');
  t.mock.timers.tick(10_000); await flush();
  assert.equal(received.at(-1).saveStatus, 'saved');
  t.mock.timers.tick(10_000); await flush();
  assert.equal(queries, 2);
  client.refresh('a'); await flush();
  t.mock.timers.tick(10_000); await flush();
  assert.equal(queries, 3);
  assert.equal(received.at(-1).id, 'a');
});
