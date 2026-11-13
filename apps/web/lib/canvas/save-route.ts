import { NextResponse } from 'next/server';
import { saveWorkflow } from '../db/workflows';
import { CanvasSaveError, validateSaveOperation } from './save-protocol';

export async function handleCanvasSave(request: Request, pathId?: string) {
  try {
    const operation: unknown = await request.json();
    validateSaveOperation(operation);
    if (pathId && pathId !== operation.id) throw new CanvasSaveError('Canvas ID does not match URL');
    return NextResponse.json({ success: true, data: saveWorkflow(operation) });
  } catch (error) {
    const status = error instanceof CanvasSaveError ? error.status : error instanceof SyntaxError ? 400 : 500;
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Save failed' }, { status });
  }
}
