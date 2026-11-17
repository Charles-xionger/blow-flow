import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import styles from './personal-space-menu.module.css';

export function PersonalSpaceMenu() {
  return <details className={styles.wrapper}>
    <summary role="button" className={styles.trigger}><span className={styles.avatar}>P</span><span>个人空间</span></summary>
    <div className={styles.menu} role="menu" aria-label="个人空间">
      <Link role="menuitem" href="/personal/skills"><Sparkles size={15} />创作技能</Link>
    </div>
  </details>;
}
