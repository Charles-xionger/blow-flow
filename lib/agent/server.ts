import { getDatabase } from '../db';
import { AgentService } from './service';
import { registerReadTools } from './mcp';
export function getAgentService() { const service = new AgentService(getDatabase()); registerReadTools(service); return service; }
