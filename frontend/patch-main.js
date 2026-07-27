const fs = require('fs');
const path = require('path');

const mainPath = path.join(__dirname, 'electron', 'main.cjs');
let content = fs.readFileSync(mainPath, 'utf8');

// Step 1: Add autoUpdater import after child_process
content = content.replace(
  'const { spawn } = require("child_process");',
  'const { spawn } = require("child_process");\nconst { autoUpdater } = require("electron-updater");'
);

// Step 2: Add auto-updater initialization in app.whenReady()
const oldWhenReady = `app.whenReady().then(() => {
  createSplashWindow();
  startBackend();
  createWindow();
  createBrowserViews();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});`;

const newWhenReady = `app.whenReady().then(() => {
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

if (content.includes(oldWhenReady)) {
  content = content.replace(oldWhenReady, newWhenReady);
  console.log('Step 2: app.whenReady() patched');
} else {
  console.log('Step 2: WARNING - oldWhenReady pattern not found, trying line-based approach');
}

// Step 3: Add IPC handlers after "// ============ IPC ============"
const oldIpcStart = `// ============ IPC ============

// 前端询问后端是否就绪
ipcMain.handle("backend-status", () => backendReady);`;

const newIpcStart = `// ============ IPC ============

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

if (content.includes(oldIpcStart)) {
  content = content.replace(oldIpcStart, newIpcStart);
  console.log('Step 3: IPC handlers patched');
} else {
  console.log('Step 3: WARNING - oldIpcStart pattern not found');
}

fs.writeFileSync(mainPath, content, 'utf8');
console.log('main.cjs patched successfully!');
