'use client';
import { useEffect, useId, useRef } from 'react';
import type { Container } from '@tsparticles/engine';

let engine: Promise<typeof import('@tsparticles/engine')['tsParticles']> | undefined;
function loadEngine() {
  return engine ??= Promise.all([import('@tsparticles/engine'),import('@tsparticles/slim')]).then(async ([{ tsParticles },{ loadSlim }]) => { await loadSlim(tsParticles); return tsParticles; });
}
/** Engine is loaded only for active, on-screen nodes; the library owns particle simulation. */
export default function ScriptParticles() {
  const element = useRef<HTMLDivElement>(null);
  const id = useId().replace(/:/g,'');
  useEffect(() => {
    const host = element.current;
    if (!host) return;
    let container: Container | undefined;
    let disposed = false; let visible = false; let starting = false;
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const update = async () => {
      if (!visible || media.matches || document.hidden) { container?.pause(); return; }
      if (container) { container.play(); return; }
      if (starting) return;
      starting = true;
      try {
        const particles = await loadEngine();
        if (disposed || !visible || media.matches) return;
        container = await particles.load({ id, element:host, options: {
          fullScreen:{ enable:false }, fpsLimit:24, detectRetina:false, pauseOnOutsideViewport:true,
          particles:{ number:{ value:28 }, color:{ value:'#b69cff' }, links:{ enable:true,color:'#9876ed',distance:85,opacity:0.3,width:1 },
            move:{ enable:true,speed:0.6 }, opacity:{ value:0.65 }, size:{ value:{ min:1,max:2.5 } } },
        } });
        if (disposed) container?.destroy();
        else if (!visible || media.matches || document.hidden) container?.pause();
      } finally { starting = false; }
    };
    const notify = () => { void update().catch(() => {}); };
    const observer = new IntersectionObserver(entries => { visible = entries[0].isIntersecting; notify(); });
    observer.observe(host); media.addEventListener('change',notify); document.addEventListener('visibilitychange',notify);
    return () => { disposed = true; observer.disconnect(); media.removeEventListener('change',notify); document.removeEventListener('visibilitychange',notify); container?.destroy(); };
  },[id]);
  return <div ref={element} id={id} aria-hidden="true" className="absolute inset-0 pointer-events-none" />;
}
