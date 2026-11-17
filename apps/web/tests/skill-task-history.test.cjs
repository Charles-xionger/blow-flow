const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSkillTestFixture, skillUploadInput } = require('./helpers/skill-test-fixture.cjs');
const fixture = createSkillTestFixture(test, 'skill-task-history');
const { AgentService } = fixture.requireApp('lib/agent/service.ts');
const { registerReadTools } = fixture.requireApp('lib/agent/mcp.ts');
const { saveWorkflow } = fixture.requireApp('lib/db/workflows.ts');
const { getDatabase } = fixture.requireApp('lib/db/index.ts');
const { deleteSkill, uploadSkillMarkdown } = fixture.requireApp('lib/agent/skills.ts');

function project(id) {
  saveWorkflow({
    id, requestId: `seed-${id}`, baseVersion: 0,
    snapshot: { name: id, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
  });
}

function upload(instructions, resource) {
  const markdown = `---\nname: durable-skill\ndescription: A durable task skill.\n---\n\n${instructions}`;
  uploadSkillMarkdown(skillUploadInput(markdown, resource ? new Map([['references/guide.md', Buffer.from(resource)]]) : undefined));
}

test('task steps retain read snapshots while deletion fences unread content and same-name uploads', async () => {
  project('read-before-delete');
  project('discover-before-delete');
  project('read-after-reupload');
  upload('Original task instructions.', 'Original task resource.');
  const service = new AgentService(getDatabase());
  registerReadTools(service);

  const readTask = service.send('read-before-delete', { requestId: 'send-read', text: '读取技能', modelId: 'test' });
  await service.runNext(async context => {
    assert.equal(await context.tool('read-instructions', 'read_skill', { id: 'durable-skill' }), 'Original task instructions.');
    assert.equal(await context.tool('read-resource', 'read_skill', { id: 'durable-skill', resource: 'references/guide.md' }), 'Original task resource.');
  });

  const unreadTask = service.send('discover-before-delete', { requestId: 'send-discover', text: '发现后再读取', modelId: 'test' });
  await service.runNext(async context => {
    const discovered = await context.tool('discover', 'discover_skills', {});
    assert.equal(discovered.some(skill => skill.id === 'durable-skill'), true);
    deleteSkill('durable-skill');
    await assert.rejects(context.tool('late-instructions', 'read_skill', { id: 'durable-skill' }), /不再可用/);
    await assert.rejects(context.tool('late-resource', 'read_skill', { id: 'durable-skill', resource: 'references/guide.md' }), /不再可用/);
  });

  assert.equal(service.task(readTask.id).steps.find(step => step.id === 'read-instructions').result, 'Original task instructions.');
  assert.equal(service.task(readTask.id).steps.find(step => step.id === 'read-resource').result, 'Original task resource.');
  assert.match(service.task(unreadTask.id).steps.find(step => step.id === 'late-instructions').result.error, /不再可用/);
  assert.match(service.task(unreadTask.id).steps.find(step => step.id === 'late-resource').result.error, /不再可用/);

  upload('Replacement instructions.');
  const replacementTask = service.send('read-after-reupload', { requestId: 'send-replacement', text: '读取重传技能', modelId: 'test' });
  await service.runNext(async context => {
    assert.equal(await context.tool('read-replacement', 'read_skill', { id: 'durable-skill' }), 'Replacement instructions.');
  });
  assert.equal(service.task(replacementTask.id).steps[0].result, 'Replacement instructions.');
  assert.equal(service.task(readTask.id).steps[0].result, 'Original task instructions.');
});
