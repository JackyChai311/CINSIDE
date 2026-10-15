import { defineConfig } from "vitest/config";

// 独立的 Vitest 配置：不改动 vite.config.ts（构建链路保持原样）。
// 纯逻辑单测运行在 node 环境，只收集 src 下的 *.test.ts。
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
