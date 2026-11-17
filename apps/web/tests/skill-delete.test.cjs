require('../scripts/register-typescript.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-delete-'));
process.env.DATABASE_PATH = path.join(directory, 'skills.db');
const originalLoad = Module._load;
Module._load = function (id, parent, isMain) {
  if (id.startsWith('@/')) id = path.resolve(__dirname, '..', id.slice(2));
  return originalLoad.call(this, id, parent, isMain);
};
const { DELETE } = require('../app/api/personal/skills/route.ts');
const { uploadSkillMarkdown, discoverSkills, readSkill } = require('../lib/agent/skills.ts');
const { closeDatabase } = require('../lib/db/index.ts');
Module._load = originalLoad;

test.after(() => {
  closeDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
});

function request(id) {
  return new Request('http://localhost/api/personal/skills', {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
  });
}

test('DELETE removes an uploaded skill and all of its resources', async () => {
  const markdown = '---\nname: removable-skill\ndescription: Remove this skill.\n---\n\nOld instructions.';
  uploadSkillMarkdown({
    fileName: 'SKILL.md', content: markdown, size: Buffer.byteLength(markdown), totalSize: Buffer.byteLength(markdown),
    resources: new Map([['references/old.md', Buffer.from('Old resource.')]]),
  });

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
