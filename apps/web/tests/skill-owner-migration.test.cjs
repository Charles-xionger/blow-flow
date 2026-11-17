const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createSkillTestFixture, skillUploadInput } = require('./helpers/skill-test-fixture.cjs');

const fixture = createSkillTestFixture(test, 'skill-owner-migration');
const legacy = new Database(fixture.databasePath);
legacy.exec(`
  CREATE TABLE user_skills (
    name TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    instructions TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE user_skill_resources (
    skill_name TEXT NOT NULL,
    path TEXT NOT NULL,
    content BLOB NOT NULL,
    PRIMARY KEY (skill_name, path),
    FOREIGN KEY (skill_name) REFERENCES user_skills(name) ON DELETE CASCADE
  );
`);
legacy.prepare('INSERT INTO user_skills VALUES (?, ?, ?, ?)').run('legacy-skill', 'Legacy description.', 'Legacy instructions.', 1);
legacy.prepare('INSERT INTO user_skill_resources VALUES (?, ?, ?)').run('legacy-skill', 'guide.txt', Buffer.from('Legacy guide.'));
legacy.close();

const { currentLocalOwner } = fixture.requireApp('lib/auth/current-user.ts');
const { listSkills, readSkill, uploadSkillMarkdown } = fixture.requireApp('lib/agent/skills.ts');

test('existing unowned personal skills migrate to the current local owner without data loss', () => {
  assert.equal(listSkills(currentLocalOwner).find(skill => skill.id === 'legacy-skill').description, 'Legacy description.');
  assert.equal(readSkill('legacy-skill', 'guide.txt', currentLocalOwner), 'Legacy guide.');

  const otherOwner = { ownerId: 'test-owner-after-migration' };
  const markdown = '---\nname: legacy-skill\ndescription: Independent owner.\n---\n\nOther instructions.';
  uploadSkillMarkdown(skillUploadInput(markdown), otherOwner);

  assert.equal(readSkill('legacy-skill', undefined, currentLocalOwner), 'Legacy instructions.');
  assert.equal(readSkill('legacy-skill', undefined, otherOwner), 'Other instructions.');
});
