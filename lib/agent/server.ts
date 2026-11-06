import { registerScriptTools } from './script';
import { registerGenerationTools } from './generation';
import { getDatabase } from '../db';
import { registerCanvasTools } from './canvas';
import { AgentService } from './service';
import { registerReadTools } from './mcp';
export function getAgentService(options: {leaseMs?:number} = {}) { const service = new AgentService(getDatabase(), options); registerReadTools(service); registerCanvasTools(service); registerScriptTools(service); registerGenerationTools(service); return service; }
