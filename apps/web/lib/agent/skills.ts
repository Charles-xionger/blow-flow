export type SkillSummary = {
    id: string;
    name: string;
    description: string;
    source: '内置';
    readOnly: true;
    resources: string[];
};

export type SkillDetail = SkillSummary & {
    instructions: string;
};

const skills = {
    screenplay: {
        name: '剧本创作',
        description: '按创作意图编写剧本、人物与场景对白。',
        instructions: '先理解用户已有素材与目标。仅询问影响故事的关键歧义。依据用户要求编写人物、场景、动作与对白；无需固定长度或强制后续分镜。保留角色动机与因果连贯。可按需读取 screenplay/format 资源。',
        resources: { format: '场景标题：地点 / 时间；动作：可视化描述；人物：对白。此格式可按用户目标调整。' },
    },
    storyboard: {
        name: '分镜创作',
        description: '将故事或创意组织成可视化分镜。',
        instructions: '先读取相关剧本或参考素材，可直接根据创意创作，不要求先写剧本。按用户目标组织镜头、景别、构图、动作、声音和衔接。分镜文稿保存在完整的 text 节点中。使用脚本节点时选择 storyboard 预设并连接参考，点击生成即创建相连的文本节点并流式写入，完成后直接编辑文本；无需发布或历史版本管理，下游使用结果文本。不自动拆镜头或连续推进素材制作。不要声称已经生成图片或视频；执行生成必须使用工具并遵守批准。可按需读取 storyboard/shot 资源。',
        resources: { shot: '每个镜头可包含：编号、场景、景别、主体动作、运镜、时长、声音。只保留对交付有用的字段。' },
    },
} as const;

type SkillId = keyof typeof skills;

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

export function listSkills(): SkillSummary[] {
    return (Object.keys(skills) as SkillId[]).map(toSkillSummary);
}

export function getSkill(id: string): SkillDetail {
    const skill = skills[id as SkillId];
    if (!skill) throw new Error('Unknown built-in skill');
    return {
        ...toSkillSummary(id as SkillId),
        instructions: skill.instructions,
    };
}

export function discoverSkills() {
    return listSkills().map(({ id, description }) => ({ id, description }));
}

export function readSkill(id: string, resource?: string) {
    const skill = skills[id as SkillId];
    if (!skill) throw new Error('Unknown built-in skill');
    if (!resource) return skill.instructions;
    const value = (skill.resources as Record<string, string>)[resource];
    if (!value) throw new Error('Unknown skill resource');
    return value;
}
