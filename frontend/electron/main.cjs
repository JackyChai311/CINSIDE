"use strict";

const { app, BrowserWindow, BrowserView, ipcMain, shell, Tray, Menu, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
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
  return new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
    },
  });
}

function createBrowserViews() {
  if (!leftBrowserView) {
    leftBrowserView = makeBrowserView();
    leftBrowserView.webContents.loadURL("about:blank");
    attachViewMessageRelay(leftBrowserView, "left");
  }
  if (!rightBrowserView) {
    rightBrowserView = makeBrowserView();
    rightBrowserView.webContents.loadURL("about:blank");
    attachViewMessageRelay(rightBrowserView, "right");
  }
}

// 把 BrowserView 内部通过 window.__cinsidePostMessage 发回的消息转发到前端
function attachViewMessageRelay(view, side) {
  // 页面加载完成后注入细滚动条样式 + 拾取模式光标 CSS
  view.webContents.on("did-finish-load", () => {
    view.webContents.insertCSS(`
      ::-webkit-scrollbar { width: 5px; height: 5px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: rgba(99,102,241,.18); border-radius: 10px; }
      ::-webkit-scrollbar-thumb:hover { background: rgba(99,102,241,.35); }
      ::-webkit-scrollbar-corner { background: transparent; }
      .cinside-picking, .cinside-picking * { cursor: crosshair !important; }
      .cinside-picking *:hover { outline: 2px dashed #6366f1 !important; outline-offset: 1px !important; box-shadow: 0 0 0 4px rgba(99,102,241,.15) !important; }
    `).catch(() => {});
    // 页面重载后若拾取模式仍激活，重新注入拾取脚本
    if (pickingActive[side]) {
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
        // Ctrl+滚轮缩放
        window.addEventListener('wheel', function (e) {
          if (e.ctrlKey) {
            e.preventDefault();
            console.log('[cinside-relay]', JSON.stringify({ kind: 'ctrl-wheel', deltaY: e.deltaY }));
          }
        }, { passive: false });
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
  });
  view.webContents.on("did-navigate-in-page", () => {
    if (pickingActive[side]) {
      view.webContents.executeJavaScript(ELEMENT_PICKER_SCRIPT).catch(() => {});
    }
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
      if (mainWindow.getBrowserViews().includes(view)) {
        const b = view.getBounds();
        setTimeout(() => {
          try { if (!view.webContents.isDestroyed()) view.setBounds(b); } catch (_) {}
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

  // 附加消息中继（与主 view 完全一致）
  view.webContents.on("did-finish-load", () => {
    view.webContents.insertCSS(`
      ::-webkit-scrollbar { width: 5px; height: 5px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: rgba(99,102,241,.18); border-radius: 10px; }
      ::-webkit-scrollbar-thumb:hover { background: rgba(99,102,241,.35); }
      ::-webkit-scrollbar-corner { background: transparent; }
      .cinside-picking, .cinside-picking * { cursor: crosshair !important; }
      .cinside-picking *:hover { outline: 2px dashed #6366f1 !important; outline-offset: 1px !important; box-shadow: 0 0 0 4px rgba(99,102,241,.15) !important; }
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
        // Ctrl+滚轮缩放
        window.addEventListener('wheel', function (e) {
          if (e.ctrlKey) {
            e.preventDefault();
            console.log('[cinside-relay]', JSON.stringify({ kind: 'ctrl-wheel', deltaY: e.deltaY }));
          }
        }, { passive: false });
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
      // 发给弹窗所在的窗口
      if (win && !win.isDestroyed()) {
        win.webContents.send("view-message", { side: parentSide, payload });
      }
      // 如果是脱离窗口的弹窗，也要发给主窗口
      if (win !== mainWindow && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("view-message", { side: parentSide, payload });
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

  // 加载 URL 并设置 bounds（与父 view 完全重合）
  view.webContents.loadURL(url);
  view.setBounds(parentBounds);
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

function loadView(side, url) {
  const view = side === "left" ? leftBrowserView : rightBrowserView;
  if (!view || !url || typeof url !== "string") return;
  view.webContents.loadURL(url);
}

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
  // 不要 setTopBrowserView：BrowserView 置顶会盖住设置弹窗/确认对话框等 HTML 层。
  // 弹窗打开时 App.tsx 会主动 viewHide，弹窗关闭后由 sync() 恢复。
  // 强制重绘：通过 setBounds 再次触发 Chromium 合成器刷新，解决后台
  // 加载/JS执行后 BrowserView 内容不更新直到重新切换tab才显示的问题
  if (bounds) {
    setTimeout(() => {
      if (!view.webContents.isDestroyed()) {
        try { view.setBounds(bounds); } catch (_) {}
      }
    }, 100);
  }
  // 同步弹窗 view 的 bounds
  const popup = popupViews[side];
  if (popup && popup.win === mainWindow && bounds) {
    popup.view.setBounds(bounds);
    if (!mainWindow.getBrowserViews().includes(popup.view)) {
      mainWindow.addBrowserView(popup.view);
    }
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
    el.style.outline = '3px solid ' + color;
    el.style.outlineOffset = '1px';
    el.style.boxShadow = '0 0 0 6px ' + color + '33';
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
    highlight(el, '#6366f1');
    // 文档提取：收集元素的链接/图片地址（PDF、图片等）
    var linkEl = (el.closest && el.closest('a')) || (el.tagName === 'A' ? el : null);
    var imgEl = (el.tagName === 'IMG') ? el : (el.querySelector ? el.querySelector('img') : null);
    var payload = {
      kind: 'element-picked',
      selector: buildSelector(el),
      label: getLabel(el),
      value: el.value || el.getAttribute('value') || (el.isContentEditable ? (el.innerText || '').trim() : ''),
      tag: el.nodeName.toLowerCase(),
      type: el.getAttribute && el.getAttribute('type') || '',
      isContentEditable: !!el.isContentEditable,
      rect: getRect(el),
      text: (el.innerText || '').trim().slice(0, 120),
      href: linkEl && linkEl.href ? linkEl.href : (el.href || ''),
      src: imgEl && imgEl.src ? imgEl.src : (el.src || ''),
    };
    console.log('[onPick] payload=', JSON.stringify({ tag: payload.tag, selector: payload.selector, isContentEditable: payload.isContentEditable, value: payload.value }));
    window.__cinsidePostMessage(payload);
    // 自动取消激活，单次拾取
    window.__cinsidePickerActive = false;
    document.body.classList.remove('cinside-picking');
    removeFrameArms();
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
      try { d.__cinsideArmed = false; } catch (_) {}
    }
    window.__cinsideArmedDocs = [];
  }

  if (needsInstall) {
    // pointerdown 比 click 更早触发，能更好捕获 input 等会抢占焦点的元素
    document.addEventListener('pointerdown', onPick, true);
    document.addEventListener('click', onPick, true);
  } else {
    // 重复注入：清掉旧武装，下面会用新闭包重新武装
    try { removeFrameArms(); } catch (_) {}
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
  document.body.classList.remove('cinside-picking');
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
  // 给被高亮的元素本身加 outline，更醒目
  function applyOutline() {
    boxInfos.forEach(function (info) {
      try {
        var el = deepQuery(info.sel);
        if (el) {
          el.style.outline = '2px solid ' + info.color;
          el.style.outlineOffset = '1px';
        }
      } catch (e) {}
    });
  }
  reposition();
  applyOutline();
  // 滚动/resize 时通过 rAF 重新定位（capture=true 捕获所有滚动容器）
  var rafId = null;
  var scheduleReposition = function () {
    if (rafId != null) return;
    rafId = requestAnimationFrame(function () {
      rafId = null;
      reposition();
    });
  };
  document.addEventListener('scroll', scheduleReposition, true);
  window.addEventListener('resize', scheduleReposition);
  window.__cinsideHighlightCleanup = function () {
    document.removeEventListener('scroll', scheduleReposition, true);
    window.removeEventListener('resize', scheduleReposition);
    if (rafId != null) cancelAnimationFrame(rafId);
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
  showView(side, bounds, url);
});

ipcMain.handle("view-hide", (_event, side) => {
  hideView(side);
});

ipcMain.handle("view-hide-all", () => {
  hideAllViews();
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

// 高亮指定 view 中的若干元素（boxes: [{selector, status, label}]）
ipcMain.handle("view-highlight-boxes", (_event, side, boxes) => {
  return executeInView(side, buildHighlightScript(boxes || []));
});

// 清除高亮
ipcMain.handle("view-clear-highlight", (_event, side) => {
  return executeInView(side, CLEAR_HIGHLIGHT_SCRIPT);
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
  view.webContents.loadURL("about:blank");

  // 页面加载完成后注入滚动条样式 + 拾取模式光标 CSS
  view.webContents.on("did-finish-load", () => {
    view.webContents.insertCSS(`
      ::-webkit-scrollbar { width: 5px; height: 5px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: rgba(99,102,241,.18); border-radius: 10px; }
      ::-webkit-scrollbar-thumb:hover { background: rgba(99,102,241,.35); }
      ::-webkit-scrollbar-corner { background: transparent; }
      .cinside-picking, .cinside-picking * { cursor: crosshair !important; }
      .cinside-picking *:hover { outline: 2px dashed #6366f1 !important; outline-offset: 1px !important; box-shadow: 0 0 0 4px rgba(99,102,241,.15) !important; }
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
        // Ctrl+滚轮缩放
        window.addEventListener('wheel', function (e) {
          if (e.ctrlKey) {
            e.preventDefault();
            console.log('[cinside-relay]', JSON.stringify({ kind: 'ctrl-wheel', deltaY: e.deltaY }));
          }
        }, { passive: false });
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
  // 同 showView：不在此处自动 loadURL，避免无限刷新
  const view = detachedPanels[side + "_view"];
  const win = detachedPanels[side];
  if (!view || !win || win.isDestroyed()) return;
  view.setBounds(bounds);
  if (!win.getBrowserViews().includes(view)) {
    win.addBrowserView(view);
  }
  // 强制重绘：与 showView 一致，通过 setBounds 再次触发 Chromium 合成器刷新
  if (bounds) {
    setTimeout(() => {
      if (!view.webContents.isDestroyed()) {
        try { view.setBounds(bounds); } catch (_) {}
      }
    }, 100);
  }
  // 同步弹窗 view 的 bounds
  const actualSide = side === "browser-left" ? "left" : "right";
  const popup = popupViews[actualSide];
  if (popup && popup.win === win && bounds) {
    popup.view.setBounds(bounds);
    if (!win.getBrowserViews().includes(popup.view)) {
      win.addBrowserView(popup.view);
    }
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
