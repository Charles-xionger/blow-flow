import type { GenerationConfig, GenerationInput } from './types';
import type { TaskSnapshot } from './service';
import { inspectReference, readReferenceBody, validReferenceUrl } from './reference-files';
/** A minimal adapter to the existing Gemini image service, sharing the durable queue. */
export function geminiImageConfig(): GenerationConfig {
    const connection = { id: 'gemini-images', baseUrl: 'https://generativelanguage.googleapis.com', apiKeyEnv: 'GEMINI_API_KEY', concurrency: 1, requestTimeoutMs: 180000, pollIntervalMs: 5000, queryTimeoutMs: 300000, maxQueryErrors: 1 };
    return {connections:[connection],models:[{ id:'gemini-3-pro-image-preview',name:'Nano Banana Pro (Gemini)',category:'IMAGE',adapter:'gemini-image',version:'1',connectionId:connection.id,
        capabilities:{prompt:true,referenceImages:true,dimensions:{min:64,max:8192,step:8,defaultWidth:1024,defaultHeight:1024},image:{maxImages:8,sizes:['1K','2K','4K'],aspectRatios:['1:1','16:9','9:16','4:3','3:4']}}}]};
}
export function geminiImageParameters(input: GenerationInput) {
    const scale = Math.max(input.width,input.height) / 1024;
    const ratio = ['1:1','16:9','9:16','4:3','3:4'].find(ratio => {const [w,h]=ratio.split(':').map(Number);return input.width*h===input.height*w;});
    if (!ratio || ![1,2,4].includes(scale)) throw new Error('Gemini 图片须使用支持的画幅与 1K/2K/4K 档位（长边 1024/2048/4096）');
    return {aspectRatio:ratio,size:`${scale}K`};
}
export async function generateExistingGeminiImage(snapshot: TaskSnapshot, input: GenerationInput, beforeSubmit: () => void): Promise<string> {
    const { generateGeminiImage, generateGeminiImageToImage } = await import('../ai-services/image/gemini');
    const parameters = geminiImageParameters(input);
    const images = await Promise.all((input.references ?? []).map(async reference => {
        if (reference.kind !== 'image' || !validReferenceUrl(reference.url)) throw new Error('Invalid reference');
        const response = await fetch(reference.url,{signal:AbortSignal.timeout(30000),redirect:'error'});
        const mime = response.headers.get('content-type')?.split(';')[0];
        if (!mime || !['image/png','image/jpeg','image/webp'].includes(mime)) throw new Error('Invalid image reference');
        const bytes = await readReferenceBody(response);
        await inspectReference(bytes, `reference.${mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]}`, 'image');
        return `data:${mime};base64,${bytes.toString('base64')}`;
    }));
    return images.length
        ? generateGeminiImageToImage(snapshot.model.id,input.prompt,images,parameters.aspectRatio,parameters.size,beforeSubmit)
        : generateGeminiImage(snapshot.model.id,input.prompt,parameters.aspectRatio,parameters.size,beforeSubmit);
}
