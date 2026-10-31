import { getGenerationService } from '../../../../../../lib/generation/server';
import { generationHttp } from '../../../../../../lib/generation/http';
export const runtime = 'nodejs';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return generationHttp(request, getGenerationService(), 'save', (await context.params).id);
}
