import {test,expect} from '@playwright/test';
test('assistant persists questions, references and background replies after closing the page',async({page,context})=>{
 await page.goto('/canvas');
 await page.locator('.react-flow').dispatchEvent('drop',{dataTransfer:await page.evaluateHandle(()=>{const transfer=new DataTransfer();transfer.setData('application/reactflow-nodetype','text');return transfer;}),clientX:450,clientY:250});
 await expect(page.getByTestId('canvas-save-status')).toHaveText('已同步');
 const url=page.url();
 await page.getByRole('button',{name:'创作助手',exact:true}).click();
 await expect(page.getByRole('combobox',{name:'助手模型'})).toContainText('测试助手');
 await page.locator('.react-flow__node').first().click();
 await page.getByRole('button',{name:'引用选中节点'}).click();
 await page.getByLabel('创作要求').fill('请提问');await page.getByRole('button',{name:'发送',exact:true}).click();
 await expect(page.getByText('故事面向谁？')).toBeVisible();await expect(page.getByLabel('助手消息')).toContainText('参考：');
 await page.reload();await page.getByRole('button',{name:'创作助手',exact:true}).click();await expect(page.getByText('故事面向谁？')).toBeVisible();
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
