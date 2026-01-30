import { NextRequest, NextResponse } from "next/server";
import { fetchThirdParty, constructUrl } from "@/lib/ai-services/network";

export async function POST(request: NextRequest) {
  try {
    const { prompt, mode = "IMAGE" } = await request.json();

    if (!prompt) {
      return NextResponse.json(
        { success: false, error: "Prompt is required" },
        { status: 400 },
      );
    }

    const config = {
      baseUrl: process.env.DEFAULT_BASE_URL || "",
      key: process.env.DEFAULT_API_KEY || "",
      modelId: "gemini-2.0-flash-exp",
      endpoint: "/v1/chat/completions",
    };

    const optimizationPrompt = `Optimize this ${mode.toLowerCase()} description for professional AI generation. Input: "${prompt}". Provide ONLY the optimized prompt text.`;

    const payload = {
      model: config.modelId,
      messages: [{ role: "user", content: optimizationPrompt }],
    };

    const url = constructUrl(config.baseUrl, config.endpoint);
    const res = await fetchThirdParty(url, "POST", payload, config.key);

    const optimizedPrompt = res.choices?.[0]?.message?.content || prompt;

    return NextResponse.json({
      success: true,
      data: optimizedPrompt,
    });
  } catch (error) {
    console.error("[API] Prompt optimization error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Optimization failed",
      },
      { status: 500 },
    );
  }
}
