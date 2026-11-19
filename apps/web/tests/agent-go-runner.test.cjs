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
