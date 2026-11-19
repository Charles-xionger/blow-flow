import { getDatabase } from '../../../../../lib/db';

import { getGenerationService } from '../../../../../lib/generation/server';
import { generationLabel } from '../../../../../lib/generation/client';
import { NextRequest, NextResponse } from 'next/server';
import { creatorAccess, goAuthorized, goCutoverEnabled, goPublic, setCreatorCookies } from '../../../../../lib/go-cutover';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Progress is transient; it must not advance the saved canvas revision.
// The browser fetches the full canvas only when this revision changes.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if(goCutoverEnabled()){
    const path=`/v1/projects/${encodeURIComponent(id)}`;
    const initial=await goAuthorized(request,path).catch(()=>undefined);
    if(!initial?.response?.ok)return NextResponse.json({error:'请先登录或项目不存在'},{status:initial?.response?.status??503});
    const token=initial.refreshed?.access??creatorAccess(request);
    if(!token)return NextResponse.json({error:'请先登录'},{status:401});
    const encoder=new TextEncoder();
    const stream=new ReadableStream<Uint8Array>({start(controller){
      let closed=false;let previous:number|undefined;let heartbeat=Date.now();
      const close=()=>{if(closed)return;closed=true;clearInterval(timer);request.signal.removeEventListener('abort',close);try{controller.close();}catch{}};
      const poll=async()=>{if(closed)return;try{
        const response=await goPublic(path,{headers:{Authorization:`Bearer ${token}`}});
        if(!response.ok){close();return;}
        const project=await response.json() as {version:number};
        const message=project.version!==previous?`data: ${project.version}\n\n`:Date.now()-heartbeat>10000?': heartbeat\n\n':'';
        if(message){if((controller.desiredSize??0)<=0){close();return;}controller.enqueue(encoder.encode(message));previous=project.version;heartbeat=Date.now();}
      }catch{close();}};
      const timer=setInterval(()=>{void poll();},3000);
      request.signal.addEventListener('abort',close,{once:true});void poll();
    }});
    const response=new NextResponse(stream,{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','X-Accel-Buffering':'no'}});
    if(initial.refreshed)setCreatorCookies(response,initial.refreshed.access,initial.refreshed.refresh);
    return response;
  }
  const query = getDatabase().prepare('SELECT version, deleted_at FROM workflows WHERE id = ?');
  const generation = getGenerationService();
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      let previous: number | null | undefined;
      let previousProgress: string | undefined;
      let heartbeat = Date.now();
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        request.signal.removeEventListener('abort', close);
        controller.close();
      };
      cleanup = () => {
        closed = true;
        clearInterval(timer);
        request.signal.removeEventListener('abort', close);
      };
      const check = () => {
        if (closed) return;
        try {
          const row = query.get(id) as { version: number; deleted_at: number | null } | undefined;
          const version = row && row.deleted_at === null ? row.version : null;
          const progress = JSON.stringify(Object.fromEntries((version === null ? [] : generation.activeAgentProgress(id))
            .map(task => [task.nodeId, generationLabel(task)])));
          let message = version !== previous ? `data: ${JSON.stringify(version)}\n\n` : '';
          if (progress !== previousProgress) message += `event: agent-progress\ndata: ${progress}\n\n`;
          if (!message && Date.now() - heartbeat >= 10_000) message = ': heartbeat\n\n';
          if (!message) return;
          if ((controller.desiredSize ?? 0) <= 0) { close(); return; }
          controller.enqueue(encoder.encode(message));
          previous = version;
          previousProgress = progress;
          heartbeat = Date.now();
        } catch { close(); }
      };
      if (request.signal.aborted) { close(); return; }
      request.signal.addEventListener('abort', close, { once: true });
      check();
      if (!closed) timer = setInterval(check, 1000);
    },
    cancel() { cleanup(); },
  }, { highWaterMark: 16 });
  return new Response(stream, { headers: {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no',
  } });
}
