require('../scripts/register-typescript.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-registry-'));
process.env.DATABASE_PATH = path.join(directory, 'skills.db');
const { listSkills, getSkill, discoverSkills, readSkill, uploadSkillMarkdown } = require('../lib/agent/skills.ts');
const { closeDatabase } = require('../lib/db/index.ts');

test.after(() => {
  closeDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
});

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

  const uploaded = uploadSkillMarkdown({ fileName: 'SKILL.md', content: markdown, size: Buffer.byteLength(markdown), totalSize: Buffer.byteLength(markdown) });

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
