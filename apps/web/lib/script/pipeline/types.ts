export interface PlannedShot {
  id: string; title: string; duration: number; action: string;
  characters: string[]; scene: string; props: string[];
}
export interface ShotPlan { summary: string; shots: PlannedShot[] }
export interface WorkflowAsset { id: string; kind: 'characters' | 'scene' | 'props'; name: string; description: string }
export interface ShotDetail { id: string; visual: string; size: string; lighting: string; dialogue: string; sound: string; camera: string }
export interface WorkflowStep {
  key: string; label: string; status: 'pending' | 'running' | 'completed' | 'failed'; attempts: number;
  shotIds?: string[]; phase?: string; startedAt?: number; finishedAt?: number; draft?: string; error?: string;
}
export interface StoryboardWorkflow {
  version: 1; steps: WorkflowStep[]; plan?: ShotPlan; assets?: WorkflowAsset[];
  details: Record<string, ShotDetail>; prompts: Record<string, string>;
}
export function newStoryboardWorkflow(): StoryboardWorkflow {
  return { version: 1, steps: [
    { key: 'plan', label: '规划镜头', status: 'pending', attempts: 0 },
    { key: 'assets', label: '整理资产', status: 'pending', attempts: 0 },
    { key: 'prompts', label: '组装提示词', status: 'pending', attempts: 0 },
  ], details: {}, prompts: {} };
}
export function workflowProgress(workflow: StoryboardWorkflow | undefined, completed = false): number {
  if (!workflow) return 0;
  const done = (key: string) => workflow.steps.some(step => step.key === key && step.status === 'completed');
  const total = workflow.plan?.shots.length || 1;
  const value = (done('plan') ? 20 : 0) + (done('assets') ? 20 : 0)
    + 50 * Object.keys(workflow.details).length / total + (done('prompts') ? 10 : 0);
  return Math.min(completed && done('prompts') ? 100 : 99, Math.floor(value));
}
export function workflowStage(workflow: StoryboardWorkflow): string {
  return workflow.steps.filter(step => step.status === 'running').map(step => step.label).join('、')
    || workflow.steps.find(step => step.status === 'failed')?.label
    || workflow.steps.find(step => step.status === 'pending')?.label || '已完成';
}
