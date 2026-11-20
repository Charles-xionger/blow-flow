import Link from 'next/link';
import { BookOpen, Grid2X2, LockKeyhole } from 'lucide-react';
import { BrandMark } from '@/components/ui/brand-mark';
import { PersonalSpaceMenu } from '@/components/workspace/PersonalSpaceMenu';
import { getSkill, listSkills } from '@/lib/agent/skills';
import { SkillUploadForm } from './SkillUploadForm';
import { SkillDeleteButton } from './SkillDeleteButton';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextRequest } from 'next/server';
import { goAuthorized, goCutoverEnabled } from '@/lib/go-cutover';
import { listBuiltInSkills, getBuiltInSkill, type SkillSummary, type SkillDetail } from '@/lib/agent/skills';
import { currentLocalOwner } from '@/lib/auth/current-user';
import { getSkillUploadLimits } from '@/lib/agent/skill-upload-limits';
import styles from './skills.module.css';

type Props = { searchParams: Promise<{ skill?: string }> };

export default async function PersonalSkillsPage({ searchParams }: Props) {
  let skills: SkillSummary[];
  let selected: SkillDetail;
  const requested = (await searchParams).skill;
  if (goCutoverEnabled()) {
    const cookieHeader = (await cookies()).toString();
    const request = new NextRequest('http://localhost/personal/skills', { headers: { cookie: cookieHeader } });
    const { response } = await goAuthorized(request, '/v1/personal/skills');
    if (!response || response.status === 401) redirect('/login');
    if (!response.ok) throw new Error('无法读取个人技能库');
    skills = [...listBuiltInSkills(), ...await response.json() as SkillSummary[]];
    const id = skills.some(skill => skill.id === requested) ? requested! : skills[0].id;
    const builtIn = getBuiltInSkill(id);
    if (builtIn) selected = builtIn;
    else {
      const detail = await goAuthorized(request, `/v1/personal/skills/${encodeURIComponent(id)}`);
      if (!detail.response?.ok) throw new Error('无法读取创作技能');
      selected = await detail.response.json() as SkillDetail;
    }
  } else {
    skills = listSkills(currentLocalOwner);
    selected = getSkill(skills.some(skill => skill.id === requested) ? requested! : skills[0].id, currentLocalOwner);
  }
  const { packageMb, fileMb, expandedMb } = getSkillUploadLimits();

  return <div className={styles.page}>
    <header className={styles.header}>
      <Link href="/workspace" className={styles.brand} aria-label="Blow Flow 工作空间"><span className={styles.brandMark}><BrandMark /></span>Blow <span className={styles.brandLight}>Flow</span></Link>
      <nav aria-label="主导航"><Link href="/workspace"><Grid2X2 size={17} />工作空间</Link></nav>
      <PersonalSpaceMenu />
    </header>
    <main className={styles.main}>
      <div className={styles.intro}><p>PERSONAL SKILLS</p><h1>个人技能库</h1><span>跨所有项目使用和管理你的创作技能。</span></div>
      <SkillUploadForm limits={{ packageMb, fileMb, expandedMb }} />
      <div className={styles.layout}>
        <section aria-label="创作技能" className={styles.list}>
          <div className={styles.listTitle}><h2>创作技能</h2><span>{skills.length} 项</span></div>
          {skills.map(skill => <Link key={skill.id} href={`/personal/skills?skill=${skill.id}`} aria-current={skill.id === selected.id ? 'page' : undefined}>
            <span className={styles.skillIcon}><BookOpen size={18} /></span>
            <span className={styles.skillCopy}><strong>{skill.name}</strong><code>{skill.id}</code><small>{skill.description}</small><span className={styles.badges}><em>{skill.source}</em>{skill.readOnly && <em><LockKeyhole size={11} />只读</em>}</span></span>
          </Link>)}
        </section>
        <article className={styles.detail}>
          <div className={styles.detailHeader}><div><code>{selected.id}</code><h2>{selected.name}</h2><p>{selected.description}</p></div><div className={styles.detailActions}><span className={styles.detailSource}>{selected.readOnly && <LockKeyhole size={13} />}{selected.readOnly ? '内置 · 只读' : '用户上传'}</span>{!selected.readOnly && <SkillDeleteButton id={selected.id} name={selected.name} />}</div></div>
          <section><h3>完整指令</h3><p className={styles.instructions}>{selected.instructions}</p></section>
          <section><h3>资源清单</h3><div className={styles.resources}>{selected.resources.map(resource => <div key={resource}><code>{resource}</code></div>)}</div></section>
        </article>
      </div>
    </main>
  </div>;
}
