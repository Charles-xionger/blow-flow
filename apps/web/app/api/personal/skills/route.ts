import { NextRequest, NextResponse } from 'next/server';
import { deleteSkill, SkillUploadError, skillUploadLimit, uploadSkillMarkdown } from '@/lib/agent/skills';
import { parseSkillArchive } from '@/lib/agent/skill-archive';
import { currentLocalOwner } from '@/lib/auth/current-user';

export const runtime = 'nodejs';
const multipartOverheadLimit = 64 * 1024;
const requestBodyLimit = skillUploadLimit + multipartOverheadLimit;

async function readUpload(request: NextRequest) {
  const reader = request.body?.getReader();
  if (!reader) throw new SkillUploadError('请选择一个 SKILL.md 文件');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > requestBodyLimit) {
      await reader.cancel();
      throw new SkillUploadError('整个上传不能超过 20 MB', 413);
    }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
  const copy = new Request(request.url, { method: 'POST', headers: request.headers, body });
  return copy.formData();
}

export async function POST(request: NextRequest) {
  try {
    const declaredSize = Number(request.headers.get('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > requestBodyLimit) {
      throw new SkillUploadError('整个上传不能超过 20 MB', 413);
    }
    const form = await readUpload(request);
    if ([...form.keys()].some(key => key !== 'file') || [...form.entries()].length !== 1) {
      throw new SkillUploadError('只允许上传一个文件');
    }
    const files = form.getAll('file');
    if (files.length !== 1 || !(files[0] instanceof File)) throw new SkillUploadError('请选择一个 SKILL.md 文件');
    const file = files[0];
    const zip = file.name.toLowerCase().endsWith('.zip') || file.type === 'application/zip';
    const archive = zip ? parseSkillArchive(Buffer.from(await file.arrayBuffer())) : undefined;
    const data = uploadSkillMarkdown({
      fileName: archive ? 'SKILL.md' : file.name,
      content: archive?.markdown ?? await file.text(),
      size: archive ? Buffer.byteLength(archive.markdown) : file.size,
      totalSize: file.size,
      resources: archive?.resources,
    }, currentLocalOwner);
    return NextResponse.json({ success: true, data }, { status: 201 });
  } catch (error) {
    const status = error instanceof SkillUploadError ? error.status : error instanceof TypeError ? 400 : 500;
    if (status === 500) console.error('[Personal skills] Upload failed', error);
    return NextResponse.json({ success: false, error: error instanceof SkillUploadError ? error.message : '上传失败，请重试' }, { status });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json() as { id?: unknown };
    if (typeof body.id !== 'string' || !body.id) throw new SkillUploadError('请选择要删除的创作技能');
    deleteSkill(body.id, currentLocalOwner);
    return NextResponse.json({ success: true });
  } catch (error) {
    const status = error instanceof SkillUploadError ? error.status : 400;
    return NextResponse.json({
      success: false,
      error: error instanceof SkillUploadError ? error.message : '删除请求格式无效',
    }, { status });
  }
}
