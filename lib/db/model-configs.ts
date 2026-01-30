import { getDatabase } from "./index";
import type { ModelConfig } from "@/types";

interface ModelConfigRow {
  model_name: string;
  base_url: string;
  api_key: string;
  model_id: string;
  endpoint: string;
  query_endpoint: string | null;
  download_endpoint: string | null;
  updated_at: number;
}

export function getAllModelConfigs(): Record<string, ModelConfig> {
  const db = getDatabase();
  const stmt = db.prepare("SELECT * FROM model_configs");
  const rows = stmt.all() as ModelConfigRow[];

  const configs: Record<string, ModelConfig> = {};
  for (const row of rows) {
    configs[row.model_name] = {
      modelId: row.model_id,
      baseUrl: row.base_url,
      key: row.api_key,
      endpoint: row.endpoint,
      queryEndpoint: row.query_endpoint || undefined,
      downloadEndpoint: row.download_endpoint || undefined,
    };
  }

  return configs;
}

export function getModelConfig(modelName: string): ModelConfig | null {
  const db = getDatabase();
  const stmt = db.prepare("SELECT * FROM model_configs WHERE model_name = ?");
  const row = stmt.get(modelName) as ModelConfigRow | undefined;

  if (!row) return null;

  return {
    modelId: row.model_id,
    baseUrl: row.base_url,
    key: row.api_key,
    endpoint: row.endpoint,
    queryEndpoint: row.query_endpoint || undefined,
    downloadEndpoint: row.download_endpoint || undefined,
  };
}

export function saveModelConfig(modelName: string, config: ModelConfig): void {
  const db = getDatabase();
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO model_configs 
    (model_name, base_url, api_key, model_id, endpoint, query_endpoint, download_endpoint, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    modelName,
    config.baseUrl,
    config.key,
    config.modelId,
    config.endpoint,
    config.queryEndpoint || null,
    config.downloadEndpoint || null,
    now,
  );
}

export function deleteModelConfig(modelName: string): boolean {
  const db = getDatabase();
  const stmt = db.prepare("DELETE FROM model_configs WHERE model_name = ?");
  const result = stmt.run(modelName);
  return result.changes > 0;
}
