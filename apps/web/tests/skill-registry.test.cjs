const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSkillTestFixture, skillUploadInput } = require('./helpers/skill-test-fixture.cjs');
const fixture = createSkillTestFixture(test, 'skill-registry');
const { listSkills, getSkill, discoverSkills, readSkill, uploadSkillMarkdown, deleteSkill } = fixture.requireApp('lib/agent/skills.ts');
const { closeDatabase } = fixture.requireApp('lib/db/index.ts');

test('personal skill library and Agent read the same built-in skill registry', () => {
  assert.deepEqual(listSkills(), [
    {
      id: 'screenplay',
      name: '剧本创作',
      description: '按创作意图编写剧本、人物与场景对白。',
      source: '内置',
      readOnly: true,
      resources: ['format'],
    },
    {
      id: 'storyboard',
      name: '分镜创作',
      description: '将故事或创意组织成可视化分镜。',
      source: '内置',
      readOnly: true,
      resources: ['shot'],
    },
  ]);

  const screenplay = getSkill('screenplay');
  assert.match(screenplay.instructions, /人物、场景、动作与对白/);
  assert.deepEqual(screenplay.resources, ['format']);
  assert.match(readSkill('screenplay', 'format'), /场景标题：地点 \/ 时间/);
  assert.deepEqual(discoverSkills(), listSkills().map(({ id, description }) => ({ id, description })));
  assert.equal(readSkill('screenplay'), screenplay.instructions);
});

test('a valid SKILL.md is immediately discoverable while instructions stay behind read_skill', () => {
  const markdown = `---\nname: lighting-director\ndescription: Plan expressive lighting for a scene.\n---\n\n# Lighting Director\n\nShape the key, fill, and rim light.`;

  const uploaded = uploadSkillMarkdown(skillUploadInput(markdown));

  assert.deepEqual(uploaded, {
    id: 'lighting-director',
    name: 'lighting-director',
    description: 'Plan expressive lighting for a scene.',
    source: '用户上传',
    readOnly: false,
    resources: [],
  });
  assert.deepEqual(discoverSkills().find(skill => skill.id === 'lighting-director'), {
    id: 'lighting-director',
    description: 'Plan expressive lighting for a scene.',
  });
  assert.equal(readSkill('lighting-director'), '# Lighting Director\n\nShape the key, fill, and rim light.');
});

test('uploaded skill metadata and instructions survive reopening the database', () => {
  closeDatabase();

  const summary = listSkills().find(skill => skill.id === 'lighting-director');

  assert.equal(summary.description, 'Plan expressive lighting for a scene.');
  assert.equal(readSkill('lighting-director'), '# Lighting Director\n\nShape the key, fill, and rim light.');
});

test('a legal skill name that matches an object prototype property can be uploaded', () => {
  const markdown = '---\nname: constructor\ndescription: Build constructor scenes.\n---\n\nKeep the structure visible.';

  uploadSkillMarkdown(skillUploadInput(markdown));

  assert.equal(readSkill('constructor'), 'Keep the structure visible.');
});

test('deleting an uploaded skill removes its resources and permits an independent same-name upload', () => {
  const original = '---\nname: disposable-skill\ndescription: Original version.\n---\n\nOriginal instructions.';
  uploadSkillMarkdown(skillUploadInput(original, new Map([['references/original.md', Buffer.from('Original resource.')]])));

  deleteSkill('disposable-skill');

  assert.equal(discoverSkills().some(skill => skill.id === 'disposable-skill'), false);
  assert.throws(() => readSkill('disposable-skill'), /不再可用/);
  assert.throws(() => readSkill('disposable-skill', 'references/original.md'), /不再可用/);

  const replacement = '---\nname: disposable-skill\ndescription: Replacement version.\n---\n\nReplacement instructions.';
  uploadSkillMarkdown(skillUploadInput(replacement));
  assert.equal(readSkill('disposable-skill'), 'Replacement instructions.');
  assert.throws(() => readSkill('disposable-skill', 'references/original.md'), /不再可用/);
});

test('built-in skills cannot be deleted through the registry', () => {
  assert.throws(() => deleteSkill('screenplay'), /内置创作技能不能删除/);
  assert.match(readSkill('screenplay'), /人物、场景、动作与对白/);
});

test('personal creative skills are isolated by owner across every registry operation', () => {
  const firstOwner = { ownerId: 'test-owner-first' };
  const secondOwner = { ownerId: 'test-owner-second' };
  const first = '---\nname: shared-name\ndescription: First owner version.\n---\n\nFirst owner instructions.';
  const second = '---\nname: shared-name\ndescription: Second owner version.\n---\n\nSecond owner instructions.';

  uploadSkillMarkdown(skillUploadInput(first, new Map([['reference.txt', Buffer.from('first resource')]])), firstOwner);
  uploadSkillMarkdown(skillUploadInput(second, new Map([['reference.txt', Buffer.from('second resource')]])), secondOwner);

  assert.equal(getSkill('shared-name', firstOwner).description, 'First owner version.');
  assert.equal(getSkill('shared-name', secondOwner).description, 'Second owner version.');
  assert.equal(readSkill('shared-name', undefined, firstOwner), 'First owner instructions.');
  assert.equal(readSkill('shared-name', 'reference.txt', secondOwner), 'second resource');
  assert.equal(listSkills(firstOwner).filter(skill => skill.id === 'shared-name').length, 1);
  assert.equal(discoverSkills(secondOwner).find(skill => skill.id === 'shared-name').description, 'Second owner version.');

  deleteSkill('shared-name', firstOwner);

  assert.throws(() => readSkill('shared-name', undefined, firstOwner), /不再可用/);
  assert.equal(readSkill('shared-name', undefined, secondOwner), 'Second owner instructions.');
});
