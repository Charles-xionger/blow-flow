"use client";

import { Sparkles } from "lucide-react";

const selectClass = "h-8 min-w-0 cursor-pointer truncate rounded-lg bg-transparent px-2 text-xs hover:bg-white/10 [&>option]:bg-[#232323]";
export const consoleSelectClass = `${selectClass} w-28`;
export const narrowConsoleSelectClass = `${selectClass} w-[72px]`;

export function PromptOptimizeToggle({ active, onChange }: { active: boolean; onChange: (active: boolean) => void }) {
  return (
    <button type="button" aria-label="提示词优化" aria-pressed={active} onClick={() => onChange(!active)}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors ${
        active ? "bg-purple-500/20 text-purple-400" : "text-zinc-400 hover:bg-white/10 hover:text-white"
      }`}>
      <Sparkles size={15} fill={active ? "currentColor" : "none"} />
    </button>
  );
}
