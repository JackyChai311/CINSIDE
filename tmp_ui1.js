const fs = require("fs");
const p = "d:/CINSIDE/frontend/src/App.tsx";
let c = fs.readFileSync(p, "utf8");
let lines = c.split("\n");
const insertAt = 4463;
console.log("Insert after", insertAt + 1, ":", lines[insertAt]);
const ui1 = [
  "        {/* === ?????? === */}",
  "        {updateStatus === \"available\" && updateInfo && (",
  "          <div className=\"flex items-center gap-2\" style={{ WebkitAppRegion: \"no-drag\" } as React.CSSProperties}>",
  "            <div className=\"flex items-center gap-2 rounded-lg bg-indigo-50 px-2 py-1 text-[11px] text-indigo-700 border border-indigo-200\">",
  "              <span className=\"font-semibold\">????? v{updateInfo.version}</span>",
  "              <button onClick={() => { window.electronAPI?.updateDownloadUpdate(); setUpdateStatus(\"downloading\"); setUpdateProgress(0); }} className=\"rounded bg-indigo-600 px-2 py-0.5 text-white hover:bg-indigo-700 transition-colors font-medium\">????</button>",
  "            </div>",
  "          </div>",
  "        )}",
  "        {updateStatus === \"downloading\" && (",
  "          <div className=\"flex items-center gap-2\" style={{ WebkitAppRegion: \"no-drag\" } as React.CSSProperties}>",
  "            <div className=\"flex items-center gap-2 rounded-lg bg-violet-50 px-2 py-1 text-[11px] text-violet-700 border border-violet-200 min-w-[180px]\">",
  "              <Loader2 className=\"h-3 w-3 animate-spin\" />",
  "              <span className=\"font-medium\">???</span>",
  "              <div className=\"flex-1 h-1.5 bg-violet-200 rounded-full overflow-hidden\"><div className=\"h-full bg-violet-600 transition-all duration-300 rounded-full\" style={{ width: `${updateProgress}%` }} /></div>",
  "              <span className=\"text-violet-600 font-mono text-[10px]\">{updateProgress}%</span>",
  "            </div>",
  "          </div>",
  "        )}",
];
lines.splice(insertAt + 1, 0, ...ui1);
fs.writeFileSync(p, lines.join("\n"));
console.log("UI part 1 added");
