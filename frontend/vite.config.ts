import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// dev 后端端口：开发版固定 8001，与正式版的 8000 并存（见 electron/main.cjs）
// 该代理只在 vite dev server 生效，正式构建（vite build）不参与。
const DEV_BACKEND_PORT = 8001;

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": `http://localhost:${DEV_BACKEND_PORT}`,
      "/ws": {
        target: `ws://localhost:${DEV_BACKEND_PORT}`,
        ws: true,
      },
      "/mock": `http://localhost:${DEV_BACKEND_PORT}`,
    },
  },
});
