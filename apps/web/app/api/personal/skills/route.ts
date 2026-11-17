import { NextRequest, NextResponse } from 'next/server';
import { SkillUploadError, uploadSkillMarkdown } from '@/lib/agent/skills';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const declaredSize = Number(request.headers.get('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > 20 * 1024 * 1024) {
      throw new SkillUploadError('整个上传不能超过 20 MB', 413);
    }
    const form = await request.formData();
    const files = form.getAll('file');
    if (files.length !== 1 || !(files[0] instanceof File)) throw new SkillUploadError('请选择一个 SKILL.md 文件');
    const file = files[0];
    const data = uploadSkillMarkdown({
      fileName: file.name,
      content: await file.text(),
      size: file.size,
      totalSize: Number.isFinite(declaredSize) && declaredSize > 0 ? declaredSize : file.size,
    });
    return NextResponse.json({ success: true, data }, { status: 201 });
  } catch (error) {
    const status = error instanceof SkillUploadError ? error.status : error instanceof TypeError ? 400 : 500;
    if (status === 500) console.error('[Personal skills] Upload failed', error);
    return NextResponse.json({ success: false, error: error instanceof SkillUploadError ? error.message : '上传失败，请重试' }, { status });
  }
}
