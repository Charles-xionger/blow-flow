import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
    root: __dirname,
  },
};

export default nextConfig;
