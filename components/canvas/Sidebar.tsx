"use client";

import React, { useState, useRef, useEffect } from "react";
import { useCanvasStore } from "@/store/useCanvasStore";
import { NodeType } from "@/types";
import {
  Grid3x3,
  Clock,
  FolderOpen,
  Image,
  Video,
  Sparkles,
  X,
  ChevronRight,
  FilePlus,
  Loader2,
  FileText,
  Trash2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

// 侧边栏按钮组件 - 移到组件外部
interface SidebarButtonProps {
  icon: any;
  tooltip: string;
  onClick?: () => void;
  isActive?: boolean;
  isDark?: boolean;
  textSub?: string;
  hoverBg?: string;
  activeBg?: string;
}

const SidebarButton: React.FC<SidebarButtonProps> = ({
  icon: Icon,
  tooltip,
  onClick,
  isActive,
  isDark,
  textSub,
  hoverBg,
  activeBg,
}) => {
  return (
    <button
      className={`relative w-11 h-11 flex items-center justify-center rounded-xl transition-all duration-200 group ${
        isActive ? activeBg : `${textSub} ${hoverBg}`
      }`}
      onClick={onClick}
    >
      <Icon size={20} />
      <div
        className={`absolute left-full ml-3 px-2.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap opacity-0 group-hover:opacity-100 transition-all pointer-events-none z-50 ${
          isDark
            ? "bg-zinc-900 text-white border border-zinc-700"
            : "bg-white text-gray-900 border border-gray-200 shadow-lg"
        }`}
      >
        {tooltip}
      </div>
    </button>
  );
};

export function Sidebar() {
  const { addNode, isDarkMode, loadWorkflow } = useCanvasStore();
  const [activePanel, setActivePanel] = useState<
    "ADD" | "HISTORY" | "PROJECT" | null
  >(null);
  const [workflows, setWorkflows] = useState<any[]>([]);
  const [isLoadingWorkflows, setIsLoadingWorkflows] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [workflowToDelete, setWorkflowToDelete] = useState<string | null>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // 主题样式
  const isDark = isDarkMode;
  const bgMain = isDark ? "bg-[#18181b]/95" : "bg-white/95";
  const borderColor = isDark ? "border-zinc-800" : "border-gray-200";
  const textMain = isDark ? "text-white" : "text-gray-900";
  const textSub = isDark ? "text-gray-400" : "text-gray-500";
  const textMuted = isDark ? "text-gray-600" : "text-gray-400";
  const hoverBg = isDark ? "hover:bg-white/5" : "hover:bg-gray-100";
  const activeBg = isDark
    ? "bg-blue-500/10 text-blue-400"
    : "bg-blue-50 text-blue-600";

  // 关闭面板当点击外部
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        sidebarRef.current &&
        !sidebarRef.current.contains(target) &&
        panelRef.current &&
        !panelRef.current.contains(target)
      ) {
        setActivePanel(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const togglePanel = (panel: "ADD" | "HISTORY" | "PROJECT" | null) => {
    setActivePanel((prev) => (prev === panel ? null : panel));
    // 当打开项目面板时，加载项目列表
    if (panel === "PROJECT") {
      loadWorkflowList();
    }
  };

  // 加载项目列表
  const loadWorkflowList = async () => {
    setIsLoadingWorkflows(true);
    try {
      const response = await fetch("/api/workflow");
      const result = await response.json();
      if (result.success) {
        setWorkflows(result.data || []);
      }
    } catch (error) {
      console.error("Failed to load workflows:", error);
    } finally {
      setIsLoadingWorkflows(false);
    }
  };

  // 加载项目
  const handleLoadWorkflow = async (workflowId: string) => {
    try {
      const response = await fetch(`/api/workflow/${workflowId}`);
      const result = await response.json();
      if (result.success && result.data) {
        loadWorkflow(result.data);
        setActivePanel(null);
      }
    } catch (error) {
      console.error("Failed to load workflow:", error);
    }
  };

  // 删除项目
  const handleDeleteWorkflow = async (
    workflowId: string,
    e: React.MouseEvent,
  ) => {
    e.stopPropagation();
    setWorkflowToDelete(workflowId);
    setDeleteDialogOpen(true);
  };

  // 确认删除
  const confirmDelete = async () => {
    if (!workflowToDelete) return;

    try {
      const response = await fetch(`/api/workflow/${workflowToDelete}`, {
        method: "DELETE",
      });
      const result = await response.json();
      if (result.success) {
        // 重新加载项目列表
        loadWorkflowList();
      }
    } catch (error) {
      console.error("Failed to delete workflow:", error);
    } finally {
      setDeleteDialogOpen(false);
      setWorkflowToDelete(null);
    }
  };

  // 添加节点面板
  const renderAddPanel = () => {
    const NodeButton = ({
      icon: Icon,
      label,
      description,
      type,
      color,
    }: {
      icon: any;
      label: string;
      description: string;
      type: NodeType;
      color: string;
    }) => (
      <button
        onClick={() => {
          addNode(type);
          setActivePanel(null);
        }}
        className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-all group ${
          isDark
            ? "border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/50"
            : "border-gray-100 hover:border-gray-200 hover:bg-gray-50"
        }`}
      >
        <div
          className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${color}`}
        >
          <Icon size={20} />
        </div>
        <div className="flex-1 text-left">
          <div className={`text-sm font-semibold ${textMain}`}>{label}</div>
          <div className={`text-[11px] ${textMuted}`}>{description}</div>
        </div>
        <ChevronRight
          size={16}
          className={`${textMuted} group-hover:translate-x-0.5 transition-transform`}
        />
      </button>
    );

    return (
      <div className="space-y-2">
        <div
          className={`text-[10px] font-bold uppercase tracking-wider ${textMuted}`}
        >
          生成节点
        </div>
        <div className="space-y-2">
          <NodeButton
            icon={Image}
            label="文生图"
            description="文本生成图片"
            type={NodeType.TEXT_TO_IMAGE}
            color={
              isDark
                ? "bg-blue-500/15 text-blue-400"
                : "bg-blue-100 text-blue-600"
            }
          />
          <NodeButton
            icon={Video}
            label="文生视频"
            description="文本生成视频"
            type={NodeType.TEXT_TO_VIDEO}
            color={
              isDark
                ? "bg-purple-500/15 text-purple-400"
                : "bg-purple-100 text-purple-600"
            }
          />
          <NodeButton
            icon={Image}
            label="图生图"
            description="图片生成图片"
            type={NodeType.IMAGE_TO_IMAGE}
            color={
              isDark
                ? "bg-cyan-500/15 text-cyan-400"
                : "bg-cyan-100 text-cyan-600"
            }
          />
          <NodeButton
            icon={Video}
            label="图生视频"
            description="图片生成视频"
            type={NodeType.IMAGE_TO_VIDEO}
            color={
              isDark
                ? "bg-indigo-500/15 text-indigo-400"
                : "bg-indigo-100 text-indigo-600"
            }
          />
          <NodeButton
            icon={Video}
            label="首尾帧生成视频"
            description="首尾两图生成视频"
            type={NodeType.START_END_TO_VIDEO}
            color={
              isDark
                ? "bg-pink-500/15 text-pink-400"
                : "bg-pink-100 text-pink-600"
            }
          />
          <NodeButton
            icon={Sparkles}
            label="创意描述"
            description="AI增强提示词"
            type={NodeType.CREATIVE_DESC}
            color={
              isDark
                ? "bg-emerald-500/15 text-emerald-400"
                : "bg-emerald-100 text-emerald-600"
            }
          />
        </div>
      </div>
    );
  };

  // 项目面板
  const renderProjectPanel = () => (
    <div className="space-y-3">
      <button
        onClick={() => {
          // TODO: 新建工作流
          setActivePanel(null);
        }}
        className={`w-full flex items-center gap-3 p-3 rounded-xl transition-all ${hoverBg}`}
      >
        <div
          className={`w-9 h-9 rounded-lg flex items-center justify-center ${
            isDark ? "bg-blue-500/10 text-blue-400" : "bg-blue-50 text-blue-600"
          }`}
        >
          <FilePlus size={18} />
        </div>
        <div className="text-left">
          <div className={`text-sm font-medium ${textMain}`}>新建项目</div>
          <div className={`text-[11px] ${textMuted}`}>创建空白画布</div>
        </div>
      </button>

      <button
        onClick={() => {
          // TODO: 打开导出导入
          setActivePanel(null);
        }}
        className={`w-full flex items-center gap-3 p-3 rounded-xl transition-all ${hoverBg}`}
      >
        <div
          className={`w-9 h-9 rounded-lg flex items-center justify-center ${
            isDark
              ? "bg-emerald-500/10 text-emerald-400"
              : "bg-emerald-50 text-emerald-600"
          }`}
        >
          <FolderOpen size={18} />
        </div>
        <div className="text-left">
          <div className={`text-sm font-medium ${textMain}`}>导出 / 导入</div>
          <div className={`text-[11px] ${textMuted}`}>项目文件管理</div>
        </div>
      </button>

      {/* 分隔线 */}
      <div className={`border-t ${borderColor} pt-3`}>
        <div
          className={`text-[10px] font-bold uppercase tracking-wider ${textMuted} mb-2 px-1`}
        >
          项目列表
        </div>

        {/* 加载状态 */}
        {isLoadingWorkflows ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={24} className={`${textMuted} animate-spin`} />
          </div>
        ) : workflows.length === 0 ? (
          <div className={`text-center py-8 ${textMuted}`}>
            <div
              className={`w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-2 ${
                isDark ? "bg-zinc-800" : "bg-gray-100"
              }`}
            >
              <FileText size={20} className="opacity-40" />
            </div>
            <p className="text-xs">暂无项目</p>
          </div>
        ) : (
          <div className="space-y-2 max-h-64 overflow-y-auto custom-scrollbar">
            {workflows.map((workflow) => (
              <div
                key={workflow.id}
                className={`relative w-full rounded-xl transition-all group ${hoverBg}`}
              >
                <button
                  onClick={() => handleLoadWorkflow(workflow.id)}
                  className="w-full flex items-center gap-3 p-3 pr-10 text-left"
                >
                  <div
                    className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                      isDark
                        ? "bg-zinc-800 text-zinc-400"
                        : "bg-gray-100 text-gray-600"
                    }`}
                  >
                    <FileText size={16} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm font-medium ${textMain} truncate`}>
                      {workflow.name}
                    </div>
                    <div className={`text-[11px] ${textMuted}`}>
                      {workflow.nodes?.length || 0} 节点 ·{" "}
                      {new Date(workflow.updatedAt).toLocaleDateString("zh-CN")}
                    </div>
                  </div>
                </button>
                <button
                  onClick={(e) => handleDeleteWorkflow(workflow.id, e)}
                  className={`absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-lg opacity-0 group-hover:opacity-100 transition-all z-10 ${
                    isDark
                      ? "hover:bg-red-500/20 text-red-400"
                      : "hover:bg-red-50 text-red-600"
                  }`}
                  title="删除项目"
                >
                  <X size={16} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  // 渲染面板内容
  const renderPanel = () => {
    if (!activePanel) return null;

    return (
      <div
        ref={panelRef}
        className={`fixed left-19 top-4 w-80 ${bgMain} backdrop-blur-xl border ${borderColor} rounded-2xl z-190 flex flex-col shadow-2xl animate-in slide-in-from-left-2 duration-200`}
        style={{ maxHeight: "calc(100vh - 32px)" }}
      >
        {/* Header */}
        <div
          className={`px-5 py-4 border-b ${borderColor} flex items-center justify-between shrink-0`}
        >
          <div className="flex items-center gap-3">
            <div
              className={`p-2 rounded-lg ${
                isDark ? "bg-blue-500/10" : "bg-blue-50"
              }`}
            >
              {activePanel === "ADD" && (
                <Grid3x3
                  size={18}
                  className={isDark ? "text-blue-400" : "text-blue-600"}
                />
              )}
              {activePanel === "HISTORY" && (
                <Clock
                  size={18}
                  className={isDark ? "text-blue-400" : "text-blue-600"}
                />
              )}
              {activePanel === "PROJECT" && (
                <FolderOpen
                  size={18}
                  className={isDark ? "text-blue-400" : "text-blue-600"}
                />
              )}
            </div>
            <h3 className={`text-base font-bold ${textMain}`}>
              {activePanel === "ADD" && "添加节点"}
              {activePanel === "HISTORY" && "生成历史"}
              {activePanel === "PROJECT" && "项目"}
            </h3>
          </div>
          <button
            onClick={() => setActivePanel(null)}
            className={`p-2 rounded-lg ${hoverBg} ${textSub}`}
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 p-4 overflow-y-auto custom-scrollbar">
          {activePanel === "ADD" && renderAddPanel()}
          {activePanel === "HISTORY" && (
            <div
              className={`flex flex-col items-center justify-center h-full ${textMuted}`}
            >
              <div
                className={`w-16 h-16 rounded-2xl flex items-center justify-center mb-4 ${
                  isDark ? "bg-zinc-800" : "bg-gray-100"
                }`}
              >
                <Clock size={28} className="opacity-40" />
              </div>
              <p className="text-sm font-medium">暂无生成历史</p>
              <p className={`text-xs mt-1 ${textMuted}`}>
                生成的内容将显示在这里
              </p>
            </div>
          )}
          {activePanel === "PROJECT" && renderProjectPanel()}
        </div>
      </div>
    );
  };

  return (
    <>
      {/* 侧边栏 */}
      <div
        ref={sidebarRef}
        className={`fixed left-4 top-1/2 -translate-y-1/2 z-180 flex flex-col gap-2 p-2 ${bgMain} backdrop-blur-xl border ${borderColor} rounded-2xl shadow-xl`}
      >
        <SidebarButton
          icon={Grid3x3}
          tooltip="添加节点"
          isActive={activePanel === "ADD"}
          isDark={isDark}
          textSub={textSub}
          hoverBg={hoverBg}
          activeBg={activeBg}
          onClick={() => togglePanel("ADD")}
        />
        <SidebarButton
          icon={Clock}
          tooltip="生成历史"
          isActive={activePanel === "HISTORY"}
          isDark={isDark}
          textSub={textSub}
          hoverBg={hoverBg}
          activeBg={activeBg}
          onClick={() => togglePanel("HISTORY")}
        />
        <div className={`h-px ${borderColor}`} />
        <SidebarButton
          icon={FolderOpen}
          tooltip="项目"
          isActive={activePanel === "PROJECT"}
          isDark={isDark}
          textSub={textSub}
          hoverBg={hoverBg}
          activeBg={activeBg}
          onClick={() => togglePanel("PROJECT")}
        />
      </div>

      {/* 面板 */}
      {renderPanel()}

      {/* 删除确认对话框 */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <div
                className={`p-2 rounded-lg ${isDark ? "bg-red-500/10" : "bg-red-50"}`}
              >
                <Trash2
                  size={20}
                  className={isDark ? "text-red-400" : "text-red-600"}
                />
              </div>
              删除项目
            </DialogTitle>
            <DialogDescription>
              确定要删除这个项目吗？此操作无法撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
            >
              取消
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
