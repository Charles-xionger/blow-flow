require('../../scripts/register-typescript.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const appRoot = path.resolve(__dirname, '../..');

function requireApp(modulePath) {
  const originalLoad = Module._load;
  Module._load = function (id, parent, isMain) {
    if (id.startsWith('@/')) id = path.resolve(appRoot, id.slice(2));
    return originalLoad.call(this, id, parent, isMain);
  };
  try {
    return require(path.resolve(appRoot, modulePath));
  } finally {
    Module._load = originalLoad;
  }
}

function createSkillTestFixture(test, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  process.env.DATABASE_PATH = path.join(directory, 'skills.db');
  test.after(() => {
    requireApp('lib/db/index.ts').closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { databasePath: process.env.DATABASE_PATH, requireApp };
}

function skillUploadInput(markdown, resources) {
  const size = Buffer.byteLength(markdown);
  return { fileName: 'SKILL.md', content: markdown, size, totalSize: size, resources };
}

module.exports = { createSkillTestFixture, skillUploadInput };
