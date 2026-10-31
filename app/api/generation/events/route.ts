import { getGenerationService } from '../../../../lib/generation/server';
import { generationEvents } from '../../../../lib/generation/events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(request: Request) {
  return generationEvents(request, getGenerationService());
}
