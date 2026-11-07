"use client";

import { nodeContentEqual } from "@/lib/canvas/node-content";

import dynamic from 'next/dynamic';
import { scriptOutputText } from '@/lib/script/shots';
import { useScriptOutput } from '@/hooks/useScriptOutput';
import { scriptActive, scriptPhaseLabel, scriptStatusLabel } from '@/lib/script/types';
import { memo, useMemo } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { useUpstreamNodes } from "@/hooks/useUpstreamNodes";
import { expandPrompt, promptSegments, promptText } from "@/lib/canvas/prompt";
import { useCanvasStore } from "@/store/useCanvasStore";
import type { NodeData } from "@/types";
import { textPurposes } from "@/lib/script/publishing-types";
import { NodeShell } from "./NodeShell";
import { NodeConsole } from "./shared/NodeConsole";
import { PromptEditor } from "./shared/PromptEditor";

const Particles = dynamic(() => import('./shared/ScriptParticles'), { ssr:false });

const TextNode = (props: NodeProps<Node<NodeData>>) => {
  const { id, data } = props;
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const upstream = useUpstreamNodes(id).filter(node => node.id !== data.scriptOutputSource);
  const task = useScriptOutput(id,data.scriptOutputTaskId);
  const generating = scriptActive(task?.status);
  const segments = useMemo(() => promptSegments(data.prompt), [data.prompt]);
  // The stage shows what downstream nodes receive. Only a node with references walks the graph on store changes.
  const hasReferences = segments.some(segment => "ref" in segment);
  const content = useCanvasStore((state) => hasReferences ? expandPrompt(id, state) : promptText(segments));

  const displayed = generating || (task && !task.outputSaved) ? (task ? scriptOutputText(task, id) : '') : content;
  const status = task && (task.status === 'running' && task.phase ? scriptPhaseLabel[task.phase] : scriptStatusLabel[task.status]);

  return (
    <NodeShell {...props}
      console={generating ? <div className="absolute top-full mt-3 w-full rounded-xl bg-[#242426] p-3 text-xs text-zinc-400">正在写入文字；可在脚本节点停止，结束后直接编辑此文本。</div> :
        <NodeConsole data={data}
          editor={
            <PromptEditor value={segments} upstream={upstream} placeholder="输入文本描述..."
              onChange={prompt => updateNodeData(id, { prompt })} />
          }
        />
      }
    >
      <div data-testid="text-content"
        className={`nowheel h-full w-full overflow-y-auto overscroll-contain whitespace-pre-wrap break-words p-4 text-sm leading-relaxed ${displayed ? "text-zinc-200" : "text-zinc-500"}`}>
        {data.textPurpose && <span className="mb-2 block text-xs text-violet-300">{textPurposes[data.textPurpose]}</span>}
        {task && <div role="status" className="relative mb-3 min-h-8 rounded-lg bg-white/5 p-2 text-xs text-violet-200">
          {generating && !displayed && <Particles/>}<span className="relative">{status}</span>
        </div>}
        {displayed || (generating ? '等待模型输出正文…' : '暂无内容')}
        {task?.error && <p role="alert" className="mt-3 text-xs text-amber-300">{task.error}</p>}
      </div>
    </NodeShell>
  );
};

TextNode.displayName = "TextNode";

export default memo(TextNode, nodeContentEqual);
