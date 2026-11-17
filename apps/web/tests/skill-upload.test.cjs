require('../scripts/register-typescript.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-upload-')), 'skills.db');

const originalLoad = Module._load;
Module._load = function (id, parent, isMain) {
  if (id.startsWith('@/')) id = path.resolve(__dirname, '..', id.slice(2));
  return originalLoad.call(this, id, parent, isMain);
};
const { POST } = require('../app/api/personal/skills/route.ts');
const { discoverSkills } = require('../lib/agent/skills.ts');
Module._load = originalLoad;

test('SKILL.md upload API registers a valid personal creative skill', async () => {
  const markdown = '---\nname: color-script\ndescription: Design a scene color progression.\n---\n\nUse motivated palette changes.';
  const form = new FormData();
  form.append('file', new File([markdown], 'SKILL.md', { type: 'text/markdown' }));

  const response = await POST(new Request('http://localhost/api/personal/skills', { method: 'POST', body: form }));

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    success: true,
    data: {
      id: 'color-script', name: 'color-script', description: 'Design a scene color progression.',
      source: '用户上传', readOnly: false, resources: [],
    },
  });
});

test('upload API rejects invalid frontmatter, duplicates, and size limits without partial registration', async () => {
  async function upload(markdown, name = 'SKILL.md', headers) {
    const form = new FormData();
    form.append('file', new File([markdown], name, { type: 'text/markdown' }));
    const request = new Request('http://localhost/api/personal/skills', { method: 'POST', body: form, headers });
    return POST(request);
  }

  const cases = [
    [await upload('no frontmatter'), 400, /YAML frontmatter/],
    [await upload('---\nname: Bad Name\ndescription: useful\n---\nbody'), 400, /name 格式无效/],
    [await upload('---\nname: no-description\n---\nbody'), 400, /description 不能为空/],
    [await upload('---\nname: screenplay\ndescription: duplicate built-in\n---\nbody'), 409, /已存在/],
    [await upload('---\nname: color-script\ndescription: duplicate upload\n---\nreplacement'), 409, /已存在/],
    [await upload('---\nname: too-large\ndescription: too large\n---\n' + 'x'.repeat(5 * 1024 * 1024)), 413, /5 MB/],
    [await upload('---\nname: total-too-large\ndescription: too large\n---\nbody', 'SKILL.md', { 'content-length': String(20 * 1024 * 1024 + 1) }), 413, /20 MB/],
    [await upload('---\nname: wrong-file\ndescription: wrong file\n---\nbody', 'skill.md'), 400, /文件名必须是 SKILL.md/],
  ];
  for (const [response, status, message] of cases) {
    assert.equal(response.status, status);
    assert.match((await response.json()).error, message);
  }
  assert.deepEqual(discoverSkills().filter(skill => ['no-description', 'too-large', 'total-too-large', 'wrong-file'].includes(skill.id)), []);
  assert.equal(require('../lib/agent/skills.ts').readSkill('color-script'), 'Use motivated palette changes.');
});
