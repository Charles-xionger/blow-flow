import {test,expect} from '@playwright/test';
import sharp from 'sharp';
test('assistant persists questions, references and background replies after closing the page',async({page,context})=>{
 await page.goto('/canvas');
 await page.locator('.react-flow').dispatchEvent('drop',{dataTransfer:await page.evaluateHandle(()=>{const transfer=new DataTransfer();transfer.setData('application/reactflow-nodetype','text');return transfer;}),clientX:450,clientY:250});
 await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
 const url=page.url();
 await page.getByRole('button',{name:'创作助手',exact:true}).click();
 await expect(page.getByRole('combobox',{name:'助手模型'})).toContainText('测试助手');
 await page.locator('.react-flow__node').first().click();
 await page.getByRole('button',{name:'引用选中节点'}).click();
 const original=await sharp({create:{width:1800,height:1600,channels:4,background:'#ff000080'}}).png().toBuffer();
 const assetUrl='https://browser-fixture.oss-test.aliyuncs.com/images/reference.png';
 await page.route('**/api/upload/image',async route=>{
  expect(route.request().postDataBuffer()!.includes(original)).toBeTruthy();
  await route.fulfill({json:{success:true,data:{url:assetUrl,objectKey:'images/reference.png'}}});
 });
 await page.getByLabel('添加参考图').setInputFiles({name:'character.png',mimeType:'image/png',buffer:original});
 await expect(page.getByRole('button',{name:'参考：character.png ×'})).toBeVisible();
 await page.getByLabel('创作要求').fill('请提问');await page.getByRole('button',{name:'发送',exact:true}).click();
 await expect(page.getByText('故事面向谁？')).toBeVisible();await expect(page.getByLabel('助手消息')).toContainText('参考：');
 await page.reload();await page.getByRole('button',{name:'创作助手',exact:true}).click();await expect(page.getByText('故事面向谁？')).toBeVisible();
 const projectId=new URL(page.url()).searchParams.get('project');
 const persisted=await (await page.request.get(`/api/agent/${projectId}`)).json();
 expect(persisted.messages[0].references).toContainEqual({url:assetUrl,assetId:'images/reference.png',name:'character.png',mimeType:'image/png'});
 await page.getByRole('button',{name:'儿童',exact:true}).click();await expect(page.getByLabel('助手消息')).toContainText('收到：儿童');
 await page.getByLabel('创作要求').fill('在后台继续');await page.getByRole('button',{name:'发送',exact:true}).click();await expect(page.getByLabel('助手消息')).toContainText('在后台继续');
 await page.close();const reopened=await context.newPage();await reopened.goto(url);await reopened.getByRole('button',{name:'创作助手',exact:true}).click();await expect(reopened.getByLabel('助手消息')).toContainText('收到：在后台继续');
 await reopened.getByLabel('创作要求').fill('请提问');await reopened.getByRole('button',{name:'发送',exact:true}).click();await expect(reopened.getByText('故事面向谁？')).toBeVisible();await reopened.getByRole('button',{name:'停止',exact:true}).click();await expect(reopened.getByRole('status').filter({hasText:'已停止'})).toBeVisible();
});
test('assistant can start from an empty project and keeps another project conversation separate',async({page,request})=>{
 await page.goto('/canvas');await page.getByRole('button',{name:'创作助手',exact:true}).click();await expect(page.getByLabel('创作要求')).toBeVisible();
 await page.getByLabel('创作要求').fill('一个新的故事');await page.getByRole('button',{name:'发送',exact:true}).click();await expect(page.getByLabel('助手消息')).toContainText('收到：一个新的故事');
 const second=crypto.randomUUID();await request.post('/api/workspace',{data:{action:'create-project',id:second,folderId:null}});await page.goto(`/canvas?project=${second}`);await page.getByRole('button',{name:'创作助手',exact:true}).click();await expect(page.getByLabel('创作要求')).toBeVisible();await expect(page.getByLabel('助手消息')).not.toContainText('一个新的故事');
});
test('generation batch details survive reopening and can be modified, cancelled and approved',async({page,context})=>{
 await page.goto('/canvas');await page.getByRole('button',{name:'创作助手',exact:true}).click();
 await page.getByLabel('创作要求').fill('测试生成方案');await page.getByRole('button',{name:'发送',exact:true}).click();
 await expect(page.getByLabel('生成方案')).toContainText('猫咪海报');await expect(page.getByLabel('生成方案')).toContainText('1K · 1:1');
 const bytes=await sharp({create:{width:32,height:32,channels:3,background:'red'}}).png().toBuffer();
 await context.route('**/api/canvas-preview?**',route=>route.fulfill({contentType:'image/png',body:bytes}));
 const url=page.url().replace('&assistant=1','');await page.close();const reopened=await context.newPage();await reopened.goto(url);await reopened.getByRole('button',{name:'创作助手',exact:true}).click();
 await expect(reopened.getByRole('button',{name:'确认生成',exact:true})).toBeVisible();
 await reopened.getByLabel('创作要求').fill('测试修改生成：狗狗海报');await reopened.getByRole('button',{name:'回答 / 修改',exact:true}).click();
 await expect(reopened.getByLabel('生成方案')).toContainText('狗狗海报');
 await reopened.getByRole('button',{name:'取消生成',exact:true}).click();await expect(reopened.getByLabel('生成方案')).toHaveCount(0);
 await reopened.getByLabel('创作要求').fill('测试生成方案');await reopened.getByRole('button',{name:'发送',exact:true}).click();await reopened.getByRole('button',{name:'确认生成',exact:true}).click();
 const target = reopened.locator('.react-flow__node[data-id="agent-image"]');
 await target.click();
 await expect(target.getByRole('button',{name:'生成中',exact:true})).toBeDisabled();
 await expect(reopened.getByLabel('生成进度').last()).toContainText('已保存');
 await expect(target.getByRole('button',{name:'生成中',exact:true})).toHaveCount(0);
 await expect.poll(async()=>reopened.evaluate(()=>document.querySelectorAll('.react-flow__node img').length)).toBeGreaterThan(0);
});

test('a real worker restart shows saved progress and resumes only after clicking continue',async({page,request,context})=>{
 await page.goto('/canvas');await page.getByRole('button',{name:'创作助手',exact:true}).click();
 await page.getByLabel('创作要求').fill('测试服务重启');await page.getByRole('button',{name:'发送',exact:true}).click();
 await expect(page.getByLabel('助手消息')).toContainText('进度已保存，等待测试重启');
 expect((await request.post('http://127.0.0.1:3218/restart-agent')).ok()).toBeTruthy();
 await expect(page.getByRole('button',{name:'继续创作',exact:true})).toBeVisible();
 await context.setOffline(true);await page.getByLabel('创作要求').fill('重连前保留输入');await context.setOffline(false);
 await page.reload();
 await expect(page.getByLabel('助手消息')).toContainText('进度已保存，等待测试重启');
 await expect(page.getByLabel('助手消息')).not.toContainText('收到：测试服务重启');
 await page.getByRole('button',{name:'继续创作',exact:true}).click();
 await expect(page.getByLabel('助手消息')).toContainText('收到：测试服务重启');
});

test('idle assistant avoids per-second polling and sending wakes live updates', async ({ page, request }) => {
 const id=crypto.randomUUID();await request.post('/api/workspace',{data:{action:'create-project',id,folderId:null}});
 let reads=0;
 page.on('request',req=>{if(req.method()==='GET'&&new URL(req.url()).pathname===`/api/agent/${id}`)reads++;});
 await page.goto(`/canvas?project=${id}&assistant=1`);
 await expect(page.getByRole('combobox',{name:'助手模型'})).toContainText('测试助手');
 const initial=reads;
 await page.waitForTimeout(3200);
 expect(reads).toBe(initial);
 await page.getByLabel('创作要求').fill('请提问');
 await page.getByRole('button',{name:'发送',exact:true}).click();
 await expect(page.getByText('故事面向谁？')).toBeVisible();
});

test('a slow assistant refresh has no overlapping polls and closing stops requests', async ({ page, request }) => {
 const id=crypto.randomUUID();await request.post('/api/workspace',{data:{action:'create-project',id,folderId:null}});
 let reads=0, hold=false;
 let release!:()=>void;
 const held=new Promise<void>(resolve=>{release=resolve;});
 await page.route(`**/api/agent/${id}`,async route=>{
  reads++;
  if(hold)await held;
  await route.fulfill({json:{tasks:[],messages:[],models:[{id:'test',name:'Slow test',available:true}]}});
 });
 await page.goto(`/canvas?project=${id}&assistant=1`);
 await expect(page.getByRole('combobox',{name:'助手模型'})).toContainText('Slow test');
 const initial=reads;
 hold=true;
 await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
 try {
  await expect.poll(()=>reads).toBe(initial+1);
  await page.waitForTimeout(2200);
  expect(reads).toBe(initial+1);
 } finally { release(); }
 await page.getByRole('button',{name:'关闭创作助手',exact:true}).click();
 await page.waitForTimeout(1200);
 expect(reads).toBe(initial+1);
});

test('assistant composer supports starters, multiline input, IME and compact layouts', async ({page,request})=>{
 const id=crypto.randomUUID();await request.post('/api/workspace',{data:{action:'create-project',id,folderId:null}});
 await page.goto(`/canvas?project=${id}&assistant=1`);
 const panel=page.getByLabel('创作助手对话');
 const input=page.getByLabel('创作要求');
 await expect(page.getByRole('combobox',{name:'助手模型'})).toContainText('测试助手');
 await page.getByRole('button',{name:'写一个故事'}).click();
 await expect(input).toBeFocused();await expect(input).toHaveValue('帮我写一个故事剧本：');
 await input.fill('第一行');await input.press('Shift+Enter');await page.keyboard.insertText('第二行');
 await expect(input).toHaveValue('第一行\n第二行');
 await input.dispatchEvent('keydown',{key:'Enter',isComposing:true});
 await expect(input).toHaveValue('第一行\n第二行');
 await input.press('Enter');
 await expect(page.getByLabel('助手消息')).toContainText('收到：第一行');
 await expect(input).toHaveValue('');
 await page.getByRole('button',{name:'展开宽屏'}).click();
 await expect(panel).toHaveAttribute('data-expanded','true');
 await page.setViewportSize({width:390,height:700});
 await expect(input).toBeVisible();await expect(page.getByRole('button',{name:'发送',exact:true})).toBeVisible();
 const bounds=await panel.boundingBox();expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(390);
 expect(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBeTruthy();
 await page.screenshot({path:'/tmp/ai-flow-agent-mobile.png'});
 await page.setViewportSize({width:1440,height:1000});
 await page.getByRole('button',{name:'收起宽屏'}).click();
 await page.screenshot({path:'/tmp/ai-flow-agent-desktop.png'});
});

test('assistant-ui composer selects skills with dollar or slash, renders tools and retries a failed turn', async ({page,request})=>{
 const id=crypto.randomUUID();await request.post('/api/workspace',{data:{action:'create-project',id,folderId:null}});
 await page.goto(`/canvas?project=${id}&assistant=1`);
 const input=page.getByLabel('创作要求');
 await expect(page.getByRole('combobox',{name:'助手模型'})).toContainText('测试助手');

 await input.fill('$');
 const dollarSkills=page.getByRole('listbox',{name:'选择创作技能'});
 await expect(dollarSkills).toBeVisible();
 await dollarSkills.getByRole('option',{name:/剧本创作/}).click();
 await expect(input).toContainText('剧本创作');
 await input.pressSequentially(' 请写一个短场景');
 await page.getByRole('button',{name:'发送',exact:true}).click();
 await expect(page.getByLabel('助手消息')).toContainText('技能：剧本创作');
 await expect(page.getByLabel('工具调用')).toContainText('read_canvas');
 await expect(page.getByLabel('工具调用')).toContainText('已完成');

 await input.fill('/');
 const slashSkills=page.getByRole('listbox',{name:'选择创作技能'});
 await expect(slashSkills).toBeVisible();
 await slashSkills.getByRole('option',{name:/分镜创作/}).click();
 await expect(input).toContainText('分镜创作');

 await input.fill('测试失败');
 await page.getByRole('button',{name:'发送',exact:true}).click();
 await expect(page.getByText('助手执行失败，请检查平台配置或稍后重试。')).toBeVisible();
 await page.getByRole('button',{name:'重试消息'}).last().click();
 await expect(page.getByLabel('助手消息')).toContainText('收到：测试失败');
});

test('assistant docks beside the canvas, floats, drags and references searchable nodes', async ({page})=>{
 await page.setViewportSize({width:1440,height:1000});
 await page.goto('/canvas');
 await page.locator('.react-flow').dispatchEvent('drop',{dataTransfer:await page.evaluateHandle(()=>{const transfer=new DataTransfer();transfer.setData('application/reactflow-nodetype','text');return transfer;}),clientX:450,clientY:250});
 await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
 await page.getByRole('button',{name:'创作助手',exact:true}).click();
 const panel=page.getByLabel('创作助手对话');
 await expect(panel).toHaveAttribute('data-mode','docked');
 const canvas=await page.locator('.react-flow').boundingBox();const dock=await panel.boundingBox();
 expect(canvas!.x+canvas!.width).toBeLessThanOrEqual(dock!.x+1);
 await page.getByRole('button',{name:'选择节点',exact:true}).click();
 const picker=page.getByLabel('选择画布节点');
 await picker.getByRole('checkbox').first().click();
 await expect(picker.getByRole('checkbox').first()).toBeChecked();
 await page.getByLabel('搜索画布节点').fill('不存在的节点');
 await expect(picker).toContainText('没有匹配的节点');
 await page.getByLabel('搜索画布节点').fill('');
 await picker.getByRole('button',{name:/定位节点/}).first().click();
 await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
 await picker.getByRole('button',{name:'完成',exact:true}).click();
 await expect(panel.getByRole('button',{name:/参考：.* ×/})).toHaveCount(1);
 await page.getByLabel('创作要求').fill('请参考这个节点');
 await page.getByRole('button',{name:'切换为浮动窗口'}).click();
 await expect(panel).toHaveAttribute('data-mode','floating');
 await expect(page.getByLabel('创作要求')).toHaveValue('请参考这个节点');
 const before=await panel.boundingBox();const handle=panel.getByTitle('拖动以移动助手');const bounds=await handle.boundingBox();
 await page.mouse.move(bounds!.x+30,bounds!.y+20);await page.mouse.down();await page.mouse.move(bounds!.x-170,bounds!.y+70,{steps:10});await page.mouse.up();
 const after=await panel.boundingBox();expect(after!.x).toBeLessThan(before!.x-100);expect(after!.y).toBeGreaterThan(before!.y);
 await page.screenshot({path:'/tmp/ai-flow-agent-floating.png'});
 await page.getByRole('button',{name:'停靠到右侧'}).click();
 await expect(panel).toHaveAttribute('data-mode','docked');
 await page.getByRole('button',{name:'发送',exact:true}).click();
 await expect(page.getByLabel('助手消息')).toContainText('参考：');
 await page.screenshot({path:'/tmp/ai-flow-agent-docked.png'});
});
