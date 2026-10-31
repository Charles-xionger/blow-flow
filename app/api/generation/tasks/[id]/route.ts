import { getGenerationService } from '../../../../../lib/generation/server';
import { generationHttp } from '../../../../../lib/generation/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return generationHttp(request, getGenerationService(), 'tasks', (await context.params).id);
}
