import { NextRequest, NextResponse } from "next/server";
import {
  getCharacter,
  updateCharacter,
  deleteCharacter,
} from "@/lib/db/characters";

/**
 * GET /api/character/[id] - 获取单个角色
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const character = getCharacter(id);

    if (!character) {
      return NextResponse.json(
        {
          success: false,
          error: "Character not found",
        },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      data: character,
    });
  } catch (error: any) {
    console.error("[API] Error fetching character:", error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Failed to fetch character",
      },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/character/[id] - 更新角色
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json();

    // 验证参考图数量（如果提供）
    if (body.referenceImages) {
      if (!Array.isArray(body.referenceImages)) {
        return NextResponse.json(
          {
            success: false,
            error: "referenceImages must be an array",
          },
          { status: 400 },
        );
      }

      if (body.referenceImages.length === 0) {
        return NextResponse.json(
          {
            success: false,
            error: "At least one reference image is required",
          },
          { status: 400 },
        );
      }

      if (body.referenceImages.length > 5) {
        return NextResponse.json(
          {
            success: false,
            error: "Maximum 5 reference images allowed",
          },
          { status: 400 },
        );
      }
    }

    const success = updateCharacter(id, body);

    if (!success) {
      return NextResponse.json(
        {
          success: false,
          error: "Character not found or no changes made",
        },
        { status: 404 },
      );
    }

    // 返回更新后的角色
    const updatedCharacter = getCharacter(id);

    return NextResponse.json({
      success: true,
      data: updatedCharacter,
    });
  } catch (error: any) {
    console.error("[API] Error updating character:", error);

    // 处理唯一性约束错误
    if (error.message?.includes("UNIQUE constraint failed")) {
      return NextResponse.json(
        {
          success: false,
          error: "A character with this name already exists",
        },
        { status: 409 },
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: error.message || "Failed to update character",
      },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/character/[id] - 删除角色
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const success = deleteCharacter(id);

    if (!success) {
      return NextResponse.json(
        {
          success: false,
          error: "Character not found",
        },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      message: "Character deleted successfully",
    });
  } catch (error: any) {
    console.error("[API] Error deleting character:", error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Failed to delete character",
      },
      { status: 500 },
    );
  }
}
