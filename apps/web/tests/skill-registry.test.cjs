require('../scripts/register-typescript.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { listSkills, getSkill, discoverSkills, readSkill } = require('../lib/agent/skills.ts');

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
