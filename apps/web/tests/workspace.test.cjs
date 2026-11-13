require('../scripts/register-typescript.cjs');
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
process.env.DATABASE_PATH = ':memory:';
const { getDatabase, closeDatabase } = require('../lib/db/index.ts');
const { getWorkspace, manageWorkspace } = require('../lib/db/workspace.ts');
const { saveWorkflow, getWorkflowById } = require('../lib/db/workflows.ts');
after(closeDatabase);
beforeEach(() => closeDatabase());
const create = (id, folderId = null) => manageWorkspace({ action: 'create-project', id, folderId });
const project = id => getWorkspace().projects.find(p => p.id === id);
const target = id => { const p = project(id) || getWorkspace(true).projects.find(p => p.id === id); return { id, version: p.version }; };
const act = (action, ids, extra = {}) => manageWorkspace({ action, targets: ids.map(target), ...extra });
const image = (id, url, type = 'textToImage') => ({ id, type, position: { x: 0, y: 0 }, data: { imageSrc: url } });
function save(id, nodes, requestId = crypto.randomUUID()) {
  const p = getWorkflowById(id);
  return saveWorkflow({ id, baseVersion: p.version, requestId, snapshot: { name: p.name, nodes, edges: [], viewport: p.viewport } });
}

test('empty creation is durable and replayable; the management list returns summaries only', () => {
  create('empty'); create('empty');
  assert.equal(getWorkspace().projects.length, 1);
  assert.equal(project('empty').nodeCount, 0);
  assert.equal(project('empty').name, '未命名项目');
  assert.equal(project('empty').version, 1);
  assert.ok(!('nodes' in project('empty')));
  assert.equal(getWorkflowById('empty').nodes.length, 0);
});

test('replaying creation after its folder was removed opens the original project without changing its current folder', () => {
  manageWorkspace({ action: 'create-folder', id: 'original-folder', name: '原文件夹' });
  create('retry', 'original-folder');
  manageWorkspace({ action: 'delete-folder', id: 'original-folder' });
  assert.deepEqual(create('retry', 'original-folder'), { id: 'retry' });
  assert.equal(project('retry').folderId, null);
  manageWorkspace({ action: 'create-folder', id: 'new-folder', name: '新文件夹' });
  act('move', ['retry'], { folderId: 'new-folder' });
  create('retry', 'original-folder');
  assert.equal(project('retry').folderId, 'new-folder');
  assert.equal(getWorkspace().projects.length, 1);
  act('trash', ['retry']);
  assert.throws(() => create('retry', 'original-folder'), error => error.status === 410);
  act('purge', ['retry']);
  assert.throws(() => create('retry', 'original-folder'), error => error.status === 410);
  assert.throws(() => create('invalid', 'original-folder'), error => error.status === 404);
  assert.equal(getWorkflowById('invalid'), null);
});

test('cover tracks the latest changed generated image, survives unrelated saves, and falls back on deletion', () => {
  create('cover');
  const a = image('a', 'https://example.com/a.png');
  const b = image('b', 'https://example.com/b.png');
  const upload = image('upload', 'https://example.com/upload.png', 'originalImage');
  save('cover', [a, b, upload]);
  assert.equal(project('cover').coverUrl, b.data.imageSrc);
  a.data.imageSrc = 'https://example.com/new-a.png';
  save('cover', [a, b, upload]);
  assert.equal(project('cover').coverUrl, a.data.imageSrc);
  save('cover', [a, b, upload]);
  assert.equal(project('cover').coverUrl, a.data.imageSrc);
  save('cover', [upload]);
  assert.equal(project('cover').coverUrl, upload.data.imageSrc);
  save('cover', [{ ...image('video', 'https://example.com/video.mp4', 'textToVideo'), data: { videoSrc: 'https://example.com/video.mp4' } }]);
  assert.equal(project('cover').coverUrl, null);
  assert.equal(project('cover').nodeCount, 1);
});

test('renaming protects content from stale editors and batch operations roll back on conflict', () => {
  create('a'); create('b');
  const stale = target('a');
  act('rename-project', ['a'], { name: ' 改名 ' });
  assert.equal(getWorkflowById('a').name, '改名');
  assert.throws(() => saveWorkflow({ id: 'a', requestId: 'stale-save', baseVersion: stale.version,
    snapshot: { name: 'old', nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } }), error => error.status === 409);
  assert.throws(() => manageWorkspace({ action: 'trash', targets: [target('b'), stale] }), error => error.status === 409);
  assert.equal(getWorkspace().projects.length, 2);
  assert.equal(getWorkspace(true).projects.length, 0);
});

test('folder removal preserves active and trashed projects and restoration falls back to root', () => {
  manageWorkspace({ action: 'create-folder', id: 'folder', name: '灵感' });
  create('a', 'folder'); create('b', 'folder');
  assert.equal(getWorkspace().folders[0].projectCount, 2);
  act('trash', ['b']);
  assert.equal(getWorkspace().folders[0].projectCount, 1);
  manageWorkspace({ action: 'delete-folder', id: 'folder' });
  assert.equal(project('a').folderId, null);
  act('restore', ['b']);
  assert.equal(project('b').folderId, null);
  assert.equal(getWorkflowById('b').nodes.length, 0);
  assert.throws(() => act('move', ['a', 'b'], { folderId: 'folder' }), error => error.status === 404);
  assert.equal(project('a').folderId, null);
});

test('moves survive later canvas saves, and a failed move never changes the batch', () => {
  manageWorkspace({ action: 'create-folder', id: 'folder', name: '归档' });
  create('a'); create('b');
  act('move', ['a', 'b'], { folderId: 'folder' });
  save('a', [image('node', 'https://example.com/image.png')]);
  assert.equal(project('a').folderId, 'folder');
  assert.equal(getWorkspace().folders[0].projectCount, 2);
});

test('restore preserves content, and permanent deletion cannot be undone by an offline save', () => {
  create('recover');
  const node = image('node', 'https://example.com/image.png');
  save('recover', [node]);
  const before = getWorkflowById('recover');
  act('trash', ['recover']);
  assert.equal(getWorkflowById('recover'), null);
  act('restore', ['recover']);
  assert.deepEqual(getWorkflowById('recover').nodes, before.nodes);
  assert.ok(getWorkflowById('recover').version > before.version);
  act('trash', ['recover']);
  const stale = target('recover');
  act('purge', ['recover']);
  assert.equal(getWorkspace(true).projects.length, 0);
  assert.equal(getDatabase().prepare('SELECT data FROM workflows WHERE id = ?').get('recover').data, '{}');
  assert.throws(() => saveWorkflow({ id: 'recover', requestId: 'offline', baseVersion: 0,
    snapshot: { name: 'resurrect', nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } }), error => error.status === 410);
  assert.throws(() => manageWorkspace({ action: 'restore', targets: [stale] }), error => error.status === 404);
});

test('invalid commands and names cannot mutate projects or produce nested folders', () => {
  assert.throws(() => manageWorkspace(null));
  assert.throws(() => manageWorkspace({ action: 'create-folder', id: 'a', name: '   ' }));
  create('a');
  assert.throws(() => act('rename-project', ['a'], { name: '' }));
  assert.throws(() => act('purge', ['a']));
  assert.throws(() => manageWorkspace({ action: 'trash', targets: [] }));
  assert.equal(project('a').version, 1);
});
