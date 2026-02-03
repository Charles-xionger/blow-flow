import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "AI Canvas - 无限画布工作台",
  description: "一站式 AI 图像 & 视频生成工作流平台",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className={inter.className} suppressHydrationWarning>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  const store = localStorage.getItem('canvas-store');
                  if (store) {
                    const isDark = JSON.parse(store).state.isDarkMode;
                    if (isDark) {
                      document.documentElement.classList.add('dark');
                    }
                  }
                } catch (e) {}
              })();
            `,
          }}
        />
        {children}
        <Toaster position="bottom-right" richColors />
      </body>
    </html>
  );
}
