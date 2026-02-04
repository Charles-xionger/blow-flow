"use client";

import { useEffect, useState } from "react";
import { useCanvasStore } from "@/store/useCanvasStore";

/**
 * 主题初始化组件
 * 确保页面加载时主题状态正确同步到 DOM
 */
export function ThemeInitializer() {
  const isDarkMode = useCanvasStore((state) => state.isDarkMode);
  const [mounted, setMounted] = useState(false);

  // 使用 useLayoutEffect 在渲染前同步主题，避免闪烁
  useEffect(() => {
    // 初始化时立即应用主题，然后标记为已挂载
    if (typeof document !== "undefined") {
      document.documentElement.classList.toggle("dark", isDarkMode);
    }

    // 使用 setTimeout 0 将 setState 推迟到下一个事件循环
    const timer = setTimeout(() => {
      setMounted(true);
    }, 0);

    return () => clearTimeout(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // 只在客户端挂载后才同步主题变化，避免 hydration mismatch
    if (mounted && typeof document !== "undefined") {
      document.documentElement.classList.toggle("dark", isDarkMode);
    }
  }, [isDarkMode, mounted]);

  return null;
}
