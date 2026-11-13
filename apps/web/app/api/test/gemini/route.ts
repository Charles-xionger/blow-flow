import { NextRequest, NextResponse } from "next/server";
import { generateGeminiText } from "@/lib/ai-services/text/gemini";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { model = "gemini-3-flash-preview", prompt } = body;

    if (!prompt) {
      return NextResponse.json(
        { success: false, error: "Prompt is required" },
        { status: 400 },
      );
    }

    console.log("[Gemini Test] Generating text with model:", model);
    console.log("[Gemini Test] Prompt:", prompt);

    const text = await generateGeminiText(model, prompt);

    console.log("[Gemini Test] Generated text:", text);

    return NextResponse.json({
      success: true,
      data: {
        model,
        text,
      },
    });
  } catch (error) {
    console.error("[Gemini Test] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
