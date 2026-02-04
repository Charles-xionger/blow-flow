import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

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

// 关闭数据库连接（优雅退出时调用）
export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

// 在 Next.js 中，开发环境热重载时关闭旧连接
if (process.env.NODE_ENV === "development") {
  const globalForDb = global as typeof globalThis & { db?: Database.Database };
  if (globalForDb.db) {
    globalForDb.db.close();
  }
  globalForDb.db = db;
}
