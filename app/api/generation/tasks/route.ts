import { getGenerationService } from '../../../../lib/generation/server';
import { generationHttp } from '../../../../lib/generation/http';
export const runtime = 'nodejs';
export function POST(request: Request) {
  return generationHttp(request, getGenerationService(), 'tasks');
}

export const DELETE = POST;
