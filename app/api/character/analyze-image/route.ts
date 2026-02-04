import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

export async function POST(request: NextRequest) {
  try {
    const { imageUrl, prompt } = await request.json();

    if (!imageUrl) {
      return NextResponse.json(
        { success: false, error: "Image URL is required" },
        { status: 400 },
      );
    }

    console.log("[Analyze Image] Starting analysis for:", imageUrl);

    // 初始化 Gemini SDK
    const apiKey = process.env.GEMINI_API_KEY || "";
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY not configured");
    }

    const ai = new GoogleGenAI({ apiKey });

    // 下载图片并转换为 base64
    const imageResponse = await fetch(imageUrl);
    const arrayBuffer = await imageResponse.arrayBuffer();
    const base64Image = Buffer.from(arrayBuffer).toString("base64");

    // 构建分析提示词
    const analysisPrompt = `
请分析这张角色图片，并以 JSON 格式返回以下信息：

原始生成提示词：${prompt || "无"}

请提取：
1. character_name: 为角色起一个合适的中文名字（2-3个字，要有寓意）
2. detailed_description: 详细描述角色的外貌、服装、风格（100-200字，包含年龄、性别、发型、服装、气质等）
3. appearance: 包含 age（年龄段，如"20-25岁"）、gender（性别）、hair（发型发色）、clothing（服装细节）
4. tags: 5-10个关键标签（如：女性、古装、长发、温柔、主角、紫色等）

返回纯 JSON，不要包含任何其他文字和markdown标记：
{
  "character_name": "名字",
  "detailed_description": "详细描述...",
  "appearance": {
    "age": "年龄段",
    "gender": "性别",
    "hair": "发型描述",
    "clothing": "服装描述"
  },
  "tags": ["标签1", "标签2", "标签3", ...]
}
`;

    // 调用 Gemini Vision with @google/genai SDK
    const response = await ai.models.generateContent({
      model: "gemini-3-pro-preview",
      contents: [
        { text: analysisPrompt },
        {
          inlineData: {
            mimeType: "image/jpeg",
            data: base64Image,
          },
        },
      ],
    });

    const responseText = response.text || "";
    console.log("[Analyze Image] Raw response:", responseText);

    // 提取 JSON（处理可能的 markdown 包裹）
    let jsonText = responseText;
    const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      jsonText = jsonMatch[1];
    } else {
      const simpleMatch = responseText.match(/\{[\s\S]*\}/);
      if (simpleMatch) {
        jsonText = simpleMatch[0];
      }
    }

    const analysis = JSON.parse(jsonText);

    console.log("[Analyze Image] Parsed analysis:", analysis);

    return NextResponse.json({
      success: true,
      data: {
        name: analysis.character_name,
        description: analysis.detailed_description,
        tags: analysis.tags,
        appearance: analysis.appearance,
      },
    });
  } catch (error) {
    console.error("[Analyze Image Error]:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to analyze image",
      },
      { status: 500 },
    );
  }
}
