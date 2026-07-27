const fs = require("fs");
const p = "d:/CINSIDE/frontend/src/electron.d.ts";
let c = fs.readFileSync(p, "utf8");

const newTypes = `/** ???? */
export interface UpdateInfo {
  version: string;
  releaseDate?: string;
  releaseNotes?: string;
}

/** ?????? */
export interface UpdateDownloadProgress {
  bytesPerSecond: number;
  percent: number;
  transferred: number;
  total: number;
}

`;

// Insert after HighlightBox interface
c = c.replace(
  "export interface HighlightBox {\n  selector: string;\n  status: \"match\" | \"mismatch\" | \"missing\" | \"partial\" | \"pending\" | \"unknown\";\n  label?: string;\n}\n",
  "export interface HighlightBox {\n  selector: string;\n  status: \"match\" | \"mismatch\" | \"missing\" | \"partial\" | \"pending\" | \"unknown\";\n  label?: string;\n}\n\n" + newTypes
);

// Add updater APIs after openExternal
const oldOpenExt = "  openExternal: (url: string) => void;\n\n  // === ??????? ===";
const newOpenExt = `  openExternal: (url: string) => void;

  // === ???? ===
  updateCheckNow: () => Promise<{ ok: boolean; message?: string; result?: unknown }>;
  updateDownloadUpdate: () => Promise<{ ok: boolean; message?: string }>;
  updateQuitAndInstall: () => Promise<{ ok: boolean }>;
  onUpdateAvailable: (callback: (info: UpdateInfo) => void) => () => void;
  onUpdateNotAvailable: (callback: (info: UpdateInfo) => void) => () => void;
  onUpdateDownloadProgress: (callback: (progress: UpdateDownloadProgress) => void) => () => void;
  onUpdateDownloaded: (callback: (info: UpdateInfo) => void) => () => void;
  onUpdateError: (callback: (error: { message: string }) => void) => () => void;
  getAppVersion: () => Promise<string>;

  // === ??????? ===`;

c = c.replace(oldOpenExt, newOpenExt);

fs.writeFileSync(p, c);
console.log("electron.d.ts updated");
