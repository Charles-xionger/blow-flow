const skills = {
    screenplay: { description: '按创作意图编写剧本、人物与场景对白。', instructions: '先理解用户已有素材与目标。仅询问影响故事的关键歧义。依据用户要求编写人物、场景、动作与对白；无需固定长度或强制后续分镜。保留角色动机与因果连贯。可按需读取 screenplay/format 资源。', resources: { format: '场景标题：地点 / 时间；动作：可视化描述；人物：对白。此格式可按用户目标调整。' } },
    storyboard: { description: '将故事或创意组织成可视化分镜。', instructions: '先读取相关剧本或参考素材，可直接根据创意创作，不要求先写剧本。按用户目标组织镜头、景别、构图、动作、声音和衔接。每个镜头写入独立的 text 节点，并列布局，使用编号表达镜头顺序，禁止用镜头间的串联连线表示顺序。有来源节点时，来源分别连接到每个镜头；否则不添加连线。不要声称已经生成图片或视频；执行生成必须使用工具并遵守批准。可按需读取 storyboard/shot 资源。', resources: { shot: '每个镜头可包含：编号、场景、景别、主体动作、运镜、时长、声音。只保留对交付有用的字段。' } },
};
export function discoverSkills() { return Object.entries(skills).map(([id, s]) => ({ id, description: s.description })); }
export function readSkill(id: string, resource?: string) { const skill = skills[id as keyof typeof skills]; if (!skill)
    throw new Error('Unknown built-in skill'); if (!resource)
    return skill.instructions; const value = (skill.resources as Record<string, string>)[resource]; if (!value)
    throw new Error('Unknown skill resource'); return value; }
