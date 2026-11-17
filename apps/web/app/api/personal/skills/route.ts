import { NextRequest, NextResponse } from 'next/server';
import { SkillUploadError, skillUploadLimit, uploadSkillMarkdown } from '@/lib/agent/skills';

export const runtime = 'nodejs';

async function readUpload(request: NextRequest) {
  const reader = request.body?.getReader();
  if (!reader) throw new SkillUploadError('请选择一个 SKILL.md 文件');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > skillUploadLimit) {
      await reader.cancel();
      throw new SkillUploadError('整个上传不能超过 20 MB', 413);
    }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
  const copy = new Request(request.url, { method: 'POST', headers: request.headers, body });
  return { form: await copy.formData(), size };
}

export async function POST(request: NextRequest) {
  try {
    const declaredSize = Number(request.headers.get('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > skillUploadLimit) {
      throw new SkillUploadError('整个上传不能超过 20 MB', 413);
    }
    const upload = await readUpload(request);
    const form = upload.form;
    const files = form.getAll('file');
    if (files.length !== 1 || !(files[0] instanceof File)) throw new SkillUploadError('请选择一个 SKILL.md 文件');
    const file = files[0];
    const data = uploadSkillMarkdown({
      fileName: file.name,
      content: await file.text(),
      size: file.size,
      totalSize: upload.size,
    });
    return NextResponse.json({ success: true, data }, { status: 201 });
  } catch (error) {
    const status = error instanceof SkillUploadError ? error.status : error instanceof TypeError ? 400 : 500;
    if (status === 500) console.error('[Personal skills] Upload failed', error);
    return NextResponse.json({ success: false, error: error instanceof SkillUploadError ? error.message : '上传失败，请重试' }, { status });
  }
}
