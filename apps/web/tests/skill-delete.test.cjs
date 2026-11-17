const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSkillTestFixture, skillUploadInput } = require('./helpers/skill-test-fixture.cjs');
const fixture = createSkillTestFixture(test, 'skill-delete');
const { DELETE } = fixture.requireApp('app/api/personal/skills/route.ts');
const { uploadSkillMarkdown, discoverSkills, readSkill } = fixture.requireApp('lib/agent/skills.ts');

function request(id) {
  return new Request('http://localhost/api/personal/skills', {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
  });
}

test('DELETE removes an uploaded skill and all of its resources', async () => {
  const markdown = '---\nname: removable-skill\ndescription: Remove this skill.\n---\n\nOld instructions.';
  uploadSkillMarkdown(skillUploadInput(markdown, new Map([['references/old.md', Buffer.from('Old resource.')]])));

  const response = await DELETE(request('removable-skill'));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true });
  assert.equal(discoverSkills().some(skill => skill.id === 'removable-skill'), false);
  assert.throws(() => readSkill('removable-skill', 'references/old.md'), /不再可用/);
});

test('DELETE rejects built-in and unavailable skills at the server boundary', async () => {
  const builtIn = await DELETE(request('screenplay'));
  assert.equal(builtIn.status, 403);
  assert.match((await builtIn.json()).error, /内置创作技能不能删除/);
  assert.match(readSkill('screenplay'), /人物、场景、动作与对白/);

  const missing = await DELETE(request('already-gone'));
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /不再可用/);
});

test('DELETE cannot remove a skill owned outside the current local user scope', async () => {
  const otherOwner = { ownerId: 'test-owner-api-delete' };
  const markdown = '---\nname: other-owner-skill\ndescription: Another owner.\n---\n\nPrivate instructions.';
  uploadSkillMarkdown(skillUploadInput(markdown), otherOwner);

  const response = await DELETE(request('other-owner-skill'));

  assert.equal(response.status, 404);
  assert.equal(readSkill('other-owner-skill', undefined, otherOwner), 'Private instructions.');
});
