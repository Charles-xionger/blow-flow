import { getDatabase } from "./index";
import crypto from "crypto";

interface CacheOptions {
  ttl?: number; // Time to live in seconds, default 1 hour
}

interface CacheRow {
  cache_key: string;
  model_name: string;
  prompt: string;
  params: string;
  result: string;
  created_at: number;
  expires_at: number;
}

export function getCacheKey(
  modelName: string,
  prompt: string,
  params: unknown,
): string {
  const content = JSON.stringify({ modelName, prompt, params });
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function getCache(cacheKey: string): unknown | null {
  const db = getDatabase();
  const now = Date.now();

  // 删除过期缓存
  db.prepare("DELETE FROM api_cache WHERE expires_at < ?").run(now);

  const stmt = db.prepare(
    "SELECT * FROM api_cache WHERE cache_key = ? AND expires_at > ?",
  );
  const row = stmt.get(cacheKey, now) as CacheRow | undefined;

  if (!row) return null;

  try {
    return JSON.parse(row.result);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (e) {
    return null;
  }
}

export function setCache(
  cacheKey: string,
  modelName: string,
  prompt: string,
  params: unknown,
  result: unknown,
  options: CacheOptions = {},
): void {
  const db = getDatabase();
  const now = Date.now();
  const ttl = options.ttl || 3600; // 默认 1 小时
  const expiresAt = now + ttl * 1000;

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO api_cache 
    (cache_key, model_name, prompt, params, result, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    cacheKey,
    modelName,
    prompt,
    JSON.stringify(params),
    JSON.stringify(result),
    now,
    expiresAt,
  );
}

export function clearExpiredCache(): number {
  const db = getDatabase();
  const now = Date.now();
  const stmt = db.prepare("DELETE FROM api_cache WHERE expires_at < ?");
  const result = stmt.run(now);
  return result.changes;
}

export function clearAllCache(): number {
  const db = getDatabase();
  const stmt = db.prepare("DELETE FROM api_cache");
  const result = stmt.run();
  return result.changes;
}

export function getCacheStats() {
  const db = getDatabase();

  const totalStmt = db.prepare("SELECT COUNT(*) as count FROM api_cache");
  const total = (totalStmt.get() as { count: number }).count;

  const sizeStmt = db.prepare(
    "SELECT SUM(LENGTH(result)) as size FROM api_cache",
  );
  const size = (sizeStmt.get() as { size: number | null }).size || 0;

  const now = Date.now();
  const expiredStmt = db.prepare(
    "SELECT COUNT(*) as count FROM api_cache WHERE expires_at < ?",
  );
  const expired = (expiredStmt.get(now) as { count: number }).count;

  return {
    total,
    expired,
    size,
    sizeFormatted: `${(size / 1024 / 1024).toFixed(2)} MB`,
  };
}
