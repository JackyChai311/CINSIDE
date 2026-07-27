const fs = require('fs');
const path = require('path');

let content = fs.readFileSync(path.join(__dirname, 'electron/main.cjs'), 'utf8');

// 1. 添加 autoUpdater 导入
content = content.replace(
  'const { spawn } = require("child_process");',
  'const { spawn } = require("child_process");\nconst { autoUpdater } = require("electron-updater");'
);

// 2. 在 app.whenReady() 中添加自动更新初始化
const whenReadyOld = `app.whenReady().then(() => {
  createSplashWindow();
  startBackend();
  createWindow();
  createBrowserViews();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});`;

const whenReadyNew = `app.whenReady().then(() => {
  createSplashWindow();
  startBackend();
  createWindow();
  createBrowserViews();

  // === 自动更新初始化（仅打包后启用） ===
  if (!isDev) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("update-available", (info) => {
      debugLog(\`[updater] update available: \${info.version}\`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("update-available", info);
      }
    });
    autoUpdater.on("update-not-available", (info) => {
      debugLog(\`[updater] update not available\`);
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
      debugLog(\`[updater] update downloaded: \${info.version}\`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("update-downloaded", info);
      }
    });
    autoUpdater.on("error", (err) => {
      debugLog(\`[updater] error: \${err.message}\`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("update-error", { message: err.message });
      }
    });

    // 启动3秒后检查更新
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((e) => {
        debugLog(\`[updater] check failed: \${e.message}\`);
      });
    }, 3000);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});`;

content = content.replace(whenReadyOld, whenReadyNew);

// 3. 在 IPC 部分添加更新相关的 handlers（在 backend-status 之后）
const ipcOld = `// ============ IPC ============

// 前端询问后端是否就绪
ipcMain.handle("backend-status", () => backendReady);`;

const ipcNew = `// ============ IPC ============

// === 自动更新 IPC ===
ipcMain.handle("get-app-version", () => app.getVersion());
ipcMain.handle("update-check-now", async () => {
  if (isDev) return { ok: false, message: "开发模式不检查更新" };
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
ipcMain.handle("backend-status", () => backendReady);`;

content = content.replace(ipcOld, ipcNew);

fs.writeFileSync(path.join(__dirname, 'electron/main.cjs'), content, 'utf8');
console.log('main.cjs patched successfully!');
