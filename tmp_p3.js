const fs = require("fs");
const p = "d:/CINSIDE/frontend/electron/main.cjs";
let lines = fs.readFileSync(p, "utf8").split("\n");
const insertAt = 1086;
const newLines = [
  "// === ???? IPC ===",
  "ipcMain.handle(\"get-app-version\", () => app.getVersion());",
  "ipcMain.handle(\"update-check-now\", async () => {",
  "  if (isDev) return { ok: false, message: \"?????????\" };",
  "  try {",
  "    const result = await autoUpdater.checkForUpdates();",
  "    return { ok: true, result };",
  "  } catch (e) {",
  "    return { ok: false, message: e.message };",
  "  }",
  "});",
  "ipcMain.handle(\"update-download\", async () => {",
  "  if (isDev) return { ok: false };",
  "  try {",
  "    await autoUpdater.downloadUpdate();",
  "    return { ok: true };",
  "  } catch (e) {",
  "    return { ok: false, message: e.message };",
  "  }",
  "});",
  "ipcMain.handle(\"update-quit-install\", () => {",
  "  if (!isDev) {",
  "    autoUpdater.quitAndInstall(false, true);",
  "  }",
  "  return { ok: true };",
  "});",
  "",
];
lines.splice(insertAt, 0, ...newLines);
fs.writeFileSync(p, lines.join("\n"));
console.log("Step 3 done");
