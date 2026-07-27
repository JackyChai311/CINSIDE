const fs = require("fs");
const p = "d:/CINSIDE/frontend/src/App.tsx";
let c = fs.readFileSync(p, "utf8");
let lines = c.split("\n");

// Find the correct insertion point: after line 4463 (0-based 4462), which is </div> closing left logo
// Before line 4464 (0-based 4463), which is <div className="flex items-center gap-1"... (right buttons)
let insertAt = -1;
for (let i = 4455; i < 4475; i++) {
  if (lines[i] && lines[i].includes('<div className="flex items-center gap-1"') && lines[i].includes("WebkitAppRegion")) {
    insertAt = i - 1; // Insert before this line, after previous </div>
    break;
  }
}

if (insertAt < 0) {
  console.log("ERROR: Could not find insertion point");
  process.exit(1);
}

console.log("Inserting UI after line", insertAt + 1, ":", lines[insertAt].trim().substring(0, 60));
console.log("Before line", insertAt + 2, ":", lines[insertAt + 1].trim().substring(0, 60));

const updaterUI = [
  "        {/* === 自动更新提示 === */}",
  "        <div className=\"flex items-center gap-2\" style={{ WebkitAppRegion: \"no-drag\" } as React.CSSProperties}>",
  "          {updateStatus === \"available\" && updateInfo && (",
  "            <div className=\"flex items-center gap-2 rounded-lg bg-indigo-50 px-2 py-1 text-[11px] text-indigo-700 border border-indigo-200\">",
  "              <span className=\"font-semibold\">发现新版本 v{updateInfo.version}</span>",
  "              <button",
  "                onClick={() => { window.electronAPI?.updateDownloadUpdate(); setUpdateStatus(\"downloading\"); setUpdateProgress(0); }}",
  "                className=\"rounded bg-indigo-600 px-2 py-0.5 text-white hover:bg-indigo-700 transition-colors font-medium\"",
  "              >",
  "                立即下载",
  "              </button>",
  "            </div>",
  "          )}",
  "          {updateStatus === \"downloading\" && (",
  "            <div className=\"flex items-center gap-2 rounded-lg bg-violet-50 px-2 py-1 text-[11px] text-violet-700 border border-violet-200 min-w-[180px]\">",
  "              <Loader2 className=\"h-3 w-3 animate-spin\" />",
  "              <span className=\"font-medium\">正在下载更新...</span>",
  "              <div className=\"flex-1 h-1.5 bg-violet-200 rounded-full overflow-hidden\">",
  "                <div className=\"h-full bg-violet-600 transition-all duration-300 rounded-full\" style={{ width: `${updateProgress}%` }} />",
  "              </div>",
  "              <span className=\"text-violet-600 font-mono text-[10px]\">{updateProgress}%</span>",
  "            </div>",
  "          )}",
  "          {updateStatus === \"downloaded\" && updateInfo && (",
  "            <div className=\"flex items-center gap-2 rounded-lg bg-emerald-50 px-2 py-1 text-[11px] text-emerald-700 border border-emerald-200\">",
  "              <CheckCircle2 className=\"h-3.5 w-3.5\" />",
  "              <span className=\"font-semibold\">v{updateInfo.version} 已下载</span>",
  "              <button",
  "                onClick={() => window.electronAPI?.updateQuitAndInstall()}",
  "                className=\"rounded bg-emerald-600 px-2 py-0.5 text-white hover:bg-emerald-700 transition-colors font-medium\"",
  "              >",
  "                立即重启安装",
  "              </button>",
  "            </div>",
  "          )}",
  "          {updateStatus === \"error\" && updateError && (",
  "            <div className=\"flex items-center gap-1.5 rounded-lg bg-rose-50 px-2 py-1 text-[10px] text-rose-600 border border-rose-200\" title={updateError}>",
  "              <AlertCircle className=\"h-3 w-3\" />",
  "              <span>更新失败</span>",
  "            </div>",
  "          )}",
  "          {appVersion && updateStatus === \"idle\" && (",
  "            <span className=\"text-[10px] text-slate-400\">v{appVersion}</span>",
  "          )}",
  "        </div>",
];

lines.splice(insertAt + 1, 0, ...updaterUI);
fs.writeFileSync(p, lines.join("\n"), "utf8");
console.log("Updater UI added successfully! Lines inserted:", updaterUI.length);
