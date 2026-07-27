const fs=require("fs");
const p="d:/CINSIDE/frontend/src/electron.d.ts";
let c=fs.readFileSync(p,"utf8");
const insertAfter = "  openExternal: (url: string) => void;";
const updaterApi = `
  // === 自动更新 ===
  getAppVersion: () => Promise<string>;
  updateCheckNow: () => Promise<{ ok: boolean; message?: string }>;
  updateDownloadUpdate: () => Promise<{ ok: boolean; message?: string }>;
  updateQuitAndInstall: () => Promise<{ ok: boolean }>;
  onUpdateAvailable: (callback: (info: UpdateInfo) => void) => () => void;
  onUpdateNotAvailable: (callback: (info: UpdateInfo) => void) => () => void;
  onUpdateDownloadProgress: (callback: (progress: UpdateDownloadProgress) => void) => () => void;
  onUpdateDownloaded: (callback: (info: UpdateInfo) => void) => () => void;
  onUpdateError: (callback: (error: { message: string }) => void) => () => void;
`;
c = c.replace(insertAfter, insertAfter + "\n" + updaterApi);
fs.writeFileSync(p,c,"utf8");
console.log("Added updater API types");