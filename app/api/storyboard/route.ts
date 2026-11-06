import { NextRequest, NextResponse } from "next/server";
import { generateText } from "@/lib/ai-services/text";

export async function POST(request: NextRequest) {
  try {
    const { prompt, shotCount = 4, modelName } = await request.json();

    if (!prompt) {
      return NextResponse.json(
        { success: false, error: "Story description is required" },
        { status: 400 },
      );
    }

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

    const { text: content } = await generateText({ model: modelName, prompt: storyboardPrompt, signal: request.signal });

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
