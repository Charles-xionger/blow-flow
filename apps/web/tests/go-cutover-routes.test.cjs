require('../scripts/register-typescript.cjs');
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const Module=require('node:module');
const {NextRequest}=require('next/server');
const originalLoad=Module._load;
Module._load=function(id,parent,isMain){
  if(id.startsWith('@/'))id=path.resolve(__dirname,'..',id.slice(2));
  return originalLoad.call(this,id,parent,isMain);
};
process.env.GO_CUTOVER='1';
process.env.GO_API_URL='http://go.test';
const session=require('../app/api/creator/session/route.ts');
const workflow=require('../app/api/workflow/[id]/route.ts');
const workspace=require('../app/api/workspace/route.ts');
const agent=require('../app/api/agent/[projectId]/route.ts');
Module._load=originalLoad;
after(()=>{delete process.env.GO_CUTOVER;delete process.env.GO_API_URL;});

test('creator login forwards the image challenge and stores only HttpOnly session cookies',async()=>{
  const original=global.fetch;
  let submitted;
  global.fetch=async(url,init)=>{
    assert.equal(url,'http://go.test/v1/auth/user/login');
    submitted=JSON.parse(init.body);
    return new Response(JSON.stringify({accessToken:'access-1',user:{id:'user-1'}}),{status:200,headers:{'Set-Cookie':'blow_flow_user_refresh=refresh-1; Path=/v1/auth/user; HttpOnly; SameSite=Strict'}});
  };
  try{
    const request=new NextRequest('http://localhost/api/creator/session',{method:'POST',headers:{Origin:'http://localhost'},body:JSON.stringify({email:'a@example.com',password:'password',captchaId:'challenge',captchaAnswer:'1234'})});
    const response=await session.POST(request);
    assert.equal(response.status,200);
    assert.equal(submitted.captchaAnswer,'1234');
    const payload=await response.json();
    assert.deepEqual(payload,{user:{id:'user-1'}});
    const cookies=response.headers.get('set-cookie');
    assert.match(cookies,/blow_flow_creator_access=access-1/);
    assert.match(cookies,/blow_flow_creator_refresh=refresh-1/);
    assert.match(cookies,/httponly/i);
    assert.doesNotMatch(JSON.stringify(payload),/access-1|refresh-1/);
  }finally{global.fetch=original;}
});

test('versioned canvas save and Agent send use Go paths with owner token',async()=>{
  const original=global.fetch;
  const calls=[];
  global.fetch=async(url,init)=>{
    calls.push({url,init});
    if(url.endsWith('/canvas'))return Response.json({id:'p',requestId:'r',version:3});
    return Response.json({id:'task',status:'queued'});
  };
  try{
    const cookie='blow_flow_creator_access=token';
    const save=new NextRequest('http://localhost/api/workflow/p',{method:'PUT',headers:{Cookie:cookie},body:JSON.stringify({id:'p',requestId:'r',baseVersion:2,snapshot:{name:'项目',nodes:[],edges:[],viewport:{x:0,y:0,zoom:1}}})});
    const receipt=await workflow.PUT(save,{params:Promise.resolve({id:'p'})});
    assert.deepEqual(await receipt.json(),{success:true,data:{id:'p',requestId:'r',version:3}});
    assert.equal(JSON.parse(calls[0].init.body).baseVersion,2);
    const send=new NextRequest('http://localhost/api/agent/p',{method:'POST',headers:{Cookie:cookie},body:JSON.stringify({action:'send',requestId:'ar',text:'hi',modelId:'gemini',canvasVersion:3})});
    const task=await agent.POST(send,{params:Promise.resolve({projectId:'p'})});
    assert.deepEqual(await task.json(),{id:'task',status:'queued'});
    assert.equal(JSON.parse(calls[1].init.body).canvasVersion,3);
    assert.equal(calls[1].init.headers.Authorization,'Bearer token');
  }finally{global.fetch=original;}
});

test('expired access token refreshes through Go and rotates the browser cookies',async()=>{
  const original=global.fetch;
  const calls=[];
  global.fetch=async(url,init)=>{
    calls.push({url,init});
    if(url.endsWith('/refresh'))return new Response(JSON.stringify({accessToken:'fresh'}),{headers:{'Set-Cookie':'blow_flow_user_refresh=rotated; Path=/v1/auth/user; HttpOnly'}});
    return init.headers.Authorization==='Bearer stale'?Response.json({error:'expired'},{status:401}):Response.json({user:{id:'user-1'}});
  };
  try{
    const request=new NextRequest('http://localhost/api/creator/session',{headers:{Cookie:'blow_flow_creator_access=stale; blow_flow_creator_refresh=previous'}});
    const response=await session.GET(request);
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{user:{id:'user-1'}});
    assert.equal(calls[1].init.headers.Cookie,'blow_flow_user_refresh=previous');
    assert.match(response.headers.get('set-cookie'),/blow_flow_creator_refresh=rotated/);
  }finally{global.fetch=original;}
});

test('workspace reads and new project writes stay on the Go API',async()=>{
  const original=global.fetch;
  const calls=[];
  global.fetch=async(url,init)=>{
    calls.push({url,init});
    if(init.method==='POST')return Response.json({id:'new-project',version:1},{status:201});
    return Response.json({projects:[{id:'p',name:'旧项目',folderId:null,nodeCount:2,version:5,createdAt:'2026-11-19T00:00:00Z',updatedAt:'2026-11-19T01:00:00Z'}],folders:[]});
  };
  try{
    const headers={Cookie:'blow_flow_creator_access=token',Origin:'http://localhost'};
    const listing=await workspace.GET(new NextRequest('http://localhost/api/workspace',{headers}));
    assert.equal((await listing.json()).data.projects[0].updatedAt,Date.parse('2026-11-19T01:00:00Z'));
    const create=new NextRequest('http://localhost/api/workspace',{method:'POST',headers,body:JSON.stringify({action:'create-project',id:'new-project',folderId:null})});
    assert.deepEqual(await (await workspace.POST(create)).json(),{success:true,data:{id:'new-project'}});
    assert.deepEqual(calls.map(call=>call.url),['http://go.test/v1/workspace','http://go.test/v1/projects']);
  }finally{global.fetch=original;}
});

test('same-origin writes accept the browser Host even when Next normalizes nextUrl to localhost',async()=>{
  const original=global.fetch;
  global.fetch=async()=>Response.json({id:'local-project',version:1},{status:201});
  try{
    const body=JSON.stringify({action:'create-project',id:'local-project',folderId:null});
    const valid=new NextRequest('http://localhost:3220/api/workspace',{method:'POST',headers:{Host:'127.0.0.1:3220',Origin:'http://127.0.0.1:3220',Cookie:'blow_flow_creator_access=token'},body});
    assert.equal((await workspace.POST(valid)).status,200);
    const invalid=new NextRequest('http://localhost:3220/api/workspace',{method:'POST',headers:{Host:'127.0.0.1:3220',Origin:'http://attacker.test',Cookie:'blow_flow_creator_access=token'},body});
    assert.equal((await workspace.POST(invalid)).status,403);
  }finally{global.fetch=original;}
});
