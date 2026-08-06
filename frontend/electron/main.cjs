"use strict";

const { app, BrowserWindow, BrowserView, ipcMain, shell, Tray, Menu, nativeImage, session } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const { spawn } = require("child_process");
const { autoUpdater } = require("electron-updater");

// 统一日志文件，供调试用
const LOG_FILE = path.join(app ? app.getPath("userData") : ".", "cinside-debug.log");
function debugLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  console.log(msg);
  try { fs.appendFileSync(LOG_FILE, line); } catch (e) {}
}

// 资源路径解析：开发环境和打包环境路径不同
function resolveAssetPath(relativePath) {
  if (isDev) {
    return path.join(__dirname, "../../", relativePath);
  }
  // 打包后：assets 被打包到 app.asar/assets/
  return path.join(__dirname, "../", relativePath);
}

// 开启 CDP，让后端 browser-use 能连接到这个 Electron 实例并控制 BrowserView
app.commandLine.appendSwitch("remote-debugging-port", "9222");

// 设置 AppUserModelID，使 Windows 任务栏显示窗口自身图标（app-icon.ico）
// 而不是 electron.exe 的默认图标。必须在 app.whenReady() 之前调用。
app.setName("CINSIDE");
app.setAppUserModelId("com.cinside.app");

let mainWindow = null;
let splashWindow = null;
// 左右两个 BrowserView：left = 数据源网页 / right = 学校系统网页
let leftBrowserView = null;
let rightBrowserView = null;
let backendProcess = null;
let backendReady = false;
// 脱离的面板窗口：{ left: BrowserWindow, bottom: BrowserWindow }
const detachedPanels = {};

// === 防误关：开启后关闭按钮改为最小化到系统托盘 ===
let preventAccidentalClose = false;
let tray = null;
let isQuitting = false;

const isDev = !app.isPackaged;
const BACKEND_PORT = 8000;

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 480,
    height: 220,
    frame: false,
    alwaysOnTop: true,
    transparent: false,
    resizable: false,
    movable: false,
    center: true,
    skipTaskbar: true,
    backgroundColor: "#ffffff",
    title: "CINSIDE",
    icon: path.join(__dirname, "../../assets/app-icon.ico"),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const splashPath = isDev
    ? path.join(__dirname, "../public/splash.html")
    : path.join(__dirname, "../dist/splash.html");
  splashWindow.loadFile(splashPath);

  splashWindow.on("closed", () => {
    splashWindow = null;
  });
}

function closeSplashWindow() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
    splashWindow = null;
  }
}

function createWindow() {
  const workArea = require("electron").screen.getPrimaryDisplay().workAreaSize;
  // 窗口尺寸不超过工作区，并留出一些边距，避免超出屏幕
  const winW = Math.min(1680, Math.max(1024, workArea.width - 40));
  const winH = Math.min(940, Math.max(600, workArea.height - 40));

  mainWindow = new BrowserWindow({
    width: winW,
    height: winH,
    minWidth: 1024,
    minHeight: 600,
    title: "CINSIDE · 申请信息核验",
    show: false,
    icon: path.join(__dirname, "../../assets/app-icon.ico"),
    // 无边框窗口：移除系统标题栏和菜单栏
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });

  // 居中显示，确保不超出工作区
  mainWindow.center();

  // 移除默认菜单栏（File, Edit, View, Window, Help）
  const { Menu } = require("electron");
  Menu.setApplicationMenu(null);

  // 外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
    // 只有显式开启调试模式时才打开 DevTools，避免普通用户看到
    if (process.env.CINSIDE_DEVTOOLS === "1") {
      mainWindow.webContents.openDevTools();
    }
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  // 主窗口加载完成后关闭启动页并显示主窗口
  mainWindow.webContents.on("did-finish-load", () => {
    closeSplashWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    destroyDockWindow();
  });

  // === 防误关拦截：开启时点关闭改为最小化到托盘 ===
  mainWindow.on("close", (e) => {
    if (!isQuitting && preventAccidentalClose && mainWindow) {
      e.preventDefault();
      mainWindow.hide();
      // 首次隐藏时显示托盘气泡提示
      if (tray) {
        tray.displayBalloon({
          iconType: "info",
          title: "CINSIDE 仍在后台运行",
          content: "已最小化到系统托盘。点击托盘图标可恢复窗口，右键可退出。",
        });
      }
    }
  });

  // 创建系统托盘
  createTray();
}

// ============ 系统托盘（防误关时显示） ============
function createTray() {
  // 托盘只在需要时创建一次
  if (tray) return;
  const iconPath = path.join(__dirname, "../../assets/app-icon.ico");
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath);
    if (trayIcon.isEmpty()) trayIcon = nativeImage.createEmpty();
  } catch (e) {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip("CINSIDE · 申请信息核验");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "显示主窗口",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: "最小化到托盘",
      click: () => {
        if (mainWindow) mainWindow.hide();
      },
    },
    { type: "separator" },
    {
      label: "退出 CINSIDE",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  // 单击托盘图标：切换主窗口显示/隐藏
  tray.on("click", () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible() && mainWindow.isFocused()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // 双击托盘图标：显示主窗口
  tray.on("double-click", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ============ 左右两个 BrowserView 的统一工厂 ============
function makeBrowserView() {
  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
    },
  });
  // 禁用默认的 Ctrl+滚轮缩放（改为主进程通过 setZoomFactor 控制），
  // 这样注入的 wheel 监听器可以使用 passive: true，避免阻塞页面正常滚动
  try {
    view.webContents.setLayoutZoomResizingEnabled(false);
    view.webContents.setVisualZoomResizingEnabled(false);
  } catch (_) {}
  return view;
}

function createBrowserViews() {
  if (!leftBrowserView) {
    leftBrowserView = makeBrowserView();
    leftBrowserView.webContents.loadURL("about:blank");
    attachViewMessageRelay(leftBrowserView, "left");
    setupTwoStepPasteInterceptor(leftBrowserView, "left");
  }
  if (!rightBrowserView) {
    rightBrowserView = makeBrowserView();
    rightBrowserView.webContents.loadURL("about:blank");
    attachViewMessageRelay(rightBrowserView, "right");
    setupTwoStepPasteInterceptor(rightBrowserView, "right");
  }
}

// 把 BrowserView 内部通过 window.__cinsidePostMessage 发回的消息转发到前端
function attachViewMessageRelay(view, side) {
  // 页面加载完成后注入细滚动条样式 + 拾取模式光标 CSS
  view.webContents.on("did-finish-load", () => {
    view.webContents.insertCSS(`
      ::-webkit-scrollbar { width: 4px; height: 4px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: rgba(148,163,184,.30); border-radius: 4px; }
      ::-webkit-scrollbar-thumb:hover { background: rgba(99,102,241,.45); }
      ::-webkit-scrollbar-corner { background: transparent; }
      .cinside-picking, .cinside-picking * { cursor: crosshair !important; }
      .cinside-picking *:hover { outline: 2px dashed #6366f1 !important; outline-offset: 1px !important; box-shadow: 0 0 0 4px rgba(99,102,241,.15) !important; }
      @keyframes cinside-pick-flash { 0% { outline: 3px solid #6366f1; outline-offset: 1px; box-shadow: 0 0 0 6px rgba(99,102,241,0.30); } 70% { outline: 3px solid rgba(99,102,241,0.4); outline-offset: 1px; box-shadow: 0 0 0 6px rgba(99,102,241,0.10); } 100% { outline: 3px solid rgba(99,102,241,0); outline-offset: 1px; box-shadow: 0 0 0 6px rgba(99,102,241,0); } }
      .cinside-pick-flash { animation: cinside-pick-flash 0.28s ease-out forwards; }
    `).catch(() => {});
    // 页面重载后若拾取模式仍激活，重新注入拾取脚本
    if (pickingActive[side]) {
      view.webContents.executeJavaScript(ELEMENT_PICKER_SCRIPT).catch(() => {});
    }
  });

  view.webContents.on("dom-ready", () => {
    // 在 DOM 就绪时立即注入屏蔽规则（比 did-finish-load 早很多，减少导航闪烁）
    applyBlockRules(side);
    view.webContents.executeJavaScript(`
      (function () {
        if (window.__cinsideRelayInstalled) return;
        window.__cinsideRelayInstalled = true;
        window.__cinsidePostMessage = function (payload) {
          try { console.log('[cinside-relay]', JSON.stringify(payload)); } catch (e) {}
        };
        // Ctrl+滚轮缩放：passive:true 不阻塞页面正常滚动
        // 默认缩放已在主进程通过 setLayoutZoomResizingEnabled(false) 禁用
        window.addEventListener('wheel', function (e) {
          if (e.ctrlKey) {
            console.log('[cinside-relay]', JSON.stringify({ kind: 'ctrl-wheel', deltaY: e.deltaY }));
          }
        }, { passive: true });
      })();
    `).catch(() => {});
  });

  // 页面内导航（SPA 路由、hash 变化等）后，重注入拾取脚本
  view.webContents.on("did-navigate", () => {
    // 父页面导航时关闭弹窗
    closePopupView(side);
    if (pickingActive[side]) {
      view.webContents.executeJavaScript(ELEMENT_PICKER_SCRIPT).catch(() => {});
    }
    // 导航后立即注入屏蔽规则（dom-ready 也会注入，这里作为兜底）
    applyBlockRules(side);
  });
  view.webContents.on("did-navigate-in-page", () => {
    if (pickingActive[side]) {
      view.webContents.executeJavaScript(ELEMENT_PICKER_SCRIPT).catch(() => {});
    }
    // SPA 路由变化后重新注入屏蔽规则（SPA 可能重新渲染了被屏蔽元素）
    applyBlockRules(side);
  });

  // 加载状态变化：通知前端 loading 开始/结束
  view.webContents.on("did-start-loading", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("view-message", { side, payload: { kind: "view-loading", loading: true } });
    }
  });
  view.webContents.on("did-stop-loading", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("view-message", { side, payload: { kind: "view-loading", loading: false } });
      // 页面加载完成后强制重绘 BrowserView，解决内容更新不显示的问题
      // 使用版本号防止旧 setTimeout 的 bounds 覆盖渲染进程发送的新 bounds
      if (mainWindow.getBrowserViews().includes(view)) {
        const b = view.getBounds();
        view._cinsideBoundsVer = (view._cinsideBoundsVer || 0) + 1;
        const ver = view._cinsideBoundsVer;
        setTimeout(() => {
          if (ver === view._cinsideBoundsVer && !view.webContents.isDestroyed()) {
            try { view.setBounds(b); } catch (_) {}
          }
        }, 50);
      }
    }
  });
  view.webContents.on("did-fail-load", (_e, errorCode, _errorDescription, validatedURL) => {
    if (errorCode !== -3 && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("view-message", { side, payload: { kind: "view-loading", loading: false, error: errorCode, url: validatedURL } });
    }
  });

  // 监听 console message，把 [cinside-relay] 前缀的日志解析回前端
  view.webContents.on("console-message", (_e, level, message) => {
    if (typeof message !== "string") return;
    // 全量转发 BrowserView console 日志到调试文件
    if (message.startsWith("[onPick]") || message.startsWith("[BrowserPane")) {
      debugLog(`[view:${side}] ${message}`);
    }
    const tag = "[cinside-relay]";
    if (message.startsWith(tag)) {
      try {
        const payload = JSON.parse(message.slice(tag.length).trim());
        // Ctrl+滚轮缩放：直接在主进程调整 zoom factor
        if (payload.kind === "ctrl-wheel") {
          const cur = view.webContents.getZoomFactor();
          const next = Math.max(0.5, Math.min(3.0, Math.round((cur + (payload.deltaY < 0 ? 0.1 : -0.1)) * 100) / 100));
          if (next !== cur) {
            try { view.webContents.setZoomFactor(next); } catch (_) {}
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send("view-message", { side, payload: { kind: "zoom-changed", factor: next } });
            }
          }
          return;
        }
        debugLog(`[main] relay ${side}: kind=${payload.kind}, tag=${payload.tag || "n/a"}, selector=${payload.selector || "n/a"}`);
        // 右键菜单请求：前端需要返回 Excel 列列表，这里需要特殊处理
        // 前端通过 view-message 收到后，用 executeJavaScript 回传列列表到 picker 脚本
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("view-message", { side, payload });
        }
      } catch (_) {}
    }
  });

  // 拦截 window.open()：在主窗口创建覆盖弹窗 BrowserView
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (url && url !== "about:blank") {
      createPopupView(side, url, mainWindow);
    }
    return { action: "deny" };
  });
}

// ============ 弹窗（window.open）管理 ============
// 当网页调用 window.open() 时，创建一个覆盖在父 view 上的 BrowserView
// 支持：拾取元素、高亮、关闭弹窗
const popupViews = {}; // side -> { view, win, url }

// 弹窗居中：在父 view bounds 内按 82% 缩放并居中（最小 520x400，不超过父 view）
function computePopupBounds(parentBounds) {
  const pw = parentBounds.width || 800;
  const ph = parentBounds.height || 600;
  const w = Math.max(Math.min(Math.round(pw * 0.82), pw), Math.min(520, pw));
  const h = Math.max(Math.min(Math.round(ph * 0.82), ph), Math.min(400, ph));
  return {
    x: (parentBounds.x || 0) + Math.round((pw - w) / 2),
    y: (parentBounds.y || 0) + Math.round((ph - h) / 2),
    width: w,
    height: h,
  };
}

function createPopupView(parentSide, url, win) {
  // 先关闭已有的弹窗
  closePopupView(parentSide);

  if (!win || win.isDestroyed()) return;

  // 获取父 view 及其 bounds
  const detachedSide = parentSide === "left" ? "browser-left" : "browser-right";
  const isDetached = !!detachedPanels[detachedSide] && !detachedPanels[detachedSide].isDestroyed();
  const parentView = isDetached
    ? detachedPanels[detachedSide + "_view"]
    : (parentSide === "left" ? leftBrowserView : rightBrowserView);
  if (!parentView) return;

  let parentBounds;
  try { parentBounds = parentView.getBounds(); } catch (_) { parentBounds = { x: 0, y: 0, width: 800, height: 600 }; }

  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
    },
  });
  // 禁用默认 Ctrl+滚轮缩放（与主 view 一致）
  try {
    view.webContents.setLayoutZoomResizingEnabled(false);
    view.webContents.setVisualZoomResizingEnabled(false);
  } catch (_) {}

  // 附加消息中继（与主 view 完全一致）
  view.webContents.on("did-finish-load", () => {
    view.webContents.insertCSS(`
      ::-webkit-scrollbar { width: 4px; height: 4px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: rgba(148,163,184,.30); border-radius: 4px; }
      ::-webkit-scrollbar-thumb:hover { background: rgba(99,102,241,.45); }
      ::-webkit-scrollbar-corner { background: transparent; }
      .cinside-picking, .cinside-picking * { cursor: crosshair !important; }
      .cinside-picking *:hover { outline: 2px dashed #6366f1 !important; outline-offset: 1px !important; box-shadow: 0 0 0 4px rgba(99,102,241,.15) !important; }
      @keyframes cinside-pick-flash { 0% { outline: 3px solid #6366f1; outline-offset: 1px; box-shadow: 0 0 0 6px rgba(99,102,241,0.30); } 70% { outline: 3px solid rgba(99,102,241,0.4); outline-offset: 1px; box-shadow: 0 0 0 6px rgba(99,102,241,0.10); } 100% { outline: 3px solid rgba(99,102,241,0); outline-offset: 1px; box-shadow: 0 0 0 6px rgba(99,102,241,0); } }
      .cinside-pick-flash { animation: cinside-pick-flash 0.28s ease-out forwards; }
    `).catch(() => {});
    // 页面加载后若拾取模式激活，注入拾取脚本
    const picking = isDetached ? detachedPickingActive[detachedSide] : pickingActive[parentSide];
    if (picking) {
      view.webContents.executeJavaScript(ELEMENT_PICKER_SCRIPT).catch(() => {});
    }
  });

  view.webContents.on("dom-ready", () => {
    view.webContents.executeJavaScript(`
      (function () {
        if (window.__cinsideRelayInstalled) return;
        window.__cinsideRelayInstalled = true;
        window.__cinsidePostMessage = function (payload) {
          try { console.log('[cinside-relay]', JSON.stringify(payload)); } catch (e) {}
        };
        // Ctrl+滚轮缩放：passive:true 不阻塞页面正常滚动
        window.addEventListener('wheel', function (e) {
          if (e.ctrlKey) {
            console.log('[cinside-relay]', JSON.stringify({ kind: 'ctrl-wheel', deltaY: e.deltaY }));
          }
        }, { passive: true });
      })();
    `).catch(() => {});
  });

  view.webContents.on("did-navigate", () => {
    const picking = isDetached ? detachedPickingActive[detachedSide] : pickingActive[parentSide];
    if (picking) {
      view.webContents.executeJavaScript(ELEMENT_PICKER_SCRIPT).catch(() => {});
    }
  });
  view.webContents.on("did-navigate-in-page", () => {
    const picking = isDetached ? detachedPickingActive[detachedSide] : pickingActive[parentSide];
    if (picking) {
      view.webContents.executeJavaScript(ELEMENT_PICKER_SCRIPT).catch(() => {});
    }
  });

// 弹窗内的 console-message 转发到前端（side = parentSide，拾取结果正常回传）
view.webContents.on("console-message", (_e, level, message) => {
  if (typeof message !== "string") return;
  if (message.startsWith("[onPick]") || message.startsWith("[BrowserPane")) {
    debugLog(`[popup:${side}] ${message}`);
  }
  const tag = "[cinside-relay]";
  if (message.startsWith(tag)) {
    try {
      const payload = JSON.parse(message.slice(tag.length).trim());
      // 发给弹窗所在的窗口（fromPopup 标记：拾取结果来自弹窗，执行时路由到弹窗 view）
      if (win && !win.isDestroyed()) {
        win.webContents.send("view-message", { side: parentSide, payload, fromPopup: true });
      }
      // 如果是脱离窗口的弹窗，也要发给主窗口
      if (win !== mainWindow && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("view-message", { side: parentSide, payload, fromPopup: true });
      }
    } catch (_) {}
  }
  });

  // 弹窗内再次 window.open：替换当前弹窗
  view.webContents.setWindowOpenHandler(({ url: subUrl }) => {
    if (subUrl && subUrl !== "about:blank") {
      createPopupView(parentSide, subUrl, win);
    }
    return { action: "deny" };
  });

  // 加载 URL 并设置 bounds（居中于父 view，四周露出父页面）
  view.webContents.loadURL(url);
  view.setBounds(computePopupBounds(parentBounds));
  win.addBrowserView(view);

  popupViews[parentSide] = { view, win, url };

  // 通知前端弹窗已创建
  notifyPopupCreated(parentSide, url, win);
}

function closePopupView(parentSide) {
  const popup = popupViews[parentSide];
  if (!popup) return;
  try {
    if (popup.win && !popup.win.isDestroyed()) {
      popup.win.removeBrowserView(popup.view);
    }
    if (popup.view.webContents && !popup.view.webContents.isDestroyed()) {
      popup.view.webContents.close();
    }
  } catch (e) {
    console.warn("[closePopupView]", e?.message || e);
  }
  popupViews[parentSide] = null;
  notifyPopupClosed(parentSide);
}

function notifyPopupCreated(parentSide, url, win) {
  const data = { parentSide, url };
  if (win && !win.isDestroyed()) win.webContents.send("popup-created", data);
  if (win !== mainWindow && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("popup-created", data);
  }
}

function notifyPopupClosed(parentSide) {
  const data = { parentSide };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("popup-closed", data);
  }
  // 也通知所有脱离窗口
  for (const key of Object.keys(detachedPanels)) {
    const w = detachedPanels[key];
    if (w && !w.isDestroyed()) {
      w.webContents.send("popup-closed", data);
    }
  }
}

function closeAllPopupViews() {
  for (const side of Object.keys(popupViews)) {
    closePopupView(side);
  }
}

// ============ 通用 view 操作 ============
// 跟踪每个 side 的拾取模式状态：导航/重载后需重注入拾取脚本
const pickingActive = { left: false, right: false };
// 跟踪每个 side 的元素屏蔽规则（含 mode），导航/重载后自动重注入
const blockRulesBySide = { left: [], right: [] };
// insertCSS 返回的 key，用于移除旧规则
let blockCssKey = { left: null, right: null };
// 折叠规则的 JS key，用于移除旧脚本
let blockJsKey = { left: null, right: null };

function applyBlockRules(side) {
  const view = side === "left" ? leftBrowserView : rightBrowserView;
  if (!view) return;
  var oldCssKey = blockCssKey[side];
  blockCssKey[side] = null;
  const rules = blockRulesBySide[side];
  if (!rules || rules.length === 0) {
    // 无规则：移除旧CSS（insertCSS + style标签），并注入清理JS恢复被折叠的元素
    if (oldCssKey) view.webContents.removeInsertedCSS(oldCssKey).catch(() => {});
    view.webContents.executeJavaScript(
      "(function(){var s=document.getElementById('cinside-block-style');if(s)s.remove();})();"
    ).catch(() => {});
    var cleanupJs = "(function() {\n" +
      "  document.querySelectorAll('.cinside-sidebar-hidden, .cinside-collapsed').forEach(function(el) {\n" +
      "    el.classList.remove('cinside-sidebar-hidden', 'cinside-sidebar-left', 'cinside-sidebar-right', 'cinside-collapsed', 'cinside-expanded');\n" +
      "    el.style.removeProperty('width');\n" +
      "    el.style.removeProperty('min-width');\n" +
      "    el.style.removeProperty('max-width');\n" +
      "    el.style.removeProperty('overflow');\n" +
      "    el.style.removeProperty('transform');\n" +
      "    el.style.removeProperty('opacity');\n" +
      "    el.style.removeProperty('pointer-events');\n" +
      "    el.style.removeProperty('padding');\n" +
      "    el.style.removeProperty('margin');\n" +
      "    el.style.removeProperty('border');\n" +
      "    el.style.removeProperty('flex');\n" +
      "    delete el.dataset.cinsideAutoMarked;\n" +
      "    delete el.dataset.cinsideCollapsed;\n" +
      "    delete el.dataset.cinsideForceCollapsed;\n" +
      "    delete el.dataset.cinsideCollapse;\n" +
      "    delete el.dataset.cinsideBtnAttached;\n" +
      "  });\n" +
      "  document.querySelectorAll('.cinside-expand-btn').forEach(function(b) { b.remove(); });\n" +
      "})();";
    view.webContents.executeJavaScript(cleanupJs).catch(() => {});
    return;
  }

  var hideSelectors = [];
  var collapseSelectors = [];
  var autoSidebarDetect = false;
  rules.forEach(function (r) {
    if (r.mode === "collapse") {
      collapseSelectors.push(r.selector);
      // 自动侧边栏折叠选择器特征：包含 [class*= 或 aside 标签
      if (r.selector.indexOf("[class*=") >= 0 || r.selector === "aside" || r.selector.indexOf("[id*=") >= 0) {
        autoSidebarDetect = true;
      }
    } else {
      hideSelectors.push(r.selector);
    }
  });

  // 合并所有 CSS（hide + collapse）一次注入
  var cssParts = [];
  if (hideSelectors.length > 0) {
    cssParts.push(hideSelectors.join(",\n") + " { display: none !important; }");
  }
  // 手动折叠规则的 CSS（选择器精确匹配）：width:0 + transform 双保险
  var manualCollapseSels = collapseSelectors.filter(function(s) {
    return s.indexOf("[class*=") < 0 && s !== "aside" && s.indexOf("[id*=") < 0;
  });
  if (manualCollapseSels.length > 0) {
    cssParts.push(manualCollapseSels.map(function (s) {
      return s + " { width: 0 !important; min-width: 0 !important; max-width: 0 !important; overflow: hidden !important; padding: 0 !important; margin: 0 !important; border: 0 !important; flex: 0 0 0 !important; transform: translateX(-100%) !important; transition: transform 0.25s ease-out, width 0.25s ease-out; }";
    }).join("\n"));
  }
  // 自动检测到的侧边栏折叠类
  cssParts.push(".cinside-sidebar-hidden { width: 0 !important; min-width: 0 !important; max-width: 0 !important; overflow: hidden !important; padding: 0 !important; margin: 0 !important; border: 0 !important; flex: 0 0 0 !important; opacity: 0 !important; pointer-events: none !important; transition: width 0.25s ease-out, opacity 0.2s ease-out; }");
  cssParts.push(".cinside-sidebar-hidden.cinside-sidebar-left { transform: translateX(-105%) !important; }");
  cssParts.push(".cinside-sidebar-hidden.cinside-sidebar-right { transform: translateX(105%) !important; }");
  cssParts.push(".cinside-expanded { width: revert !important; min-width: revert !important; max-width: revert !important; overflow: revert !important; padding: revert !important; margin: revert !important; border: revert !important; flex: revert !important; transform: none !important; opacity: 1 !important; pointer-events: auto !important; }");

  // 自动侧边栏折叠：直接用 CSS 折叠所有匹配选择器的元素（不等 JS 检测）
  // 排除已被用户手动展开的 (.cinside-expanded)
  if (autoSidebarDetect) {
    var autoCollapseCss = collapseSelectors.filter(function(s) {
      return s.indexOf("[class*=") >= 0 || s === "aside" || s.indexOf("[id*=") >= 0;
    }).map(function(s) {
      return s + ":not(.cinside-expanded) { width: 0 !important; min-width: 0 !important; max-width: 0 !important; overflow: hidden !important; padding: 0 !important; margin: 0 !important; border: 0 !important; flex: 0 0 0 !important; opacity: 0 !important; pointer-events: none !important; }";
    });
    if (autoCollapseCss.length > 0) {
      cssParts.push(autoCollapseCss.join("\n"));
    }
  }

  if (cssParts.length > 0) {
    var fullCss = cssParts.join("\n");
    // 方式1：executeJavaScript 同步注入 <style> 标签 —— 比 insertCSS 更快生效，
    // 在 dom-ready 时能在页面渲染前立即应用 CSS，避免侧边栏先显示再被隐藏的闪烁
    var styleInjectJs = "(function(){\n" +
      "  var existing = document.getElementById('cinside-block-style');\n" +
      "  if (existing) existing.remove();\n" +
      "  var style = document.createElement('style');\n" +
      "  style.id = 'cinside-block-style';\n" +
      "  style.textContent = " + JSON.stringify(fullCss) + ";\n" +
      "  (document.head || document.documentElement).appendChild(style);\n" +
      "})();";
    view.webContents.executeJavaScript(styleInjectJs).catch(() => {});
    // 方式2：insertCSS 作为持久化备份（防止页面 JS 移除 <style> 标签）
    view.webContents.insertCSS(fullCss).then(function (key) {
      blockCssKey[side] = key;
      if (oldCssKey) {
        view.webContents.removeInsertedCSS(oldCssKey).catch(() => {});
      }
    }).catch(() => {});
  } else if (oldCssKey) {
    view.webContents.removeInsertedCSS(oldCssKey).catch(() => {});
    view.webContents.executeJavaScript(
      "(function(){var s=document.getElementById('cinside-block-style');if(s)s.remove();})();"
    ).catch(() => {});
  }

  // 折叠 JS：手动选择器折叠 + 可选的自动几何检测
  if (collapseSelectors.length > 0) {
    var collapseJs = "(function() {\n" +
      "  var manualSels = " + JSON.stringify(manualCollapseSels) + ";\n" +
      "  var autoDetect = " + (autoSidebarDetect ? "true" : "false") + ";\n" +
      "  var scanTimer = null;\n" +
      "  function scheduleScan() { if (!scanTimer) scanTimer = setTimeout(doScan, 200); }\n" +
      "  // 强制折叠手动选择的元素\n" +
      "  function forceCollapseManual(el) {\n" +
      "    if (el.dataset.cinsideCollapsed === '1') return;\n" +
      "    el.dataset.cinsideCollapsed = '1';\n" +
      "    el.classList.add('cinside-collapsed');\n" +
      "    el.style.setProperty('width', '0px', 'important');\n" +
      "    el.style.setProperty('min-width', '0px', 'important');\n" +
      "    el.style.setProperty('max-width', '0px', 'important');\n" +
      "    el.style.setProperty('overflow', 'hidden', 'important');\n" +
      "    el.style.setProperty('transform', 'translateX(-100%)', 'important');\n" +
      "    // 尝试点击网站的原生关闭按钮，然后回收父容器预留空间\n" +
      "    try { tryClickNativeToggle(el, 'left'); } catch(e) {}\n" +
      "    setTimeout(function() { try { reclaimParentSpace(el, 'left'); } catch(e) {} }, 250);\n" +
      "    setTimeout(function() { try { reclaimParentSpace(el, 'left'); } catch(e) {} }, 900);\n" +
      "    var obs = new MutationObserver(function() {\n" +
      "      if (el.classList.contains('cinside-expanded')) return;\n" +
      "      el.style.setProperty('width', '0px', 'important');\n" +
      "      el.style.setProperty('min-width', '0px', 'important');\n" +
      "      el.style.setProperty('max-width', '0px', 'important');\n" +
      "      el.style.setProperty('overflow', 'hidden', 'important');\n" +
      "      el.style.setProperty('transform', 'translateX(-100%)', 'important');\n" +
      "    });\n" +
      "    obs.observe(el, { attributes: true, attributeFilter: ['style', 'class'] });\n" +
      "  }\n" +
      "  // 尝试点击网站自身提供的侧边栏关闭/折叠/切换按钮（优先于纯样式隐藏）\n" +
      "  function tryClickNativeToggle(el, side) {\n" +
      "    if (el.dataset.cinsideToggled === '1') return false;\n" +
      "    el.dataset.cinsideToggled = '1';\n" +
      "    var elId = el.id ? el.id : null;\n" +
      "    var toggles = [];\n" +
      "    var addToggle = function(btn, score) {\n" +
      "      if (!btn || btn.dataset && btn.dataset.cinsideToggleTried === '1') return;\n" +
      "      try { btn.dataset.cinsideToggleTried = '1'; } catch(e) {}\n" +
      "      toggles.push({ b: btn, score: score || 0 });\n" +
      "    };\n" +
      "    // 1) 侧边栏内部：通常有一个收起/关闭按钮（chevron / × / toggle 图标）\n" +
      "    try {\n" +
      "      var innerCandidates = el.querySelectorAll('button, [role=\"button\"], [data-toggle], [aria-controls], a[href=\"#\"], [class*=\"icon\" i], svg, i');\n" +
      "      for (var ii = 0; ii < innerCandidates.length; ii++) {\n" +
      "        var c = innerCandidates[ii];\n" +
      "        var txt = ((c.textContent || '') + ' ' + (c.getAttribute('aria-label') || '') + ' ' + (c.getAttribute('title') || '') + ' ' + (c.className || '') + ' ' + (c.id || '')).toLowerCase();\n" +
      "        var s = 0;\n" +
      "        if (/(collapse|toggle|hide|close|minimize|收起|折叠|关闭|drawer|sider|sidebar|chevron|angle-left|angle-right|arrow-left|arrow-right|leftarrow|rightarrow|back|nav-toggle|menu|退出|收起侧栏|[×x»«<>]|三)/.test(txt)) s += 3;\n" +
      "        if (c.querySelector('svg, i, [class*=\"icon\" i]')) s += 1;\n" +
      "        if (s >= 3) addToggle(c, s);\n" +
      "      }\n" +
      "    } catch(e) {}\n" +
      "    // 2) 外部：aria-controls 指向该侧边栏的元素\n" +
      "    if (elId) {\n" +
      "      try {\n" +
      "        var controlled = document.querySelectorAll('[aria-controls=\"' + elId + '\"]');\n" +
      "        for (var ci = 0; ci < controlled.length; ci++) addToggle(controlled[ci], 5);\n" +
      "      } catch(e) {}\n" +
      "      try {\n" +
      "        var dtgt = document.querySelectorAll('[data-target=\"#' + elId + '\"]');\n" +
      "        for (var di = 0; di < dtgt.length; di++) addToggle(dtgt[di], 4);\n" +
      "      } catch(e) {}\n" +
      "    }\n" +
      "    // 3) 通用切换按钮选择器（顶部常见的汉堡/三横线等）\n" +
      "    try {\n" +
      "      var generic = document.querySelectorAll('.sidebar-toggle, .toggle-sidebar, .sidebar-toggle-btn, .sider-trigger, .ant-layout-sider-trigger, .drawer-toggle, .menu-toggle, .hamburger, .burger, .nav-toggle, .btn-collapse, .btn-menu, .app-sidebar__toggle, .main-sidebar__toggle, #sidebar-toggle, #menu-toggle, [data-sidebar-toggle], [data-action=\"toggle-sidebar\"], [data-toggle=\"sidebar\"], [class*=\"sidebar-toggle\" i], [id*=\"sidebar-toggle\" i], [class*=\"sider-trigger\" i]');\n" +
      "      for (var gi = 0; gi < generic.length; gi++) {\n" +
      "        var g = generic[gi];\n" +
      "        var gSig = ((g.textContent || '') + ' ' + (g.getAttribute('aria-label') || '') + ' ' + (g.getAttribute('title') || '') + ' ' + (g.className || '') + ' ' + (g.id || '')).toLowerCase();\n" +
      "        var gScore = 3;\n" +
      "        if (/(collapse|toggle|hide|close|minimize|收起|折叠|关闭|menu|drawer|sider|sidebar|chevron|angle|arrow|hamburger|burger|nav|×|x|三|»|«)/.test(gSig)) gScore += 1;\n" +
      "        if (g.getAttribute('aria-expanded') === 'true') gScore += 1;\n" +
      "        addToggle(g, gScore);\n" +
      "      }\n" +
      "    } catch(e) {}\n" +
      "    // 4) 父容器中的兄弟元素（布局中经常在标题栏放 toggle 按钮）\n" +
      "    try {\n" +
      "      var parent = el.parentElement;\n" +
      "      if (parent) {\n" +
      "        var sibs = parent.querySelectorAll('button, [role=\"button\"], a[href=\"#\"], [class*=\"icon\" i], svg, i');\n" +
      "        for (var si = 0; si < sibs.length; si++) {\n" +
      "          var sb = sibs[si];\n" +
      "          if (sb === el || el.contains(sb)) continue;\n" +
      "          var sbSig = ((sb.textContent || '') + ' ' + (sb.getAttribute('aria-label') || '') + ' ' + (sb.getAttribute('title') || '') + ' ' + (sb.className || '') + ' ' + (sb.id || '')).toLowerCase();\n" +
      "          if (/(collapse|toggle|hide|close|minimize|收起|折叠|关闭|menu|drawer|sider|sidebar|chevron|angle|arrow|back|nav|hamburger|burger|[×x»«<>]|三)/.test(sbSig)) addToggle(sb, 2);\n" +
      "        }\n" +
      "      }\n" +
      "    } catch(e) {}\n" +
      "    // 按得分从高到低点击，最多尝试 3 个\n" +
      "    toggles.sort(function(a, b) { return b.score - a.score; });\n" +
      "    var clicked = 0;\n" +
      "    for (var ti = 0; ti < toggles.length && clicked < 3; ti++) {\n" +
      "      var t = toggles[ti].b;\n" +
      "      try {\n" +
      "        var rect = t.getBoundingClientRect && t.getBoundingClientRect();\n" +
      "        var cs = window.getComputedStyle(t);\n" +
      "        if (!cs || cs.display === 'none' || cs.visibility === 'hidden' || (rect && (rect.width < 2 || rect.height < 2))) continue;\n" +
      "        var ev = new MouseEvent('click', { bubbles: true, cancelable: true, view: window, composed: true });\n" +
      "        t.dispatchEvent(ev);\n" +
      "        if (typeof t.click === 'function') try { t.click(); } catch(e) {}\n" +
      "        clicked++;\n" +
      "        el.dataset.cinsideNativeToggled = '1';\n" +
      "      } catch(e) {}\n" +
      "    }\n" +
      "    return clicked > 0;\n" +
      "  }\n" +
      "  // 向上遍历容器，回收父/兄弟元素预留的侧边栏间距（grid/flex/margin/padding/left 等），消除黑区\n" +
      "  function reclaimParentSpace(el, side) {\n" +
      "    var marginSide = side === 'left' ? 'marginLeft' : 'marginRight';\n" +
      "    var marginSideCSS = side === 'left' ? 'margin-left' : 'margin-right';\n" +
      "    var paddingSide = side === 'left' ? 'paddingLeft' : 'paddingRight';\n" +
      "    var paddingSideCSS = side === 'left' ? 'padding-left' : 'padding-right';\n" +
      "    var posSide = side === 'left' ? 'left' : 'right';\n" +
      "    // 1) 处理兄弟元素：常见「兄弟 main 有 margin-left: 200px」或 padding-left 预留\n" +
      "    try {\n" +
      "      var parent = el.parentElement;\n" +
      "      if (parent) {\n" +
      "        for (var bi = 0; bi < parent.children.length; bi++) {\n" +
      "          var sib = parent.children[bi];\n" +
      "          if (sib === el) continue;\n" +
      "          try {\n" +
      "            var sibTag = (sib.tagName || '').toLowerCase();\n" +
      "            if (sibTag === 'script' || sibTag === 'style' || sibTag === 'link' || sibTag === 'meta' || sibTag === 'noscript') continue;\n" +
      "            var sCS = window.getComputedStyle(sib);\n" +
      "            var mv = parseFloat(sCS[marginSide]);\n" +
      "            var pv = parseFloat(sCS[paddingSide]);\n" +
      "            if (!isNaN(mv) && mv > 10) sib.style.setProperty(marginSideCSS, '0px', 'important');\n" +
      "            if (!isNaN(pv) && pv > 10) sib.style.setProperty(paddingSideCSS, '0px', 'important');\n" +
      "            var pos = sCS.position;\n" +
      "            if (pos === 'absolute' || pos === 'fixed' || pos === 'sticky' || pos === 'relative') {\n" +
      "              var lv = parseFloat(sCS[posSide]);\n" +
      "              if (!isNaN(lv) && lv > 10) sib.style.setProperty(posSide, '0px', 'important');\n" +
      "            }\n" +
      "          } catch(e) {}\n" +
      "        }\n" +
      "      }\n" +
      "    } catch(e) {}\n" +
      "    // 2) 向上遍历祖先，修正 grid/flex/margin/padding 预留（向上最多 8 层）\n" +
      "    var cur = el.parentElement;\n" +
      "    var depth = 0;\n" +
      "    while (cur && cur !== document.documentElement && depth < 8) {\n" +
      "      depth++;\n" +
      "      try {\n" +
      "        var curCS = window.getComputedStyle(cur);\n" +
      "        // Grid：把侧边栏对应列的宽度设为 0px（左→第一列，右→最后一列）\n" +
      "        if (curCS.display === 'grid' || curCS.display === 'inline-grid') {\n" +
      "          var tc = cur.style ? cur.style.gridTemplateColumns : '';\n" +
      "          if (!tc) tc = curCS.gridTemplateColumns;\n" +
      "          if (tc && /\\d/.test(tc)) {\n" +
      "            var cols = tc.trim().split(/\\s+/).filter(function(x) { return x.length > 0; });\n" +
      "            if (cols.length >= 2) {\n" +
      "              var targetIdx = side === 'left' ? 0 : cols.length - 1;\n" +
      "              var firstPx = parseFloat(cols[targetIdx]);\n" +
      "              if (!isNaN(firstPx) && firstPx > 0) {\n" +
      "                cols[targetIdx] = '0px';\n" +
      "                cur.style.setProperty('grid-template-columns', cols.join(' '), 'important');\n" +
      "              }\n" +
      "            }\n" +
      "          }\n" +
      "        }\n" +
      "        // 容器自身的 margin/padding/pos 预留\n" +
      "        var mvC = parseFloat(curCS[marginSide]);\n" +
      "        var pvC = parseFloat(curCS[paddingSide]);\n" +
      "        if (!isNaN(mvC) && mvC > 10) cur.style.setProperty(marginSideCSS, '0px', 'important');\n" +
      "        if (!isNaN(pvC) && pvC > 10) cur.style.setProperty(paddingSideCSS, '0px', 'important');\n" +
      "        var posC = curCS.position;\n" +
      "        if (posC === 'absolute' || posC === 'fixed' || posC === 'sticky' || posC === 'relative') {\n" +
      "          var lvC = parseFloat(curCS[posSide]);\n" +
      "          if (!isNaN(lvC) && lvC > 10) cur.style.setProperty(posSide, '0px', 'important');\n" +
      "        }\n" +
      "      } catch(e) {}\n" +
      "      cur = cur.parentElement;\n" +
      "    }\n" +
      "    // 3) 兜底：body/documentElement 上的 margin/padding 预留（部分框架会在这里偏移）\n" +
      "    try {\n" +
      "      var bodyCS = window.getComputedStyle(document.body);\n" +
      "      var bMv = parseFloat(bodyCS[marginSide]);\n" +
      "      var bPv = parseFloat(bodyCS[paddingSide]);\n" +
      "      if (!isNaN(bMv) && bMv > 10) document.body.style.setProperty(marginSideCSS, '0px', 'important');\n" +
      "      if (!isNaN(bPv) && bPv > 10) document.body.style.setProperty(paddingSideCSS, '0px', 'important');\n" +
      "      var docCS = window.getComputedStyle(document.documentElement);\n" +
      "      var dMv = parseFloat(docCS[marginSide]);\n" +
      "      var dPv = parseFloat(docCS[paddingSide]);\n" +
      "      if (!isNaN(dMv) && dMv > 10) document.documentElement.style.setProperty(marginSideCSS, '0px', 'important');\n" +
      "      if (!isNaN(dPv) && dPv > 10) document.documentElement.style.setProperty(paddingSideCSS, '0px', 'important');\n" +
      "    } catch(e) {}\n" +
      "  }\n" +
      "  // 自动检测侧边栏：通过几何特征\n" +
      "  function autoDetectSidebars() {\n" +
      "    var vw = window.innerWidth;\n" +
      "    var vh = window.innerHeight;\n" +
      "    var found = [];\n" +
      "    // 候选选择器：aside/nav + 各种常见侧边栏类名/id + body 前4层后代\n" +
      "    var candidateSels = 'aside, nav, [role=\"navigation\"], [class*=\"sidebar\" i], [class*=\"sider\" i], [class*=\"side-bar\" i], [class*=\"sidenav\" i], [class*=\"side-nav\" i], [class*=\"side-menu\" i], [class*=\"left-menu\" i], [class*=\"left-panel\" i], [class*=\"left-nav\" i], [class*=\"left-sidebar\" i], [class*=\"right-panel\" i], [class*=\"right-sidebar\" i], [class*=\"drawer\" i], [class*=\"nav-menu\" i], [class*=\"layout-sider\" i], [class*=\"ant-layout-sider\" i], [class*=\"el-aside\" i], [class*=\"app-sidebar\" i], [class*=\"main-sidebar\" i], [class*=\"menu-panel\" i], [class*=\"nav-panel\" i], [class*=\"sidebar-content\" i], [class*=\"side-content\" i], [id*=\"sidebar\" i], [id*=\"sidenav\" i], [id*=\"side-bar\" i]';\n" +
      "    var candidates = document.querySelectorAll(candidateSels);\n" +
      "    // 额外递归扫描 body 前 4 层，捕获无特征类名的侧边栏\n" +
      "    var extraEls = [];\n" +
      "    function collectLayer(root, depth) {\n" +
      "      if (depth > 4 || !root || !root.children) return;\n" +
      "      for (var i = 0; i < root.children.length; i++) {\n" +
      "        var child = root.children[i];\n" +
      "        try {\n" +
      "          var r = child.getBoundingClientRect();\n" +
      "          // 直接符合侧边栏特征的，加入候选\n" +
      "          if (r.width >= 80 && r.width <= 500 && r.height >= vh * 0.4 && (r.left <= 10 || r.right >= vw - 10)) {\n" +
      "            extraEls.push(child);\n" +
      "          }\n" +
      "          // 只有当元素足够大（>=60% 视口宽、>=40% 视口高）时才继续递归（容器元素）\n" +
      "          if (r.width >= vw * 0.5 && r.height >= vh * 0.4) {\n" +
      "            collectLayer(child, depth + 1);\n" +
      "          }\n" +
      "        } catch(e) {}\n" +
      "      }\n" +
      "    }\n" +
      "    collectLayer(document.body, 0);\n" +
      "    var candidatesArr = [].slice.call(candidates);\n" +
      "    for (var ei = 0; ei < extraEls.length; ei++) candidatesArr.push(extraEls[ei]);\n" +
      "    var seen = new Set();\n" +
      "    candidatesArr.forEach(function(el) {\n" +
      "      if (seen.has(el) || el.dataset.cinsideAutoMarked === '1' || el.classList.contains('cinside-expanded')) return;\n" +
      "      seen.add(el);\n" +
      "      try {\n" +
      "        // 测量自然尺寸：临时移除 CSS 折叠来测量\n" +
      "        var rect = el.getBoundingClientRect();\n" +
      "        var naturalW = rect.width;\n" +
      "        var naturalH = rect.height;\n" +
      "        if (naturalW === 0 || naturalH === 0) {\n" +
      "          // 被 CSS 预折叠了，临时彻底展开测量（覆盖所有被 CSS 隐藏的属性）\n" +
      "          var savedStyle = el.getAttribute('style') || '';\n" +
      "          el.style.setProperty('width', 'auto', 'important');\n" +
      "          el.style.setProperty('min-width', '0', 'important');\n" +
      "          el.style.setProperty('max-width', 'none', 'important');\n" +
      "          el.style.setProperty('opacity', '1', 'important');\n" +
      "          el.style.setProperty('overflow', 'visible', 'important');\n" +
      "          el.style.setProperty('display', 'block', 'important');\n" +
      "          el.style.setProperty('flex', '0 0 auto', 'important');\n" +
      "          el.style.setProperty('transform', 'none', 'important');\n" +
      "          el.style.setProperty('padding', '0', 'important');\n" +
      "          el.style.setProperty('margin', '0', 'important');\n" +
      "          el.style.setProperty('border', '0', 'important');\n" +
      "          el.style.setProperty('pointer-events', 'auto', 'important');\n" +
      "          var r2 = el.getBoundingClientRect();\n" +
      "          naturalW = r2.width;\n" +
      "          naturalH = r2.height;\n" +
      "          var onLeft2 = r2.left <= 10;\n" +
      "          var onRight2 = r2.right >= vw - 10;\n" +
      "          // 恢复原始内联样式（CSS 预折叠规则仍通过 <style> 标签生效）\n" +
      "          if (savedStyle) el.setAttribute('style', savedStyle); else el.removeAttribute('style');\n" +
      "          if (naturalW < 80 || naturalW > 500) return;\n" +
      "          if (naturalH < vh * 0.4) return;\n" +
      "          if (!onLeft2 && !onRight2) return;\n" +
      "          found.push({ el: el, side: onLeft2 ? 'left' : 'right', area: naturalW * naturalH });\n" +
      "          return;\n" +
      "        }\n" +
      "        if (naturalW < 80 || naturalW > 500) return;\n" +
      "        if (naturalH < vh * 0.4) return;\n" +
      "        var onLeft = rect.left <= 10;\n" +
      "        var onRight = rect.right >= vw - 10;\n" +
      "        if (!onLeft && !onRight) return;\n" +
      "        // 排除已被折叠的祖先的子元素\n" +
      "        var p = el.parentElement;\n" +
      "        while (p && p !== document.body) {\n" +
      "          if (p.classList.contains('cinside-sidebar-hidden')) return;\n" +
      "          p = p.parentElement;\n" +
      "        }\n" +
      "        // 检查元素是否真正可见\n" +
      "        var cs = getComputedStyle(el);\n" +
      "        if (cs.display === 'none' || cs.visibility === 'hidden') return;\n" +
      "        found.push({ el: el, side: onLeft ? 'left' : 'right', area: naturalW * naturalH });\n" +
      "      } catch(e) {}\n" +
      "    });\n" +
      "    // 在同一侧取面积最大的（通常是最外层容器）\n" +
      "    var best = { left: null, right: null };\n" +
      "    found.forEach(function(f) {\n" +
      "      if (!best[f.side] || f.area > best[f.side].area) best[f.side] = f;\n" +
      "    });\n" +
      "    ['left', 'right'].forEach(function(sd) {\n" +
      "      if (best[sd] && !best[sd].el.classList.contains('cinside-expanded')) {\n" +
      "        collapseAutoSidebar(best[sd].el, sd);\n" +
      "      }\n" +
      "    });\n" +
      "  }\n" +
      "  function collapseAutoSidebar(el, sd) {\n" +
      "    if (el.dataset.cinsideAutoMarked === '1') return;\n" +
      "    el.dataset.cinsideAutoMarked = '1';\n" +
      "    el.classList.add('cinside-sidebar-hidden', sd === 'left' ? 'cinside-sidebar-left' : 'cinside-sidebar-right');\n" +
      "    // 优先：尝试点击网站自身的侧边栏切换/关闭按钮\n" +
      "    try { tryClickNativeToggle(el, sd); } catch(e) {}\n" +
      "    // 回收父/兄弟/祖先容器的预留间距（消除黑区）——两次定时以兼容网站动画和异步 re-render\n" +
      "    setTimeout(function() { try { reclaimParentSpace(el, sd); } catch(e) {} }, 250);\n" +
      "    setTimeout(function() { try { reclaimParentSpace(el, sd); } catch(e) {} }, 900);\n" +
      "    // 创建展开按钮\n" +
      "    var btn = document.createElement('div');\n" +
      "    btn.className = 'cinside-expand-btn';\n" +
      "    var btnPos = sd === 'left' ? 'left:0;' : 'right:0;';\n" +
      "    var btnArrow = sd === 'left' ? '\\u25B6' : '\\u25C0';\n" +
      "    btn.style.cssText = 'position:fixed;' + btnPos + 'top:50%;transform:translateY(-50%);width:14px;height:48px;background:rgba(99,102,241,0.85);color:#fff;cursor:pointer;z-index:2147483646;display:flex;align-items:center;justify-content:center;font-size:9px;border-radius:' + (sd === 'left' ? '0 3px 3px 0' : '3px 0 0 3px') + ';opacity:0;transition:opacity 0.2s;pointer-events:auto;';\n" +
      "    btn.textContent = btnArrow;\n" +
      "    btn.title = '\\u70B9\\u51FB\\u5C55\\u5F00\\u4FA7\\u8FB9\\u680F';\n" +
      "    btn.addEventListener('mouseenter', function() { btn.style.opacity = '1'; });\n" +
      "    btn.addEventListener('mouseleave', function() { btn.style.opacity = sd === 'left' ? (window.mouseX < 30 ? '0.3' : '0') : (window.mouseX > window.innerWidth - 30 ? '0.3' : '0'); });\n" +
      "    btn.addEventListener('click', function(e) {\n" +
      "      e.stopPropagation();\n" +
      "      e.preventDefault();\n" +
      "      el.classList.add('cinside-expanded');\n" +
      "      el.classList.remove('cinside-sidebar-hidden', 'cinside-sidebar-left', 'cinside-sidebar-right');\n" +
      "      // 尝试反向点击原生按钮以恢复（若 site 支持）\n" +
      "      try { tryClickNativeToggle(el, sd); } catch(e) {}\n" +
      "      // 展开时也清理我们在兄弟/祖先上覆盖的 margin/padding/grid\n" +
      "      try { clearReclaimedSpace(el, sd); } catch(e) {}\n" +
      "      btn.remove();\n" +
      "    });\n" +
      "    document.body.appendChild(btn);\n" +
      "    btn.style.opacity = '0.3';\n" +
      "    el._cinsideExpandBtn = btn;\n" +
      "    // 鼠标移到边缘显示按钮\n" +
      "    document.addEventListener('mousemove', function(ev) {\n" +
      "      window.mouseX = ev.clientX;\n" +
      "      if ((sd === 'left' && ev.clientX < 8) || (sd === 'right' && ev.clientX > window.innerWidth - 8)) {\n" +
      "        btn.style.opacity = '1';\n" +
      "      } else if ((sd === 'left' && ev.clientX > 30) || (sd === 'right' && ev.clientX < window.innerWidth - 30)) {\n" +
      "        btn.style.opacity = '0';\n" +
      "      }\n" +
      "    });\n" +
      "    // 监控被 SPA 恢复：若 sidebar 被重新加回，重设类名并再次回收间距\n" +
      "    var obs = new MutationObserver(function() {\n" +
      "      if (el.classList.contains('cinside-expanded')) return;\n" +
      "      if (!el.classList.contains('cinside-sidebar-hidden')) {\n" +
      "        el.classList.add('cinside-sidebar-hidden', sd === 'left' ? 'cinside-sidebar-left' : 'cinside-sidebar-right');\n" +
      "        setTimeout(function() { try { reclaimParentSpace(el, sd); } catch(e) {} }, 100);\n" +
      "      }\n" +
      "    });\n" +
      "    obs.observe(el, { attributes: true, attributeFilter: ['style', 'class'] });\n" +
      "  }\n" +
      "  // 展开时清理在兄弟/祖先/body/html 上通过 reclaimParentSpace 设置的 !important 覆盖\n" +
      "  function clearReclaimedSpace(el, side) {\n" +
      "    var marginSideCSS = side === 'left' ? 'margin-left' : 'margin-right';\n" +
      "    var paddingSideCSS = side === 'left' ? 'padding-left' : 'padding-right';\n" +
      "    var posSide = side === 'left' ? 'left' : 'right';\n" +
      "    var clearOn = function(node) {\n" +
      "      try {\n" +
      "        if (!node || !node.style) return;\n" +
      "        node.style.removeProperty(marginSideCSS);\n" +
      "        node.style.removeProperty(paddingSideCSS);\n" +
      "        node.style.removeProperty(posSide);\n" +
      "        node.style.removeProperty('grid-template-columns');\n" +
      "      } catch(e) {}\n" +
      "    };\n" +
      "    try {\n" +
      "      var parent = el.parentElement;\n" +
      "      if (parent) {\n" +
      "        for (var i = 0; i < parent.children.length; i++) {\n" +
      "          if (parent.children[i] !== el) clearOn(parent.children[i]);\n" +
      "        }\n" +
      "      }\n" +
      "    } catch(e) {}\n" +
      "    var cur = el.parentElement;\n" +
      "    var d = 0;\n" +
      "    while (cur && cur !== document.documentElement && d < 8) {\n" +
      "      d++;\n" +
      "      clearOn(cur);\n" +
      "      cur = cur.parentElement;\n" +
      "    }\n" +
      "    clearOn(document.body);\n" +
      "    clearOn(document.documentElement);\n" +
      "  }\n" +
      "  function doScan() {\n" +
      "    scanTimer = null;\n" +
      "    // 手动选择器\n" +
      "    manualSels.forEach(function(sel) {\n" +
      "      document.querySelectorAll(sel).forEach(function(el) {\n" +
      "        forceCollapseManual(el);\n" +
      "        // 手动折叠也创建展开按钮\n" +
      "        if (el.dataset.cinsideBtnAttached) return;\n" +
      "        el.dataset.cinsideBtnAttached = '1';\n" +
      "        // 先判断方向：根据元素左/右边缘贴边情况，决定按钮在哪一侧\n" +
      "        var r = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, right: window.innerWidth };\n" +
      "        var onLeft = r.left <= 10 || r.left < (window.innerWidth - r.right);\n" +
      "        var sdBtn = onLeft ? 'left' : 'right';\n" +
      "        var btn = document.createElement('div');\n" +
      "        btn.style.cssText = 'position:fixed;' + (onLeft ? 'left:0;border-radius:0 3px 3px 0;' : 'right:0;border-radius:3px 0 0 3px;') + 'top:50%;transform:translateY(-50%);width:14px;height:48px;background:rgba(99,102,241,0.85);color:#fff;cursor:pointer;z-index:2147483646;display:flex;align-items:center;justify-content:center;font-size:9px;opacity:0;transition:opacity 0.2s;pointer-events:auto;';\n" +
      "        btn.textContent = onLeft ? '\\u25B6' : '\\u25C0';\n" +
      "        btn.title = '\\u70B9\\u51FB\\u5C55\\u5F00\\u4FA7\\u8FB9\\u680F';\n" +
      "        btn.addEventListener('mouseenter', function() { btn.style.opacity = '1'; });\n" +
      "        btn.addEventListener('mouseleave', function() { btn.style.opacity = '0'; });\n" +
      "        btn.addEventListener('click', function(e) {\n" +
      "          e.stopPropagation();\n" +
      "          e.preventDefault();\n" +
      "          el.classList.add('cinside-expanded');\n" +
      "          el.style.setProperty('width', '', 'important');\n" +
      "          el.style.setProperty('min-width', '', 'important');\n" +
      "          el.style.setProperty('max-width', '', 'important');\n" +
      "          el.style.setProperty('overflow', '', 'important');\n" +
      "          el.style.setProperty('transform', '', 'important');\n" +
      "          // 清理回收的父/兄弟容器间距（让侧边栏展开时布局同步恢复）\n" +
      "          try { clearReclaimedSpace(el, sdBtn); } catch(e) {}\n" +
      "          btn.remove();\n" +
      "        });\n" +
      "        document.body.appendChild(btn);\n" +
      "        document.addEventListener('mousemove', function(ev) {\n" +
      "          if (onLeft) {\n" +
      "            if (ev.clientX < 8) btn.style.opacity = '1';\n" +
      "            else if (ev.clientX > 30) btn.style.opacity = '0';\n" +
      "          } else {\n" +
      "            if (ev.clientX > window.innerWidth - 8) btn.style.opacity = '1';\n" +
      "            else if (ev.clientX < window.innerWidth - 30) btn.style.opacity = '0';\n" +
      "          }\n" +
      "        });\n" +
      "      });\n" +
      "    });\n" +
      "    // 自动检测\n" +
      "    if (autoDetect) autoDetectSidebars();\n" +
      "  }\n" +
      "  doScan();\n" +
      "  var mo = new MutationObserver(function() { scheduleScan(); });\n" +
      "  mo.observe(document.body, { childList: true, subtree: true });\n" +
      "  window.addEventListener('resize', function() { scheduleScan(); });\n" +
      "  window.addEventListener('beforeunload', function() { mo.disconnect(); if (scanTimer) clearTimeout(scanTimer); });\n" +
      "})();";
    view.webContents.executeJavaScript(collapseJs).catch(() => {});
  }
}

function loadView(side, url) {
  const view = side === "left" ? leftBrowserView : rightBrowserView;
  if (!view || !url || typeof url !== "string") return;
  view.webContents.loadURL(url);
}

// === 模态覆盖层锁：modalOverlayDepth > 0 时禁止任何 BrowserView 被 add 回窗口，
// 防止 BrowserPane 的 150ms sync() 定时器或 resize 事件在模态期间把原生视图加回来遮挡 HTML ===
let modalOverlayDepth = 0;
let dockWasVisibleForModal = false;

function showView(side, bounds, _url) {
  // 注意：不再根据 url 不一致就自动 loadURL。
  // URL 加载只通过显式的 view-load / detached-view-load IPC 触发，
  // 否则数据源网站任何重定向（加斜杠/HTTPS/SPA 路由）都会让 sync() 触发无限刷新，
  // 导致已注入的拾取脚本和高亮层丢失。
  const view = side === "left" ? leftBrowserView : rightBrowserView;
  if (!mainWindow || !view) return;
  if (bounds) view.setBounds(bounds);
  if (!mainWindow.getBrowserViews().includes(view)) {
    mainWindow.addBrowserView(view);
  }
  // 确保 BrowserView 在最上层（HTML 层之上），否则 HTML 层可能拦截鼠标滚轮事件。
  // 弹窗（popup BrowserView）打开时 addBrowserView 会在主 view 之上，无需额外处理。
  // 注意：HTML 弹窗（设置对话框等）打开时 App.tsx 会主动 viewHide，所以不会被覆盖。
  try { mainWindow.setTopBrowserView(view); } catch (_) {}
  // 强制重绘：通过 setBounds 再次触发 Chromium 合成器刷新，解决后台
  // 加载/JS执行后 BrowserView 内容不更新直到重新切换tab才显示的问题
  // 使用版本号防止旧 setTimeout 的 bounds 覆盖新的 setBounds（zoom变化/页面加载时布局频繁变化）
  if (bounds) {
    view._cinsideBoundsVer = (view._cinsideBoundsVer || 0) + 1;
    const ver = view._cinsideBoundsVer;
    setTimeout(() => {
      if (ver === view._cinsideBoundsVer && !view.webContents.isDestroyed()) {
        try { view.setBounds(bounds); } catch (_) {}
      }
    }, 100);
  }
  // 同步弹窗 view 的 bounds（居中于主 view）
  const popup = popupViews[side];
  if (popup && popup.win === mainWindow && bounds) {
    popup.view.setBounds(computePopupBounds(bounds));
    if (!mainWindow.getBrowserViews().includes(popup.view)) {
      mainWindow.addBrowserView(popup.view);
    }
    // 弹窗必须在主 view 之上
    try { mainWindow.setTopBrowserView(popup.view); } catch (_) {}
  }
}

function hideView(side) {
  const view = side === "left" ? leftBrowserView : rightBrowserView;
  if (!mainWindow || !view) return;
  if (mainWindow.getBrowserViews().includes(view)) {
    mainWindow.removeBrowserView(view);
  }
  // 同时隐藏弹窗
  const popup = popupViews[side];
  if (popup && popup.win === mainWindow && mainWindow.getBrowserViews().includes(popup.view)) {
    mainWindow.removeBrowserView(popup.view);
  }
}

function hideAllViews() {
  hideView("left");
  hideView("right");
}

// 在指定 view 中执行 JS（用于元素选择脚本注入、高亮等）
function executeInView(side, script) {
  const view = side === "left" ? leftBrowserView : rightBrowserView;
  if (!view) return Promise.resolve(undefined);
  return view.webContents.executeJavaScript(script).catch((e) => {
    console.error(`[executeInView:${side}]`, e);
    return undefined;
  });
}

// 在指定 view 中插入 CSS（用于高亮样式）
function insertCSSInView(side, css) {
  const view = side === "left" ? leftBrowserView : rightBrowserView;
  if (!view) return Promise.resolve(undefined);
  return view.webContents.insertCSS(css).catch((e) => {
    console.error(`[insertCSSInView:${side}]`, e);
    return undefined;
  });
}

function destroyBrowserViews() {
  closeAllPopupViews();
  hideAllViews();
  // 安全销毁：webContents 可能在 window-all-closed 时已被 Electron 内部销毁，
  // 直接 .destroy() 会抛 "Cannot read properties of undefined"。
  // 用 try-catch + 存在性检查，确保不会因销毁失败而阻断退出流程。
  for (const ref of [leftBrowserView, rightBrowserView]) {
    if (!ref) continue;
    try {
      if (ref.webContents && !ref.webContents.isDestroyed()) {
        ref.webContents.close();
      }
    } catch (e) {
      console.warn("[destroyBrowserViews] webContents 关闭失败:", e?.message || e);
    }
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.removeBrowserView(ref);
      }
    } catch (e) {
      console.warn("[destroyBrowserViews] 移除 view 失败:", e?.message || e);
    }
  }
  leftBrowserView = null;
  rightBrowserView = null;
}

// ============ 元素选择脚本：监听点击并回传 selector / 文本 / 位置 ============
// 注入到目标 view，激活后下一次点击会被捕获，并阻止默认行为
const ELEMENT_PICKER_SCRIPT = `
(function () {
  var needsInstall = !window.__cinsidePickerInstalled;
  if (needsInstall) {
    window.__cinsidePickerInstalled = true;
    window.__cinsidePickerActive = false;
    window.__cinsideJustPicked = false;
  }

  function buildSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var chain = [];   // 每个 shadow 层一段路径（跨 shadow DOM 时各段用 ' >>> ' 连接）
    var path = [];
    var cur = el;
    var depth = 0;
    while (cur && cur.nodeType === 1) {
      // id 短路：作为当前段的锚点结束该段（shadow 内 id 在该 shadowRoot 内唯一）
      if (cur.id) {
        path.unshift('#' + CSS.escape(cur.id));
        chain.unshift(path.join(' > '));
        path = [];
        var root0 = cur.getRootNode ? cur.getRootNode() : null;
        if (root0 && root0.host) { cur = root0.host; depth = 0; continue; }
        break;
      }
      var part = cur.nodeName.toLowerCase();
      if (cur.className && typeof cur.className === 'string') {
        // 过滤 cinside-* 临时类（拾取/高亮时注入），否则拾取结束后类被移除，选择器失效
        // 注意：模板字符串中必须写 \\s，否则 \s 会被解析成字面 s，split(/\s+/) 变成 split(/s+/)
        var cls = cur.className.trim().split(/\\s+/)
          .filter(function (c) { return c && c.indexOf('cinside') !== 0; })
          .slice(0, 2).join('.');
        if (cls) part += '.' + cls;
      }
      var parent = cur.parentElement;
      if (parent) {
        var siblings = Array.prototype.filter.call(parent.children, function (c) { return c.nodeName === cur.nodeName; });
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
      }
      path.unshift(part);
      depth++;
      if (parent && depth < 8) { cur = parent; continue; }
      // 到达当前文档树顶层：若在 shadow root 内，跨越到 host 继续向上
      var root = cur.getRootNode ? cur.getRootNode() : null;
      if (root && root.host) {
        chain.unshift(path.join(' > '));
        path = [];
        cur = root.host;
        depth = 0;
        continue;
      }
      // iframe 边界：顶层元素的 ownerDocument 有 frameElement 时，跨越到 iframe 元素继续向上
      try {
        var topDoc = cur.ownerDocument;
        var frameEl = topDoc && topDoc.defaultView && topDoc.defaultView.frameElement;
        if (frameEl) {
          chain.unshift(path.join(' > '));
          path = [];
          cur = frameEl;
          depth = 0;
          continue;
        }
      } catch (_) {}
      break;
    }
    if (path.length) chain.unshift(path.join(' > '));
    return chain.join(' >>> ');
  }

  function getLabel(el) {
    if (el.labels && el.labels[0]) return el.labels[0].innerText.trim();
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    if (el.getAttribute('placeholder')) return el.getAttribute('placeholder');
    if (el.getAttribute('name')) return el.getAttribute('name');
    var txt = (el.innerText || '').trim().slice(0, 40);
    return txt;
  }

  // 元素矩形：统一转换到主视口坐标（iframe 内元素累加各层 frame 偏移）
  function getRect(el) {
    var r = el.getBoundingClientRect();
    var x = r.x, y = r.y;
    try {
      var doc = el.ownerDocument;
      while (doc && doc !== document) {
        var frameEl = doc.defaultView && doc.defaultView.frameElement;
        if (!frameEl) break;
        var fr = frameEl.getBoundingClientRect();
        x += fr.left + (frameEl.clientLeft || 0);
        y += fr.top + (frameEl.clientTop || 0);
        doc = frameEl.ownerDocument;
      }
    } catch (_) {}
    return { x: Math.round(x), y: Math.round(y), width: Math.round(r.width), height: Math.round(r.height) };
  }

  function highlight(el, color) {
    try {
      // 用 data 属性标记当前闪光颜色，CSS keyframe 通过该属性选择颜色
      el.setAttribute('data-cinside-flash', '1');
      el.classList.remove('cinside-pick-flash');
      void el.offsetWidth;
      el.classList.add('cinside-pick-flash');
      var onEnd = function() {
        el.classList.remove('cinside-pick-flash');
        el.removeAttribute('data-cinside-flash');
        el.removeEventListener('animationend', onEnd);
      };
      el.addEventListener('animationend', onEnd);
      // 兜底：animationend 可能不触发（页面隐藏等情况）
      setTimeout(onEnd, 500);
    } catch(e) {}
  }

  var lastPickTime = 0;
  // 判断元素是否为输入类元素
  function isInputEl(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.nodeName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (el.isContentEditable) return true;
    if (el.getAttribute && el.getAttribute('role') === 'textbox') return true;
    return false;
  }
  // 判断元素是否为小装饰元素（icon/span 等），其下的第一个 input 才可信
  function isDecorator(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.nodeName.toLowerCase();
    if (tag === 'svg' || tag === 'path' || tag === 'i' || tag === 'img' || tag === 'canvas') return true;
    if (tag === 'span' || tag === 'em' || tag === 'strong' || tag === 'b' || tag === 'small') {
      // 行内装饰元素，宽高通常小于单行 input
      var r = el.getBoundingClientRect();
      return r.width < 80 && r.height < 40;
    }
    return false;
  }
  // 从点击的元素向上/向下查找最近的输入类元素。
  // 传入点击坐标 x/y，使用 elementsFromPoint 精确命中，避免容器 querySelector 返回第一个子 input 导致点下一行选上一行。
  function findInputFromTarget(el, x, y) {
    if (!el || el.nodeType !== 1) return null;
    // 本身就是输入元素
    if (isInputEl(el)) return el;

    // 1. 用 elementsFromPoint 取点击位置下所有元素（从顶到底），遍历找第一个 input/label
    // 这是最精确的方式：不会被大容器（如 .field-grid）的 querySelector 误导
    try {
      var stack = document.elementsFromPoint(x, y) || [];
      for (var si = 0; si < stack.length; si++) {
        var se = stack[si];
        if (!se || se.nodeType !== 1) continue;
        // 跳过 cinside 自己注入的高亮层
        if (se.id === 'cinside-highlight-layer' || (se.className && typeof se.className === 'string' && se.className.indexOf('cinside') === 0)) continue;
        if (isInputEl(se)) return se;
        // label 指向控件
        if (se.nodeName === 'LABEL') {
          var forId = se.getAttribute && se.getAttribute('for');
          if (forId) {
            var labeled = se.ownerDocument.getElementById(forId);
            if (labeled) return labeled;
          }
          // label 紧后兄弟是 input
          var sib = se.nextElementSibling;
          for (var k = 0; k < 3 && sib; k++) {
            if (isInputEl(sib)) return sib;
            sib = sib.nextElementSibling;
          }
        }
      }
    } catch (_) {}

    // 2. label[for] 兜底
    var forId2 = el.getAttribute && el.getAttribute('for');
    if (forId2) {
      var labeled2 = document.getElementById(forId2);
      if (labeled2) return labeled2;
    }
    // 3. label 无 for：向后找兄弟 input
    if (el.nodeName === 'LABEL') {
      var sib2 = el.nextElementSibling;
      for (var k2 = 0; k2 < 3 && sib2; k2++) {
        if (isInputEl(sib2)) return sib2;
        sib2 = sib2.nextElementSibling;
      }
    }
    // 4. 仅当命中的是小装饰元素（icon/span），才向下找第一个 input；
    //    大容器（div/section/grid/form）不向下找，否则会返回第一个子 input 导致选错行
    if (isDecorator(el)) {
      var decoChild = el.querySelector('input, textarea, select, [contenteditable], [role="textbox"]');
      if (decoChild) return decoChild;
    }
    // 5. 点在字段容器非输入区域：用 closest 取最近的字段容器，再在容器内找 input
    //    但为了避免跨行错选，要求容器面积不超过 500x80（单行字段尺寸）
    var group = el.closest && el.closest('.field, .form-group, .input-group, [data-field], .ant-form-item, .el-form-item, .form-item');
    if (group) {
      var gr = group.getBoundingClientRect();
      if (gr.width < 800 && gr.height < 120) {
        var gInput = group.querySelector('input, textarea, select, [contenteditable], [role="textbox"]');
        if (gInput) return gInput;
      }
    }
    // 6. 向上仅查 1 层父元素（点击在 input 内部装饰元素上的情况）
    var parent = el.parentElement;
    if (parent && isInputEl(parent)) return parent;
    return null;
  }
  function onPick(e) {
    // 拾取完成后的指针已 handled，紧随其后的 click 会穿透到网页再触发一次控件
    // （下拉/日历被二次点击 → 打开又关闭 → 快照永远找不到面板）。此处吞掉该 click。
    if (window.__cinsideJustPicked && e.type === 'click') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      window.__cinsideJustPicked = false;
      return;
    }
    if (!window.__cinsidePickerActive) return;
    var now = Date.now();
    if (now - lastPickTime < 200) return;
    lastPickTime = now;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    // shadow DOM 事件会重定向到 host，用 composedPath 取最深的真实目标
    var rawTarget = null;
    try {
      var cp = e.composedPath ? e.composedPath() : null;
      if (cp && cp.length) {
        for (var ci = 0; ci < cp.length; ci++) {
          if (cp[ci] && cp[ci].nodeType === 1) { rawTarget = cp[ci]; break; }
        }
      }
    } catch (_) {}
    if (!rawTarget) rawTarget = e.target;
    if (!rawTarget || rawTarget.nodeType !== 1) return;
    // 自动查找最近的输入类元素（处理点击在 input 外层容器上的情况）
    var el = findInputFromTarget(rawTarget, e.clientX, e.clientY) || rawTarget;
    // 诊断日志：点击坐标 vs 命中元素坐标，用于定位"点 A 选 B"的偏移问题
    var rawRect = rawTarget.getBoundingClientRect ? rawTarget.getBoundingClientRect() : null;
    var elRect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    console.log('[onPick] click=(' + e.clientX + ',' + e.clientY + ')',
      'rawTarget=', rawTarget.nodeName, rawRect ? ('rect=(' + Math.round(rawRect.left) + ',' + Math.round(rawRect.top) + ',' + Math.round(rawRect.width) + 'x' + Math.round(rawRect.height) + ')') : '',
      '→ el=', el.nodeName, elRect ? ('rect=(' + Math.round(elRect.left) + ',' + Math.round(elRect.top) + ',' + Math.round(elRect.width) + 'x' + Math.round(elRect.height) + ')') : '',
      'isInput=', /^(input|textarea|select)$/i.test(el.nodeName), 'selector=', buildSelector(el));
    // 先取消picking模式（移除:hover !important outline），避免和闪光动画冲突
    window.__cinsidePickerActive = false;
    document.body.classList.remove('cinside-picking');
    removeFrameArms();
    // 标记本次拾取已完成，接下来吞掉紧随其后的 click（避免它穿透网页二次触发控件）
    window.__cinsideJustPicked = true;
    setTimeout(function () { window.__cinsideJustPicked = false; }, 350);
    highlight(el, '#6366f1');
    // 文档提取：收集元素的链接/图片地址（PDF、图片等）
    var linkEl = (el.closest && el.closest('a')) || (el.tagName === 'A' ? el : null);
    var imgEl = (el.tagName === 'IMG') ? el : (el.querySelector ? el.querySelector('img') : null);
    // 文件上传：探测关联的 file input（自身是 file input，或点击上传按钮/label/容器时附近隐藏的 file input）
    var fileInputEl = null;
    try {
      if (el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'file') {
        fileInputEl = el;
      } else {
        // 1. label[for] 指向 file input
        var lbl = (el.tagName === 'LABEL') ? el : (el.closest ? el.closest('label') : null);
        if (lbl) {
          var lfor = lbl.getAttribute('for');
          if (lfor) {
            var lEl = lbl.ownerDocument.getElementById(lfor);
            if (lEl && lEl.tagName === 'INPUT' && (lEl.getAttribute('type') || '').toLowerCase() === 'file') fileInputEl = lEl;
          }
          if (!fileInputEl) {
            var inLbl = lbl.querySelector('input[type="file"]');
            if (inLbl) fileInputEl = inLbl;
          }
        }
        // 2. 上传容器内找 file input（按钮 + 隐藏 input 的常见结构）
        if (!fileInputEl && el.closest) {
          var upBox = el.closest('[class*="upload"], [class*="Upload"], [data-upload], .el-upload, .ant-upload, .file-upload, form, .form-item, .el-form-item, .ant-form-item, .field, .form-group');
          if (upBox) {
            var inBox = upBox.querySelector('input[type="file"]');
            if (inBox) fileInputEl = inBox;
          }
        }
        // 3. 临近兄弟节点兜底（按钮后跟隐藏 input）
        if (!fileInputEl) {
          var p = el.parentElement;
          for (var depth2 = 0; depth2 < 2 && p; depth2++) {
            var cand = p.querySelector(':scope > input[type="file"]');
            if (cand) { fileInputEl = cand; break; }
            p = p.parentElement;
          }
        }
      }
    } catch (_) {}
    var payload = {
      kind: 'element-picked',
      selector: buildSelector(el),
      label: getLabel(el),
      value: el.value || el.getAttribute('value') || (el.isContentEditable ? (el.innerText || '').trim() : ''),
      tag: el.nodeName.toLowerCase(),
      type: el.getAttribute && el.getAttribute('type') || '',
      accept: (el.getAttribute && el.getAttribute('accept')) || '',
      isContentEditable: !!el.isContentEditable,
      rect: getRect(el),
      text: (el.innerText || '').trim().slice(0, 120),
      href: linkEl && linkEl.href ? linkEl.href : (el.href || ''),
      src: imgEl && imgEl.src ? imgEl.src : (el.src || ''),
      fileInputSelector: fileInputEl ? buildSelector(fileInputEl) : '',
      fileInputAccept: (fileInputEl && fileInputEl.getAttribute && fileInputEl.getAttribute('accept')) || '',
    };
    console.log('[onPick] payload=', JSON.stringify({ tag: payload.tag, selector: payload.selector, isContentEditable: payload.isContentEditable, value: payload.value }));
    window.__cinsidePostMessage(payload);
  }

  // ============ 右键菜单：绑定输入时右键点输入框 → 弹出 Excel 列选择菜单 ============
  // 仅在"绑定输入"模式（__cinsideBindInputMode=true 由主进程设置）下生效
  // 菜单列出当前行的所有 Excel 列，点击后通过 IPC 回传选择的列名
  window.__cinsideBindInputMode = false; // 由主进程通过 executeJavaScript 设置
  var _cinsideCtxMenu = null; // 当前显示的右键菜单 DOM

  function _removeCtxMenu() {
    if (_cinsideCtxMenu && _cinsideCtxMenu.parentNode) {
      _cinsideCtxMenu.parentNode.removeChild(_cinsideCtxMenu);
    }
    _cinsideCtxMenu = null;
  }

  function onContextMenu(e) {
    if (!window.__cinsidePickerActive) return;
    // 仅在绑定输入模式下拦截右键
    if (!window.__cinsideBindInputMode) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    // 找到目标元素（同 onPick 逻辑）
    var rawTarget = null;
    try {
      var cp = e.composedPath ? e.composedPath() : null;
      if (cp && cp.length) {
        for (var ci = 0; ci < cp.length; ci++) {
          if (cp[ci] && cp[ci].nodeType === 1) { rawTarget = cp[ci]; break; }
        }
      }
    } catch (_) {}
    if (!rawTarget) rawTarget = e.target;
    if (!rawTarget || rawTarget.nodeType !== 1) return;

    var el = findInputFromTarget(rawTarget, e.clientX, e.clientY) || rawTarget;
    // 只对输入类元素弹出菜单
    if (!isInputEl(el)) return;

    // 先移除旧菜单
    _removeCtxMenu();

    // 向主进程请求 Excel 列列表（通过 IPC，携带目标元素选择器）
    var selector = buildSelector(el);
    var menuId = 'ctx-' + Date.now();

    // 创建悬浮菜单容器（loading 状态）
    var menu = document.createElement('div');
    menu.id = 'cinside-ctx-menu';
    menu.style.cssText = 'position:fixed;z-index:999999;background:#fff;border:1px solid #e2e8f0;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.15);padding:4px 0;min-width:160px;max-height:280px;overflow-y:auto;font-size:13px;font-family:system-ui,-apple-system,sans-serif;';
    // 定位：鼠标位置，但避免超出视口
    var x = e.clientX, y = e.clientY;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    // loading 提示
    var loading = document.createElement('div');
    loading.style.cssText = 'padding:8px 14px;color:#94a3b8;font-size:12px;';
    loading.textContent = '加载列列表…';
    menu.appendChild(loading);
    document.body.appendChild(menu);
    _cinsideCtxMenu = menu;

    // 点击菜单外部时关闭
    var closeHandler = function(ev) {
      if (_cinsideCtxMenu && !_cinsideCtxMenu.contains(ev.target)) {
        _removeCtxMenu();
        document.removeEventListener('pointerdown', closeHandler, true);
      }
    };
    document.addEventListener('pointerdown', closeHandler, true);

    // 通知主进程：请求 Excel 列列表，附带目标元素选择器
    window.__cinsidePostMessage({
      kind: 'context-menu-request',
      menuId: menuId,
      selector: selector,
      label: getLabel(el),
    });

    // 监听主进程回传的列列表（通过 __cinsideCtxMenuResponse 回调）
    window.__cinsideCtxMenuResponse = function(columns, currentField) {
      if (!_cinsideCtxMenu) return;
      _cinsideCtxMenu.innerHTML = '';
      if (!columns || !columns.length) {
        var empty = document.createElement('div');
        empty.style.cssText = 'padding:8px 14px;color:#94a3b8;font-size:12px;';
        empty.textContent = '无可用列';
        _cinsideCtxMenu.appendChild(empty);
        return;
      }
      // 标题
      var title = document.createElement('div');
      title.style.cssText = 'padding:6px 14px 4px;font-size:11px;color:#94a3b8;border-bottom:1px solid #f1f5f9;margin-bottom:2px;';
      title.textContent = '选择输入源列';
      _cinsideCtxMenu.appendChild(title);
      columns.forEach(function(col) {
        var item = document.createElement('div');
        item.style.cssText = 'padding:6px 14px;cursor:pointer;color:#334155;display:flex;align-items:center;gap:6px;transition:background .1s;';
        if (col === currentField) {
          item.style.color = '#6366f1';
          item.style.fontWeight = '600';
          item.textContent = '✓ ' + col;
        } else {
          item.textContent = col;
        }
        item.addEventListener('mouseenter', function() { item.style.background = '#f1f5f9'; });
        item.addEventListener('mouseleave', function() { item.style.background = ''; });
        item.addEventListener('click', function() {
          _removeCtxMenu();
          document.removeEventListener('pointerdown', closeHandler, true);
          window.__cinsidePostMessage({
            kind: 'context-menu-select',
            selector: selector,
            field: col,
          });
        });
        _cinsideCtxMenu.appendChild(item);
      });
      // 确保菜单不超出视口
      var rect = _cinsideCtxMenu.getBoundingClientRect();
      if (rect.right > window.innerWidth) _cinsideCtxMenu.style.left = (window.innerWidth - rect.width - 8) + 'px';
      if (rect.bottom > window.innerHeight) _cinsideCtxMenu.style.top = (window.innerHeight - rect.height - 8) + 'px';
    };
  }

  // 拾取模式下阻止 Enter 触发表单提交/页面跳转，并把 Enter 回传给主窗口执行 commitInput
  window.__cinsideBlockEnter = true;
  function onEnter(e) {
    if (!window.__cinsideBlockEnter) return;
    if (e.key === 'Enter' || e.code === 'Enter' || e.keyCode === 13) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      window.__cinsidePostMessage({ kind: 'enter-pressed', key: 'Enter' });
    }
  }

  // ============ iframe 武装：把拾取监听器挂到可访问的 iframe 文档上 ============
  // webSecurity=false 时跨域 iframe 的 contentDocument 通常也可访问；
  // 实在不可访问的计数并上报，提醒用户该区域内元素无法拾取
  function armOneDoc(doc) {
    if (!doc || doc.__cinsideArmed) return true;
    try {
      doc.addEventListener('pointerdown', window.__cinsideOnPick, true);
      doc.addEventListener('click', window.__cinsideOnPick, true);
      doc.addEventListener('keydown', window.__cinsideOnEnter, true);
      doc.addEventListener('contextmenu', window.__cinsideOnContextMenu, true);
      doc.__cinsideArmed = true;
      (window.__cinsideArmedDocs = window.__cinsideArmedDocs || []).push(doc);
      return true;
    } catch (_) { return false; }
  }
  function armFramesIn(doc, stats) {
    var frames = [];
    try { frames = doc.querySelectorAll('iframe, frame'); } catch (_) {}
    for (var i = 0; i < frames.length; i++) {
      var fd = null;
      try { fd = frames[i].contentDocument; } catch (_) { fd = null; }
      if (!fd) { stats.blocked++; continue; }
      if (armOneDoc(fd)) armFramesIn(fd, stats); else stats.blocked++;
    }
  }
  function armAllFrames() {
    if (!window.__cinsidePickerActive) return 0;
    var stats = { blocked: 0 };
    try { armFramesIn(document, stats); } catch (_) {}
    if (stats.blocked > 0 && !window.__cinsideFrameWarned) {
      window.__cinsideFrameWarned = true;
      console.log('[onPick] ' + stats.blocked + ' iframe(s) blocked (cross-origin), elements inside cannot be picked');
      try { window.__cinsidePostMessage({ kind: 'pick-warning', message: stats.blocked + ' 个 iframe 内的元素无法拾取（跨域受限）' }); } catch (_) {}
    }
    return stats.blocked;
  }
  function removeFrameArms() {
    if (window.__cinsideArmTimers) {
      window.__cinsideArmTimers.forEach(clearTimeout);
      window.__cinsideArmTimers = null;
    }
    window.__cinsideFrameWarned = false;
    var docs = window.__cinsideArmedDocs || [];
    for (var i = 0; i < docs.length; i++) {
      var d = docs[i];
      try { d.removeEventListener('pointerdown', window.__cinsideOnPick, true); } catch (_) {}
      try { d.removeEventListener('click', window.__cinsideOnPick, true); } catch (_) {}
      try { d.removeEventListener('keydown', window.__cinsideOnEnter, true); } catch (_) {}
      try { d.removeEventListener('contextmenu', window.__cinsideOnContextMenu, true); } catch (_) {}
      try { d.__cinsideArmed = false; } catch (_) {}
    }
    window.__cinsideArmedDocs = [];
  }

  if (needsInstall) {
    // ============ 框选模式（日格子多选）：拖拽画矩形框，松开时批量选中矩形内所有日格子元素 ============
    // 通过设置 window.__cinsidePickerMarqueeMode = true 启用（日格子引导步骤）；false 还原为单点模式
    window.__cinsidePickerMarqueeMode = false;
    var _marqueeOverlay = null;
    var _marqueeStart = null;
    var _marqueeMoveListener = null;
    var _marqueeUpListener = null;
    var _marqueeCancelListener = null;
    function _clearMarquee() {
      if (_marqueeOverlay && _marqueeOverlay.parentNode) _marqueeOverlay.parentNode.removeChild(_marqueeOverlay);
      _marqueeOverlay = null;
      _marqueeStart = null;
      if (_marqueeMoveListener) { window.removeEventListener('pointermove', _marqueeMoveListener, true); _marqueeMoveListener = null; }
      if (_marqueeUpListener) { window.removeEventListener('pointerup', _marqueeUpListener, true); _marqueeUpListener = null; }
      if (_marqueeCancelListener) { window.removeEventListener('pointercancel', _marqueeCancelListener, true); _marqueeCancelListener = null; }
    }
    // 判断元素是否像日格子：叶子级可见元素，可见文本为 1-31 的纯数字
    function _isDayCellLike(el) {
      if (!el || el.nodeType !== 1) return false;
      var tag = el.nodeName.toLowerCase();
      // 排除脚本/样式/不可见容器
      if (tag === 'script' || tag === 'style' || tag === 'br' || tag === 'wbr') return false;
      if (el.disabled) return false;
      var r;
      try { r = el.getBoundingClientRect(); } catch(e) { return false; }
      if (r.width < 8 || r.height < 8 || r.width > 120 || r.height > 120) return false;
      // 可见性
      var st;
      try { st = (el.ownerDocument.defaultView || window).getComputedStyle(el); } catch(e) { return false; }
      if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity || '1') === 0) return false;
      // 文本：用 innerText 取可见文本（兼容含 sr-only 隐藏文本的日格子）
      var txt = (el.innerText || el.textContent || '').trim();
      if (!/^([1-9]|[12]\d|3[01])$/.test(txt)) return false;
      // 叶子检测：不含更深层同文本子元素
      var kids = el.children;
      for (var i = 0; i < kids.length; i++) {
        if ((kids[i].textContent || '').trim() === txt) return false;
      }
      return true;
    }
    // 为单个元素构建拾取 payload（与 onPick 中单点拾取的 payload 结构一致）
    function _buildPickPayload(el) {
      return {
        selector: buildSelector(el),
        label: getLabel(el),
        value: el.value || el.getAttribute('value') || (el.isContentEditable ? (el.innerText || '').trim() : ''),
        tag: el.nodeName.toLowerCase(),
        type: el.getAttribute && el.getAttribute('type') || '',
        accept: (el.getAttribute && el.getAttribute('accept')) || '',
        isContentEditable: !!el.isContentEditable,
        rect: getRect(el),
        text: (el.innerText || '').trim().slice(0, 120),
        href: el.href || '',
        src: el.src || '',
        fileInputSelector: '',
        fileInputAccept: '',
      };
    }
    function _onMarqueeDown(e) {
      if (!window.__cinsidePickerActive || !window.__cinsidePickerMarqueeMode) return;
      // 只响应主键
      if (e.button !== 0) return;
      _marqueeStart = { x: e.clientX, y: e.clientY };
      // 阻止默认的单点 onPick 触发（onPick 也在 pointerdown capture 阶段）
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      // 创建矩形遮罩
      _marqueeOverlay = document.createElement('div');
      _marqueeOverlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;'
        + 'border:2px dashed #3b82f6;background:rgba(59,130,246,0.12);'
        + 'border-radius:2px;box-shadow:0 0 0 1px rgba(255,255,255,.5);';
      document.body.appendChild(_marqueeOverlay);
      var moved = false;
      _marqueeMoveListener = function(ev) {
        if (!_marqueeStart) return;
        var dx = ev.clientX - _marqueeStart.x;
        var dy = ev.clientY - _marqueeStart.y;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true;
        _marqueeOverlay.style.left = Math.min(_marqueeStart.x, ev.clientX) + 'px';
        _marqueeOverlay.style.top = Math.min(_marqueeStart.y, ev.clientY) + 'px';
        _marqueeOverlay.style.width = Math.abs(dx) + 'px';
        _marqueeOverlay.style.height = Math.abs(dy) + 'px';
      };
      _marqueeUpListener = function(ev) {
        if (!_marqueeStart) return;
        var dx = ev.clientX - _marqueeStart.x;
        var dy = ev.clientY - _marqueeStart.y;
        var dist = Math.hypot(dx, dy);
        var marqueeRect = {
          left: Math.min(_marqueeStart.x, ev.clientX),
          top: Math.min(_marqueeStart.y, ev.clientY),
          right: Math.max(_marqueeStart.x, ev.clientX),
          bottom: Math.max(_marqueeStart.y, ev.clientY),
        };
        // 清理遮罩与监听器（先清，再处理结果）
        _clearMarquee();
        // 吞掉随后的 click 事件，避免穿透到网页
        window.__cinsideJustPicked = true;
        setTimeout(function() { window.__cinsideJustPicked = false; }, 350);
        if (dist < 5) {
          // 单击（无拖拽）：对点击位置的元素执行一次单点拾取
          // （用 elementsFromPoint 精确定位；日格子不是 input，跳过 findInputFromTarget）
          var stack = document.elementsFromPoint(marqueeRect.left, marqueeRect.top) || [];
          var target = null;
          for (var si = 0; si < stack.length; si++) {
            var se = stack[si];
            if (!se || se.nodeType !== 1) continue;
            if (se.id === 'cinside-highlight-layer') continue;
            if (se.className && typeof se.className === 'string' && se.className.indexOf('cinside') === 0) continue;
            target = se; break;
          }
          if (target) {
            highlight(target, '#6366f1');
            window.__cinsidePostMessage(Object.assign({ kind: 'element-picked' }, _buildPickPayload(target)));
          }
        } else {
          // 拖拽：收集矩形内所有日格子元素
          var candSelectors = 'td, li, span, div, a, button, [role="gridcell"], [role="button"], [class*="day"], [class*="date"], [class*="cell"]';
          var all;
          try { all = document.querySelectorAll(candSelectors); } catch(e) { all = []; }
          var picked = [];
          var seenSet = {};
          for (var i = 0; i < all.length; i++) {
            var el = all[i];
            if (!_isDayCellLike(el)) continue;
            var er;
            try { er = el.getBoundingClientRect(); } catch(e2) { continue; }
            // 元素中心需在矩形内部（边缘擦到不算，避免误选）
            var cx = er.left + er.width / 2;
            var cy = er.top + er.height / 2;
            if (cx < marqueeRect.left || cx > marqueeRect.right || cy < marqueeRect.top || cy > marqueeRect.bottom) continue;
            var key = buildSelector(el);
            if (seenSet[key]) continue;
            seenSet[key] = true;
            picked.push(el);
          }
          // 采样点兜底（覆盖非典型标签/类名的日格子）
          var stepX = Math.max(8, Math.floor((marqueeRect.right - marqueeRect.left) / 12));
          var stepY = Math.max(8, Math.floor((marqueeRect.bottom - marqueeRect.top) / 8));
          for (var sx = marqueeRect.left + stepX / 2; sx < marqueeRect.right; sx += stepX) {
            for (var sy = marqueeRect.top + stepY / 2; sy < marqueeRect.bottom; sy += stepY) {
              var stack2 = document.elementsFromPoint(sx, sy) || [];
              for (var k = 0; k < stack2.length; k++) {
                var e2 = stack2[k];
                if (!e2 || e2.nodeType !== 1) continue;
                if (!_isDayCellLike(e2)) continue;
                var k2 = buildSelector(e2);
                if (seenSet[k2]) continue;
                seenSet[k2] = true;
                picked.push(e2);
              }
            }
          }
          if (picked.length > 0) {
            picked.forEach(function(el) { highlight(el, '#6366f1'); });
            var payloads = picked.map(_buildPickPayload);
            window.__cinsidePostMessage({ kind: 'multi-element-picked', elements: payloads });
          } else {
            window.__cinsidePostMessage({ kind: 'pick-warning', message: '框内未发现日格子（应为 1-31 数字的可见单元格）' });
          }
        }
      };
      _marqueeCancelListener = function() { _clearMarquee(); };
      window.addEventListener('pointermove', _marqueeMoveListener, true);
      window.addEventListener('pointerup', _marqueeUpListener, true);
      window.addEventListener('pointercancel', _marqueeCancelListener, true);
    }
    window.__cinsideOnMarqueeDown = _onMarqueeDown;
    window.__cinsideClearMarquee = _clearMarquee;
    document.addEventListener('pointerdown', _onMarqueeDown, true);
    // pointerdown 比 click 更早触发，能更好捕获 input 等会抢占焦点的元素
    document.addEventListener('pointerdown', onPick, true);
    document.addEventListener('click', onPick, true);
    document.addEventListener('contextmenu', onContextMenu, true);
  } else {
    // 重复注入：清掉旧武装，下面会用新闭包重新武装
    try { removeFrameArms(); } catch (_) {}
    // 重复注入时若有未完成的框选，清理掉
    try { if (window.__cinsideClearMarquee) window.__cinsideClearMarquee(); } catch (_) {}
    // 更新全局引用（主文档首次注册的监听器通过这些引用调到最新闭包）
    if (window.__cinsideOnMarqueeDown) {
      // 替换为新的闭包：通过 listener 无法替换，这里用全局包装让下次调用走新逻辑
      // （实际上因为主 doc listener 只添加一次，调用旧闭包 _onMarqueeDown；
      //  但它依赖的 buildSelector/getLabel/highlight 等都是旧闭包中的版本，功能一致，无状态冲突）
    }
  }
  // 清理旧的 Enter 监听器并添加新的，避免重复或引用错乱
  var oldEnterHandler = window.__cinsideEnterHandler;
  if (oldEnterHandler) {
    document.removeEventListener('keydown', oldEnterHandler, true);
  }
  document.addEventListener('keydown', onEnter, true);
  window.__cinsideEnterHandler = onEnter;

  window.__cinsideOnPick = onPick;
  window.__cinsideOnEnter = onEnter;
  window.__cinsideOnContextMenu = onContextMenu;
  window.__cinsideRemoveFrameArms = removeFrameArms;
  window.__cinsidePickerActive = true;
  document.body.classList.add('cinside-picking');
  // 武装已加载的 iframe，并延迟补武装（iframe 异步加载完成后再挂）
  armAllFrames();
  window.__cinsideArmTimers = [setTimeout(armAllFrames, 600), setTimeout(armAllFrames, 1800)];
  return 'activated';
})();
`;

const ELEMENT_PICKER_DEACTIVATE_SCRIPT = `
(function () {
  window.__cinsidePickerActive = false;
  window.__cinsideBlockEnter = false;
  window.__cinsideBindInputMode = false;
  window.__cinsidePickerMarqueeMode = false;
  document.body.classList.remove('cinside-picking');
  // 清理右键菜单
  var ctxMenu = document.getElementById('cinside-ctx-menu');
  if (ctxMenu && ctxMenu.parentNode) ctxMenu.parentNode.removeChild(ctxMenu);
  // 清理未完成的框选
  if (window.__cinsideClearMarquee) {
    try { window.__cinsideClearMarquee(); } catch (_) {}
  }
  if (window.__cinsideEnterHandler) {
    document.removeEventListener('keydown', window.__cinsideEnterHandler, true);
    window.__cinsideEnterHandler = null;
  }
  if (window.__cinsideRemoveFrameArms) {
    try { window.__cinsideRemoveFrameArms(); } catch (_) {}
  }
  return 'deactivated';
})();
`;

// 高亮指定选择器：根据 match 状态着色（green=match, red=mismatch, amber=missing/pending）
// 滚动/resize 时通过 rAF 重新计算每个 box 的位置，确保高亮框始终绑定到元素
function buildHighlightScript(boxes) {
  // boxes: [{ selector, status: 'match'|'mismatch'|'missing'|'pending', label }]
  const colorMap = {
    match: "#10b981",
    mismatch: "#f43f5e",
    missing: "#f59e0b",
    partial: "#f59e0b",
    pending: "#38bdf8",
    unknown: "#94a3b8",
  };
  const entries = boxes
    .map((b) => {
      const color = colorMap[b.status] || colorMap.unknown;
      const label = (b.label || b.selector || "").replace(/'/g, "\\'").slice(0, 60);
      const sel = (b.selector || "").replace(/'/g, "\\'");
      return `{ sel: '${sel}', color: '${color}', label: '${label}' }`;
    })
    .join(",");
  return `
(function () {
  // 清理旧的监听器和高亮层
  if (window.__cinsideHighlightCleanup) {
    window.__cinsideHighlightCleanup();
    window.__cinsideHighlightCleanup = null;
  }
  var old = document.getElementById('cinside-highlight-layer');
  if (old) old.remove();
  var boxes = [${entries}];
  var layer = document.createElement('div');
  layer.id = 'cinside-highlight-layer';
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
  document.body.appendChild(layer);
  // 为每个 box 创建 DOM 元素，box 使用 position:fixed 直接定位到视口坐标
  var boxInfos = [];
  boxes.forEach(function (b) {
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;'
      + 'border:2px solid ' + b.color + ';'
      + 'background:' + b.color + '1a;'
      + 'box-shadow:0 0 0 4px ' + b.color + '33, 0 0 16px ' + b.color + '66;'
      + 'border-radius:4px;pointer-events:none;display:none;';
    var tag = document.createElement('span');
    tag.style.cssText = 'position:absolute;left:0;top:-20px;'
      + 'background:' + b.color + ';color:#fff;'
      + 'padding:1px 6px;font-size:11px;font-family:inherit;'
      + 'border-radius:3px 3px 0 0;white-space:nowrap;max-width:200px;'
      + 'overflow:hidden;text-overflow:ellipsis;';
    tag.textContent = b.label;
    box.appendChild(tag);
    layer.appendChild(box);
    boxInfos.push({ el: box, sel: b.sel, color: b.color });
  });
  // deep query：支持 ' >>> ' 分段穿透 shadowRoot / iframe contentDocument
  function deepQuery(sel) {
    if (!sel) return null;
    if (sel.indexOf('>>>') === -1) {
      try { return document.querySelector(sel); } catch (e) { return null; }
    }
    var segs = sel.split('>>>');
    var ctx = document;
    var el = null;
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i].trim();
      if (!s) return null;
      try { el = ctx.querySelector(s); } catch (e) { return null; }
      if (!el) return null;
      if (i < segs.length - 1) {
        var next = null;
        try { if (el.shadowRoot) next = el.shadowRoot; } catch (e) {}
        if (!next) { try { if (el.contentDocument) next = el.contentDocument; } catch (e) {} }
        if (!next) return null;
        ctx = next;
      }
    }
    return el;
  }
  // 元素矩形：iframe 内元素累加各层 frame 偏移，统一到主视口坐标
  function frameRect(el) {
    var r = el.getBoundingClientRect();
    var x = r.left, y = r.top;
    try {
      var doc = el.ownerDocument;
      while (doc && doc !== document) {
        var fe = doc.defaultView && doc.defaultView.frameElement;
        if (!fe) break;
        var fr = fe.getBoundingClientRect();
        x += fr.left + (fe.clientLeft || 0);
        y += fr.top + (fe.clientTop || 0);
        doc = fe.ownerDocument;
      }
    } catch (_) {}
    return { left: x, top: y, width: r.width, height: r.height };
  }
  // 重新计算每个 box 的位置（视口坐标）
  function reposition() {
    boxInfos.forEach(function (info) {
      var target = deepQuery(info.sel);
      if (!target) { info.el.style.display = 'none'; return; }
      var r = frameRect(target);
      info.el.style.display = 'block';
      info.el.style.left = r.left + 'px';
      info.el.style.top = r.top + 'px';
      info.el.style.width = r.width + 'px';
      info.el.style.height = r.height + 'px';
    });
  }
  // 保存被高亮元素原始 outline/boxShadow/transition，cleanup 时恢复
  var outlinedElements = [];
  function applyOutline() {
    boxInfos.forEach(function (info) {
      try {
        var el = deepQuery(info.sel);
        if (el) {
          outlinedElements.push({
            el: el,
            outline: el.style.outline,
            offset: el.style.outlineOffset,
            shadow: el.style.boxShadow,
            trans: el.style.transition,
          });
          el.style.transition = 'outline 0.15s ease-out, box-shadow 0.15s ease-out';
          el.style.outline = '2px solid ' + info.color;
          el.style.outlineOffset = '1px';
          el.style.boxShadow = '0 0 0 4px ' + info.color + '33';
        }
      } catch (e) {}
    });
  }
  function restoreOutline() {
    outlinedElements.forEach(function (o) {
      try {
        o.el.style.outline = o.outline || '';
        o.el.style.outlineOffset = o.offset || '';
        o.el.style.boxShadow = o.shadow || '';
        o.el.style.transition = o.trans || '';
      } catch (e) {}
    });
    outlinedElements = [];
  }
  reposition();
  applyOutline();
  // 持续 rAF 追踪：每帧重新计算位置，保证 smooth scroll / 动画 / DOM 变化时不脱节
  var rafId = null;
  function trackLoop() {
    reposition();
    rafId = requestAnimationFrame(trackLoop);
  }
  trackLoop();
  window.__cinsideHighlightCleanup = function () {
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;
    restoreOutline();
  };
})();
`;
}

const CLEAR_HIGHLIGHT_SCRIPT = `
(function () {
  if (window.__cinsideHighlightCleanup) {
    window.__cinsideHighlightCleanup();
    window.__cinsideHighlightCleanup = null;
  }
  var old = document.getElementById('cinside-highlight-layer');
  if (old) old.remove();
})();
`;

// ============ 后端进程 ============
function startBackend() {
  if (backendProcess) return;

  let backendExe;
  let backendCwd;
  let backendArgs;

  if (isDev) {
    // 开发环境：使用虚拟环境中的 Python
    const backendDir = path.join(__dirname, "../../backend");
    backendExe = path.join(backendDir, ".venv", "Scripts", "python.exe");
    backendArgs = ["-m", "uvicorn", "app.main:app", "--port", String(BACKEND_PORT)];
    backendCwd = backendDir;
  } else {
    // 生产环境：使用 PyInstaller 打包后的可执行文件
    // electron-builder extraResources 会把文件放到 process.resourcesPath 下
    const resourcesPath = process.resourcesPath || path.join(__dirname, "../..");
    backendExe = path.join(resourcesPath, "backend", "cinside-backend.exe");
    backendArgs = ["--port", String(BACKEND_PORT)];
    backendCwd = path.join(resourcesPath, "backend");
  }

  debugLog(`[backend] starting: ${backendExe} ${backendArgs.join(" ")}`);
  backendProcess = spawn(backendExe, backendArgs, {
    cwd: backendCwd,
    stdio: "pipe",
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      BROWSER_USE_CDP_URL: "http://localhost:9222",
    },
  });

  // uvicorn 的日志（包括 "Uvicorn running on" / "Application startup complete"）走 stderr
  const detectReady = (data) => {
    const line = data.toString();
    if (line.includes("Application startup complete") || line.includes("Uvicorn running on")) {
      backendReady = true;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("backend-ready");
      }
    }
  };

  backendProcess.stdout.on("data", (data) => {
    console.log("[backend]", data.toString().trim());
    detectReady(data);
  });

  backendProcess.stderr.on("data", (data) => {
    const line = data.toString();
    console.error("[backend err]", line.trim());
    detectReady(data);
  });

  backendProcess.on("exit", (code) => {
    console.log("[backend] exited with code", code);
    backendProcess = null;
    backendReady = false;
  });
}

function stopBackend() {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
}

app.whenReady().then(() => {
  createSplashWindow();
  startBackend();
  createWindow();
  createBrowserViews();

  // ============ 下载拦截：文件提取模式下捕获网页下载的文件 ============
  // downloadCapture[side] = true 时，该 side 的 BrowserView 触发的下载会被拦截
  const downloadCapture = { left: false, right: false };

  session.defaultSession.on("will-download", (event, item, webContents) => {
    // 判断下载来自哪个 BrowserView
    let side = null;
    if (rightBrowserView && webContents === rightBrowserView.webContents) side = "right";
    else if (leftBrowserView && webContents === leftBrowserView.webContents) side = "left";

    if (!side || !downloadCapture[side]) {
      // 不在捕获模式，阻止默认下载行为
      event.preventDefault();
      return;
    }

    // 创建下载目录
    const dlDir = path.join(app.getPath("temp"), "cinside-downloads");
    try { fs.mkdirSync(dlDir, { recursive: true }); } catch (e) {}

    const filename = item.getFilename() || `download-${Date.now()}.bin`;
    const savePath = path.join(dlDir, filename);
    item.setSavePath(savePath);

    // 一次性捕获：下载开始后立即关闭标志，避免重复捕获
    downloadCapture[side] = false;
    debugLog(`[download] 捕获下载: ${filename} → ${savePath} (side=${side})`);

    // 通知渲染进程：下载已开始
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("download-started", { side, filename });
    }

    // 下载进度更新
    item.on("updated", () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const received = item.getReceivedBytes();
        const total = item.getTotalBytes();
        mainWindow.webContents.send("download-progress", {
          side, filename, received, total,
          percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : -1,
        });
      }
    });

    item.once("done", (e, state) => {
      if (state === "completed") {
        try {
          const buffer = fs.readFileSync(savePath);
          const ext = path.extname(filename).toLowerCase();
          const mimeMap = {
            ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".png": "image/png", ".pdf": "application/pdf",
            ".gif": "image/gif", ".bmp": "image/bmp",
            ".webp": "image/webp",
          };
          const mime = mimeMap[ext] || "application/octet-stream";
          const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;

          debugLog(`[download] 下载完成: ${filename} (${buffer.length} bytes, ${mime})`);

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("download-captured", {
              side, filename, dataUrl, size: buffer.length, mime, path: savePath,
            });
          }
        } catch (err) {
          debugLog(`[download] 读取下载文件失败: ${err.message}`);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("download-failed", { side, filename, error: err.message });
          }
        }
      } else {
        debugLog(`[download] 下载失败: state=${state}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("download-failed", { side, filename, state });
        }
      }
    });
  });

  // IPC: 开启/关闭某 side 的下载捕获
  ipcMain.handle("set-download-capture", (_event, side, enabled) => {
    downloadCapture[side] = !!enabled;
    debugLog(`[download] set-download-capture side=${side}, enabled=${enabled}`);
    return { ok: true };
  });

  // ============ 文件提取保底机制 ============
  // IPC: 获取页面上所有可下载的文件链接（<a>标签指向pdf/jpg/png等文件，或带download属性）
  ipcMain.handle("view-get-downloadable-links", async (_event, side) => {
    const view = side === "left" ? leftBrowserView : rightBrowserView;
    if (!view || !view.webContents) {
      return { ok: false, error: `${side} view 不存在` };
    }
    try {
      const script = `
        (function() {
          const fileExts = ['.pdf', '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'];
          const links = [];
          const seen = new Set();

          function checkAndAdd(href, text, downloadAttr) {
            if (!href || href.startsWith('javascript:') || href.startsWith('#') || seen.has(href)) return;
            let hasExt = false;
            let filename = '';
            try {
              const url = new URL(href, window.location.href);
              const pathname = decodeURIComponent(url.pathname);
              const lowerPath = pathname.toLowerCase();
              for (const ext of fileExts) {
                if (lowerPath.endsWith(ext)) {
                  hasExt = true;
                  filename = pathname.split('/').pop() || '';
                  break;
                }
              }
              // URL参数中包含download/file等关键词也尝试
              if (!hasExt) {
                const search = url.search.toLowerCase();
                if (search.includes('download=') || search.includes('file=')) {
                  hasExt = true;
                  filename = downloadAttr || 'download';
                }
              }
            } catch(e) {}
            if (downloadAttr && !hasExt) {
              hasExt = true;
              filename = downloadAttr;
            }
            if (hasExt) {
              seen.add(href);
              links.push({ url: href, text: (text || '').trim().substring(0, 100), filename: filename });
            }
          }

          // 1. 扫描所有 <a> 标签
          document.querySelectorAll('a[href]').forEach(a => {
            checkAndAdd(a.href, a.textContent, a.getAttribute('download'));
          });

          // 2. 扫描 <area> 标签（图片热区）
          document.querySelectorAll('area[href]').forEach(area => {
            checkAndAdd(area.href, area.alt, area.getAttribute('download'));
          });

          // 3. 扫描 onclick 中的 URL（JavaScript 触发的下载）
          document.querySelectorAll('[onclick], [data-href], [data-url], [data-download]').forEach(el => {
            const onclick = el.getAttribute('onclick') || '';
            const dataHref = el.getAttribute('data-href') || el.getAttribute('data-url') || el.getAttribute('data-download') || '';
            const combined = onclick + ' ' + dataHref;
            // 提取 onclick 中的 URL
            const urlMatches = combined.match(/https?:\\/\\/[^\\s'"<>]+/gi) || [];
            urlMatches.forEach(u => {
              checkAndAdd(u, el.textContent, el.getAttribute('download'));
            });
          });

          return { ok: true, links: links };
        })();
      `;
      const result = await view.webContents.executeJavaScript(script);
      if (result && result.ok) {
        debugLog(`[fallback] ${side} 找到 ${result.links.length} 个可下载链接`);
        return { ok: true, links: result.links };
      }
      return { ok: false, error: "获取链接失败" };
    } catch (e) {
      debugLog(`[fallback] view-get-downloadable-links 失败: ${e.message}`);
      return { ok: false, error: e.message };
    }
  });

  // 辅助函数：下载单个URL并返回buffer（带BrowserView session的cookie）
  async function downloadUrl(url, timeoutMs, side) {
    // 从BrowserView对应session获取cookie
    const view = side === "left" ? leftBrowserView : rightBrowserView;
    const ses = view ? view.webContents.session : session.defaultSession;
    let cookieHeader = "";
    try {
      const parsedUrl = new URL(url);
      const cookies = await ses.cookies.get({ url: parsedUrl.origin });
      if (cookies.length > 0) {
        cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");
      }
    } catch (e) {
      debugLog(`[fallback] 获取cookie失败: ${e.message}`);
    }

    return new Promise((resolve, reject) => {
      try {
        const parsedUrl = new URL(url);
        const lib = parsedUrl.protocol === "https:" ? https : http;
        const options = {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          method: "GET",
          timeout: timeoutMs || 15000,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            ...(cookieHeader ? { "Cookie": cookieHeader } : {}),
          }
        };

        const req = lib.request(options, (res) => {
          // 处理重定向
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const redirectUrl = new URL(res.headers.location, url).toString();
            res.resume();
            downloadUrl(redirectUrl, timeoutMs, side).then(resolve).catch(reject);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const buffer = Buffer.concat(chunks);
            const filename = (() => {
              // 从Content-Disposition获取文件名
              const cd = res.headers["content-disposition"];
              if (cd) {
                const match = cd.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
                if (match) {
                  try { return decodeURIComponent(match[1].replace(/['"]/g, '')); } catch(e) {}
                }
              }
              // 从URL获取文件名
              try {
                const p = decodeURIComponent(parsedUrl.pathname);
                const n = p.split("/").filter(Boolean).pop() || "";
                return n.includes(".") ? n : "download.bin";
              } catch { return "download.bin"; }
            })();
            const ext = path.extname(filename).toLowerCase();
            const mimeMap = {
              ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
              ".png": "image/png", ".pdf": "application/pdf",
              ".gif": "image/gif", ".bmp": "image/bmp",
              ".webp": "image/webp",
              ".doc": "application/msword",
              ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            };
            const mime = res.headers["content-type"] || mimeMap[ext] || "application/octet-stream";
            resolve({ url, filename, buffer, size: buffer.length, mime });
          });
        });
        req.on("error", reject);
        req.on("timeout", () => {
          req.destroy();
          reject(new Error("下载超时"));
        });
        req.end();
      } catch (e) {
        reject(e);
      }
    });
  }

  // IPC: 批量下载URL列表并返回文件数据（base64 dataUrl）
  ipcMain.handle("view-batch-download-urls", async (_event, side, urls, timeoutMs) => {
    if (!Array.isArray(urls) || urls.length === 0) {
      return { ok: false, error: "URL列表为空" };
    }
    const view = side === "left" ? leftBrowserView : rightBrowserView;
    const timeout = timeoutMs || 20000;
    const files = [];
    const errors = [];

    debugLog(`[fallback] 开始批量下载 ${urls.length} 个文件, timeout=${timeout}ms`);

    // 并发下载，最多3个同时
    const concurrency = 3;
    for (let i = 0; i < urls.length; i += concurrency) {
      const batch = urls.slice(i, i + concurrency);
      const results = await Promise.allSettled(batch.map(url => downloadUrl(url, timeout, side)));
      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status === "fulfilled") {
          const { url, filename, buffer, size, mime } = result.value;
          const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
          files.push({ url, filename, dataUrl, size, mime });
          debugLog(`[fallback] 下载成功: ${filename} (${size} bytes)`);
        } else {
          errors.push({ url: batch[j], error: result.reason?.message || String(result.reason) });
          debugLog(`[fallback] 下载失败: ${batch[j]} - ${result.reason?.message}`);
        }
      }
    }

    if (files.length === 0) {
      return { ok: false, error: "所有文件下载失败", errors };
    }
    debugLog(`[fallback] 批量下载完成: 成功 ${files.length} 个, 失败 ${errors.length} 个`);
    return { ok: true, files, errors: errors.length > 0 ? errors : undefined };
  });

  // ============ 本地文件提取：选择目录 + 读取文件 ============
  // 选择本地文件夹，递归扫描所有文件，返回根目录绝对路径 + 文件相对路径列表
  ipcMain.handle("pick-local-directory", async () => {
    const { dialog } = require("electron");
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择包含学号子文件夹的根目录",
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, rootPath: "", files: [] };
    }
    const rootPath = result.filePaths[0];
    // 递归扫描目录，收集所有支持的文件类型
    const supportedExts = [".jpg", ".jpeg", ".png", ".pdf", ".webp", ".bmp", ".gif", ".tif", ".tiff",
      ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"];
    const files = [];
    function scanDir(dir, depth) {
      if (depth > 6) return; // 限制递归深度
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath, depth + 1);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (supportedExts.indexOf(ext) < 0) continue;
          let stat;
          try { stat = fs.statSync(fullPath); } catch (e) { continue; }
          // 相对路径（用 / 分隔，跨平台一致）
          const relativePath = path.relative(rootPath, fullPath).replace(/\\/g, "/");
          files.push({
            relativePath: relativePath,
            name: entry.name,
            size: stat.size,
            ext: ext,
          });
        }
      }
    }
    scanDir(rootPath, 0);
    debugLog(`[local-doc] picked directory: ${rootPath}, ${files.length} files`);
    return { canceled: false, rootPath: rootPath, files: files };
  });

  // 读取本地文件，返回 dataUrl（base64）+ 文件名 + mime
  // 参数: rootPath(根目录绝对路径), relativePath(相对路径，用 / 分隔)
  ipcMain.handle("read-local-doc-file", (_event, rootPath, relativePath) => {
    if (!rootPath || !relativePath) return { ok: false, error: "缺少路径参数" };
    // 安全校验：拼接路径必须在 rootPath 下（防止路径遍历攻击）
    const fullPath = path.resolve(rootPath, relativePath);
    const normalizedRoot = path.resolve(rootPath);
    if (!fullPath.startsWith(normalizedRoot + path.sep) && fullPath !== normalizedRoot) {
      return { ok: false, error: "路径越界" };
    }
    if (!fs.existsSync(fullPath)) return { ok: false, error: "文件不存在" };
    try {
      const buffer = fs.readFileSync(fullPath);
      const ext = path.extname(fullPath).toLowerCase();
      const mimeMap = {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
        ".pdf": "application/pdf", ".webp": "image/webp", ".bmp": "image/bmp",
        ".gif": "image/gif", ".tif": "image/tiff", ".tiff": "image/tiff",
        ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      };
      const mime = mimeMap[ext] || "application/octet-stream";
      const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
      const filename = path.basename(fullPath);
      debugLog(`[local-doc] read file: ${relativePath} (${buffer.length} bytes)`);
      return { ok: true, dataUrl: dataUrl, filename: filename, mime: mime, size: buffer.length };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  // 检查文件是否存在（用于 LOOP 执行时按多扩展名尝试）
  // 参数: rootPath, relativePath
  ipcMain.handle("check-local-file-exists", (_event, rootPath, relativePath) => {
    if (!rootPath || !relativePath) return { exists: false };
    const fullPath = path.resolve(rootPath, relativePath);
    const normalizedRoot = path.resolve(rootPath);
    if (!fullPath.startsWith(normalizedRoot + path.sep) && fullPath !== normalizedRoot) {
      return { exists: false };
    }
    return { exists: fs.existsSync(fullPath) };
  });

  // 导出文件：弹保存对话框 → 写入磁盘
  // 参数: defaultName(默认文件名), base64(文件内容 base64，可带 data: 前缀)
  ipcMain.handle("save-exported-file", async (_event, defaultName, base64) => {
    const { dialog } = require("electron");
    const path = require("path");

    // 从默认文件名解析扩展名，用于构建文件类型过滤器
    const parsedExt = (defaultName && defaultName.includes(".")
      ? defaultName.slice(defaultName.lastIndexOf(".") + 1).toLowerCase()
      : ""
    );

    // 根据扩展名构建过滤器（让对话框默认选中正确类型，Windows 会自动追加扩展名）
    const filterMap = {
      jpg: { name: "JPEG 图片", extensions: ["jpg", "jpeg"] },
      jpeg: { name: "JPEG 图片", extensions: ["jpg", "jpeg"] },
      png: { name: "PNG 图片", extensions: ["png"] },
      pdf: { name: "PDF 文档", extensions: ["pdf"] },
      webp: { name: "WebP 图片", extensions: ["webp"] },
      bmp: { name: "BMP 图片", extensions: ["bmp"] },
      gif: { name: "GIF 图片", extensions: ["gif"] },
    };

    const extFilters = [];
    if (parsedExt && filterMap[parsedExt]) {
      extFilters.push(filterMap[parsedExt]);
    } else if (parsedExt) {
      // 未知扩展名：以该扩展名自身作为过滤器
      extFilters.push({ name: `${parsedExt.toUpperCase()} 文件`, extensions: [parsedExt] });
    }
    extFilters.push({ name: "所有文件", extensions: ["*"] });

    const result = await dialog.showSaveDialog(mainWindow, {
      title: "导出文件",
      defaultPath: defaultName || "export.bin",
      filters: extFilters,
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };

    // 兜底：用户手动删了扩展名时，自动补回正确扩展名
    let finalPath = result.filePath;
    if (parsedExt) {
      const userExt = path.extname(finalPath).slice(1).toLowerCase();
      // 仅在用户完全没写扩展名时追加，不覆盖用户主动输入的扩展名
      if (!userExt) {
        finalPath = finalPath + "." + parsedExt;
      }
    }

    try {
      let raw = String(base64 || "");
      if (raw.startsWith("data:") && raw.indexOf(",") >= 0) raw = raw.slice(raw.indexOf(",") + 1);
      const buffer = Buffer.from(raw, "base64");
      fs.writeFileSync(finalPath, buffer);
      debugLog(`[export] saved: ${finalPath} (${buffer.length} bytes)`);
      return { ok: true, path: finalPath, size: buffer.length };
    } catch (e) {
      debugLog(`[export] save failed: ${e.message}`);
      return { ok: false, error: String(e) };
    }
  });

  // ============ 一键直传：直接把文件填入网页 file input ============
  // 参数: side, fileInputSelector, filename, mime, base64Data
  // 流程：分块传输 base64 → 在 view 中解码为 File → DataTransfer 填入 input → 触发 input/change 事件
  const DEEP_QUERY_FN = `function __cquickDeepQuery(sel) {
    if (!sel) return null;
    if (sel.indexOf('>>>') === -1) { try { return document.querySelector(sel); } catch (e) { return null; } }
    var segs = sel.split('>>>');
    var ctx = document;
    var el = null;
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i].trim();
      if (!s) return null;
      try { el = ctx.querySelector(s); } catch (e) { return null; }
      if (!el) return null;
      if (i < segs.length - 1) {
        var next = null;
        try { if (el.shadowRoot) next = el.shadowRoot; } catch (e) {}
        if (!next) { try { if (el.contentDocument) next = el.contentDocument; } catch (e) {} }
        if (!next) return null;
        ctx = next;
      }
    }
    return el;
  }`;

  ipcMain.handle("view-quick-upload", async (_event, side, fileInputSelector, filename, mime, base64Data) => {
    const view = side === "left" ? leftBrowserView : rightBrowserView;
    if (!view || view.webContents.isDestroyed()) {
      return { ok: false, error: "浏览器视图不存在" };
    }
    try {
      // 1. 分块传输 base64，避免单次 IPC 消息过大
      await view.webContents.executeJavaScript(`window.__cquickUploadB64='';'init'`);
      const CHUNK = 2 * 1024 * 1024;
      for (let i = 0; i < base64Data.length; i += CHUNK) {
        const part = base64Data.slice(i, i + CHUNK);
        await view.webContents.executeJavaScript(`window.__cquickUploadB64+=${JSON.stringify(part)};'ok'`);
      }
      // 2. 在页面中解码并填入 file input
      const fillScript = `
        ${DEEP_QUERY_FN}
        (function() {
          var el = null;
          try { el = __cquickDeepQuery(${JSON.stringify(fileInputSelector)}); } catch(e) { el = null; }
          if (!el) return { ok: false, reason: 'file_input_not_found' };
          var tag = (el.tagName || '').toLowerCase();
          var type = (el.getAttribute && el.getAttribute('type') || '').toLowerCase();
          if (tag !== 'input' || type !== 'file') return { ok: false, reason: 'not_file_input', tag: tag, type: type };
          try {
            var bstr = atob(window.__cquickUploadB64 || '');
            var n = bstr.length;
            var u8 = new Uint8Array(n);
            for (var i = 0; i < n; i++) u8[i] = bstr.charCodeAt(i);
            var file = new File([u8], ${JSON.stringify(filename)}, { type: ${JSON.stringify(mime)} });
            var dt = new DataTransfer();
            // 检查是否 multiple
            var isMultiple = el.hasAttribute('multiple');
            dt.items.add(file);
            el.files = dt.files;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            window.__cquickUploadB64 = '';
            return { ok: true, name: file.name, size: file.size, multiple: isMultiple };
          } catch (e) {
            return { ok: false, reason: 'fill_error:' + String(e) };
          }
        })();
      `;
      const result = await view.webContents.executeJavaScript(fillScript);
      debugLog(`[quick-upload] side=${side}, sel=${fileInputSelector}, result=${JSON.stringify(result)}`);
      return result || { ok: false, reason: "no_result" };
    } catch (e) {
      debugLog(`[quick-upload] error: ${e.message}`);
      return { ok: false, error: String(e) };
    }
  });

  // === ??????????????? ===
  if (!isDev) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("update-available", (info) => {
      debugLog(`[updater] update available: ${info.version}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("update-available", info);
      }
    });
    autoUpdater.on("update-not-available", (info) => {
      debugLog(`[updater] update not available`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("update-not-available", info);
      }
    });
    autoUpdater.on("download-progress", (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("update-download-progress", progress);
      }
    });
    autoUpdater.on("update-downloaded", (info) => {
      debugLog(`[updater] update downloaded: ${info.version}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("update-downloaded", info);
      }
    });
    autoUpdater.on("error", (err) => {
      debugLog(`[updater] error: ${err.message}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("update-error", { message: err.message });
      }
    });

    // ??3??????
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((e) => {
        debugLog(`[updater] check failed: ${e.message}`);
      });
    }, 3000);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  destroyBrowserViews();
  stopBackend();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  destroyBrowserViews();
  stopBackend();
});

// ============ IPC ============

// === ???? IPC ===
ipcMain.handle("get-app-version", () => app.getVersion());
ipcMain.handle("update-check-now", async () => {
  if (isDev) return { ok: false, message: "?????????" };
  try {
    const result = await autoUpdater.checkForUpdates();
    return { ok: true, result };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});
ipcMain.handle("update-download", async () => {
  if (isDev) return { ok: false };
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});
ipcMain.handle("update-quit-install", () => {
  if (!isDev) {
    autoUpdater.quitAndInstall(false, true);
  }
  return { ok: true };
});

// 前端询问后端是否就绪
ipcMain.handle("backend-status", () => backendReady);

// 打开外部链接
ipcMain.on("open-external", (_event, url) => {
  shell.openExternal(url);
});

// === 无边框窗口控制 ===
ipcMain.on("window-minimize", () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on("window-maximize", () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on("window-close", () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.handle("window-is-maximized", () => {
  return mainWindow ? mainWindow.isMaximized() : false;
});

// === 防误关控制 ===
ipcMain.on("set-prevent-close", (_event, enabled) => {
  preventAccidentalClose = Boolean(enabled);
  // 开启时确保托盘存在；关闭时也可保留托盘，不影响使用
  if (preventAccidentalClose && !tray && mainWindow) {
    createTray();
  }
});

// 真正退出应用（绕过防误关拦截）
ipcMain.on("app-quit", () => {
  isQuitting = true;
  app.quit();
});

// === 左右 BrowserView 通用控制 ===
ipcMain.handle("view-load", (_event, side, url) => {
  loadView(side, url);
});

ipcMain.handle("view-show", (_event, side, bounds, url) => {
  if (modalOverlayDepth > 0) { console.log(`[modal] BLOCKED view-show(${side}) depth=${modalOverlayDepth}`); return; } // 模态覆盖期间禁止重新添加 BrowserView，防止原生层遮挡 HTML
  showView(side, bounds, url);
});

ipcMain.handle("view-hide", (_event, side) => {
  hideView(side);
});

ipcMain.handle("view-hide-all", () => {
  hideAllViews();
});

// === 模态覆盖层：临时隐藏所有原生 BrowserView（防止穿模），关闭后恢复 ===
// 使用引用计数支持多层模态框嵌套（如：设置面板 → 流程图编辑器 → 子LOOP选择器）
function hideAllBrowserViews() {
  // 1. 隐藏主窗口的 left/right 及弹窗
  hideAllViews();
  // 2. 隐藏所有脱离面板中的 BrowserView 及弹窗
  for (const key of Object.keys(detachedPanels)) {
    const w = detachedPanels[key];
    const v = detachedPanels[key + "_view"];
    if (w && !w.isDestroyed() && v) {
      if (w.getBrowserViews().includes(v)) {
        w.removeBrowserView(v);
      }
      // 脱离面板上的弹窗（popup）也要移除
      for (const side of Object.keys(popupViews)) {
        const pp = popupViews[side];
        if (pp && pp.win === w && w.getBrowserViews().includes(pp.view)) {
          w.removeBrowserView(pp.view);
        }
      }
    }
  }
}
ipcMain.handle("modal-overlay-enter", () => {
  if (modalOverlayDepth === 0) {
    // 第一次进入：隐藏所有原生视图
    hideAllBrowserViews();
    // 临时隐藏 dock 悬浮窗（如果可见）
    if (dockWindow && !dockWindow.isDestroyed() && dockWindow.isVisible()) {
      dockWasVisibleForModal = true;
      dockWindow.hide();
    } else {
      dockWasVisibleForModal = false;
    }
  }
  modalOverlayDepth++;
  console.log(`[modal] enter -> depth=${modalOverlayDepth}`);
});

ipcMain.handle("modal-overlay-exit", () => {
  if (modalOverlayDepth <= 0) return;
  modalOverlayDepth--;
  console.log(`[modal] exit -> depth=${modalOverlayDepth}`);
  if (modalOverlayDepth > 0) return; // 还有外层模态框，保持隐藏

  // 最后一层退出：恢复 dock
  if (dockWasVisibleForModal && dockWindow && !dockWindow.isDestroyed()) {
    dockWindow.show();
  }
  dockWasVisibleForModal = false;

  // BrowserView 的恢复交由前端处理：监听 modal-overlay-exited 事件后触发 window resize，
  // BrowserPane 的 IntersectionObserver/ResizeObserver 会自动重新 sync()
  // 调用 viewShow() 重新 addBrowserView + setBounds，脱离面板同理。
  function notifyWindow(win) {
    if (win && !win.isDestroyed()) {
      win.webContents.send("modal-overlay-exited");
    }
  }
  notifyWindow(mainWindow);
  for (const key of Object.keys(detachedPanels)) {
    notifyWindow(detachedPanels[key]);
  }
});

// 设置 BrowserView 缩放因子（0.5 ~ 3.0）
ipcMain.handle("view-set-zoom", (_event, side, factor) => {
  const view = side === "left" ? leftBrowserView : rightBrowserView;
  if (!view || !view.webContents || view.webContents.isDestroyed()) return;
  const clamped = Math.max(0.5, Math.min(3.0, Number(factor) || 1.0));
  try {
    view.webContents.setZoomFactor(clamped);
  } catch (_) {}
});

// 在指定 view 中执行 JS（元素选择脚本等）
ipcMain.handle("view-execute-js", (_event, side, script) => {
  return executeInView(side, script);
});

// 在指定 view 中插入 CSS
ipcMain.handle("view-insert-css", (_event, side, css) => {
  return insertCSSInView(side, css);
});

// 激活元素选择模式
ipcMain.handle("view-start-picking", (_event, side) => {
  pickingActive[side] = true;
  debugLog(`[main] view-start-picking side=${side}`);
  return executeInView(side, ELEMENT_PICKER_SCRIPT);
});

// 取消元素选择模式
ipcMain.handle("view-stop-picking", (_event, side) => {
  pickingActive[side] = false;
  debugLog(`[main] view-stop-picking side=${side}`);
  return executeInView(side, ELEMENT_PICKER_DEACTIVATE_SCRIPT);
});

// 浏览器回退（用于网页提取时点错元素撤销）
ipcMain.handle("view-go-back", (_event, side) => {
  debugLog(`[main] view-go-back side=${side}`);
  const view = side === "left" ? leftBrowserView : rightBrowserView;
  if (view && view.webContents.canGoBack()) {
    // 回退前保持picking状态，did-navigate/did-finish-load后会自动重注入picker
    view.webContents.goBack();
    return { ok: true };
  }
  return { ok: false, reason: "cannot-go-back" };
});

// 设置元素屏蔽规则（side, rules[{selector, mode}]）—— 立即注入 CSS/JS，导航后自动重注入
ipcMain.handle("view-set-block-rules", (_event, side, rules) => {
  blockRulesBySide[side] = Array.isArray(rules) ? rules : [];
  applyBlockRules(side);
  return { ok: true };
});

// ============ 账号密码两段式粘贴 ============
// 状态：{ active, side, username, password, step }
// step: 0 = 待粘贴用户名，1 = 待粘贴密码
// 拦截 BrowserView 的 Ctrl+V：第一次填入 username，第二次填入 password，第二次后自动结束
const twoStepPaste = { active: false, side: null, username: "", password: "", step: 0 };

function notifyPasteProgress(done) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("two-step-paste-progress", {
      side: twoStepPaste.side,
      step: twoStepPaste.step,
      done: !!done,
    });
  }
}

// 在 BrowserView 中找当前 focus 的输入元素并设置值（不污染剪贴板）
function pasteIntoFocusedElement(view, value) {
  if (!view || view.webContents.isDestroyed()) return Promise.resolve(false);
  return view.webContents.executeJavaScript(`
    (function() {
      var el = document.activeElement;
      if (!el) return false;
      var tag = el.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea') {
        var type = (el.type || '').toLowerCase();
        if (type === 'checkbox' || type === 'radio' || type === 'submit' || type === 'button' || type === 'file' || type === 'image' || type === 'reset') return false;
        // 用原生 setter 触发 React/Vue 等框架响应
        var proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        var setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) setter.set.call(el, ${JSON.stringify(value)});
        else el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      if (el.isContentEditable) {
        el.textContent = ${JSON.stringify(value)};
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(value)} }));
        return true;
      }
      return false;
    })()
  `).catch(() => false);
}

function setupTwoStepPasteInterceptor(view, side) {
  if (!view) return;
  view.webContents.on("before-input-event", (event, input) => {
    if (!twoStepPaste.active || twoStepPaste.side !== side) return;
    // 只拦截 Ctrl+V（或 Cmd+V on mac）
    const isPaste = (input.control || input.meta) && input.key.toLowerCase() === "v";
    if (!isPaste) return;
    event.preventDefault();
    const currentStep = twoStepPaste.step;
    const value = currentStep === 0 ? twoStepPaste.username : twoStepPaste.password;
    pasteIntoFocusedElement(view, value).then((ok) => {
      if (!ok) {
        debugLog("[two-step-paste] 目标元素不可写入，side=" + side + " step=" + currentStep);
      }
      if (currentStep === 0) {
        twoStepPaste.step = 1;
        notifyPasteProgress(false);
      } else {
        // 完成第二次粘贴，自动结束
        const finishedSide = twoStepPaste.side;
        twoStepPaste.active = false;
        twoStepPaste.side = null;
        twoStepPaste.username = "";
        twoStepPaste.password = "";
        twoStepPaste.step = 0;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("two-step-paste-progress", { side: finishedSide, step: 1, done: true });
        }
      }
    });
  });
}

ipcMain.handle("two-step-paste-start", (_event, side, username, password) => {
  twoStepPaste.active = true;
  twoStepPaste.side = side;
  twoStepPaste.username = String(username || "");
  twoStepPaste.password = String(password || "");
  twoStepPaste.step = 0;
  return { ok: true };
});

ipcMain.handle("two-step-paste-cancel", () => {
  twoStepPaste.active = false;
  twoStepPaste.side = null;
  twoStepPaste.username = "";
  twoStepPaste.password = "";
  twoStepPaste.step = 0;
  return { ok: true };
});

ipcMain.handle("two-step-paste-state", () => {
  return {
    active: twoStepPaste.active,
    step: twoStepPaste.step,
    side: twoStepPaste.side,
  };
});

// 高亮指定 view 中的若干元素（boxes: [{selector, status, label}]）
ipcMain.handle("view-highlight-boxes", (_event, side, boxes) => {
  return executeInView(side, buildHighlightScript(boxes || []));
});

// 清除高亮
ipcMain.handle("view-clear-highlight", (_event, side) => {
  return executeInView(side, CLEAR_HIGHLIGHT_SCRIPT);
});

// 设置绑定输入模式（右键菜单开关）：true=开启右键菜单，false=关闭
ipcMain.handle("view-set-bind-input-mode", (_event, side, enabled) => {
  return executeInView(side, `window.__cinsideBindInputMode = ${enabled ? "true" : "false"};`);
});

// 启用/禁用框选模式（日格子多选：拖拽画矩形批量选中矩形内所有日格子元素）
ipcMain.handle("view-set-marquee-mode", (_event, side, enabled) => {
  return executeInView(side, `
    window.__cinsidePickerMarqueeMode = ${enabled ? "true" : "false"};
    if (window.__cinsideClearMarquee && !${enabled ? "true" : "false"}) {
      try { window.__cinsideClearMarquee(); } catch (_) {}
    }
  `);
});

// 回传 Excel 列列表到 picker 脚本（右键菜单响应）
ipcMain.handle("view-ctx-menu-response", (_event, side, columns, currentField) => {
  const colsJson = JSON.stringify(columns || []);
  const curField = JSON.stringify(currentField || "");
  return executeInView(side, `if (window.__cinsideCtxMenuResponse) window.__cinsideCtxMenuResponse(${colsJson}, ${curField});`);
});

// 截图指定 view 中的元素区域，返回 base64 PNG（用于头像提取）
ipcMain.handle("view-capture-element", async (_event, side, rect) => {
  const view = side === "left" ? leftBrowserView : side === "right" ? rightBrowserView : null;
  if (!view) return { ok: false, error: "view not found" };
  try {
    const image = await view.webContents.capturePage({
      x: Math.round(rect.x || 0),
      y: Math.round(rect.y || 0),
      width: Math.round(rect.width || 100),
      height: Math.round(rect.height || 100),
    });
    const dataUrl = image.toDataURL(); // data:image/png;base64,...
    return { ok: true, dataUrl };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// 元素选择消息转发：前端订阅 view-message 事件
ipcMain.on("subscribe-view-messages", (event) => {
  // 由前端通过 ipcRenderer.on('view-message', cb) 接收
  // 这里只做 ack
  event.returnValue = "ok";
});

// ============ 脱离面板（可拖拽到其他屏幕） ============

// 脱离视图的拾取模式状态跟踪
const detachedPickingActive = {};

// 为脱离的浏览器面板创建独立的 BrowserView（含完整消息中继）
function createDetachedBrowserView(win, side) {
  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
    },
  });
  // 禁用默认 Ctrl+滚轮缩放（与主 view 一致）
  try {
    view.webContents.setLayoutZoomResizingEnabled(false);
    view.webContents.setVisualZoomResizingEnabled(false);
  } catch (_) {}
  view.webContents.loadURL("about:blank");

  // 页面加载完成后注入滚动条样式 + 拾取模式光标 CSS
  view.webContents.on("did-finish-load", () => {
    view.webContents.insertCSS(`
      ::-webkit-scrollbar { width: 4px; height: 4px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: rgba(148,163,184,.30); border-radius: 4px; }
      ::-webkit-scrollbar-thumb:hover { background: rgba(99,102,241,.45); }
      ::-webkit-scrollbar-corner { background: transparent; }
      .cinside-picking, .cinside-picking * { cursor: crosshair !important; }
      .cinside-picking *:hover { outline: 2px dashed #6366f1 !important; outline-offset: 1px !important; box-shadow: 0 0 0 4px rgba(99,102,241,.15) !important; }
      @keyframes cinside-pick-flash { 0% { outline: 3px solid #6366f1; outline-offset: 1px; box-shadow: 0 0 0 6px rgba(99,102,241,0.30); } 70% { outline: 3px solid rgba(99,102,241,0.4); outline-offset: 1px; box-shadow: 0 0 0 6px rgba(99,102,241,0.10); } 100% { outline: 3px solid rgba(99,102,241,0); outline-offset: 1px; box-shadow: 0 0 0 6px rgba(99,102,241,0); } }
      .cinside-pick-flash { animation: cinside-pick-flash 0.28s ease-out forwards; }
    `).catch(() => {});
    // 页面重载后若拾取模式仍激活，重新注入拾取脚本
    if (detachedPickingActive[side]) {
      view.webContents.executeJavaScript(ELEMENT_PICKER_SCRIPT).catch(() => {});
    }
  });

  // dom-ready：注入 relay 桥接
  view.webContents.on("dom-ready", () => {
    view.webContents.executeJavaScript(`
      (function () {
        if (window.__cinsideRelayInstalled) return;
        window.__cinsideRelayInstalled = true;
        window.__cinsidePostMessage = function (payload) {
          try { console.log('[cinside-relay]', JSON.stringify(payload)); } catch (e) {}
        };
        // Ctrl+滚轮缩放：passive:true 不阻塞页面正常滚动
        window.addEventListener('wheel', function (e) {
          if (e.ctrlKey) {
            console.log('[cinside-relay]', JSON.stringify({ kind: 'ctrl-wheel', deltaY: e.deltaY }));
          }
        }, { passive: true });
      })();
    `).catch(() => {});
  });

  // 页面内导航后重注入拾取脚本
  view.webContents.on("did-navigate", () => {
    // 父页面导航时关闭弹窗
    const actualSide = side === "browser-left" ? "left" : "right";
    closePopupView(actualSide);
    if (detachedPickingActive[side]) {
      view.webContents.executeJavaScript(ELEMENT_PICKER_SCRIPT).catch(() => {});
    }
  });
  view.webContents.on("did-navigate-in-page", () => {
    if (detachedPickingActive[side]) {
      view.webContents.executeJavaScript(ELEMENT_PICKER_SCRIPT).catch(() => {});
    }
  });

  // 加载状态变化：通知前端 loading 开始/结束
  const actualSideForMsg = side === "browser-left" ? "left" : "right";
  view.webContents.on("did-start-loading", () => {
    if (win && !win.isDestroyed()) {
      win.webContents.send("view-message", { side: actualSideForMsg, payload: { kind: "view-loading", loading: true } });
    }
  });
  view.webContents.on("did-stop-loading", () => {
    if (win && !win.isDestroyed()) {
      win.webContents.send("view-message", { side: actualSideForMsg, payload: { kind: "view-loading", loading: false } });
    }
  });
  view.webContents.on("did-fail-load", (_e, errorCode, _errorDesc, validatedURL) => {
    if (errorCode !== -3 && win && !win.isDestroyed()) {
      win.webContents.send("view-message", { side: actualSideForMsg, payload: { kind: "view-loading", loading: false, error: errorCode, url: validatedURL } });
    }
  });

// 监听 console message，把 [cinside-relay] 前缀的日志解析后转发到脱离窗口
view.webContents.on("console-message", (_e, level, message) => {
  if (typeof message !== "string") return;
  if (message.startsWith("[onPick]") || message.startsWith("[BrowserPane")) {
    debugLog(`[detach:${side}] ${message}`);
  }
  const tag = "[cinside-relay]";
  if (message.startsWith(tag)) {
    try {
      const payload = JSON.parse(message.slice(tag.length).trim());
      if (win && !win.isDestroyed()) {
        win.webContents.send("view-message", { side: side === "browser-left" ? "left" : "right", payload });
      }
    } catch (_) {}
  }
});

  // 拦截 window.open()：在脱离窗口创建覆盖弹窗 BrowserView
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (url && url !== "about:blank") {
      const actualSide = side === "browser-left" ? "left" : "right";
      createPopupView(actualSide, url, win);
    }
    return { action: "deny" };
  });

  win.addBrowserView(view);
  // 通知分离窗口的渲染进程：BrowserView 已就绪，可以重新触发 sync 和 loadURL
  // 解决 view 创建晚于渲染进程首次 sync 的时序竞态（分离后不显示内容）
  if (win && !win.isDestroyed()) {
    win.webContents.send("detached-view-ready", side);
  }
  return view;
}

// 前端日志转发到主进程日志文件
ipcMain.on("renderer-log", (_event, msg) => {
  debugLog(`[renderer] ${msg}`);
});

ipcMain.handle("panel-detach", (_event, side) => {
  if (detachedPanels[side] && !detachedPanels[side].isDestroyed()) {
    detachedPanels[side].focus();
    return true;
  }

  const isLeftPanel = side === "left";
  const isBrowser = side === "browser-left" || side === "browser-right";
  const isExcel = side === "browser-excel";
  const width = isLeftPanel ? 340 : (isBrowser || isExcel) ? 900 : 720;

  const win = new BrowserWindow({
    width,
    height: 600,
    minWidth: 280,
    minHeight: 360,
    title: isLeftPanel ? "CINSIDE · 数据源" : side === "browser-left" ? "CINSIDE · 数据源网页" : side === "browser-right" ? "CINSIDE · 学校系统" : isExcel ? "CINSIDE · Excel 视图" : "CINSIDE · 核验结果",
    icon: path.join(__dirname, "../../assets/app-icon.ico"),
    frame: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });

  if (isDev) {
    win.loadURL(`http://localhost:5173?detach=${side}`);
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"), { query: { detach: side } });
  }

  // 浏览器脱离面板需要自己的 BrowserView
  if (isBrowser) {
    win.webContents.on("did-finish-load", () => {
      detachedPanels[side + "_view"] = createDetachedBrowserView(win, side);
    });
  }

  detachedPanels[side] = win;

  win.on("closed", () => {
    // 关闭该 side 的弹窗（如果有）
    const actualSide = side === "browser-left" ? "left" : "right";
    closePopupView(actualSide);
    if (detachedPanels[side + "_view"]) {
      try { detachedPanels[side + "_view"].webContents.destroy(); } catch (_) {}
      detachedPanels[side + "_view"] = null;
    }
    detachedPanels[side] = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("panel-reattached", side);
    }
  });

  return true;
});

// 脱离的浏览器面板：控制其 BrowserView
ipcMain.handle("detached-view-show", (_event, side, bounds, _url) => {
  if (modalOverlayDepth > 0) return; // 模态覆盖期间禁止重新添加 BrowserView
  // 同 showView：不在此处自动 loadURL，避免无限刷新
  const view = detachedPanels[side + "_view"];
  const win = detachedPanels[side];
  if (!view || !win || win.isDestroyed()) return;
  view.setBounds(bounds);
  if (!win.getBrowserViews().includes(view)) {
    win.addBrowserView(view);
  }
  try { win.setTopBrowserView(view); } catch (_) {}
  // 强制重绘：与 showView 一致，通过 setBounds 再次触发 Chromium 合成器刷新
  // 使用版本号防止旧 setTimeout 的 bounds 覆盖新的 setBounds
  if (bounds) {
    view._cinsideBoundsVer = (view._cinsideBoundsVer || 0) + 1;
    const ver = view._cinsideBoundsVer;
    setTimeout(() => {
      if (ver === view._cinsideBoundsVer && !view.webContents.isDestroyed()) {
        try { view.setBounds(bounds); } catch (_) {}
      }
    }, 100);
  }
  // 同步弹窗 view 的 bounds（居中于父 view）
  const actualSide = side === "browser-left" ? "left" : "right";
  const popup = popupViews[actualSide];
  if (popup && popup.win === win && bounds) {
    popup.view.setBounds(computePopupBounds(bounds));
    if (!win.getBrowserViews().includes(popup.view)) {
      win.addBrowserView(popup.view);
    }
    try { win.setTopBrowserView(popup.view); } catch (_) {}
  }
});

ipcMain.handle("detached-view-hide", (_event, side) => {
  const view = detachedPanels[side + "_view"];
  const win = detachedPanels[side];
  if (!view || !win || win.isDestroyed()) return;
  if (win.getBrowserViews().includes(view)) {
    win.removeBrowserView(view);
  }
  // 同时隐藏弹窗
  const actualSide = side === "browser-left" ? "left" : "right";
  const popup = popupViews[actualSide];
  if (popup && popup.win === win && win.getBrowserViews().includes(popup.view)) {
    win.removeBrowserView(popup.view);
  }
});

ipcMain.handle("detached-view-load", (_event, side, url) => {
  const view = detachedPanels[side + "_view"];
  if (!view || !url) return;
  view.webContents.loadURL(url);
});

ipcMain.handle("detached-view-execute-js", (_event, side, script) => {
  const view = detachedPanels[side + "_view"];
  if (!view) return Promise.resolve(undefined);
  return view.webContents.executeJavaScript(script).catch((e) => {
    console.error(`[detached-view:${side}]`, e);
    return undefined;
  });
});

// 脱离视图：激活/取消元素选择模式
ipcMain.handle("detached-view-start-picking", (_event, side) => {
  detachedPickingActive[side] = true;
  const view = detachedPanels[side + "_view"];
  if (!view) return Promise.resolve(undefined);
  return view.webContents.executeJavaScript(ELEMENT_PICKER_SCRIPT).catch((e) => {
    console.error(`[detached-view-picking:${side}]`, e);
    return undefined;
  });
});

ipcMain.handle("detached-view-stop-picking", (_event, side) => {
  detachedPickingActive[side] = false;
  const view = detachedPanels[side + "_view"];
  if (!view) return Promise.resolve(undefined);
  return view.webContents.executeJavaScript(ELEMENT_PICKER_DEACTIVATE_SCRIPT).catch((e) => {
    console.error(`[detached-view-picking:${side}]`, e);
    return undefined;
  });
});

// 脱离视图：高亮元素
ipcMain.handle("detached-view-highlight-boxes", (_event, side, boxes) => {
  const view = detachedPanels[side + "_view"];
  if (!view) return Promise.resolve(undefined);
  return view.webContents.executeJavaScript(buildHighlightScript(boxes || [])).catch((e) => {
    console.error(`[detached-view-highlight:${side}]`, e);
    return undefined;
  });
});

// 脱离视图：清除高亮
ipcMain.handle("detached-view-clear-highlight", (_event, side) => {
  const view = detachedPanels[side + "_view"];
  if (!view) return Promise.resolve(undefined);
  return view.webContents.executeJavaScript(CLEAR_HIGHLIGHT_SCRIPT).catch((e) => {
    console.error(`[detached-view-highlight:${side}]`, e);
    return undefined;
  });
});

// 脱离视图：插入 CSS
ipcMain.handle("detached-view-insert-css", (_event, side, css) => {
  const view = detachedPanels[side + "_view"];
  if (!view) return Promise.resolve(undefined);
  return view.webContents.insertCSS(css).catch((e) => {
    console.error(`[detached-view-css:${side}]`, e);
    return undefined;
  });
});

// ============ 弹窗（popup）IPC 处理器 ============

// 关闭弹窗
ipcMain.handle("popup-close", (_event, side) => {
  closePopupView(side);
});

// 弹窗：激活元素选择
ipcMain.handle("popup-start-picking", (_event, side) => {
  const popup = popupViews[side];
  if (!popup) return Promise.resolve(undefined);
  return popup.view.webContents.executeJavaScript(ELEMENT_PICKER_SCRIPT).catch((e) => {
    console.error(`[popup-picking:${side}]`, e);
    return undefined;
  });
});

// 弹窗：取消元素选择
ipcMain.handle("popup-stop-picking", (_event, side) => {
  const popup = popupViews[side];
  if (!popup) return Promise.resolve(undefined);
  return popup.view.webContents.executeJavaScript(ELEMENT_PICKER_DEACTIVATE_SCRIPT).catch((e) => {
    console.error(`[popup-picking:${side}]`, e);
    return undefined;
  });
});

// 弹窗：高亮元素
ipcMain.handle("popup-highlight-boxes", (_event, side, boxes) => {
  const popup = popupViews[side];
  if (!popup) return Promise.resolve(undefined);
  return popup.view.webContents.executeJavaScript(buildHighlightScript(boxes || [])).catch((e) => {
    console.error(`[popup-highlight:${side}]`, e);
    return undefined;
  });
});

// 弹窗：清除高亮
ipcMain.handle("popup-clear-highlight", (_event, side) => {
  const popup = popupViews[side];
  if (!popup) return Promise.resolve(undefined);
  return popup.view.webContents.executeJavaScript(CLEAR_HIGHLIGHT_SCRIPT).catch((e) => {
    console.error(`[popup-highlight:${side}]`, e);
    return undefined;
  });
});

// 弹窗：执行任意 JS
ipcMain.handle("popup-execute-js", (_event, side, script) => {
  const popup = popupViews[side];
  if (!popup) return Promise.resolve(undefined);
  return popup.view.webContents.executeJavaScript(script).catch((e) => {
    console.error(`[popup-js:${side}]`, e);
    return undefined;
  });
});

// 弹窗一键直传：把文件直接填入弹窗中的 file input
ipcMain.handle("popup-quick-upload", async (_event, side, fileInputSelector, filename, mime, base64Data) => {
  const popup = popupViews[side];
  if (!popup || !popup.view || popup.view.webContents.isDestroyed()) {
    return { ok: false, error: "弹窗视图不存在" };
  }
  try {
    await popup.view.webContents.executeJavaScript(`window.__cquickUploadB64='';'init'`);
    const CHUNK = 2 * 1024 * 1024;
    for (let i = 0; i < base64Data.length; i += CHUNK) {
      const part = base64Data.slice(i, i + CHUNK);
      await popup.view.webContents.executeJavaScript(`window.__cquickUploadB64+=${JSON.stringify(part)};'ok'`);
    }
    const fillScript = `
      ${DEEP_QUERY_FN}
      (function() {
        var el = null;
        try { el = __cquickDeepQuery(${JSON.stringify(fileInputSelector)}); } catch(e) { el = null; }
        if (!el) return { ok: false, reason: 'file_input_not_found' };
        var tag = (el.tagName || '').toLowerCase();
        var type = (el.getAttribute && el.getAttribute('type') || '').toLowerCase();
        if (tag !== 'input' || type !== 'file') return { ok: false, reason: 'not_file_input', tag: tag, type: type };
        try {
          var bstr = atob(window.__cquickUploadB64 || '');
          var n = bstr.length;
          var u8 = new Uint8Array(n);
          for (var i = 0; i < n; i++) u8[i] = bstr.charCodeAt(i);
          var file = new File([u8], ${JSON.stringify(filename)}, { type: ${JSON.stringify(mime)} });
          var dt = new DataTransfer();
          var isMultiple = el.hasAttribute('multiple');
          dt.items.add(file);
          el.files = dt.files;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          window.__cquickUploadB64 = '';
          return { ok: true, name: file.name, size: file.size, multiple: isMultiple };
        } catch (e) {
          return { ok: false, reason: 'fill_error:' + String(e) };
        }
      })();
    `;
    const result = await popup.view.webContents.executeJavaScript(fillScript);
    debugLog(`[popup-quick-upload] side=${side}, sel=${fileInputSelector}, result=${JSON.stringify(result)}`);
    return result || { ok: false, reason: "no_result" };
  } catch (e) {
    debugLog(`[popup-quick-upload] error: ${e.message}`);
    return { ok: false, error: String(e) };
  }
});

// 主窗口 → 脱离窗口：广播状态
ipcMain.on("panel-state-broadcast", (_event, side, state) => {
  const win = detachedPanels[side];
  if (win && !win.isDestroyed()) {
    win.webContents.send("panel-state", state);
  }
});

// 脱离窗口 → 主窗口：用户操作回传
ipcMain.on("panel-action", (_event, action, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("panel-action", { action, payload });
  }
});

// ============ 外挂插件：屏幕边缘悬浮条（dock） ============
// 独立于主窗口的小条，挂到屏幕边缘；两个按钮「提取源」「操作页」，
// AI 通过后端体外循环从提取源抓数据并自动填写操作页。

let dockWindow = null;
let dockMode = "strip"; // 'strip' | 'picker' | 'collapsed'
let dockEdge = "right"; // 'left' | 'right'
const DOCK_STRIP = { w: 240, h: 520 };
const DOCK_PICKER = { w: 360, h: 520 };
const DOCK_COLLAPSED = { w: 48, h: 48 };

function dockBoundsForMode(mode, edge, keepPos) {
  const { screen } = require("electron");
  let x, y;
  const size = mode === "picker" ? DOCK_PICKER : (mode === "collapsed" ? DOCK_COLLAPSED : DOCK_STRIP);
  if (keepPos && dockWindow && !dockWindow.isDestroyed()) {
    // 形态切换时保持靠边的内侧边缘不动
    const b = dockWindow.getBounds();
    const disp = screen.getDisplayMatching(b).workArea;
    x = edge === "right" ? disp.x + disp.width - size.w : disp.x;
    y = Math.min(Math.max(b.y, disp.y), disp.y + disp.height - size.h);
  } else {
    const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    x = edge === "right" ? disp.x + disp.width - size.w : disp.x;
    y = disp.y + Math.round((disp.height - size.h) / 2);
  }
  return { x, y, width: size.w, height: size.h };
}

function createDockWindow() {
  if (dockWindow && !dockWindow.isDestroyed()) {
    dockWindow.show();
    dockWindow.focus();
    return dockWindow;
  }
  dockMode = "strip";
  dockWindow = new BrowserWindow({
    ...dockBoundsForMode("strip", dockEdge, false),
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    transparent: true,
    backgroundColor: "#00000000",
    title: "CINSIDE 外挂",
    icon: path.join(__dirname, "../../assets/app-icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "dock-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  dockWindow.setAlwaysOnTop(true, "screen-saver");
  dockWindow.loadFile(path.join(__dirname, "dock.html"));
  dockWindow.setMenu(null);

  // 拖动结束后吸附到最近的左右边缘
  dockWindow.on("moved", () => {
    if (!dockWindow || dockWindow.isDestroyed()) return;
    const { screen } = require("electron");
    const b = dockWindow.getBounds();
    const disp = screen.getDisplayMatching(b).workArea;
    const centerX = b.x + b.width / 2;
    dockEdge = centerX < disp.x + disp.width / 2 ? "left" : "right";
    const x = dockEdge === "right" ? disp.x + disp.width - b.width : disp.x;
    const y = Math.min(Math.max(b.y, disp.y), disp.y + disp.height - b.height);
    dockWindow.setBounds({ x, y, width: b.width, height: b.height });
  });

  dockWindow.on("closed", () => {
    dockWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("dock-state", { open: false });
    }
  });
  dockWindow.webContents.on("did-finish-load", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("dock-state", { open: true });
    }
  });
  return dockWindow;
}

function destroyDockWindow() {
  if (dockWindow && !dockWindow.isDestroyed()) {
    dockWindow.destroy();
  }
  dockWindow = null;
}

ipcMain.handle("dock-toggle", () => {
  if (dockWindow && !dockWindow.isDestroyed()) {
    destroyDockWindow();
    return { open: false };
  }
  createDockWindow();
  return { open: true };
});

ipcMain.handle("dock-is-open", () => !!(dockWindow && !dockWindow.isDestroyed()));

ipcMain.on("dock-show-main", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

ipcMain.on("dock-close", () => {
  destroyDockWindow();
});

ipcMain.on("dock-set-mode", (_event, mode) => {
  dockMode = mode === "picker" ? "picker" : (mode === "collapsed" ? "collapsed" : "strip");
  if (dockWindow && !dockWindow.isDestroyed()) {
    dockWindow.setBounds(dockBoundsForMode(dockMode, dockEdge, true));
  }
});

// 悬浮条 / 主窗口访问后端插件 API 的代理（避免 CORS 与端口耦合）
ipcMain.handle("plugin-api", async (_event, req) => {
  const { path: apiPath, method = "GET", body } = req || {};
  try {
    const resp = await fetch(`http://127.0.0.1:${BACKEND_PORT}${apiPath}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await resp.json(); } catch (e) {}
    return { ok: resp.ok, status: resp.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: `后端未连接: ${e && e.message ? e.message : e}` } };
  }
});

// 启动带 CDP 调试端口的受控 Chrome（独立 profile，端口 9223，避开 Electron 自用的 9222）
ipcMain.handle("dock-launch-chrome", async () => {
  const candidates = [
    path.join(process.env["PROGRAMFILES"] || "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
    path.join(process.env["LOCALAPPDATA"] || "", "Google\\Chrome\\Application\\chrome.exe"),
    path.join(process.env["PROGRAMFILES"] || "C:\\Program Files", "Microsoft\\Edge\\Application\\msedge.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Microsoft\\Edge\\Application\\msedge.exe"),
  ];
  const exe = candidates.find((p) => p && fs.existsSync(p));
  if (!exe) {
    return { ok: false, error: "未找到 Chrome / Edge 浏览器，请手动安装" };
  }
  const profileDir = path.join(app.getPath("userData"), "plugin-chrome-profile");
  try { fs.mkdirSync(profileDir, { recursive: true }); } catch (e) {}
  try {
    const child = spawn(exe, [
      "--remote-debugging-port=9223",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
    ], { detached: true, stdio: "ignore" });
    child.unref();
    debugLog(`[dock] launched controlled browser: ${exe}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});
