import { NextRequest, NextResponse } from "next/server";
import {
  clearExpiredCache,
  clearAllCache,
  getCacheStats,
} from "@/lib/db/cache";

// GET: 获取缓存统计
export async function GET() {
  try {
    const stats = getCacheStats();
    return NextResponse.json({ success: true, data: stats });
  } catch (error) {
    console.error("[API] Get cache stats error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to get cache stats",
      },
      { status: 500 },
    );
  }
}

// DELETE: 清理缓存
export async function DELETE(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const action = searchParams.get("action") || "expired";

    let deletedCount = 0;

    if (action === "all") {
      deletedCount = clearAllCache();
    } else {
      deletedCount = clearExpiredCache();
    }

    return NextResponse.json({
      success: true,
      message: `Cleared ${deletedCount} cache entries`,
      deletedCount,
    });
  } catch (error) {
    console.error("[API] Clear cache error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to clear cache",
      },
      { status: 500 },
    );
  }
}
