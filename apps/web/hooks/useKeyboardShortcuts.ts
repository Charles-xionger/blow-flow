import { useCanvasStore } from "@/store/useCanvasStore";
import { useEffect } from "react";

export function useKeyboardShortcuts(onSave?: () => void) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      // 检查当前焦点是否在可编辑元素上
      const target = e.target as HTMLElement;
      const isEditableElement =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;

      // 如果在可编辑元素中，不拦截快捷键，让浏览器处理默认行为
      if (isEditableElement) {
        // 只处理保存快捷键，其他快捷键让浏览器默认处理
        if ((e.ctrlKey || e.metaKey) && e.key === "s") {
          e.preventDefault();
          onSave?.();
        }
        return;
      }

      // Ctrl/Cmd + S: 保存
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        onSave?.();
      }

      // Ctrl/Cmd + Z: 撤销
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        useCanvasStore.getState().undo();
      }

      // Ctrl/Cmd + Shift + Z: 重做
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && e.shiftKey) {
        e.preventDefault();
        useCanvasStore.getState().redo();
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        useCanvasStore.getState().redo();
      }

      // Delete/Backspace: 删除选中节点
      // React Flow 会自动处理
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onSave]);
}
