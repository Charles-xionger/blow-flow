import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-canvas-test/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    rules: {
      // Custom rules can be added here
      // 暂时关闭 any 类型警告
      "@typescript-eslint/no-explicit-any": "off",
      // no-unused-vars 规则关闭
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
]);

export default eslintConfig;
