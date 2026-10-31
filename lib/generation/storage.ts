import OSS from 'ali-oss';

// Use the project's existing OSS account, with bounded download/upload and no SDK
// error logging (SDK errors can include signed requests). Task paths are stable.
export async function saveGenerationImage(url: string, taskId: string, index: number): Promise<string> {
  const { OSS_REGION: region, OSS_ACCESS_KEY_ID: accessKeyId, OSS_ACCESS_KEY_SECRET: accessKeySecret, OSS_BUCKET_NAME: bucket } = process.env;
  if (!region || !accessKeyId || !accessKeySecret || !bucket) throw new Error('OSS 未配置');
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error('结果下载失败');
  const content = Buffer.from(await response.arrayBuffer());
  const client = new OSS({ region, accessKeyId, accessKeySecret, bucket, timeout: 60_000 });
  const key = `images/generation/${taskId}/${index}.png`;
  await client.put(key, content, { headers: { 'Content-Type': response.headers.get('content-type') || 'image/png' } });
  return `https://${bucket}.${region}.aliyuncs.com/${key}`;
}
