import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// 全局错误捕获：白屏根因写入调试日志（console.log 会被主进程转发到 cinside-debug.log）
const dumpErr = (tag: string, e: unknown) => {
  try {
    const err = e instanceof Error ? `${e.name}: ${e.message}\n  at ${e.stack?.split("\n").slice(1, 4).join("\n  at ")}` : String(e);
    console.log(`[cinside-crash] ${tag}: ${err}`);
  } catch { /* 忽略捕获器自身错误 */ }
};
window.addEventListener("error", (e) => dumpErr("uncaught", e.error || e.message));
window.addEventListener("unhandledrejection", (e) => dumpErr("unhandled-rejection", e.reason));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
