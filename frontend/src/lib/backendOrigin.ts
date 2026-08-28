// 后端服务地址。
// - 开发版（window.location.hostname 存在，即从 vite 5173 加载）：后端固定 8001，与正式版 8000 并存
// - 打包版（file:// 加载，无 hostname）：正式版后端 8000
// dev 后端端口需与 vite.config.ts、electron/main.cjs 保持一致。
const DEV_BACKEND_PORT = "8001";
const isDevLoad = typeof window !== "undefined" && !!window.location.hostname;

export const BACKEND_ORIGIN: string = isDevLoad
  ? `http://localhost:${DEV_BACKEND_PORT}`
  : "http://localhost:8000";

// normalizeUrl 给 bare localhost/127.0.0.1 补默认端口时使用
export const BACKEND_PORT: string = isDevLoad ? DEV_BACKEND_PORT : "8000";
