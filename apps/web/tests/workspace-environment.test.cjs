const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

for (const development of [true, false]) test('workspace launcher preserves env precedence in ' + (development ? 'development' : 'production'), t => {
 const root = mkdtempSync(path.join(tmpdir(), 'ai-flow-env-'));
 const app = path.join(root, 'web'); mkdirSync(app);
 t.after(() => rmSync(root, {recursive:true, force:true}));
 writeFileSync(path.join(root,'.env'), 'ROOT_ONLY=base\nLAYER=repository\nEXPORTED=repo\n');
 writeFileSync(path.join(root,'.env.development'), 'MODE=development\n');
 writeFileSync(path.join(root,'.env.production'), 'MODE=production\n');
 writeFileSync(path.join(app,'.env'), 'APP_ONLY=app\nLAYER=application\nEXPORTED=app\n');
 const script = 'require(' + JSON.stringify(require.resolve('../scripts/with-env.cjs')) + ').loadEnvironment(' +
  JSON.stringify(root) + ',' + JSON.stringify(app) + ',' + development + ');' +
  'console.log(JSON.stringify(Object.fromEntries(["ROOT_ONLY","APP_ONLY","LAYER","EXPORTED","MODE","DATABASE_PATH"].map(k=>[k,process.env[k]]))))';
 const env = {...process.env,EXPORTED:'shell'};
 for (const key of ['ROOT_ONLY','APP_ONLY','LAYER','MODE','DATABASE_PATH','__NEXT_PROCESSED_ENV']) delete env[key];
 const actual = JSON.parse(execFileSync(process.execPath,['-e',script],{env,encoding:'utf8'}).trim().split('\n').at(-1));
 assert.deepEqual(actual,{ROOT_ONLY:'base',APP_ONLY:'app',LAYER:'application',EXPORTED:'shell',
  MODE:development?'development':'production',DATABASE_PATH:path.join(root,'data/canvas.db')});
});
