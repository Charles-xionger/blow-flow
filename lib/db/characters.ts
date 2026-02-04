import { getDatabase } from "./index";
import type { Character } from "@/types";
import { randomUUID } from "crypto";

interface CharacterRow {
  id: string;
  name: string;
  description: string;
  reference_images: string; // JSON string
  tags: string; // JSON string
  lora_model_url: string | null;
  lora_weight: number | null;
  lora_status: string;
  created_at: number;
  updated_at: number;
}

/**
 * 将数据库行转换为 Character 对象
 */
function rowToCharacter(row: CharacterRow): Character {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    referenceImages: JSON.parse(row.reference_images),
    tags: JSON.parse(row.tags),
    loraModelUrl: row.lora_model_url || undefined,
    loraWeight: row.lora_weight || undefined,
    loraStatus: (row.lora_status as Character["loraStatus"]) || "none",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 获取所有角色
 */
export function getAllCharacters(): Character[] {
  const db = getDatabase();
  const stmt = db.prepare("SELECT * FROM characters ORDER BY updated_at DESC");
  const rows = stmt.all() as CharacterRow[];
  return rows.map(rowToCharacter);
}

/**
 * 根据ID获取角色
 */
export function getCharacter(id: string): Character | null {
  const db = getDatabase();
  const stmt = db.prepare("SELECT * FROM characters WHERE id = ?");
  const row = stmt.get(id) as CharacterRow | undefined;
  return row ? rowToCharacter(row) : null;
}

/**
 * 根据名称获取角色
 */
export function getCharacterByName(name: string): Character | null {
  const db = getDatabase();
  const stmt = db.prepare("SELECT * FROM characters WHERE name = ?");
  const row = stmt.get(name) as CharacterRow | undefined;
  return row ? rowToCharacter(row) : null;
}

/**
 * 创建角色
 */
export function createCharacter(
  data: Omit<Character, "id" | "createdAt" | "updatedAt">,
): Character {
  const db = getDatabase();
  const id = randomUUID();
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO characters (
      id, name, description, reference_images, tags,
      lora_model_url, lora_weight, lora_status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    data.name,
    data.description,
    JSON.stringify(data.referenceImages),
    JSON.stringify(data.tags),
    data.loraModelUrl || null,
    data.loraWeight || null,
    data.loraStatus || "none",
    now,
    now,
  );

  return {
    id,
    ...data,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 更新角色
 */
export function updateCharacter(
  id: string,
  data: Partial<Omit<Character, "id" | "createdAt" | "updatedAt">>,
): boolean {
  const db = getDatabase();
  const now = Date.now();

  // 构建动态更新语句
  const updates: string[] = [];
  const values: any[] = [];

  if (data.name !== undefined) {
    updates.push("name = ?");
    values.push(data.name);
  }
  if (data.description !== undefined) {
    updates.push("description = ?");
    values.push(data.description);
  }
  if (data.referenceImages !== undefined) {
    updates.push("reference_images = ?");
    values.push(JSON.stringify(data.referenceImages));
  }
  if (data.tags !== undefined) {
    updates.push("tags = ?");
    values.push(JSON.stringify(data.tags));
  }
  if (data.loraModelUrl !== undefined) {
    updates.push("lora_model_url = ?");
    values.push(data.loraModelUrl || null);
  }
  if (data.loraWeight !== undefined) {
    updates.push("lora_weight = ?");
    values.push(data.loraWeight || null);
  }
  if (data.loraStatus !== undefined) {
    updates.push("lora_status = ?");
    values.push(data.loraStatus);
  }

  if (updates.length === 0) {
    return false; // 没有需要更新的字段
  }

  updates.push("updated_at = ?");
  values.push(now);
  values.push(id);

  const stmt = db.prepare(
    `UPDATE characters SET ${updates.join(", ")} WHERE id = ?`,
  );
  const result = stmt.run(...values);
  return result.changes > 0;
}

/**
 * 删除角色
 */
export function deleteCharacter(id: string): boolean {
  const db = getDatabase();
  const stmt = db.prepare("DELETE FROM characters WHERE id = ?");
  const result = stmt.run(id);
  return result.changes > 0;
}

/**
 * 搜索角色（按名称或标签）
 */
export function searchCharacters(query: string): Character[] {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT * FROM characters 
    WHERE name LIKE ? OR tags LIKE ? OR description LIKE ?
    ORDER BY updated_at DESC
  `);
  const searchTerm = `%${query}%`;
  const rows = stmt.all(searchTerm, searchTerm, searchTerm) as CharacterRow[];
  return rows.map(rowToCharacter);
}
