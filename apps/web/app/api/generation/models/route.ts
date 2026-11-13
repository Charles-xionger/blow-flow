import { getGenerationService } from '../../../../lib/generation/server';
import { generationHttp } from '../../../../lib/generation/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return generationHttp(request, getGenerationService(), 'models');
}
