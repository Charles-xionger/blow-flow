/**
 * BaseNodeWrapper.tsx
 *
 * 通用节点包装组件，提供节点的基本结构和样式。
 */

"use client";

import React, { memo, ReactNode } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import { NodeData } from "@/types";
import { cn } from "@/lib/utils";
import { Loader2, AlertCircle, MoreVertical } from "lucide-react";

interface BaseNodeWrapperProps {
  data: NodeData;
  selected: boolean;
  color?: string;
  children: ReactNode;
  hasInput?: boolean;
  hasOutput?: boolean;
  className?: string;
}

export const BaseNodeWrapper = memo(
  ({
    data,
    selected,
    color = "blue",
    children,
    hasInput = true,
    hasOutput = true,
    className,
  }: BaseNodeWrapperProps) => {
    const colorClasses = {
      blue: "border-blue-500 bg-blue-50 dark:bg-blue-950/30",
      purple: "border-purple-500 bg-purple-50 dark:bg-purple-950/30",
      green: "border-green-500 bg-green-50 dark:bg-green-950/30",
      amber: "border-amber-500 bg-amber-50 dark:bg-amber-950/30",
    };

    return (
      <div
        className={cn(
          "rounded-xl border-2 shadow-xl min-w-[320px] transition-all",
          colorClasses[color as keyof typeof colorClasses] || colorClasses.blue,
          selected && "ring-4 ring-offset-2 ring-primary",
          className,
        )}
      >
        {/* 输入连接点 */}
        {hasInput && (
          <Handle
            type="target"
            position={Position.Left}
            className="w-4 h-4 border-2 border-white"
            style={{ background: `var(--${color}-500)` }}
          />
        )}

        {/* 头部 */}
        <div className="flex items-center justify-between p-3 border-b bg-white/50 dark:bg-black/20">
          <div className="flex items-center gap-2">
            <div className="font-semibold text-sm">{data.label}</div>
            {data.isLoading && (
              <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
            )}
            {data.error && <AlertCircle className="w-4 h-4 text-red-500" />}
          </div>
          <button className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded">
            <MoreVertical className="w-4 h-4" />
          </button>
        </div>

        {/* 内容区域 */}
        <div className="p-4">{children}</div>

        {/* 错误提示 */}
        {data.error && (
          <div className="px-4 pb-3">
            <div className="text-xs text-red-500 bg-red-50 dark:bg-red-900/20 p-2 rounded">
              {data.error}
            </div>
          </div>
        )}

        {/* 输出连接点 */}
        {hasOutput && (
          <Handle
            type="source"
            position={Position.Right}
            className="w-4 h-4 border-2 border-white"
            style={{ background: `var(--${color}-500)` }}
          />
        )}
      </div>
    );
  },
);

BaseNodeWrapper.displayName = "BaseNodeWrapper";
