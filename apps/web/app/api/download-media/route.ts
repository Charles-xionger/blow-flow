import { NextRequest, NextResponse } from "next/server";
import JSZip from "jszip";

interface MediaItem {
  url: string;
  fileName: string;
  type: "image" | "video";
}

export async function POST(request: NextRequest) {
  try {
    const { items }: { items: MediaItem[] } = await request.json();

    if (!items || !Array.isArray(items) || items.length === 0) {
      return NextResponse.json(
        { success: false, error: "No media items provided" },
        { status: 400 },
      );
    }

    console.log(`[DownloadMedia] Starting download for ${items.length} items`);

    const zip = new JSZip();
    let successCount = 0;

    // 下载所有媒体文件并添加到 zip
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        console.log(`[DownloadMedia] Fetching: ${item.url}`);

        // 后端下载文件（绕过 CORS）
        const response = await fetch(item.url, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          },
        });

        if (!response.ok) {
          console.error(
            `[DownloadMedia] Failed to fetch ${item.url}: ${response.status} ${response.statusText}`,
          );
          continue;
        }

        const buffer = await response.arrayBuffer();
        console.log(
          `[DownloadMedia] Downloaded ${buffer.byteLength} bytes for ${item.fileName}`,
        );

        if (buffer.byteLength === 0) {
          console.error(`[DownloadMedia] Empty file: ${item.url}`);
          continue;
        }

        // 添加到 zip
        zip.file(item.fileName, buffer);
        successCount++;
      } catch (error) {
        console.error(`[DownloadMedia] Error downloading ${item.url}:`, error);
      }
    }

    if (successCount === 0) {
      return NextResponse.json(
        { success: false, error: "Failed to download any files" },
        { status: 500 },
      );
    }

    console.log(
      `[DownloadMedia] Successfully added ${successCount}/${items.length} files to zip`,
    );

    // 生成 zip 文件
    const zipBuffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });

    console.log(`[DownloadMedia] Generated zip: ${zipBuffer.length} bytes`);

    // 返回 zip 文件 (将 Buffer 转换为 Uint8Array)
    return new NextResponse(Uint8Array.from(zipBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="media-export-${new Date().toISOString().slice(0, 10)}-${Date.now()}.zip"`,
        "Content-Length": zipBuffer.length.toString(),
      },
    });
  } catch (error) {
    console.error("[DownloadMedia] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
