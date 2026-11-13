import { GenerationError, GenerationService } from './service';

export async function generationHttp(request: Request, service: GenerationService, resource: 'models' | 'tasks' | 'save', id?: string): Promise<Response> {
  try {
    if (resource === 'save') {
      if (request.method === 'POST' && id) return Response.json(service.retrySave(id));
      return Response.json({ error: '不支持的操作' }, { status: 405 });
    }
    if (resource === 'models' && request.method === 'GET') return Response.json(service.models());
    if (request.method === 'DELETE' && resource === 'tasks' && !id) {
      let value;
      try { value = await request.json(); } catch { throw new GenerationError('请求 JSON 无效'); }
      service.deleteNode(value?.canvasId, value?.nodeId);
      return Response.json({ deleted: true });
    }
    if (request.method === 'POST' && resource === 'tasks' && !id) {
      let value: unknown;
      try { value = await request.json(); } catch { throw new GenerationError('请求 JSON 无效'); }
      return Response.json(service.create(value), { status: 201 });
    }
    if (request.method === 'POST' && id) return Response.json(service.resume(id));
    if (request.method === 'GET' && id) return Response.json(service.get(id), { headers: { 'Cache-Control': 'no-store' } });
    return Response.json({ error: '不支持的操作' }, { status: 405 });
  } catch (error) {
    return Response.json({ error: error instanceof GenerationError ? error.message : '生成任务服务不可用' },
      { status: error instanceof GenerationError ? error.status : 500 });
  }
}
