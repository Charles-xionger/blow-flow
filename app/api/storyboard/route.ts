import { NextRequest, NextResponse } from "next/server";
import { fetchThirdParty, constructUrl } from "@/lib/ai-services/network";
import { getAllModelConfigs } from "@/lib/db/model-configs";
import { GoogleGenAI } from "@google/genai";
import { getModelsByCategory } from "@/lib/model-registry";

export async function POST(request: NextRequest) {
  try {
    const { prompt, shotCount = 4, modelName } = await request.json();

    if (!prompt) {
      return NextResponse.json(
        { success: false, error: "Story description is required" },
        { status: 400 },
      );
    }

    console.log("[API] Requested model:", modelName);

    // 获取可用的 TEXT 模型定义（从 model-registry）
    const textModelDefinitions = getModelsByCategory("TEXT");

    // 确定要使用的模型
    let selectedModelDef = textModelDefinitions.find(
      (m) => m.name === modelName,
    );

    // 如果没有指定或找不到，使用第一个 Gemini 模型
    if (!selectedModelDef) {
      selectedModelDef =
        textModelDefinitions.find(
          (m) =>
            m.provider === "gemini" || m.name.toLowerCase().includes("gemini"),
        ) || textModelDefinitions[0];
    }

    if (!selectedModelDef) {
      return NextResponse.json(
        {
          success: false,
          error: "No text model available. Please check model configuration.",
        },
        { status: 400 },
      );
    }

    console.log(
      "[API] Using model:",
      selectedModelDef.name,
      "ID:",
      selectedModelDef.id,
    );

    // 英文 prompt，要求拆分合理的结构
    const storyboardPrompt = `You are a professional cinematographer and storyboard artist. Break down the following story/scene description into ${shotCount} distinct shots.

Story Description:
${prompt}

Requirements:
1. Each shot should be a complete, independent visual scene
2. Include detailed visual descriptions (characters, actions, environment, lighting, color tone, camera angle, movement)
3. Maintain narrative continuity and flow
4. Make descriptions suitable for AI image/video generation
5. Use professional cinematography terminology
6. Consider shot composition, framing, and visual storytelling

Output Format (JSON only, no additional text):
{
  "shots": [
    {
      "shotNumber": 1,
      "title": "Shot title describing the scene",
      "description": "Detailed shot description suitable for AI generation, including: subject, action, camera angle (e.g., wide shot, close-up, aerial view), lighting (e.g., golden hour, soft diffused light), mood (e.g., dramatic, serene), and any specific visual elements",
      "duration": "suggested duration in seconds (for video)",
      "cameraMovement": "static/pan/tilt/dolly/etc"
    }
  ]
}`;

    let content = "";

    // 如果是 Gemini 模型，使用 Google AI SDK
    if (selectedModelDef.provider === "gemini") {
      const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;

      if (!apiKey) {
        return NextResponse.json(
          {
            success: false,
            error:
              "Google API Key not configured. Please set GOOGLE_API_KEY or GEMINI_API_KEY in environment variables.",
          },
          { status: 500 },
        );
      }

      console.log("[API] Using Google AI SDK for Gemini model");

      // 使用新的 GoogleGenAI SDK
      const ai = new GoogleGenAI({ apiKey });

      // 重试逻辑：处理 503 等临时错误
      let lastError: any;
      const maxRetries = 3;
      const baseDelay = 2000; // 2秒

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const response = await ai.models.generateContent({
            model: selectedModelDef.id,
            contents: storyboardPrompt,
          });

          content = response.text || "";
          console.log("[API] Gemini response received");
          break; // 成功，退出重试循环
        } catch (error: any) {
          lastError = error;
          const isRetryable =
            error.status === 503 || // Service Unavailable
            error.status === 429 || // Rate Limit
            error.status === 500 || // Internal Server Error
            error.code === "ECONNRESET" ||
            error.code === "ETIMEDOUT";

          if (isRetryable && attempt < maxRetries) {
            const delay = baseDelay * Math.pow(2, attempt - 1); // 指数退避
            console.log(
              `[API] Retry attempt ${attempt}/${maxRetries} after ${delay}ms (Error: ${error.status || error.code})`,
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
          } else {
            // 非重试错误或已达到最大重试次数
            throw error;
          }
        }
      }

      if (!content) {
        throw lastError || new Error("Failed to generate content");
      }
    } else {
      // 对于其他模型，从数据库获取配置
      const allConfigs = getAllModelConfigs();
      const modelConfig = allConfigs[selectedModelDef.name];

      if (!modelConfig) {
        return NextResponse.json(
          {
            success: false,
            error: `Model "${selectedModelDef.name}" not configured in database. Please configure it in settings.`,
          },
          { status: 400 },
        );
      }

      console.log(
        "[API] Using database config for model:",
        selectedModelDef.name,
      );

      const config = {
        baseUrl: modelConfig.baseUrl,
        key: modelConfig.key,
        modelId: modelConfig.modelId,
        endpoint: modelConfig.endpoint || "/v1/chat/completions",
      };

      const payload = {
        model: config.modelId,
        messages: [{ role: "user", content: storyboardPrompt }],
        temperature: 0.7,
      };

      const url = constructUrl(config.baseUrl, config.endpoint);
      const res = await fetchThirdParty(url, "POST", payload, config.key);

      content = res.choices?.[0]?.message?.content || "";
    }

    // 提取 JSON（处理可能的 markdown 代码块）
    let jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    let jsonStr = jsonMatch ? jsonMatch[1] : content;

    // 如果还没找到 JSON，尝试直接解析
    if (!jsonStr.includes('"shots"')) {
      jsonMatch = content.match(/\{[\s\S]*"shots"[\s\S]*\}/);
      jsonStr = jsonMatch ? jsonMatch[0] : content;
    }

    try {
      const result = JSON.parse(jsonStr);

      if (!result.shots || !Array.isArray(result.shots)) {
        throw new Error("Invalid response format");
      }

      return NextResponse.json({
        success: true,
        data: result.shots,
      });
    } catch (parseError) {
      console.error("[API] Failed to parse storyboard response:", parseError);
      console.error("Raw content:", content);

      return NextResponse.json(
        {
          success: false,
          error: "Failed to parse AI response",
          rawContent: content,
        },
        { status: 500 },
      );
    }
  } catch (error) {
    console.error("[API] Storyboard generation error:", error);

    // 提供更友好的错误信息
    let errorMessage = "Storyboard generation failed";
    let statusCode = 500;

    if (error instanceof Error) {
      const errorAny = error as any;

      // Google API 特定错误
      if (errorAny.status === 503) {
        errorMessage =
          "Google AI service is temporarily overloaded. Please try again in a few moments.";
        statusCode = 503;
      } else if (errorAny.status === 429) {
        errorMessage = "API rate limit exceeded. Please wait before retrying.";
        statusCode = 429;
      } else if (errorAny.status === 401 || errorAny.status === 403) {
        errorMessage =
          "API authentication failed. Please check your API key configuration.";
        statusCode = 401;
      } else if (errorAny.status === 400) {
        errorMessage = `Invalid request: ${error.message}`;
        statusCode = 400;
      } else {
        errorMessage = error.message;
      }
    }

    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
      },
      { status: statusCode },
    );
  }
}
