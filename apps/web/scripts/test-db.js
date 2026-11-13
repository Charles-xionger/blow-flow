#!/usr/bin/env node

/**
 * 数据库和缓存功能测试脚本
 * 使用方法: node scripts/test-db.js
 */

const baseUrl = process.env.API_BASE_URL || "http://localhost:3000";

async function testWorkflowAPI() {
  console.log("\n🧪 测试工作流 API...\n");

  // 创建工作流
  console.log("1. 创建工作流...");
  const createResponse = await fetch(`${baseUrl}/api/workflow`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: crypto.randomUUID(), requestId: crypto.randomUUID(), baseVersion: 0,
      snapshot: { name: "测试工作流",
      nodes: [
        {
          id: "1",
          type: "textToImage",
          position: { x: 0, y: 0 },
          data: { label: "Text to Image" },
        },
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      },
    }),
  });
  const created = await createResponse.json();
  console.log("✅ 创建成功:", created.data.id);

  // 获取所有工作流
  console.log("\n2. 获取所有工作流...");
  const listResponse = await fetch(`${baseUrl}/api/workflow`);
  const list = await listResponse.json();
  console.log(`✅ 共 ${list.data.length} 个工作流`);

  // 获取单个工作流
  console.log("\n3. 获取单个工作流...");
  const getResponse = await fetch(`${baseUrl}/api/workflow/${created.data.id}`);
  const workflow = await getResponse.json();
  console.log("✅ 工作流名称:", workflow.data.name);

  // 更新工作流
  console.log("\n4. 更新工作流...");
  const updateResponse = await fetch(
    `${baseUrl}/api/workflow/${created.data.id}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: created.data.id, requestId: crypto.randomUUID(), baseVersion: created.data.version,
        snapshot: { ...workflow.data, name: "更新后的工作流" },
      }),
    },
  );
  const updated = await updateResponse.json();
  console.log("✅ 更新成功:", updated.data.version);

  // 删除工作流
  console.log("\n5. 删除工作流...");
  const deleteResponse = await fetch(
    `${baseUrl}/api/workflow/${created.data.id}`,
    {
      method: "DELETE",
    },
  );
  const deleted = await deleteResponse.json();
  console.log("✅ 删除成功");
}

async function testModelConfigAPI() {
  console.log("\n🧪 测试模型配置 API...\n");

  // 保存模型配置
  console.log("1. 保存模型配置...");
  const saveResponse = await fetch(`${baseUrl}/api/model-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      modelName: "TestModel",
      config: {
        modelId: "test-v1",
        baseUrl: "https://test.api.com",
        key: "test-key",
        endpoint: "/v1/generate",
      },
    }),
  });
  const saved = await saveResponse.json();
  console.log("✅ 保存成功");

  // 获取所有模型配置
  console.log("\n2. 获取所有模型配置...");
  const listResponse = await fetch(`${baseUrl}/api/model-config`);
  const configs = await listResponse.json();
  console.log(`✅ 共 ${Object.keys(configs.data).length} 个模型配置`);

  // 获取单个模型配置
  console.log("\n3. 获取单个模型配置...");
  const getResponse = await fetch(
    `${baseUrl}/api/model-config?model=TestModel`,
  );
  const config = await getResponse.json();
  console.log("✅ 模型ID:", config.data.modelId);

  // 删除模型配置
  console.log("\n4. 删除模型配置...");
  const deleteResponse = await fetch(
    `${baseUrl}/api/model-config?model=TestModel`,
    {
      method: "DELETE",
    },
  );
  const deleted = await deleteResponse.json();
  console.log("✅ 删除成功");
}

async function testCacheAPI() {
  console.log("\n🧪 测试缓存 API...\n");

  // 获取缓存统计
  console.log("1. 获取缓存统计...");
  const statsResponse = await fetch(`${baseUrl}/api/cache`);
  const stats = await statsResponse.json();
  console.log("✅ 缓存统计:");
  console.log(`   - 总条目: ${stats.data.total}`);
  console.log(`   - 过期条目: ${stats.data.expired}`);
  console.log(`   - 总大小: ${stats.data.sizeFormatted}`);

  // 清理过期缓存
  console.log("\n2. 清理过期缓存...");
  const clearResponse = await fetch(`${baseUrl}/api/cache?action=expired`, {
    method: "DELETE",
  });
  const cleared = await clearResponse.json();
  console.log(`✅ 清理了 ${cleared.deletedCount} 个过期条目`);
}

async function testGenerationCache() {
  console.log("\n🧪 测试生成 API 缓存...\n");

  const testPrompt = "a test image for cache";

  // 第一次调用（无缓存）
  console.log("1. 第一次调用图片生成（应该无缓存）...");
  const start1 = Date.now();
  const response1 = await fetch(`${baseUrl}/api/generate/image`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: testPrompt,
      model: "BananaPro",
      count: 1,
    }),
  });
  const result1 = await response1.json();
  const time1 = Date.now() - start1;
  console.log(`✅ 完成 (耗时: ${time1}ms, 缓存: ${result1.cached || false})`);

  // 第二次调用（应该命中缓存）
  console.log("\n2. 第二次调用图片生成（应该命中缓存）...");
  const start2 = Date.now();
  const response2 = await fetch(`${baseUrl}/api/generate/image`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: testPrompt,
      model: "BananaPro",
      count: 1,
    }),
  });
  const result2 = await response2.json();
  const time2 = Date.now() - start2;
  console.log(`✅ 完成 (耗时: ${time2}ms, 缓存: ${result2.cached || false})`);

  if (result2.cached && time2 < time1) {
    console.log(
      `\n🎉 缓存工作正常！速度提升: ${((1 - time2 / time1) * 100).toFixed(2)}%`,
    );
  } else {
    console.log("\n⚠️  缓存未生效或首次调用失败");
  }
}

async function runTests() {
  console.log("=".repeat(60));
  console.log("  SQLite 数据库和缓存功能测试");
  console.log("=".repeat(60));

  try {
    await testWorkflowAPI();
    await testModelConfigAPI();
    await testCacheAPI();

    // 注意：生成 API 缓存测试需要实际的 API 配置
    // 如果没有配置，会失败
    console.log("\n⚠️  生成 API 缓存测试需要配置实际的 API 密钥");
    console.log("如需测试，请配置 .env.local 并取消下面的注释\n");
    // await testGenerationCache();

    console.log("\n" + "=".repeat(60));
    console.log("  ✅ 所有测试通过！");
    console.log("=".repeat(60) + "\n");
  } catch (error) {
    console.error("\n❌ 测试失败:", error.message);
    console.error(error);
    process.exit(1);
  }
}

// 检查服务是否运行
async function checkServer() {
  try {
    const response = await fetch(`${baseUrl}/api/workflow`);
    if (!response.ok) {
      throw new Error("Server returned error status");
    }
    return true;
  } catch (error) {
    console.error("\n❌ 无法连接到服务器:", baseUrl);
    console.error("请确保服务已启动: npm run dev\n");
    process.exit(1);
  }
}

// 运行测试
(async () => {
  await checkServer();
  await runTests();
})();
