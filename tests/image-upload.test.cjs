require('../scripts/register-typescript.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

test('image upload accepts 11–30 MB and rejects larger files before storage', async () => {
  const uploads = [];
  const originalLoad = Module._load;
  Module._load = function (id, parent, isMain) {
    if (id === '@/services/ossService') return { getOSSClient: () => ({
      generateObjectKey: () => 'images/test.png',
      uploadObject: async (_key, buffer) => {
        uploads.push(buffer.length);
        return { url: 'https://storage.test/images/test.png' };
      },
    }) };
    if (id.startsWith('@/')) id = path.resolve(__dirname, '..', id.slice(2));
    return originalLoad.call(this, id, parent, isMain);
  };
  let POST;
  try { ({ POST } = require('../app/api/upload/image/route.ts')); }
  finally { Module._load = originalLoad; }
  for (const size of [11, 30, 31]) {
    const file = new File([Buffer.alloc(size * 1024 * 1024)], 'test.png', { type: 'image/png' });
    const form = new FormData(); form.append('file', file);
    const response = await POST({ formData: async () => form });
    const body = await response.json();
    assert.equal(response.status, size <= 30 ? 200 : 400, JSON.stringify(body));
    if (size <= 30) assert.equal(body.data.size, file.size);
    else assert.match(body.error, /30\s?MB/);
  }
  assert.deepEqual(uploads, [11, 30].map(size => size * 1024 * 1024));
});
