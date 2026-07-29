"use strict";

// 外挂插件悬浮条（dock.html）的隔离预加载脚本
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dockAPI", {
  // 代理访问后端插件 API（避免 CORS / 端口问题）
  pluginApi: (path, method, body) => ipcRenderer.invoke("plugin-api", { path, method, body }),
  // 唤回主窗口
  showMain: () => ipcRenderer.send("dock-show-main"),
  // 关闭悬浮条（体外循环仍在后台运行，可从主窗口重新开启）
  closeDock: () => ipcRenderer.send("dock-close"),
  // 切换窗口形态：'strip' 面板 / 'picker' 扩展选择面板 / 'collapsed' 收起
  setMode: (mode) => ipcRenderer.send("dock-set-mode", mode),
  // 启动带 CDP 调试端口的受控 Chrome
  launchChrome: () => ipcRenderer.invoke("dock-launch-chrome"),
});
