import { NextRequest, NextResponse } from "next/server";
import { getOSSClient } from "@/services/ossService";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File;

    if (!file) {
      return NextResponse.json(
        { success: false, error: "No file provided" },
        { status: 400 },
      );
    }

    // 检查文件类型
    if (!file.type.startsWith("image/")) {
      return NextResponse.json(
        { success: false, error: "File must be an image" },
        { status: 400 },
      );
    }

    // 检查文件大小（限制 10MB）
    if (file.size > 10 * 1024 * 1024) {
      return NextResponse.json(
        { success: false, error: "File size exceeds 10MB" },
        { status: 400 },
      );
    }

    // 上传到 OSS
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const oss = getOSSClient();
    const objectKey = oss.generateObjectKey("images", file.name);
    const result = await oss.uploadObject(objectKey, buffer, {
      "Content-Type": file.type,
    });

    return NextResponse.json({
      success: true,
      data: {
        url: result.url,
        objectKey,
        size: file.size,
        filename: file.name,
        contentType: file.type,
      },
    });
  } catch (error) {
    console.error("[API] Image upload error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Upload failed",
      },
      { status: 500 },
    );
  }
}
