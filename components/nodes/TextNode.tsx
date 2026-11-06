"use client";

import { nodeContentEqual } from "@/lib/canvas/node-content";

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

const TextNode = (props: NodeProps<Node<NodeData>>) => {
  const { id, data } = props;
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const upstream = useUpstreamNodes(id);
  const segments = useMemo(() => promptSegments(data.prompt), [data.prompt]);
  // The stage shows what downstream nodes receive. Only a node with references walks the graph on store changes.
  const hasReferences = segments.some(segment => "ref" in segment);
  const content = useCanvasStore((state) => hasReferences ? expandPrompt(id, state) : promptText(segments));

  return (
    <NodeShell {...props}
      console={
        <NodeConsole data={data}
          editor={
            <PromptEditor value={segments} upstream={upstream} placeholder="输入文本描述..."
              onChange={prompt => updateNodeData(id, { prompt })} />
          }
        />
      }
    >
      <div data-testid="text-content"
        className={`h-full w-full overflow-y-auto whitespace-pre-wrap break-words p-4 text-sm leading-relaxed ${content ? "text-zinc-200" : "text-zinc-500"}`}>
        {data.textPurpose && <span className="mb-2 block text-xs text-violet-300">{textPurposes[data.textPurpose]}</span>}
        {content || "暂无内容"}
      </div>
    </NodeShell>
  );
};

TextNode.displayName = "TextNode";

export default memo(TextNode, nodeContentEqual);
