import { registerGenerationTools } from './generation';
import { getDatabase } from '../db';
import { registerCanvasTools } from './canvas';
import { AgentService } from './service';
import { registerReadTools } from './mcp';
export function getAgentService() { const service = new AgentService(getDatabase()); registerReadTools(service); registerCanvasTools(service); registerGenerationTools(service); return service; }
