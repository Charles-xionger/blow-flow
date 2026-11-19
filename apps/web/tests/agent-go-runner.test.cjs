require('../scripts/register-typescript.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GoPiHost } = require('../lib/agent/go-runner-host');
const { GoAgentRunClient } = require('../lib/agent/go-runner-client');

test('Go Pi host edits canvas through scoped HTTP store without SQLite', async () => {
  let snapshot = { name: 'Canvas', nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  let version = 1;
  const steps = [];
  const store = {
    read: async () => ({ snapshot, version }), deleted: async () => [],
    receipt: async () => undefined,
    save: async (_projectId, _requestId, baseVersion, next, operations) => {
      assert.equal(baseVersion, version);
      assert.equal(operations[0].kind, 'create');
      snapshot = next; version++;
      return { version };
    },
  };
  const run = {
    isAlive: () => true, canvas: () => store,
    startStep: async (callId, name, args) => ({ callId, name, arguments: args, status: 'running', runId: 'run-1' }),
    finishStep: async (callId, status, result) => { steps.push({ callId, status, result }); },
  };
  const host = new GoPiHost(run, { id: 'task-1', projectId: 'project-1', runId: 'run-1' });
  const mcp = await host.connectMcp('task-1');
  try {
    const available = await mcp.client.listTools();
    assert.ok(available.tools.some(tool => tool.name === 'edit_canvas'));
    const result = await mcp.client.callTool({ name: 'edit_canvas', arguments: { _callId: 'edit-1', operations: [{ kind: 'create', node: { id: 'new', type: 'text', data: { type: 'text', label: 'New' } } }] } });
    assert.equal(result.isError, undefined);
    assert.equal(snapshot.nodes[0].id, 'new');
    assert.equal(version, 2);
    assert.equal(steps[0].status, 'completed');
  } finally { await mcp.close(); }
});

test('Go Runner claim uses printable service key and run token scopes follow-up calls', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), authorization: init.headers.Authorization });
    if (String(url).endsWith('/claim')) return new Response(JSON.stringify({ task: { id: 't', projectId: 'p', modelId: 'm', status: 'running', createdAt: new Date().toISOString() }, runId: 'r', token: 'run-token', leaseUntil: new Date().toISOString() }), { status: 200 });
    return new Response(JSON.stringify({ task: { id: 't', projectId: 'p', modelId: 'm', status: 'running', createdAt: new Date().toISOString() }, messages: [], steps: [] }), { status: 200 });
  };
  const client = new GoAgentRunClient('http://api.test/', 'printable-base64-key', fetcher);
  const claimed = await client.claim('t');
  const context = await client.run(claimed.token).context();
  assert.equal(context.task.id, 't');
  assert.deepEqual(calls.map(call => call.authorization), ['Bearer printable-base64-key', 'Bearer run-token']);
});
