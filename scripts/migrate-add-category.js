/**
 * 数据库迁移脚本：为 model_configs 表添加 category 列
 * 运行命令: node scripts/migrate-add-category.js
 */

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

// 数据库路径
const dbPath = process.env.DATABASE_PATH || "./data/canvas.db";

if (!fs.existsSync(dbPath)) {
  console.error(`❌ Database file not found: ${dbPath}`);
  console.error("Please run the app first to create the database.");
  process.exit(1);
}

const db = new Database(dbPath);

console.log("🔧 Starting database migration...");
console.log(`📁 Database: ${dbPath}`);

try {
  // 检查 category 列是否已存在
  const tableInfo = db.pragma("table_info(model_configs)");
  const hasCategoryColumn = tableInfo.some((col) => col.name === "category");

  if (hasCategoryColumn) {
    console.log("✅ Column 'category' already exists in model_configs table.");
  } else {
    console.log("➕ Adding 'category' column to model_configs table...");

    // 添加 category 列，默认值为 'VIDEO'
    db.exec(`
      ALTER TABLE model_configs 
      ADD COLUMN category TEXT DEFAULT 'VIDEO' CHECK(category IN ('IMAGE', 'VIDEO'));
    `);

    console.log("✅ Column 'category' added successfully!");
  }

  // 显示当前表结构
  console.log("\n📋 Current model_configs table structure:");
  const columns = db.pragma("table_info(model_configs)");
  columns.forEach((col) => {
    console.log(
      `  - ${col.name} (${col.type})${col.dflt_value ? ` DEFAULT ${col.dflt_value}` : ""}`,
    );
  });

  // 显示现有记录
  const count = db.prepare("SELECT COUNT(*) as count FROM model_configs").get();
  console.log(`\n📊 Total model configs: ${count.count}`);

  if (count.count > 0) {
    console.log("\n📝 Existing model configs:");
    const configs = db
      .prepare("SELECT model_name, category FROM model_configs")
      .all();
    configs.forEach((config) => {
      console.log(
        `  - ${config.model_name}: ${config.category || "VIDEO (default)"}`,
      );
    });
  }

  console.log("\n✅ Migration completed successfully!");
} catch (error) {
  console.error("❌ Migration failed:", error);
  process.exit(1);
} finally {
  db.close();
}
