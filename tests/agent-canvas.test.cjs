/* eslint-disable @typescript-eslint/no-require-imports -- Public Node integration test entry point. */
require('../scripts/register-typescript.cjs');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
process.env.DATABASE_PATH = ':memory:';
const { getDatabase, closeDatabase } = require('../lib/db');
const { saveWorkflow, getWorkflowById } = require('../lib/db/workflows');
const { AgentService } = require('../lib/agent/service');
const { registerCanvasTools } = require('../lib/agent/canvas');
const { createCanvasHistory, validateHistory } = require('../lib/canvas/history');
after(closeDatabase);
function setup(id) { saveWorkflow({ id, requestId: 'seed', baseVersion: 0, snapshot: { name: '故事', nodes: [{ id: 'a', type: 'text', position: { x: 0, y: 0 }, data: { type: 'text', label: 'A', prompt: '原稿' } }, { id: 'b', type: 'text', position: { x: 500, y: 0 }, data: { type: 'text', label: 'B', prompt: '无关内容' } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } }); const service = new AgentService(getDatabase()); registerCanvasTools(service); return service; }
test('Agent edits a complete creative step durably, deduplicates tools and shares undo history', async () => { const service = setup('edit'); const task = service.send('edit', { requestId: 'send', text: '改写', modelId: 'test' }); await service.runNext(async (c) => { const args = { label: '改写剧本', operations: [{ kind: 'update', id: 'a', data: { prompt: '新稿' } }, { kind: 'update', id: 'a', data: { customTitle: '开场' } }] }; await c.tool('edit', 'edit_canvas', args); await c.tool('edit', 'edit_canvas', args); }); assert.equal(service.task(task.id).status, 'completed'); const saved = getWorkflowById('edit'); assert.equal(saved.nodes[0].data.prompt, '新稿'); assert.equal(saved.nodes[1].data.prompt, '无关内容'); assert.equal(saved.history.undo.length, 1); assert.equal(saved.history.operations.length, 2); let state = { ...saved, projectName: saved.name, canvasSession: 1 }; const history = createCanvasHistory(() => state, u => state = { ...state, ...u }); history.undo(); assert.equal(state.nodes[0].data.prompt, '原稿'); history.redo(); assert.equal(state.nodes[0].data.customTitle, '开场'); validateHistory(state.history, state); });
test('remote Agent edits merge into unrelated unsaved work and undo restores the actual overwritten local value', async () => {
    require('fake-indexeddb/auto');
    const { createCanvasRepository } = require('../lib/canvas/local-repository');
    const service = setup('merge');
    const base = getWorkflowById('merge');
    const repo = createCanvasRepository('agent-merge');
    await repo.adopt('merge', base, base.version);
    let local = { ...base, projectName: base.name, canvasSession: 1 };
    const edits = createCanvasHistory(() => local, u => local = { ...local, ...u });
    edits.change({ nodes: local.nodes.map(n => ({ ...n, data: { ...n.data, prompt: n.id === 'a' ? '人工改稿' : '保留的本地编辑' } })) }, { record: true, id: 'manual' });
    await repo.commit('merge', { ...base, nodes: local.nodes, history: local.history }, base.version, 0);
    service.send('merge', { requestId: 'send', text: '改写', modelId: 'test' });
    await service.runNext(async (c) => c.tool('write', 'edit_canvas', { operations: [{ kind: 'update', id: 'a', data: { prompt: '助手改稿' } }] }));
    const remote = getWorkflowById('merge');
    const merged = await repo.mergeRemote('merge', remote, remote.version, (await repo.pending('merge')).requestId);
    assert.equal(merged.snapshot.nodes[0].data.prompt, '助手改稿');
    assert.equal(merged.snapshot.nodes[1].data.prompt, '保留的本地编辑');
    local = { ...merged.snapshot, projectName: merged.snapshot.name, canvasSession: 1 };
    createCanvasHistory(() => local, u => local = { ...local, ...u }).undo();
    assert.equal(local.nodes[0].data.prompt, '人工改稿');
    assert.equal(local.nodes[1].data.prompt, '保留的本地编辑');
    validateHistory(local.history, local);
});
test('deletion waits for a persisted user decision and a model boolean cannot authorize it', async () => { const service = setup('delete'); const task = service.send('delete', { requestId: 'send', text: '整理画布', modelId: 'test' }); await service.runNext(async (c) => { await assert.rejects(c.tool('bad-delete', 'delete_canvas_nodes', { ids: ['a'], confirmed: true })); await c.tool('delete', 'delete_canvas_nodes', { ids: ['a'] }); }); assert.equal(service.canvas('delete').nodes.length, 2); const waiting = service.task(task.id); assert.equal(waiting.status, 'waiting'); service.answer('delete', { requestId: 'answer', questionId: waiting.question.id, text: '确认删除' }); await service.runNext(async (c) => c.tool('apply-delete', 'delete_canvas_nodes', { ids: ['a'] })); assert.equal(service.canvas('delete').nodes.length, 1); });
test('model edits validate capabilities and cannot inject generation state', async () => { const service = setup('params'); const task = service.send('params', { requestId: 'send', text: '调整', modelId: 'test' }); await service.runNext(async (c) => c.tool('bad', 'edit_canvas', { operations: [{ kind: 'update', id: 'a', data: { generationTaskId: 'fabricated' } }] })); assert.equal(service.task(task.id).status, 'failed'); assert.equal(service.canvas('params').nodes[0].data.generationTaskId, undefined); });
test('new content uses deterministic nonoverlapping layout without moving existing nodes', async () => { const service = setup('layout'); service.send('layout', { requestId: 'send', text: '写两个分镜', modelId: 'test' }); await service.runNext(async (c) => c.tool('create', 'edit_canvas', { operations: [{ kind: 'create', node: { id: 'new1', type: 'text', data: { type: 'text', label: '第一幕', prompt: '开场' } } }, { kind: 'create', node: { id: 'new2', type: 'text', data: { type: 'text', label: '第二幕', prompt: '结束' } } }] })); const saved = getWorkflowById('layout'); assert.equal(saved.nodes.length, 4); assert.deepEqual(saved.nodes[0].position, { x: 0, y: 0 }); assert.deepEqual(saved.nodes[1].position, { x: 500, y: 0 }); const [a, b] = saved.nodes.slice(2); assert.ok(Math.abs(a.position.x - b.position.x) >= 320 || Math.abs(a.position.y - b.position.y) >= 240); assert.ok(a.position.x >= 900 || a.position.y >= 300); });
test('an open canvas automatically rebases an Agent edit through the version-checked save protocol', async () => {
    const { createStore } = require('zustand/vanilla');
    const { createCanvasAutosave } = require('../lib/canvas/autosave');
    const { createCanvasRepository } = require('../lib/canvas/local-repository');
    const service = setup('live');
    const original = global.fetch;
    global.fetch = async (_url, options) => { if (options?.method === 'PUT') {
        try {
            return Response.json({ success: true, data: saveWorkflow(JSON.parse(options.body)) });
        }
        catch (e) {
            return Response.json({ error: e.message }, { status: e.status ?? 500 });
        }
    } return Response.json({ success: true, data: getWorkflowById('live') }); };
    const store = createStore(() => ({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, projectName: '', currentWorkflowId: null, canvasSession: 0, serverVersion: 0, persistenceReady: false, saveStatus: 'idle', saveError: null }));
    const saver = createCanvasAutosave(store, () => { }, 60000, createCanvasRepository('live-merge'), 60000, { history: true });
    const stop = saver.start();
    try {
        await saver.open('live');
        let state = store.getState();
        const edits = createCanvasHistory(store.getState, store.setState);
        edits.change({ nodes: state.nodes.map(n => n.id === 'b' ? { ...n, data: { ...n.data, prompt: '本地保持' } } : n) }, { record: true });
        service.send('live', { requestId: 's', text: '编辑', modelId: 'test' });
        await service.runNext(async (c) => c.tool('e', 'edit_canvas', { operations: [{ kind: 'update', id: 'a', data: { prompt: '后台更新' } }] }));
        await saver.flush();
        assert.equal(store.getState().nodes[0].data.prompt, '后台更新');
        assert.equal(store.getState().nodes[1].data.prompt, '本地保持');
        assert.equal(getWorkflowById('live').nodes[1].data.prompt, '本地保持');
        assert.equal(store.getState().recovery, undefined);
    }
    finally {
        stop();
        await saver.flush().catch(() => { });
        global.fetch = original;
    }
});
test('deleted targets are skipped and historical node identities cannot be recreated by Agent', async () => { const service = setup('tombstone'); const { CanvasAgentService } = require('../lib/agent/canvas'); const canvas = new CanvasAgentService(); canvas.apply('tombstone', 'delete', [{ kind: 'delete', id: 'a' }]); assert.match(canvas.apply('tombstone', 'late', [{ kind: 'update', id: 'a', data: { prompt: '迟到' } }]).skipped[0], /deleted/); assert.throws(() => canvas.apply('tombstone', 'resurrect', [{ kind: 'create', node: { id: 'a', type: 'text', position: { x: 0, y: 0 }, data: { type: 'text', label: '复活' } } }]), /deleted/); assert.equal(service.canvas('tombstone').nodes.length, 1); });
test('parameter capabilities, compatible connections and references remain atomic', async () => {
    const service = setup('capabilities');
    const { defaultConfig } = require('../lib/generation/config');
    registerCanvasTools(service, () => defaultConfig.models.map(m => ({ ...m, configured: true })));
    service.send('capabilities', { requestId: 'send', text: '设定图像', modelId: 'test' });
    await service.runNext(async (c) => c.tool('switch', 'edit_canvas', { operations: [{ kind: 'update', id: 'b', data: { type: 'textToImage', model: 'runninghub-krea2', generationWidth: 1024, generationHeight: 1024 } }, { kind: 'connect', edge: { id: 'ab', source: 'a', target: 'b' } }] }));
    assert.equal(service.canvas('capabilities').nodes[1].data.generationWidth, 1024);
    assert.deepEqual(service.canvas('capabilities').nodes[1].data.prompt, [{ text: '无关内容' }, { ref: 'a' }]);
    service.send('capabilities', { requestId: 'invalid', text: '无效参数', modelId: 'test' });
    await service.runNext(async (c) => c.tool('invalid', 'edit_canvas', { operations: [{ kind: 'update', id: 'a', data: { prompt: '不能部分提交' } }, { kind: 'update', id: 'b', data: { generationWidth: 17 } }] }));
    assert.equal(service.canvas('capabilities').nodes[0].data.prompt, '原稿');
    assert.equal(service.canvas('capabilities').nodes[1].data.generationWidth, 1024);
    service.send('capabilities', { requestId: 'disconnect', text: '断开', modelId: 'test' });
    await service.runNext(async (c) => c.tool('disconnect', 'edit_canvas', { operations: [{ kind: 'disconnect', id: 'ab' }] }));
    assert.equal(service.canvas('capabilities').edges.length, 0);
    assert.deepEqual(service.canvas('capabilities').nodes[1].data.prompt, [{ text: '无关内容@文本描述' }]);
});
test('an explicit user deletion command authorizes only its named targets', async () => { const service = setup('explicit-delete'); service.send('explicit-delete', { requestId: 'send', text: '删除节点 a', modelId: 'test' }); await service.runNext(async (c) => c.tool('delete', 'delete_canvas_nodes', { ids: ['a'] })); assert.deepEqual(service.canvas('explicit-delete').nodes.map(n => n.id), ['b']); assert.equal(service.snapshot('explicit-delete').tasks[0].status, 'completed'); });
test('new grouped content lays out children inside its dimensions without moving existing nodes', async () => { const service = setup('group-layout'); service.send('group-layout', { requestId: 'send', text: '分组分镜', modelId: 'test' }); await service.runNext(async (c) => c.tool('group', 'edit_canvas', { operations: [{ kind: 'create', node: { id: 'g', type: 'group', data: { type: 'group', label: '一幕' } } }, ...['one', 'two'].map(id => ({ kind: 'create', node: { id, type: 'text', parentId: 'g', data: { type: 'text', label: id } } }))] })); const nodes = service.canvas('group-layout').nodes; const group = nodes.find(n => n.id === 'g'), one = nodes.find(n => n.id === 'one'), two = nodes.find(n => n.id === 'two'); assert.ok(group); assert.ok(Math.abs(one.position.x - two.position.x) >= 320 || Math.abs(one.position.y - two.position.y) >= 240); assert.ok(one.position.x + 320 <= group.style.width && two.position.x + 320 <= group.style.width); assert.ok(one.position.y + 240 <= group.style.height && two.position.y + 240 <= group.style.height); });
