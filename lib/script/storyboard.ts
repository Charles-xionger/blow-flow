import { hasScriptShotHeading, splitScriptShots } from './shots';

export interface StoryboardLimits { duration: number; maxShots: number }
export const defaultStoryboardLimits: StoryboardLimits = { duration: 60, maxShots: 5 };
export const shotFields = [
  ['duration', '时长'], ['visual', '画面描述'], ['size', '景别'], ['lighting', '光影氛围'],
  ['dialogue', '对白旁白'], ['sound', '音效'], ['camera', '运镜'],
  ['characters', '角色'], ['scene', '场景'], ['props', '道具'], ['prompt', '视频提示词'],
] as const;
export type ShotField = typeof shotFields[number][0];
export type StoryboardShot = { title: string } & Record<ShotField, string>;

export function parseStoryboard(text: string): StoryboardShot[] {
  if (!hasScriptShotHeading(text)) return [];
  return splitScriptShots(text).map(block => {
    const shot = Object.fromEntries(shotFields.map(([key]) => [key, ''])) as Record<ShotField, string>;
    const title = block.match(/^## 镜头 \d+[^\r\n]*/m)?.[0].replace(/^## /, '') || '镜头';
    let current: ShotField | undefined;
    for (const line of block.split(/\r?\n/)) {
      const field = shotFields.find(([, label]) => line.startsWith(`${label}：`) || line.startsWith(`${label}:`));
      if (field) { current = field[0]; shot[current] = line.slice(field[1].length + 1).trim(); }
      else if (current && !line.startsWith('## ')) shot[current] += `\n${line}`;
    }
    return { title, ...Object.fromEntries(Object.entries(shot).map(([key, value]) => [key, value.trim()])) } as StoryboardShot;
  });
}

export const shotSeconds = (shot: StoryboardShot) => Number(shot.duration.match(/^\s*(\d+(?:\.\d+)?)\s*(?:秒|s)?\s*$/i)?.[1]) || 0;
export function storyboardProblem(shots: StoryboardShot[], limits: StoryboardLimits): string | undefined {
  if (!shots.length) return '尚未收到有效镜头';
  if (shots.length > limits.maxShots) return `镜头超过 ${limits.maxShots} 个，请合并镜头`;
  if (shots.some(shot => !shotSeconds(shot) || shotSeconds(shot) > 15)) return '每个镜头的时长须大于 0 且不超过 15 秒';
  const total = shots.reduce((sum, shot) => sum + shotSeconds(shot), 0);
  if (Math.abs(total - limits.duration) > 0.1) return `当前合计 ${total} 秒，目标 ${limits.duration} 秒，请调整时长`;
}
export function serializeStoryboard(shots: StoryboardShot[]): string {
  return shots.map((shot, index) => `## 镜头 ${String(index + 1).padStart(3, '0')}｜${shot.title.replace(/^镜头\s*\d+[｜|：:\s]*/, '')}\n${shotFields.map(([key, label]) => `${label}：${shot[key]}`).join('\n')}`).join('\n\n');
}
export function storyboardInstruction(limits: StoryboardLimits): string {
  return `你是一位短片导演，请把故事压缩成能实际拍摄的短片分镜。以下制作约束优先于参考中的原镜头数量和旧任务指令：
总时长必须为 ${limits.duration} 秒；最多 ${limits.maxShots} 个镜头；每个镜头 1–15 秒，所有镜头时长相加必须等于总时长。镜头数是上限，不是越多越好。
先在内部规划起承转合，再写分镜。同一场景内连续的动作、对白和情绪变化尽量合并到一个镜头，仅在叙事转折、场景变化或确实需要换机位时切镜。不要逐句、逐个动作或逐行对白拆镜；篇幅过长时删减支线，不增加镜头。台词长度应符合镜头可用时长，保持人物外貌、服装和场景连续。
只输出镜头正文，不写说明、代码块或表格。每个镜头以独占一行的“## 镜头 001｜简短标题”开头并换行，编号连续。每镜必须逐行填写以下字段，不要使用 Markdown 加粗：
时长：12秒（根据分配填写）
画面描述：可拍摄的具体动作和构图
景别：
光影氛围：
对白旁白：无对白时填“无”
音效：
运镜：
角色：统一角色名称，多个名称用顿号分隔，无则填“无”
场景：统一场景名称
道具：统一道具名称，多个名称用顿号分隔，无则填“无”
视频提示词：整合本镜的画面、人物特征、场景、运镜、光影、时长和声音，形成独立可用的视频生成提示词。`;
}
