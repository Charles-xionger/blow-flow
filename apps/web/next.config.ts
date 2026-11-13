import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import path from "node:path";

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_TEST_DIST || ".next",
  // 允许外部图片域名
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**",
      },
    ],
  },

  // 实验性功能
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },

  // Webpack 配置 (Better-SQLite3 需要)
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals.push({
        "better-sqlite3": "commonjs better-sqlite3",
      });
    }
    return config;
  },

  // Turbopack 配置 (Next.js 16+ 默认使用)
  turbopack: {
    root: path.resolve(__dirname, "../.."),
  },
};

export default process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN
  ? withSentryConfig(nextConfig, { silent: true, sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN } })
  : nextConfig;
