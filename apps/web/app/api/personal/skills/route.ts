import { NextRequest, NextResponse } from 'next/server';
import { deleteSkill, listSkills, listBuiltInSkills, SkillUploadError, uploadSkillMarkdown, validateSkillMarkdown } from '@/lib/agent/skills';
import { parseSkillArchive } from '@/lib/agent/skill-archive';
import { formatSkillUploadLimit, getSkillUploadLimits } from '@/lib/agent/skill-upload-limits';
import { currentLocalOwner } from '@/lib/auth/current-user';
import { goCutoverEnabled, goMapped } from '@/lib/go-cutover';

export const runtime = 'nodejs';
const multipartOverheadLimit = 64 * 1024;

export async function GET(request: NextRequest) {
  if (goCutoverEnabled()) return goMapped(request, "/v1/personal/skills", {}, (value: unknown) => [...listBuiltInSkills(), ...(value as unknown[])], true);
  return NextResponse.json({ data: listSkills(currentLocalOwner) });
}

async function readUpload(request: NextRequest, limits: ReturnType<typeof getSkillUploadLimits>) {
  const requestBodyLimit = limits.packageBytes + multipartOverheadLimit;
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
      throw new SkillUploadError(`技能包不能超过 ${formatSkillUploadLimit(limits.packageMb)}`, 413);
    }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
  const copy = new Request(request.url, { method: 'POST', headers: request.headers, body });
  return copy.formData();
}

export async function POST(request: NextRequest) {
  try {
    const limits = getSkillUploadLimits();
    const requestBodyLimit = limits.packageBytes + multipartOverheadLimit;
    const declaredSize = Number(request.headers.get('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > requestBodyLimit) {
      throw new SkillUploadError(`技能包不能超过 ${formatSkillUploadLimit(limits.packageMb)}`, 413);
    }
    const form = await readUpload(request, limits);
    if ([...form.keys()].some(key => key !== 'file') || [...form.entries()].length !== 1) {
      throw new SkillUploadError('只允许上传一个文件');
    }
    const files = form.getAll('file');
    if (files.length !== 1 || !(files[0] instanceof File)) throw new SkillUploadError('请选择一个 SKILL.md 文件');
    const file = files[0];
    const zip = file.name.toLowerCase().endsWith('.zip') || file.type === 'application/zip';
    const archive = zip ? parseSkillArchive(Buffer.from(await file.arrayBuffer())) : undefined;
    const input = {
      fileName: archive ? 'SKILL.md' : file.name,
      content: archive?.markdown ?? await file.text(),
      size: archive ? Buffer.byteLength(archive.markdown) : file.size,
      totalSize: file.size,
      resources: archive?.resources,
    };
    if (goCutoverEnabled()) {
      const checked = validateSkillMarkdown(input);
      return goMapped(request, '/v1/personal/skills', { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ ...checked, resources: Object.fromEntries([...checked.resources].map(([path, bytes]) => [path, bytes.toString('base64')])) }) }, value => value);
    }
    const data = uploadSkillMarkdown(input, currentLocalOwner);
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
    if (goCutoverEnabled()) {
      if (body.id === 'screenplay' || body.id === 'storyboard') throw new SkillUploadError('内置创作技能不能删除', 403);
      return goMapped(request, `/v1/personal/skills/${encodeURIComponent(body.id)}`, {method:'DELETE'}, () => null, false);
    }
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
