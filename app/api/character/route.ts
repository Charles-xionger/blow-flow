import { NextRequest, NextResponse } from "next/server";
import {
  getAllCharacters,
  createCharacter,
  searchCharacters,
} from "@/lib/db/characters";
import type { Character } from "@/types";

/**
 * GET /api/character - 获取所有角色或搜索角色
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const query = searchParams.get("q");

    let characters: Character[];

    if (query) {
      // 搜索模式
      characters = searchCharacters(query);
    } else {
      // 获取所有角色
      characters = getAllCharacters();
    }

    return NextResponse.json({
      success: true,
      data: characters,
    });
  } catch (error: any) {
    console.error("[API] Error fetching characters:", error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Failed to fetch characters",
      },
      { status: 500 },
    );
  }
}

/**
 * POST /api/character - 创建新角色
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      name,
      description,
      referenceImages,
      tags,
      loraModelUrl,
      loraWeight,
      loraStatus,
    } = body;

    // 验证必需字段
    if (!name || !description) {
      return NextResponse.json(
        {
          success: false,
          error: "Name and description are required",
        },
        { status: 400 },
      );
    }

    // 验证参考图数量
    if (!Array.isArray(referenceImages) || referenceImages.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: "At least one reference image is required",
        },
        { status: 400 },
      );
    }

    if (referenceImages.length > 5) {
      return NextResponse.json(
        {
          success: false,
          error: "Maximum 5 reference images allowed",
        },
        { status: 400 },
      );
    }

    // 创建角色
    const character = createCharacter({
      name,
      description,
      referenceImages,
      tags: tags || [],
      loraModelUrl,
      loraWeight,
      loraStatus: loraStatus || "none",
    });

    return NextResponse.json({
      success: true,
      data: character,
    });
  } catch (error: any) {
    console.error("[API] Error creating character:", error);

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
        error: error.message || "Failed to create character",
      },
      { status: 500 },
    );
  }
}
