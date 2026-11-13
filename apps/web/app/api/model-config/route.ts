import { NextRequest, NextResponse } from "next/server";
import {
  getAllModelConfigs,
  getModelConfig,
  saveModelConfig,
  deleteModelConfig,
} from "@/lib/db/model-configs";

// GET: 获取所有模型配置或单个配置
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const modelName = searchParams.get("model");

    if (modelName) {
      const config = getModelConfig(modelName);
      if (!config) {
        return NextResponse.json(
          { success: false, error: "Model config not found" },
          { status: 404 },
        );
      }
      return NextResponse.json({ success: true, data: config });
    }

    const configs = getAllModelConfigs();
    return NextResponse.json({ success: true, data: configs });
  } catch (error) {
    console.error("[API] Get model configs error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to get model configs",
      },
      { status: 500 },
    );
  }
}

// POST: 保存模型配置
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { modelName, config } = body;

    if (!modelName || !config) {
      return NextResponse.json(
        { success: false, error: "Model name and config are required" },
        { status: 400 },
      );
    }

    saveModelConfig(modelName, config);

    return NextResponse.json({
      success: true,
      message: "Model config saved successfully",
    });
  } catch (error) {
    console.error("[API] Save model config error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to save model config",
      },
      { status: 500 },
    );
  }
}

// DELETE: 删除模型配置
export async function DELETE(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const modelName = searchParams.get("model");

    if (!modelName) {
      return NextResponse.json(
        { success: false, error: "Model name is required" },
        { status: 400 },
      );
    }

    const success = deleteModelConfig(modelName);

    if (!success) {
      return NextResponse.json(
        { success: false, error: "Model config not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      message: "Model config deleted successfully",
    });
  } catch (error) {
    console.error("[API] Delete model config error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to delete model config",
      },
      { status: 500 },
    );
  }
}
