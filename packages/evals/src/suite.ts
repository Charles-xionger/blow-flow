import { parseStepJSON, validatePlan } from '@ai-flow/web/storyboard-validation';

const shot = { title: '出发', duration: 10, action: '主角走出家门', characters: ['主角'], scene: '街道', props: [] };
export const dataset = [
  { id: 'valid-plan', input: JSON.stringify({ summary: '出发', shots: [shot] }), expectedOutput: true },
  { id: 'fenced-json', input: '\x60\x60\x60json\n' + JSON.stringify({ summary: '出发', shots: [shot] }) + '\n\x60\x60\x60', expectedOutput: true },
  { id: 'invalid-json', input: '{"shots":', expectedOutput: false },
  { id: 'duration-mismatch', input: JSON.stringify({ summary: '出发', shots: [{ ...shot, duration: 9 }] }), expectedOutput: false },
  { id: 'overlong-shot', input: JSON.stringify({ summary: '出发', shots: [{ ...shot, duration: 16 }] }), expectedOutput: false },
  { id: 'missing-asset-list', input: JSON.stringify({ summary: '出发', shots: [{ ...shot, characters: null }] }), expectedOutput: false },
];
export function evaluatePlan(input: string): boolean {
  try { validatePlan(parseStepJSON(input), { duration: 10, maxShots: 1 }); return true; }
  catch { return false; }
}
export function runSuite(task: (input: string) => boolean = evaluatePlan) {
  const items = dataset.map(item => {
    const output = task(item.input);
    return { id: item.id, expected: item.expectedOutput, output, score: Number(output === item.expectedOutput) };
  });
  return { suite: 'storyboard-contract-v1', kind: 'deterministic-regression', items,
    score: items.reduce((sum, item) => sum + item.score, 0) / items.length };
}
