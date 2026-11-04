import fs from 'node:fs';
export interface AgentModelConfig {
    id: string;
    name: string;
    modelId: string;
    apiKeyEnv: string;
    baseUrl?: string;
}
/** Administrator-owned config. Public catalog deliberately omits connection details. */
export function agentModels(): AgentModelConfig[] {
    const models: AgentModelConfig[] = process.env.AGENT_CONFIG_PATH ? JSON.parse(fs.readFileSync(process.env.AGENT_CONFIG_PATH, 'utf8')).models : [{ id: 'gemini-flash', name: 'Gemini Flash', modelId: 'gemini-2.5-flash', apiKeyEnv: 'GEMINI_API_KEY' }];
    if (!Array.isArray(models) || models.some(m => !m.id || !m.modelId || !m.apiKeyEnv))
        throw new Error('Invalid administrator Agent configuration');
    return models;
}
export function publicAgentModels() { return agentModels().map(m => ({ id: m.id, name: m.name, available: !!process.env[m.apiKeyEnv] })); }
