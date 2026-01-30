"use client";

import { useEffect } from "react";
import { useCanvasStore } from "@/store/useCanvasStore";

/**
 * 主题初始化组件
 * 确保页面加载时主题状态正确同步到 DOM
 */
export function ThemeInitializer() {
  const isDarkMode = useCanvasStore((state) => state.isDarkMode);

  useEffect(() => {
    // 初始化时同步主题
    if (typeof document !== "undefined") {
      document.documentElement.classList.toggle("dark", isDarkMode);
      // 同步到 localStorage（以防 persist 中间件还未完成）
      localStorage.setItem("canvas-theme", isDarkMode ? "dark" : "light");
    }
  }, [isDarkMode]);

  return null;
}
