import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const { baseUrl, apiKey } = await request.json();

    if (!baseUrl || !apiKey) {
      return NextResponse.json(
        { success: false, error: "缺少 Base URL 或 API Key" },
        { status: 400 },
      );
    }

    // 针对不同平台使用不同的测试端点
    let testUrl: string;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    const cleanBaseUrl = baseUrl.replace(/\/$/, "");

    // 根据 baseUrl 判断平台类型
    if (cleanBaseUrl.includes("dashscope.aliyuncs.com")) {
      // 阿里云百炼：使用兼容模式的模型列表查询
      testUrl = `${cleanBaseUrl}/compatible-mode/v1/models`;
    } else {
      // 其他平台：使用标准 OpenAI API 端点
      testUrl = `${cleanBaseUrl}/v1/models`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(testUrl, {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // 认为 2xx, 400, 401, 403 都是连接成功（说明能连到服务器）
      if (
        response.ok ||
        response.status === 400 ||
        response.status === 401 ||
        response.status === 403
      ) {
        return NextResponse.json({
          success: true,
          message: "连接成功",
          status: response.status,
        });
      } else {
        return NextResponse.json(
          {
            success: false,
            error: `连接失败`,
            status: response.status,
          },
          { status: 200 }, // 返回 200 但标记为失败
        );
      }
    } catch (fetchError: any) {
      clearTimeout(timeoutId);

      if (fetchError.name === "AbortError") {
        return NextResponse.json(
          { success: false, error: "连接超时" },
          { status: 200 },
        );
      }

      return NextResponse.json(
        { success: false, error: fetchError.message },
        { status: 200 },
      );
    }
  } catch (error) {
    console.error("[API] Test connection error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "测试失败",
      },
      { status: 500 },
    );
  }
}
