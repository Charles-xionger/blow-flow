import sharp from 'sharp';
import { readReferenceBody, validReferenceUrl } from '../generation/reference-files';
import type { AgentReference } from './types';
import type { AgentService } from './service';
export async function resolveReference(service: AgentService, projectId: string, reference: AgentReference) {
    let data = reference.data;
    let context = reference.name ?? '用户参考图';
    if (reference.nodeId) {
        const node = service.canvas(projectId).nodes.find((n: {
            id: string;
        }) => n.id === reference.nodeId);
        if (!node)
            throw new Error('Reference node not found');
        context = JSON.stringify({ id: node.id, type: node.type, data: node.data });
        const src = node.data.imageSrc;
        if (typeof src !== 'string')
            return { context };
        const inline = /^data:image\/(?:png|jpeg|webp);base64,([a-zA-Z0-9+/=]+)$/.exec(src);
        if (inline)
            data = inline[1];
        else {
            if (!validReferenceUrl(src))
                throw new Error('Reference must use project asset storage');
            const response = await fetch(src, { redirect: 'error', signal: AbortSignal.timeout(30000) });
            data = (await readReferenceBody(response)).toString('base64');
        }
    }
    if (!data)
        return { context };
    if (data.length > 40000000)
        throw new Error('Reference too large');
    const buffer = await sharp(Buffer.from(data, 'base64'), { limitInputPixels: 40000000 }).resize({ width: 1536, height: 1536, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    return { context, image: { type: 'image' as const, data: buffer.toString('base64'), mimeType: 'image/jpeg' } };
}
