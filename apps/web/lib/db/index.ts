import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { projectCover } from "../workspace/cover";
import { currentLocalOwnerId } from "../auth/current-user";

let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (db) return db;

  // 确保数据目录存在
  const dbPath = process.env.DATABASE_PATH || "./data/canvas.db";
  const dbDir = path.dirname(dbPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL"); // Write-Ahead Logging for better concurrency

  // 初始化表结构
  initializeTables(db);

  return db;
}

function initializeTables(db: Database.Database) {
  // workflows 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workflows_updated_at ON workflows(updated_at DESC);
  `);

  // Upgrade historical canvases once; preserve all existing content.
  db.transaction(() => {
    const columns = db.prepare("PRAGMA table_info(workflows)").all() as { name: string }[];
    if (!columns.some(column => column.name === "version")) {
      db.exec("ALTER TABLE workflows ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
    }
    if (!columns.some(column => column.name === "deleted_at")) {
      db.exec("ALTER TABLE workflows ADD COLUMN deleted_at INTEGER");
    }
    if (!columns.some(column => column.name === "folder_id")) {
      db.exec("ALTER TABLE workflows ADD COLUMN folder_id TEXT");
    }
    if (!columns.some(column => column.name === "purged_at")) {
      db.exec("ALTER TABLE workflows ADD COLUMN purged_at INTEGER");
    }
    if (!columns.some(column => column.name === "cover_url")) {
      db.exec("ALTER TABLE workflows ADD COLUMN cover_url TEXT");
      db.exec("ALTER TABLE workflows ADD COLUMN node_count INTEGER NOT NULL DEFAULT 0");
      const rows = db.prepare("SELECT id, data FROM workflows").all() as { id: string; data: string }[];
      const update = db.prepare("UPDATE workflows SET cover_url = ?, node_count = ? WHERE id = ?");
      for (const row of rows) {
        const { nodes = [] } = JSON.parse(row.data);
        update.run(projectCover(nodes), nodes.length, row.id);
      }
    }
    db.exec(`CREATE TABLE IF NOT EXISTS project_folders (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workflows_folder ON workflows(folder_id, deleted_at);`);
    db.exec(`CREATE TABLE IF NOT EXISTS canvas_deleted_nodes (canvas_id TEXT NOT NULL, node_id TEXT NOT NULL, PRIMARY KEY(canvas_id,node_id));
    CREATE TABLE IF NOT EXISTS canvas_save_receipts (
      canvas_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      digest TEXT NOT NULL,
      version INTEGER NOT NULL,
      PRIMARY KEY (canvas_id, request_id)
    )`);
  }).immediate();

  // model_configs 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_configs (
      model_name TEXT PRIMARY KEY,
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL,
      model_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      query_endpoint TEXT,
      download_endpoint TEXT,
      category TEXT DEFAULT 'VIDEO' CHECK(category IN ('IMAGE', 'VIDEO')),
      updated_at INTEGER NOT NULL
    );
  `);

  // api_cache 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_cache (
      cache_key TEXT PRIMARY KEY,
      model_name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      params TEXT NOT NULL,
      result TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_api_cache_expires_at ON api_cache(expires_at);
  `);

  // media_files 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_files (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('image', 'video')),
      url TEXT,
      base64_data TEXT,
      size INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  initializeSkillTables(db);

  // characters 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      reference_images TEXT NOT NULL,
      tags TEXT NOT NULL,
      lora_model_url TEXT,
      lora_weight REAL DEFAULT 0.8,
      lora_status TEXT DEFAULT 'none' CHECK(lora_status IN ('none', 'pending', 'training', 'ready', 'failed')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_characters_updated_at ON characters(updated_at DESC);
  `);

  console.log("[DB] Database initialized");
}

function createOwnedSkillTables(db: Database.Database) {
  db.exec(`
    CREATE TABLE user_skills (
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      instructions TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (owner_id, name)
    );
    CREATE TABLE user_skill_resources (
      owner_id TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      path TEXT NOT NULL,
      content BLOB NOT NULL,
      PRIMARY KEY (owner_id, skill_name, path),
      FOREIGN KEY (owner_id, skill_name) REFERENCES user_skills(owner_id, name) ON DELETE CASCADE
    );
  `);
}

function initializeSkillTables(db: Database.Database) {
  const existing = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_skills'").get();
  if (!existing) {
    createOwnedSkillTables(db);
    return;
  }
  const columns = db.prepare('PRAGMA table_info(user_skills)').all() as { name: string }[];
  if (columns.some(column => column.name === 'owner_id')) return;

  db.transaction(() => {
    db.exec(`
      ALTER TABLE user_skill_resources RENAME TO legacy_user_skill_resources;
      ALTER TABLE user_skills RENAME TO legacy_user_skills;
    `);
    createOwnedSkillTables(db);
    db.prepare(`
      INSERT INTO user_skills (owner_id, name, description, instructions, created_at)
      SELECT ?, name, description, instructions, created_at FROM legacy_user_skills
    `).run(currentLocalOwnerId);
    db.prepare(`
      INSERT INTO user_skill_resources (owner_id, skill_name, path, content)
      SELECT ?, skill_name, path, content FROM legacy_user_skill_resources
    `).run(currentLocalOwnerId);
    db.exec(`
      DROP TABLE legacy_user_skill_resources;
      DROP TABLE legacy_user_skills;
    `);
  }).immediate();
}

// 关闭数据库连接（优雅退出时调用）
export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

// 在 Next.js 中，开发环境热重载时关闭旧连接
if (process.env.NODE_ENV === "development") {
  const globalForDb = global as typeof globalThis & {
    db?: Database.Database | null;
  };
  if (globalForDb.db) {
    globalForDb.db.close();
  }
  globalForDb.db = db;
}
