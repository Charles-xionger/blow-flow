require('../scripts/register-typescript.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSkillTestFixture, skillUploadInput } = require('./helpers/skill-test-fixture.cjs');
const fixture = createSkillTestFixture(test, 'go-runner-skills');
const { GoPiHost } = require('../lib/agent/go-runner-host');
const { GoAgentRunClient } = require('../lib/agent/go-runner-client');
const { uploadSkillMarkdown } = fixture.requireApp('lib/agent/skills.ts');

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

test('Go Pi host exposes scoped canvas tools and waits before editing existing content', async () => {
  const node = { id: 'old', type: 'text', position: { x: 0, y: 0 }, data: { type: 'text', label: 'Original' } };
  const snapshot = { name: 'Canvas', nodes: [node], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  let questioned;
  let saves = 0;
  const run = { isAlive: () => true, canvas: () => ({ read: async () => ({ snapshot, version: 1 }), deleted: async () => [], receipt: async () => undefined, save: async () => { saves++; return { version: 2 }; } }),
    startStep: async (callId, name) => ({ callId, name, status: 'running', runId: 'run-1' }), finishStep: async () => {},
    question: async value => { questioned = value; } };
  const host = new GoPiHost(run, { id: 'task-1', projectId: 'project-1', runId: 'run-1' });
  const mcp = await host.connectMcp('task-1');
  try {
    const tools = (await mcp.client.listTools()).tools;
    assert.ok(tools.some(tool => tool.name === 'delete_canvas_nodes'));
    assert.ok(tools.some(tool => tool.name === 'canvas_models'));
    assert.ok(tools.find(tool => tool.name === 'edit_canvas').inputSchema.properties.operations.items.oneOf);
    const result = await mcp.client.callTool({ name: 'edit_canvas', arguments: { _callId: 'edit-old', operations: [{ kind: 'update', id: 'old', data: { label: 'Changed' } }] } });
    assert.equal(JSON.parse(result.content[0].text).waiting, true);
    assert.deepEqual(questioned.scope, { kind: 'edit', ids: ['old'] });
    assert.equal(saves, 0);
  } finally { await mcp.close(); }
});

test('Go Pi host keeps a denied edit untouched and applies an approved deletion once', async () => {
  const node = { id: 'old', type: 'text', position: { x: 0, y: 0 }, data: { type: 'text', label: 'Original' } };
  let snapshot = { name: 'Canvas', nodes: [node], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  let version = 1;
  let saves = 0;
  const store = { read: async () => ({ snapshot, version }), deleted: async () => [], receipt: async () => undefined,
    save: async (_project, _request, base, next, operations) => { assert.equal(base, version); assert.equal(operations[0].kind, 'delete'); saves++; snapshot = next; return { version: ++version }; } };
  const run = { isAlive: () => true, canvas: () => store,
    startStep: async (callId, name) => ({ callId, name, status: 'running', runId: 'run-1' }), finishStep: async () => {} };
  const task = { id: 'task-1', projectId: 'project-1', runId: 'run-1', question: { id: 'question', scope: { kind: 'edit', ids: ['old'] }, answer: '改为新建节点' } };
  const host = new GoPiHost(run, task);
  const mcp = await host.connectMcp('task-1');
  try {
    const denied = await mcp.client.callTool({ name: 'edit_canvas', arguments: { _callId: 'denied', operations: [{ kind: 'update', id: 'old', data: { label: 'Changed' } }] } });
    assert.equal(JSON.parse(denied.content[0].text).cancelled, true);
    assert.equal(saves, 0);
    task.question = { id: 'delete-question', scope: { kind: 'delete', ids: ['old'] }, answer: '确认删除' };
    const removed = await mcp.client.callTool({ name: 'delete_canvas_nodes', arguments: { _callId: 'remove', ids: ['old'] } });
    assert.equal(JSON.parse(removed.content[0].text).version, 2);
    assert.deepEqual(snapshot.nodes, []);
    assert.equal(saves, 1);
  } finally { await mcp.close(); }
});

test('Go Pi host discovers a newly uploaded skill and reads its instructions on demand', async () => {
  const run = {
    isAlive: () => true,
    startStep: async (callId, name, args) => ({ callId, name, arguments: args, status: 'running', runId: 'run-1' }),
    finishStep: async () => {},
  };
  const host = new GoPiHost(run, { id: 'task-1', projectId: 'project-1', runId: 'run-1' });
  const mcp = await host.connectMcp('task-1');
  try {
    const available = await mcp.client.listTools();
    assert.ok(available.tools.some(tool => tool.name === 'discover_skills'));
    assert.ok(available.tools.some(tool => tool.name === 'read_skill'));
    assert.equal(host.listSkillDescriptions().some(skill => skill.id === 'fresh-skill'), false);
    uploadSkillMarkdown(skillUploadInput('---\nname: fresh-skill\ndescription: Compose short scenes.\n---\n\n# Fresh Skill\n\nWrite three beats.'));
    const discovered = await mcp.client.callTool({ name: 'discover_skills', arguments: { _callId: 'discover-1' } });
    assert.ok(JSON.parse(discovered.content[0].text).some(skill => skill.id === 'fresh-skill'));
    const read = await mcp.client.callTool({ name: 'read_skill', arguments: { _callId: 'read-1', id: 'fresh-skill' } });
    assert.match(JSON.parse(read.content[0].text), /Write three beats/);
  } finally { await mcp.close(); }
});

test('first Agent turn includes only skill descriptions; later turns use discovery tools', () => {
  const { guideForTurn, AGENT_GUIDE } = fixture.requireApp('lib/agent/guide.ts');
  const skill = { id: 'fresh-skill', name: 'Fresh', description: 'Compose short scenes.' };
  const first = guideForTurn(1, [skill]);
  assert.match(first, /Compose short scenes/);
  assert.match(first, /discover_skills/);
  assert.doesNotMatch(first, /Write three beats/);
  assert.equal(guideForTurn(2, [skill]), AGENT_GUIDE);
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
