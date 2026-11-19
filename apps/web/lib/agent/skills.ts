import { parseDocument } from 'yaml';
import { getDatabase } from '../db';
import { currentLocalOwner, type SkillOwnerScope } from '../auth/current-user';
import { formatSkillUploadLimit, getSkillUploadLimits } from './skill-upload-limits';
import { GENERATION_HANDOFF_INSTRUCTION } from './generation-handoff';

export type SkillSummary = {
    id: string;
    name: string;
    description: string;
    source: '内置' | '用户上传';
    readOnly: boolean;
    resources: string[];
};

export type SkillDetail = SkillSummary & {
    instructions: string;
};

const skills = {
    screenplay: {
        name: '剧本创作',
        description: '按创作意图编写剧本、人物与场景对白。',
        instructions: `先理解用户已有素材与目标。仅询问影响故事的关键歧义。依据用户要求编写人物、场景、动作与对白；无需固定长度或强制后续分镜。保留角色动机与因果连贯。如果用户要求执行图片或视频生成，${GENERATION_HANDOFF_INSTRUCTION}。可按需读取 screenplay/format 资源。`,
        resources: { format: '场景标题：地点 / 时间；动作：可视化描述；人物：对白。此格式可按用户目标调整。' },
    },
    storyboard: {
        name: '分镜创作',
        description: '将故事或创意组织成可视化分镜。',
        instructions: `先读取相关剧本或参考素材，可直接根据创意创作，不要求先写剧本。按用户目标组织镜头、景别、构图、动作、声音和衔接。分镜文稿保存在完整的 text 节点中。使用脚本节点时选择 storyboard 预设并连接参考，点击生成即创建相连的文本节点并流式写入，完成后直接编辑文本；无需发布或历史版本管理，下游使用结果文本。不自动拆镜头或连续推进素材制作。不要声称已经生成图片或视频；执行生成必须使用工具并遵守批准。${GENERATION_HANDOFF_INSTRUCTION}。可按需读取 storyboard/shot 资源。`,
        resources: { shot: '每个镜头可包含：编号、场景、景别、主体动作、运镜、时长、声音。只保留对交付有用的字段。' },
    },
} as const;

type SkillId = keyof typeof skills;

type UserSkillRow = { name: string; description: string; instructions: string };
type ResourceRow = { path: string; content?: Buffer };

export class SkillUploadError extends Error {
    constructor(message: string, public status = 400) {
        super(message);
        this.name = 'SkillUploadError';
    }
}

function builtInSkill(id: string) {
    return Object.prototype.hasOwnProperty.call(skills, id) ? skills[id as SkillId] : undefined;
}

function toSkillSummary(id: SkillId): SkillSummary {
    const skill = skills[id];
    return {
        id,
        name: skill.name,
        description: skill.description,
        source: '内置',
        readOnly: true,
        resources: Object.keys(skill.resources),
    };
}

export function listSkills(scope: SkillOwnerScope = currentLocalOwner): SkillSummary[] {
    const builtIn = (Object.keys(skills) as SkillId[]).map(toSkillSummary);
    const uploaded = getDatabase().prepare('SELECT name, description FROM user_skills WHERE owner_id = ? ORDER BY created_at, name').all(scope.ownerId) as UserSkillRow[];
    const resources = getDatabase().prepare('SELECT skill_name, path FROM user_skill_resources WHERE owner_id = ? ORDER BY path').all(scope.ownerId) as { skill_name: string; path: string }[];
    return [...builtIn, ...uploaded.map(skill => ({
        id: skill.name,
        name: skill.name,
        description: skill.description,
        source: '用户上传' as const,
        readOnly: false,
        resources: resources.filter(resource => resource.skill_name === skill.name).map(resource => resource.path),
    }))];
}

export function getSkill(id: string, scope: SkillOwnerScope = currentLocalOwner): SkillDetail {
    const skill = builtInSkill(id);
    if (skill) return { ...toSkillSummary(id as SkillId), instructions: skill.instructions };
    const uploaded = getDatabase().prepare('SELECT name, description, instructions FROM user_skills WHERE owner_id = ? AND name = ?').get(scope.ownerId, id) as UserSkillRow | undefined;
    if (!uploaded) throw new Error(`Unknown skill: 创作技能 ${id} 不再可用`);
    const resources = getDatabase().prepare('SELECT path FROM user_skill_resources WHERE owner_id = ? AND skill_name = ? ORDER BY path').all(scope.ownerId, id) as ResourceRow[];
    return { id: uploaded.name, name: uploaded.name, description: uploaded.description,
        source: '用户上传', readOnly: false, resources: resources.map(resource => resource.path), instructions: uploaded.instructions };
}

export function discoverSkills(scope: SkillOwnerScope = currentLocalOwner) {
    return listSkills(scope).map(({ id, name, description }) => ({ id, name, description }));
}

export function readSkill(id: string, resource?: string, scope: SkillOwnerScope = currentLocalOwner) {
    const skill = builtInSkill(id);
    if (skill) {
        if (!resource) return skill.instructions;
        const value = (skill.resources as Record<string, string>)[resource];
        if (!value) throw new Error('Unknown skill resource');
        return value;
    }
    if (resource) {
        const uploaded = getDatabase().prepare('SELECT content FROM user_skill_resources WHERE owner_id = ? AND skill_name = ? AND path = ?').get(scope.ownerId, id, resource) as ResourceRow | undefined;
        if (!uploaded?.content) throw new Error(`Unknown skill resource: 创作技能 ${id} 或资源 ${resource} 不再可用`);
        return Buffer.from(uploaded.content).toString('utf8');
    }
    return getSkill(id, scope).instructions;
}

export function deleteSkill(id: string, scope: SkillOwnerScope = currentLocalOwner) {
    if (builtInSkill(id)) throw new SkillUploadError('内置创作技能不能删除', 403);
    const db = getDatabase();
    db.transaction(() => {
        // Do not depend on a connection-wide SQLite foreign_keys setting for resource cleanup.
        db.prepare('DELETE FROM user_skill_resources WHERE owner_id = ? AND skill_name = ?').run(scope.ownerId, id);
        const result = db.prepare('DELETE FROM user_skills WHERE owner_id = ? AND name = ?').run(scope.ownerId, id);
        if (!result.changes) throw new SkillUploadError(`创作技能 ${id} 不再可用`, 404);
    }).immediate();
}

const skillName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function uploadSkillMarkdown(input: { fileName: string; content: string; size: number; totalSize: number; resources?: Map<string, Buffer> }, scope: SkillOwnerScope = currentLocalOwner): SkillSummary {
    const limits = getSkillUploadLimits();
    if (input.totalSize > limits.packageBytes) throw new SkillUploadError(`技能包不能超过 ${formatSkillUploadLimit(limits.packageMb)}`, 413);
    if (input.size > limits.fileBytes) throw new SkillUploadError(`SKILL.md 不能超过 ${formatSkillUploadLimit(limits.fileMb)}`, 413);
    if (input.fileName !== 'SKILL.md') throw new SkillUploadError('文件名必须是 SKILL.md');

    const match = input.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) throw new SkillUploadError('SKILL.md 必须包含 YAML frontmatter');
    const document = parseDocument(match[1]);
    if (document.errors.length) throw new SkillUploadError(`YAML frontmatter 格式错误：${document.errors[0].message.split('\n')[0]}`);
    const metadata = document.toJS() as unknown;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new SkillUploadError('YAML frontmatter 必须是对象');
    const { name, description } = metadata as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim()) throw new SkillUploadError('YAML frontmatter 的 name 不能为空');
    if (name !== name.trim() || name.length > 64 || !skillName.test(name)) {
        throw new SkillUploadError('name 格式无效：请使用 1–64 位小写字母、数字和连字符');
    }
    if (typeof description !== 'string' || !description.trim()) throw new SkillUploadError('YAML frontmatter 的 description 不能为空');
    if (description.trim().length > 1024) throw new SkillUploadError('description 不能超过 1024 个字符');
    if (builtInSkill(name)) throw new SkillUploadError(`创作技能 ${name} 已存在`, 409);

    const instructions = input.content.slice(match[0].length).trim();
    if (!instructions) throw new SkillUploadError('SKILL.md 正文不能为空');
    const db = getDatabase();
    try {
        db.transaction(() => {
            db.prepare('INSERT INTO user_skills (owner_id, name, description, instructions, created_at) VALUES (?, ?, ?, ?, ?)')
                .run(scope.ownerId, name, description.trim(), instructions, Date.now());
            const insertResource = db.prepare('INSERT INTO user_skill_resources (owner_id, skill_name, path, content) VALUES (?, ?, ?, ?)');
            for (const [resourcePath, content] of input.resources ?? []) insertResource.run(scope.ownerId, name, resourcePath, content);
        }).immediate();
    } catch (error) {
        if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) throw new SkillUploadError(`创作技能 ${name} 已存在`, 409);
        throw error;
    }
    return { id: name, name, description: description.trim(), source: '用户上传', readOnly: false, resources: [...(input.resources?.keys() ?? [])].sort() };
}
