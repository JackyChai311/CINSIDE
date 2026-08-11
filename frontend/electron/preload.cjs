"use strict";

const { contextBridge, ipcRenderer, webFrame } = require("electron");

// UI缩放：使用Electron原生的webFrame.setZoomFactor，而非CSS zoom。
// webFrame在Chromium底层缩放整个渲染进程，所有坐标系统自动保持一致，
// getBoundingClientRect()返回的值与BrowserView.setBounds()需要的DIP坐标完全匹配。
contextBridge.exposeInMainWorld("cinsideZoom", {
  setFactor: (factor) => {
    try { webFrame.setZoomFactor(factor); } catch (_) {}
  },
  getFactor: () => {
    try { return webFrame.getZoomFactor(); } catch (_) { return 1.0; }
  },
});

contextBridge.exposeInMainWorld("electronAPI", {
  backendStatus: () => ipcRenderer.invoke("backend-status"),
  onBackendReady: (callback) => ipcRenderer.on("backend-ready", callback),
  openExternal: (url) => ipcRenderer.send("open-external", url),

  // === 自动更新 ===
  updateCheckNow: () => ipcRenderer.invoke("update-check-now"),
  updateDownloadUpdate: () => ipcRenderer.invoke("update-download"),
  updateQuitAndInstall: () => ipcRenderer.invoke("update-quit-install"),
  onUpdateAvailable: (callback) => {
    const handler = (_e, info) => callback(info);
    ipcRenderer.on("update-available", handler);
    return () => ipcRenderer.removeListener("update-available", handler);
  },
  onUpdateNotAvailable: (callback) => {
    const handler = (_e, info) => callback(info);
    ipcRenderer.on("update-not-available", handler);
    return () => ipcRenderer.removeListener("update-not-available", handler);
  },
  onUpdateDownloadProgress: (callback) => {
    const handler = (_e, progress) => callback(progress);
    ipcRenderer.on("update-download-progress", handler);
    return () => ipcRenderer.removeListener("update-download-progress", handler);
  },
  onUpdateDownloaded: (callback) => {
    const handler = (_e, info) => callback(info);
    ipcRenderer.on("update-downloaded", handler);
    return () => ipcRenderer.removeListener("update-downloaded", handler);
  },
  onUpdateError: (callback) => {
    const handler = (_e, error) => callback(error);
    ipcRenderer.on("update-error", handler);
    return () => ipcRenderer.removeListener("update-error", handler);
  },
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),

  // === 无边框窗口控制 ===
  windowMinimize: () => ipcRenderer.send("window-minimize"),
  windowMaximize: () => ipcRenderer.send("window-maximize"),
  windowClose: () => ipcRenderer.send("window-close"),
  windowIsMaximized: () => ipcRenderer.invoke("window-is-maximized"),

  // === 防误关 ===
  setPreventClose: (enabled) => ipcRenderer.send("set-prevent-close", enabled),
  quitApp: () => ipcRenderer.send("app-quit"),

  // === 左右两个 BrowserView 通用控制 ===
  // side: "left" | "right"
  viewLoad: (side, url) => ipcRenderer.invoke("view-load", side, url),
  viewShow: (side, bounds, url) => ipcRenderer.invoke("view-show", side, bounds, url),
  viewHide: (side) => ipcRenderer.invoke("view-hide", side),
  viewHideAll: () => ipcRenderer.invoke("view-hide-all"),
  viewSetZoom: (side, factor) => ipcRenderer.invoke("view-set-zoom", side, factor),
  viewSetBrightness: (side, value) => ipcRenderer.invoke("view-set-brightness", side, value),

  // 在指定 view 中执行 JS
  viewExecuteJS: (side, script) => ipcRenderer.invoke("view-execute-js", side, script),
  // 在指定 view 中插入 CSS
  viewInsertCSS: (side, css) => ipcRenderer.invoke("view-insert-css", side, css),

  // 元素选择模式
  viewStartPicking: (side) => ipcRenderer.invoke("view-start-picking", side),
  viewStopPicking: (side) => ipcRenderer.invoke("view-stop-picking", side),
  // 浏览器回退（网页提取时点错撤销）
  viewGoBack: (side) => ipcRenderer.invoke("view-go-back", side),

  // 一键直传：把文件直接填入网页 file input
  viewQuickUpload: (side, fileInputSelector, filename, mime, base64Data) =>
    ipcRenderer.invoke("view-quick-upload", side, fileInputSelector, filename, mime, base64Data),
  // 弹窗一键直传：把文件直接填入弹窗中的 file input
  popupQuickUpload: (side, fileInputSelector, filename, mime, base64Data) =>
    ipcRenderer.invoke("popup-quick-upload", side, fileInputSelector, filename, mime, base64Data),

  // 元素屏蔽规则
  viewSetBlockRules: (side, selectors) => ipcRenderer.invoke("view-set-block-rules", side, selectors),

  // 高亮元素（用于核对时绿色/红色框）
  viewHighlightBoxes: (side, boxes) => ipcRenderer.invoke("view-highlight-boxes", side, boxes),
  viewClearHighlight: (side) => ipcRenderer.invoke("view-clear-highlight", side),

  // 绑定输入模式右键菜单：开启/关闭
  viewSetBindInputMode: (side, enabled) => ipcRenderer.invoke("view-set-bind-input-mode", side, enabled),
  // 框选模式（日格子多选）：true=拖拽框选，false=单点选择
  viewSetMarqueeMode: (side, enabled) => ipcRenderer.invoke("view-set-marquee-mode", side, enabled),
  // 回传 Excel 列列表到 picker 脚本（右键菜单响应）
  viewCtxMenuResponse: (side, columns, currentField) => ipcRenderer.invoke("view-ctx-menu-response", side, columns, currentField),

  // 截图指定 view 中的元素区域（用于头像提取）
  viewCaptureElement: (side, rect) => ipcRenderer.invoke("view-capture-element", side, rect),

  // === 下载捕获（文件提取模式） ===
  setDownloadCapture: (side, enabled) => ipcRenderer.invoke("set-download-capture", side, enabled),

  // === 文件提取保底机制 ===
  viewGetDownloadableLinks: (side) => ipcRenderer.invoke("view-get-downloadable-links", side),
  viewBatchDownloadUrls: (side, urls, timeoutMs) => ipcRenderer.invoke("view-batch-download-urls", side, urls, timeoutMs),
  // 图片直览页抓取：点击后直接预览图片（无下载按钮）时，按 URL 主动下载
  viewDownloadSingleUrl: (side, url, timeoutMs) => ipcRenderer.invoke("view-download-single-url", side, url, timeoutMs),

  // === 本地文件提取：选择目录 + 读取文件 ===
  pickLocalDirectory: () => ipcRenderer.invoke("pick-local-directory"),
  readLocalDocFile: (rootPath, relativePath) => ipcRenderer.invoke("read-local-doc-file", rootPath, relativePath),
  checkLocalFileExists: (rootPath, relativePath) => ipcRenderer.invoke("check-local-file-exists", rootPath, relativePath),
  // === 导出文件：弹保存对话框并写入磁盘 ===
  saveExportedFile: (defaultName, base64) => ipcRenderer.invoke("save-exported-file", defaultName, base64),
  // === 幻灯片任务：选择 PPT 文件 ===
  pickPptFiles: () => ipcRenderer.invoke("pick-ppt-files"),
  pickPptDirectory: () => ipcRenderer.invoke("pick-ppt-directory"),
  // 参考资料：选择 PPT/PDF 文件（支持多选）
  pickReferenceFiles: () => ipcRenderer.invoke("pick-reference-files"),
  // 拖拽放入的文件：通过 File 对象获取真实磁盘路径
  // Electron 32+ 使用 webUtils.getPathForFile，旧版回退到 file.path
  getPathForFile: (file) => {
    try {
      const { webUtils } = require("electron");
      if (webUtils && typeof webUtils.getPathForFile === "function") {
        return webUtils.getPathForFile(file);
      }
    } catch (_) {}
    return file && file.path ? file.path : "";
  },
  // 在文件管理器中显示文件（打开所在目录并选中）
  showItemInFolder: (filePath) => {
    try {
      const { shell } = require("electron");
      shell.showItemInFolder(filePath);
    } catch (_) {}
  },
  onDownloadCaptured: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on("download-captured", handler);
    return () => ipcRenderer.removeListener("download-captured", handler);
  },
  onDownloadStarted: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on("download-started", handler);
    return () => ipcRenderer.removeListener("download-started", handler);
  },
  onDownloadProgress: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on("download-progress", handler);
    return () => ipcRenderer.removeListener("download-progress", handler);
  },
  onDownloadFailed: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on("download-failed", handler);
    return () => ipcRenderer.removeListener("download-failed", handler);
  },

  // 接收来自 BrowserView 内部的消息（元素选择等）
  onViewMessage: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("view-message", handler);
    return () => ipcRenderer.removeListener("view-message", handler);
  },

  // === 面板脱离（拖拽到其他屏幕） ===
  panelDetach: (side) => ipcRenderer.invoke("panel-detach", side),
  panelBroadcastState: (side, state) => ipcRenderer.send("panel-state-broadcast", side, state),
  panelSendAction: (action, payload) => ipcRenderer.send("panel-action", action, payload),
  // 前端日志转发到主进程日志文件
  rendererLog: (msg) => ipcRenderer.send("renderer-log", msg),
  onPanelState: (callback) => {
    const handler = (_e, state) => callback(state);
    ipcRenderer.on("panel-state", handler);
    return () => ipcRenderer.removeListener("panel-state", handler);
  },
  onPanelAction: (callback) => {
    const handler = (_e, data) => callback(data.action, data.payload);
    ipcRenderer.on("panel-action", handler);
    return () => ipcRenderer.removeListener("panel-action", handler);
  },
  onPanelReattached: (callback) => {
    const handler = (_e, side) => callback(side);
    ipcRenderer.on("panel-reattached", handler);
    return () => ipcRenderer.removeListener("panel-reattached", handler);
  },
  onDetachedViewReady: (callback) => {
    const handler = (_e, side) => callback(side);
    ipcRenderer.on("detached-view-ready", handler);
    return () => ipcRenderer.removeListener("detached-view-ready", handler);
  },

  // === 脱离的浏览器面板视图控制 ===
  detachedViewShow: (side, bounds, url) => ipcRenderer.invoke("detached-view-show", side, bounds, url),
  detachedViewHide: (side) => ipcRenderer.invoke("detached-view-hide", side),
  detachedViewLoad: (side, url) => ipcRenderer.invoke("detached-view-load", side, url),
  detachedViewExecuteJS: (side, script) => ipcRenderer.invoke("detached-view-execute-js", side, script),

  // 脱离的浏览器面板：元素选择模式
  detachedViewStartPicking: (side) => ipcRenderer.invoke("detached-view-start-picking", side),
  detachedViewStopPicking: (side) => ipcRenderer.invoke("detached-view-stop-picking", side),

  // 脱离的浏览器面板：高亮/清除高亮
  detachedViewHighlightBoxes: (side, boxes) => ipcRenderer.invoke("detached-view-highlight-boxes", side, boxes),
  detachedViewClearHighlight: (side) => ipcRenderer.invoke("detached-view-clear-highlight", side),

  // 脱离的浏览器面板：插入 CSS
  detachedViewInsertCSS: (side, css) => ipcRenderer.invoke("detached-view-insert-css", side, css),

  // === 弹窗（window.open）控制 ===
  // 当网页 window.open() 被拦截后，弹窗作为覆盖 BrowserView 显示
  popupClose: (side) => ipcRenderer.invoke("popup-close", side),
  popupStartPicking: (side) => ipcRenderer.invoke("popup-start-picking", side),
  popupStopPicking: (side) => ipcRenderer.invoke("popup-stop-picking", side),
  popupHighlightBoxes: (side, boxes) => ipcRenderer.invoke("popup-highlight-boxes", side, boxes),
  popupClearHighlight: (side) => ipcRenderer.invoke("popup-clear-highlight", side),
  popupExecuteJS: (side, script) => ipcRenderer.invoke("popup-execute-js", side, script),

  onPopupCreated: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on("popup-created", handler);
    return () => ipcRenderer.removeListener("popup-created", handler);
  },
  onPopupClosed: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on("popup-closed", handler);
    return () => ipcRenderer.removeListener("popup-closed", handler);
  },

  // === 外挂插件：屏幕边缘悬浮条 ===
  dockToggle: () => ipcRenderer.invoke("dock-toggle"),
  dockIsOpen: () => ipcRenderer.invoke("dock-is-open"),
  pluginApi: (path, method, body) => ipcRenderer.invoke("plugin-api", { path, method, body }),
  onDockState: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on("dock-state", handler);
    return () => ipcRenderer.removeListener("dock-state", handler);
  },

  // === 兼容旧 API（向后兼容） ===
  loadBrowserViewUrl: (url) => ipcRenderer.invoke("view-load", "right", url),
  showBrowserView: (bounds, url) => ipcRenderer.invoke("view-show", "right", bounds, url),
  hideBrowserView: () => ipcRenderer.invoke("view-hide", "right"),
  resizeBrowserView: (bounds) => ipcRenderer.invoke("view-show", "right", bounds, null),

  // === 账号密码两段式粘贴 ===
  startTwoStepPaste: (side, username, password) => ipcRenderer.invoke("two-step-paste-start", side, username, password),
  cancelTwoStepPaste: () => ipcRenderer.invoke("two-step-paste-cancel"),
  getTwoStepPasteState: () => ipcRenderer.invoke("two-step-paste-state"),
  onTwoStepPasteProgress: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on("two-step-paste-progress", handler);
    return () => ipcRenderer.removeListener("two-step-paste-progress", handler);
  },

  // === 模态覆盖层：临时隐藏所有原生 BrowserView 防止穿模 ===
  modalOverlayEnter: () => ipcRenderer.invoke("modal-overlay-enter"),
  modalOverlayExit: () => ipcRenderer.invoke("modal-overlay-exit"),
  onModalOverlayExited: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("modal-overlay-exited", handler);
    return () => ipcRenderer.removeListener("modal-overlay-exited", handler);
  },
});
