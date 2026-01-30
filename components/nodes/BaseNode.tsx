"use client";

import React, { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import { NodeData } from "@/types";
import { cn } from "@/lib/utils";

interface BaseNodeProps extends NodeProps {
  data: NodeData;
  color?: string;
}

export const BaseNode = memo(
  ({ data, selected, color = "blue" }: BaseNodeProps) => {
    const colorClasses = {
      blue: "border-blue-500 bg-blue-50 dark:bg-blue-900/20",
      purple: "border-purple-500 bg-purple-50 dark:bg-purple-900/20",
      green: "border-green-500 bg-green-50 dark:bg-green-900/20",
      amber: "border-amber-500 bg-amber-50 dark:bg-amber-900/20",
    };

    return (
      <div
        className={cn(
          "rounded-lg border-2 p-4 shadow-lg min-w-70 transition-all",
          colorClasses[color as keyof typeof colorClasses] || colorClasses.blue,
          selected && "ring-2 ring-offset-2 ring-primary",
        )}
      >
        {/* 输入连接点 */}
        <Handle type="target" position={Position.Left} className="w-3 h-3" />

        {/* 节点标题 */}
        <div className="font-semibold mb-2">{data.label}</div>

        {/* 节点内容（占位） */}
        <div className="text-sm text-muted-foreground">
          {data.prompt || "未配置"}
        </div>

        {/* 加载状态 */}
        {data.isLoading && (
          <div className="mt-2 text-xs text-blue-500">生成中...</div>
        )}

        {/* 输出连接点 */}
        <Handle type="source" position={Position.Right} className="w-3 h-3" />
      </div>
    );
  },
);

BaseNode.displayName = "BaseNode";
