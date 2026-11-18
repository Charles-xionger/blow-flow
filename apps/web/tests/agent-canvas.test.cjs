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
function setupEmpty(id) { saveWorkflow({ id, requestId: 'seed', baseVersion: 0, snapshot: { name: '空白画布', nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } }); const service = new AgentService(getDatabase()); registerCanvasTools(service); return service; }
test('Agent edits a complete creative step durably, deduplicates tools and shares undo history', async () => { const service = setup('edit'); const task = service.send('edit', { requestId: 'send', text: '改写', modelId: 'test', references: [{ nodeId: 'a', name: 'A' }] }); await service.runNext(async (c) => { const args = { label: '改写剧本', operations: [{ kind: 'update', id: 'a', data: { prompt: '新稿' } }, { kind: 'update', id: 'a', data: { customTitle: '开场' } }] }; await c.tool('edit', 'edit_canvas', args); await c.tool('edit', 'edit_canvas', args); }); assert.equal(service.task(task.id).status, 'completed'); const saved = getWorkflowById('edit'); assert.equal(saved.nodes[0].data.prompt, '新稿'); assert.equal(saved.nodes[1].data.prompt, '无关内容'); assert.equal(saved.history.undo.length, 1); assert.equal(saved.history.operations.length, 2); let state = { ...saved, projectName: saved.name, canvasSession: 1 }; const history = createCanvasHistory(() => state, u => state = { ...state, ...u }); history.undo(); assert.equal(state.nodes[0].data.prompt, '原稿'); history.redo(); assert.equal(state.nodes[0].data.customTitle, '开场'); validateHistory(state.history, state); });
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
    service.send('merge', { requestId: 'send', text: '改写', modelId: 'test', references: [{ nodeId: 'a', name: 'A' }] });
    await service.runNext(async (c) => c.tool('write', 'edit_canvas', { operations: [{ kind: 'update', id: 'a', data: { prompt: '助手改稿' } }] }));
    const remote = getWorkflowById('merge');
    const merged = await repo.mergeRemote('merge', remote, remote.version, (await repo.pending('merge')).requestId);
    assert.equal(merged.snapshot.history.operations.at(-1).source, 'agent');
    assert.equal(merged.snapshot.nodes[0].data.prompt, '助手改稿');
    assert.equal(merged.snapshot.nodes[1].data.prompt, '保留的本地编辑');
    local = { ...merged.snapshot, projectName: merged.snapshot.name, canvasSession: 1 };
    createCanvasHistory(() => local, u => local = { ...local, ...u }).undo();
    assert.equal(local.nodes[0].data.prompt, '人工改稿');
    assert.equal(local.nodes[1].data.prompt, '保留的本地编辑');
    validateHistory(local.history, local);
});
test('deletion waits for a persisted user decision and a model boolean cannot authorize it', async () => { const service = setup('delete'); const task = service.send('delete', { requestId: 'send', text: '整理画布', modelId: 'test' }); await service.runNext(async (c) => { await assert.rejects(c.tool('bad-delete', 'delete_canvas_nodes', { ids: ['a'], confirmed: true })); await c.tool('delete', 'delete_canvas_nodes', { ids: ['a'] }); }); assert.equal(service.canvas('delete').nodes.length, 2); const waiting = service.task(task.id); assert.equal(waiting.status, 'waiting'); service.answer('delete', { requestId: 'answer', questionId: waiting.question.id, text: '确认删除' }); await service.runNext(async (c) => c.tool('apply-delete', 'delete_canvas_nodes', { ids: ['a'] })); assert.equal(service.canvas('delete').nodes.length, 1); });
test('model edits validate capabilities and cannot inject generation state', async () => { const service = setup('params'); const task = service.send('params', { requestId: 'send', text: '调整', modelId: 'test', references: [{ nodeId: 'a', name: 'A' }] }); await service.runNext(async (c) => c.tool('bad', 'edit_canvas', { operations: [{ kind: 'update', id: 'a', data: { generationTaskId: 'fabricated' } }] })); assert.equal(service.task(task.id).status, 'failed'); assert.equal(service.canvas('params').nodes[0].data.generationTaskId, undefined); });
test('malformed canvas creates fail validation before permission checks', async () => {
    const service = setup('invalid-create');
    service.send('invalid-create', { requestId: 'send', text: '新增画面', modelId: 'test' });
    let failure;
    await service.runNext(async (c) => {
        try {
            await c.tool('bad-create', 'edit_canvas', { operations: [{ kind: 'create', id: 'bad', data: { type: 'text', label: '错误节点' } }] });
        } catch (error) {
            failure = error;
        }
    });
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /Invalid tool parameters/);
    assert.doesNotMatch(failure.message, /Cannot read properties|repurpose existing nodes/);
    assert.equal(service.canvas('invalid-create').nodes.length, 2);
});
test('a valid create succeeds on an empty canvas', async () => {
    const service = setupEmpty('empty-create');
    const task = service.send('empty-create', { requestId: 'send', text: '新增开场', modelId: 'test' });
    await service.runNext((c) => c.tool('create', 'edit_canvas', { operations: [{ kind: 'create', node: { id: 'opening', type: 'text', data: { type: 'text', label: '开场', prompt: '清晨' } } }] }));
    assert.equal(service.task(task.id).status, 'completed');
    assert.deepEqual(service.canvas('empty-create').nodes.map(node => node.id), ['opening']);
});
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
        service.send('live', { requestId: 's', text: '编辑', modelId: 'test', references: [{ nodeId: 'a', name: 'A' }] });
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
    service.send('capabilities', { requestId: 'send', text: '设定图像', modelId: 'test', references: [{ nodeId: 'b', name: 'B' }] });
    await service.runNext(async (c) => c.tool('switch', 'edit_canvas', { operations: [{ kind: 'update', id: 'b', data: { type: 'textToImage', model: 'runninghub-krea2', generationWidth: 1024, generationHeight: 1024 } }, { kind: 'connect', edge: { id: 'ab', source: 'a', target: 'b' } }] }));
    assert.equal(service.canvas('capabilities').nodes[1].data.generationWidth, 1024);
    assert.deepEqual(service.canvas('capabilities').nodes[1].data.prompt, [{ text: '无关内容' }, { ref: 'a' }]);
    service.send('capabilities', { requestId: 'invalid', text: '无效参数', modelId: 'test', references: [{ nodeId: 'a', name: 'A' }, { nodeId: 'b', name: 'B' }] });
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
test('human and mixed remote edits retain independent-client conflict recovery instead of Agent overwrite', async () => {
 require('fake-indexeddb/auto');
 const {createStore}=require('zustand/vanilla');const {createCanvasAutosave}=require('../lib/canvas/autosave');const {createCanvasRepository}=require('../lib/canvas/local-repository');
 for(const mixed of [false,true]) {
  const id=`human-conflict-${mixed}`,service=setup(id),nativeFetch=global.fetch;
  global.fetch=async(_url,options)=>{if(options?.method==='PUT'){try{return Response.json({success:true,data:saveWorkflow(JSON.parse(options.body))});}catch(error){return Response.json({error:error.message},{status:error.status??500});}}return Response.json({success:true,data:getWorkflowById(id)});};
  const store=createStore(()=>({nodes:[],edges:[],viewport:{x:0,y:0,zoom:1},projectName:'',currentWorkflowId:null,canvasSession:0,serverVersion:0,persistenceReady:false,saveStatus:'idle',saveError:null}));
  const saver=createCanvasAutosave(store,()=>{},60000,createCanvasRepository(id),60000,{history:true}),stop=saver.start();
  try {
   await saver.open(id);
   if(mixed){service.send(id,{requestId:'agent',text:'编辑',modelId:'test',references:[{nodeId:'a',name:'A'}]});await service.runNext(c=>c.tool('edit','edit_canvas',{operations:[{kind:'update',id:'a',data:{prompt:'Agent remote'}}]}));}
   const remote=getWorkflowById(id);let remoteState={...remote,projectName:remote.name,canvasSession:1};createCanvasHistory(()=>remoteState,u=>remoteState={...remoteState,...u}).change({projectName:'Remote human'},{record:true});
   saveWorkflow({id,requestId:'human',baseVersion:remote.version,snapshot:{...remoteState,name:remoteState.projectName}});
   await saver.flush();assert.equal(store.getState().projectName,'故事');assert.equal(store.getState().nodes[0].data.prompt,'原稿');
   createCanvasHistory(store.getState,store.setState).change({projectName:'Local human'},{record:true});
   await saver.flush().catch(()=>{});assert.equal(store.getState().recovery?.kind,'conflict');assert.equal(store.getState().projectName,'Local human');assert.equal(getWorkflowById(id).name,'Remote human');
  }finally{stop();await saver.flush().catch(()=>{});global.fetch=nativeFetch;}
 }
});
test('Agent creates a generation node shaped as the tool schema describes (type on the node only)', async () => {
    const service = setup('create-media');
    const { defaultConfig } = require('../lib/generation/config');
    registerCanvasTools(service, () => defaultConfig.models.map(m => ({ ...m, configured: true })));
    service.send('create-media', { requestId: 'send', text: '画第一幕', modelId: 'test' });
    // Real planner output: the node type lives on node.type; data carries only creative fields.
    await service.runNext(async (c) => c.tool('scene', 'edit_canvas', { operations: [{ kind: 'create', node: { id: 'scene', type: 'textToImage', data: { label: '雨巷初遇', model: 'runninghub-krea2', prompt: [{ text: '雨夜首尔小巷' }] } } }] }));
    const nodes = service.canvas('create-media').nodes;
    const scene = nodes.find(n => n.id === 'scene');
    assert.equal(scene?.data.type, 'textToImage');
    assert.equal(scene?.data.model, 'runninghub-krea2');
    assert.deepEqual(nodes.filter(n => n.id !== 'scene').map(n => n.data.prompt), ['原稿', '无关内容']);
});
test('a rejected canvas edit tells the planner why, so it can correct the call instead of rewriting existing nodes', async () => {
    const service = setup('explain-rejection');
    const { defaultConfig } = require('../lib/generation/config');
    registerCanvasTools(service, () => defaultConfig.models.map(m => ({ ...m, configured: true })));
    const task = service.send('explain-rejection', { requestId: 'send', text: '加一段文字', modelId: 'test' });
    let message = '';
    await service.runNext(async (c) => { try { await c.tool('bad', 'edit_canvas', { operations: [{ kind: 'create', node: { id: 'note', type: 'text', data: { label: '旁白', model: 'runninghub-krea2' } } }] }); } catch (error) { message = error.message; } });
    assert.match(message, /incompatible with this node type/);
    assert.match(JSON.stringify(service.task(task.id).steps.at(-1).result), /incompatible with this node type/);
});
test('Agent cannot rewrite existing node content unasked, but may lay it out and freely edit what it created this task', async () => {
    const service = setup('guard');
    const task = service.send('guard', { requestId: 'send', text: '写一段旁白', modelId: 'test' });
    let refused;
    await service.runNext(async (c) => {
        await c.tool('create', 'edit_canvas', { operations: [{ kind: 'create', node: { id: 'note', type: 'text', data: { label: '旁白', prompt: '初稿' } } }, { kind: 'connect', edge: { id: 'a-note', source: 'a', target: 'note' } }] });
        await c.tool('revise-own', 'edit_canvas', { operations: [{ kind: 'update', id: 'note', data: { prompt: '二稿' } }, { kind: 'move', id: 'a', position: { x: 10, y: 10 } }] });
        refused = await c.tool('rewrite', 'edit_canvas', { operations: [{ kind: 'update', id: 'a', data: { prompt: '挪用' } }] });
    });
    const nodes = service.canvas('guard').nodes;
    assert.equal(nodes.find(n => n.id === 'note').data.prompt, '二稿');
    assert.deepEqual(nodes.find(n => n.id === 'a').position, { x: 10, y: 10 });
    assert.equal(nodes.find(n => n.id === 'a').data.prompt, '原稿');
    assert.equal(refused.waiting, true);
    const waiting = service.task(task.id);
    assert.equal(waiting.status, 'waiting');
    assert.deepEqual(waiting.question.scope, { kind: 'edit', ids: ['a'] });
    service.answer('guard', { requestId: 'decline', questionId: waiting.question.id, text: '改为新建节点' });
    await service.runNext(async (c) => { const result = await c.tool('rewrite-again', 'edit_canvas', { operations: [{ kind: 'update', id: 'a', data: { prompt: '挪用' } }] }); assert.equal(result.cancelled, true); });
    assert.equal(service.canvas('guard').nodes.find(n => n.id === 'a').data.prompt, '原稿');
    // A node the Agent created in an earlier task now belongs to the user.
    const next = service.send('guard', { requestId: 'next', text: '再写一句', modelId: 'test' });
    await service.runNext(async (c) => c.tool('old-own', 'edit_canvas', { operations: [{ kind: 'update', id: 'note', data: { prompt: '三稿' } }] }));
    assert.equal(service.canvas('guard').nodes.find(n => n.id === 'note').data.prompt, '二稿');
    assert.deepEqual(service.task(next.id).question.scope, { kind: 'edit', ids: ['note'] });
});
test('a confirmed edit authorizes that node for the rest of the task only', async () => {
    const service = setup('confirm-edit');
    const task = service.send('confirm-edit', { requestId: 'send', text: '把 A 的文字改成雨夜', modelId: 'test' });
    await service.runNext(async (c) => c.tool('ask', 'edit_canvas', { operations: [{ kind: 'update', id: 'a', data: { prompt: '雨夜' } }] }));
    const question = service.task(task.id).question;
    service.answer('confirm-edit', { requestId: 'yes', questionId: question.id, text: '确认修改' });
    await service.runNext(async (c) => {
        await c.tool('apply', 'edit_canvas', { operations: [{ kind: 'update', id: 'a', data: { prompt: '雨夜' } }] });
        await c.tool('again', 'edit_canvas', { operations: [{ kind: 'update', id: 'a', data: { customTitle: '雨夜' } }] });
    });
    const a = service.canvas('confirm-edit').nodes.find(n => n.id === 'a');
    assert.equal(a.data.prompt, '雨夜');
    assert.equal(a.data.customTitle, '雨夜');
    assert.equal(service.task(task.id).status, 'completed');
    const next = service.send('confirm-edit', { requestId: 'next', text: '再改一次', modelId: 'test' });
    await service.runNext(async (c) => c.tool('later', 'edit_canvas', { operations: [{ kind: 'update', id: 'a', data: { prompt: '晴天' } }] }));
    assert.equal(service.canvas('confirm-edit').nodes.find(n => n.id === 'a').data.prompt, '雨夜');
    assert.equal(service.task(next.id).status, 'waiting');
});
test('a node the user references in this task may be edited without asking', async () => {
    const service = setup('referenced');
    service.send('referenced', { requestId: 'send', text: '改这个', modelId: 'test', references: [{ nodeId: 'a', name: 'A' }] });
    await service.runNext(async (c) => c.tool('edit', 'edit_canvas', { operations: [{ kind: 'update', id: 'a', data: { prompt: '改好了' } }] }));
    assert.equal(service.canvas('referenced').nodes.find(n => n.id === 'a').data.prompt, '改好了');
    assert.equal(service.snapshot('referenced').tasks[0].status, 'completed');
});

test('Agent-created storyboard text keeps its own content when connected to its source', async () => {
    const service = setup('independent-shots');
    service.send('independent-shots', { requestId: 'send', text: '拆成两个并列镜头', modelId: 'test' });
    await service.runNext(c => c.tool('shots', 'edit_canvas', { operations: [
        { kind: 'create', node: { id: 'shot1', type: 'text', data: { label: '镜头1', prompt: [{ text: '出发' }] } } },
        { kind: 'create', node: { id: 'shot2', type: 'text', data: { label: '镜头2', prompt: [{ text: '归来' }, { ref: 'a' }] } } },
        { kind: 'connect', edge: { id: 's1', source: 'a', target: 'shot1' } },
        { kind: 'connect', edge: { id: 's2', source: 'a', target: 'shot2' } },
    ] }));
    const saved = getWorkflowById('independent-shots');
    assert.deepEqual(saved.nodes.find(n => n.id === 'shot1').data.prompt, [{ text: '出发' }]);
    assert.deepEqual(saved.nodes.find(n => n.id === 'shot2').data.prompt, [{ text: '归来' }, { ref: 'a' }]);
    assert.deepEqual(saved.edges.map(e => e.source), ['a', 'a']);
});

test('Agent creates Seedream nodes with official 1.5K dimensions and durable advanced settings', async () => {
  process.env.ARK_API_KEY = 'fake-ark';
  const service = setup('seedream-settings');
  const task = service.send('seedream-settings', { requestId: 'send', text: '新增画面', modelId: 'test' });
  await service.runNext(c => c.tool('image', 'edit_canvas', { operations: [{ kind: 'create', node: { id: 'seedream', type: 'textToImage',
    data: { type: 'textToImage', label: '雨夜', model: 'doubao-seedream-5-0-pro-260628', generationSizePreset: '1.5K', aspectRatio: '16:9',
      imageOptions: { outputFormat: 'jpeg', promptOptimization: 'fast', watermark: true } } } }] }));
  assert.equal(service.task(task.id).status, 'completed');
  const data = service.canvas('seedream-settings').nodes.find(node => node.id === 'seedream').data;
  assert.equal(data.generationWidth, 2048); assert.equal(data.generationHeight, 1152);
  assert.equal(data.generationSizePreset, '1.5k');
  assert.equal(data.imageOptions.outputFormat, 'jpeg');
});
