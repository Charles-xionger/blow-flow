require('../scripts/register-typescript.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const JSZip = require('jszip');
process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-upload-')), 'skills.db');

const originalLoad = Module._load;
Module._load = function (id, parent, isMain) {
  if (id.startsWith('@/')) id = path.resolve(__dirname, '..', id.slice(2));
  return originalLoad.call(this, id, parent, isMain);
};
const { POST } = require('../app/api/personal/skills/route.ts');
const { discoverSkills, getSkill, readSkill } = require('../lib/agent/skills.ts');
Module._load = originalLoad;

async function zipUpload(entries, name = 'skill.zip', options) {
  const zip = new JSZip();
  for (const [entryName, value, entryOptions] of entries) zip.file(entryName, value, entryOptions);
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: options?.platform });
  const form = new FormData();
  form.append('file', new File([bytes], name, { type: 'application/zip' }));
  return POST(new Request('http://localhost/api/personal/skills', { method: 'POST', body: form }));
}

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
    [await upload('---\nname: empty-body\ndescription: no instructions\n---\n'), 400, /正文不能为空/],
  ];
  for (const [response, status, message] of cases) {
    assert.equal(response.status, status);
    assert.match((await response.json()).error, message);
  }
  assert.deepEqual(discoverSkills().filter(skill => ['no-description', 'too-large', 'total-too-large', 'wrong-file'].includes(skill.id)), []);
  assert.equal(require('../lib/agent/skills.ts').readSkill('color-script'), 'Use motivated palette changes.');
});

test('upload API enforces the whole request limit without relying on Content-Length', async () => {
  const markdown = '---\nname: hidden-overflow\ndescription: must not be registered\n---\nbody';
  const form = new FormData();
  form.append('file', new File([markdown], 'SKILL.md', { type: 'text/markdown' }));
  form.append('padding', 'x'.repeat(20 * 1024 * 1024));

  const response = await POST(new Request('http://localhost/api/personal/skills', { method: 'POST', body: form }));

  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /20 MB/);
  assert.equal(discoverSkills().some(skill => skill.id === 'hidden-overflow'), false);
});

test('ZIP uploads support a root entry and one wrapper directory while resources stay on demand', async () => {
  const root = await zipUpload([
    ['SKILL.md', '---\nname: zip-root\ndescription: Root ZIP skill.\n---\n\nRead references only when needed.'],
    ['references/look.md', 'Use cyan shadows.'],
    ['scripts/plan.sh', '#!/bin/sh\necho plan'],
  ]);
  assert.equal(root.status, 201, JSON.stringify(await root.clone().json()));
  assert.deepEqual((await root.json()).data.resources, ['references/look.md', 'scripts/plan.sh']);
  assert.deepEqual(getSkill('zip-root').resources, ['references/look.md', 'scripts/plan.sh']);
  assert.equal(readSkill('zip-root'), 'Read references only when needed.');
  assert.equal(readSkill('zip-root', 'references/look.md'), 'Use cyan shadows.');
  assert.equal(readSkill('zip-root', 'scripts/plan.sh'), '#!/bin/sh\necho plan');

  const wrapped = await zipUpload([
    ['wrapped/SKILL.md', '---\nname: zip-wrapped\ndescription: Wrapped ZIP skill.\n---\n\nUse wrapped resources.'],
    ['wrapped/assets/palette.txt', 'amber'],
  ]);
  assert.equal(wrapped.status, 201, JSON.stringify(await wrapped.clone().json()));
  assert.deepEqual((await wrapped.json()).data.resources, ['assets/palette.txt']);
  assert.equal(readSkill('zip-wrapped', 'assets/palette.txt'), 'amber');
  assert.throws(() => readSkill('zip-wrapped', '../wrapped/SKILL.md'), /Unknown skill resource/);
});

test('ZIP uploads reject missing, multiple, deeply wrapped, and escaping entries atomically', async () => {
  const cases = [
    [['notes.md', 'none'], /SKILL\.md/],
    [[['SKILL.md', '---\nname: duplicate-entry\ndescription: root\n---\nbody'], ['other/SKILL.md', '---\nname: other-entry\ndescription: other\n---\nbody']], /只能包含一个 SKILL\.md/],
    [['outer/inner/SKILL.md', '---\nname: too-deep\ndescription: deep\n---\nbody'], /根目录或仅外包一层目录/],
    [['../SKILL.md', '---\nname: escaping-path\ndescription: escape\n---\nbody'], /不安全路径/],
    [['/SKILL.md', '---\nname: absolute-path\ndescription: absolute\n---\nbody'], /不安全路径/],
  ];
  for (const [rawEntries, message] of cases) {
    const entries = Array.isArray(rawEntries[0]) ? rawEntries : [rawEntries];
    const response = await zipUpload(entries);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, message);
  }
  assert.equal(discoverSkills().some(skill => ['duplicate-entry', 'other-entry', 'too-deep', 'escaping-path', 'absolute-path'].includes(skill.id)), false);
});

test('ZIP uploads reject symlinks, too many files, oversized files, and expanded archives atomically', async () => {
  const symlink = await zipUpload([
    ['SKILL.md', '---\nname: linked-skill\ndescription: linked\n---\nbody'],
    ['escape', '../outside', { unixPermissions: 0o120777 }],
  ], 'linked.zip', { platform: 'UNIX' });
  assert.equal(symlink.status, 400);
  assert.match((await symlink.json()).error, /符号链接/);

  const many = [['SKILL.md', '---\nname: many-files\ndescription: many\n---\nbody']];
  for (let index = 0; index < 200; index++) many.push([`resource-${index}.txt`, 'x']);
  const tooMany = await zipUpload(many);
  assert.equal(tooMany.status, 413);
  assert.match((await tooMany.json()).error, /200 个文件/);

  const tooLarge = await zipUpload([
    ['SKILL.md', '---\nname: large-file\ndescription: large\n---\nbody'],
    ['large.txt', 'x'.repeat(5 * 1024 * 1024 + 1)],
  ]);
  assert.equal(tooLarge.status, 413);
  assert.match((await tooLarge.json()).error, /单个文件不能超过 5 MB/);

  const expanded = [['SKILL.md', '---\nname: expanded-archive\ndescription: expanded\n---\nbody']];
  for (let index = 0; index < 5; index++) expanded.push([`large-${index}.txt`, 'x'.repeat(5 * 1024 * 1024)]);
  const tooExpanded = await zipUpload(expanded);
  assert.equal(tooExpanded.status, 413);
  assert.match((await tooExpanded.json()).error, /解压后不能超过 20 MB/);

  assert.equal(discoverSkills().some(skill => ['linked-skill', 'many-files', 'large-file', 'expanded-archive'].includes(skill.id)), false);
});
