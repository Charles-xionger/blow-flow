require('../scripts/register-typescript.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeEvent } = require('../lib/telemetry/sanitize');
test('Sentry keeps stack frames and correlation but removes content and credentials', () => {
 const event = sanitizeEvent({
  message:'prompt', request:{headers:{authorization:'secret'}}, user:{email:'private'}, extra:{media:'base64'},
  breadcrumbs:[{message:'prompt'}], contexts:{prompt:'private'},
  tags:{service:'web',request_id:'id',token:'secret'},
  exception:{values:[{value:'private prompt',stacktrace:{frames:[{function:'generate'}]}}]},
 });
 assert.deepEqual(event, {
  tags:{service:'web',request_id:'id'},
  exception:{values:[{value:'[redacted]',stacktrace:{frames:[{function:'generate'}]}}]},
 });
});
