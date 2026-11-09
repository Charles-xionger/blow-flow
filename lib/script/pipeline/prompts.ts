import type { ScriptInput } from '../types';
import type { PlannedShot, ShotPlan, WorkflowAsset } from './types';
import { defaultStoryboardLimits } from '../storyboard';
import { assetNames } from './outputs';
import { realisticTexture, realisticNegative } from '../reference-art';
const photographicStyle = `未指定其他美术风格时，采用真人实拍摄影质感：${realisticTexture}。避免 ${realisticNegative}；不用 perfect skin、flawless、beauty、model look 美化人物。光线、镜头与景深服从场景和景别，人物近景可用 85mm、f/1.8、柔和窗光；远景和多人镜头须保留必要清晰度。用户明确指定其他风格时遵从用户。`;
const jsonOnly = '只返回一个合法 JSON 对象，不要 Markdown、解释或思考过程。';
export function planPrompt(input: ScriptInput): string {
  const limits = input.storyboard ?? defaultStoryboardLimits;
  return `原始参考：\n${input.references.map(ref => ref.type === 'text' ? `${ref.label}：${ref.content}` : `图片参考：${ref.label}`).join('\n\n')}
用户要求：${input.requirements}\n创作意图：${input.instruction}
${photographicStyle}
summary 必须明确全局视觉风格。
本次只做短片镜头骨架规划，不生成详细对白、技术参数、资产设定或视频提示词。
总时长严格为 ${limits.duration} 秒，最多 ${limits.maxShots} 镜，每镜 1–15 秒整数，时长相加必须等于总时长。合并同场景连续动作，保留起承转合，删减支线而非增加镜头。
同一个角色、场景或道具必须复用统一名称。每镜 action 限 100 字，summary 限 300 字。
${jsonOnly}\n结构：{"summary":"故事摘要与全局视觉风格","shots":[{"title":"短标题","duration":12,"action":"叙事目的和主要动作","characters":["人物名"],"scene":"场景名","props":["道具名"]}]}。无角色或道具时使用空数组。`;
}
export function assetsPrompt(input: ScriptInput, plan: ShotPlan): string {
  return `本次只为固定的资产名称补充统一视觉设定，不修改故事或镜头。
参考：${input.references.filter(ref => ref.type === 'text').map(ref => ref.content).join('\n')}
用户要求：${input.requirements}\n规划：${JSON.stringify(plan)}
必须恰好覆盖这些名称，不得增删或重命名：${JSON.stringify(assetNames(plan))}。
每个 description 限 150 字，人物按年龄、性别、人种、身高体型 → 发型发色、脸型、五官、表情 → 上装、下装、鞋子、配饰的顺序写清身份、外貌与服装，场景写清空间与光线，道具写清外观。区分原文设定与必要补充，保持全局风格一致。
${jsonOnly}\n结构：{"characters":[{"name":"原名称","description":"视觉设定"}],"scene":[{"name":"原名称","description":"视觉设定"}],"props":[{"name":"原名称","description":"视觉设定"}]}。无资产的类别使用空数组。`;
}
export function detailsPrompt(input: ScriptInput, plan: ShotPlan, assets: WorkflowAsset[], shots: PlannedShot[]): string {
  const relevant = assets.filter(asset => shots.some(shot => asset.kind === 'characters' ? shot.characters.includes(asset.name) : asset.kind === 'scene' ? shot.scene === asset.name : shot.props.includes(asset.name)));
  const structure = { shots: shots.map(shot => ({ id: shot.id, visual: '具体画面与动作', size: '景别', lighting: '光影', dialogue: '对白旁白', sound: '音效', camera: '运镜' })) };
  return `${photographicStyle}
将适合本镜头的真实皮肤、发丝、衣料质感与摄影光线写入 visual 和 lighting，不只写“高清”。
本次只完善指定镜头，不增删镜头、不调整时长、不改变资产设定。
用户要求：${input.requirements}\n故事与全局风格：${plan.summary}
衔接概要：${JSON.stringify(plan.shots.map(shot => ({ id: shot.id, action: shot.action })))}
相关资产：${JSON.stringify(relevant)}\n本批镜头：${JSON.stringify(shots)}
必须返回本批全部 ${shots.length} 个镜头，id 依次为 ${shots.map(shot => shot.id).join('、')}，每个恰好一次，不得合并或遗漏。每镜画面描述限 150 字，其他字段简洁；对白长度须能在本镜时长内自然说完，没有对白或音效时填“无”。不生成视频提示词。
${jsonOnly}\n逐项填写以下结构，保留全部条目和原 id：${JSON.stringify(structure)}。`;
}
