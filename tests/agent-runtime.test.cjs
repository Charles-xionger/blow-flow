/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS test fixture. */
const {test}=require('node:test');
const {execFileSync}=require('node:child_process');
const path=require('node:path');
test('real Pi agent executes project tools through real internal MCP with controlled provider output',()=>{
 execFileSync(process.execPath,['--import','tsx',path.join(__dirname,'fixtures/agent-runtime.ts')],{cwd:path.join(__dirname,'..'),stdio:'pipe'});
});

test('uploaded originals persist through real Pi planning into approved image and video references',()=>{
 execFileSync(process.execPath,['--import','tsx',path.join(__dirname,'fixtures/agent-upload.ts')],{cwd:path.join(__dirname,'..'),stdio:'pipe'});
});
