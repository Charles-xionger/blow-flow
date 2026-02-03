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

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    // 只在客户端挂载后才同步主题，避免 hydration mismatch
    if (mounted && typeof document !== "undefined") {
      document.documentElement.classList.toggle("dark", isDarkMode);
    }
  }, [isDarkMode, mounted]);

  return null;
}
