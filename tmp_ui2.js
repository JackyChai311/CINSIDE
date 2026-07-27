const fs = require("fs");
const p = "d:/CINSIDE/frontend/src/App.tsx";
let c = fs.readFileSync(p, "utf8");
let lines = c.split("\n");

// Find the line we just added (ends with "downloading" status closing)
let insertAfter = -1;
for (let i = 4460; i < lines.length; i++) {
  if (lines[i] && lines[i].includes("updateStatus === \"downloading\"") && lines[i+1] && lines[i+1].includes("</div>")) {
    // Find the closing 3 </div> tags
    let found = 0;
    for (let j = i; j < i + 20; j++) {
      if (lines[j] && lines[j].trim() === "</div>") {
        found++;
        if (found === 3) {
          insertAfter = j;
          break;
        }
      }
    }
    break;
  }
}
console.log("Insert UI part 2 after line", insertAfter + 1);

const ui2 = [
  "        {updateStatus === \"downloaded\" && updateInfo && (",
  "          <div className=\"flex items-center gap-2\" style={{ WebkitAppRegion: \"no-drag\" } as React.CSSProperties}>",
  "            <div className=\"flex items-center gap-2 rounded-lg bg-emerald-50 px-2 py-1 text-[11px] text-emerald-700 border border-emerald-200\">",
  "              <CheckCircle2 className=\"h-3.5 w-3.5\" />",
  "              <span className=\"font-semibold\">v{updateInfo.version} ???</span>",
  "              <button onClick={() => window.electronAPI?.updateQuitAndInstall()} className=\"rounded bg-emerald-600 px-2 py-0.5 text-white hover:bg-emerald-700 transition-colors font-medium\">??????</button>",
  "            </div>",
  "          </div>",
  "        )}",
  "        {updateStatus === \"error\" && updateError && (",
  "          <div className=\"flex items-center gap-1.5\" style={{ WebkitAppRegion: \"no-drag\" } as React.CSSProperties}>",
  "            <div className=\"flex items-center gap-1.5 rounded-lg bg-rose-50 px-2 py-1 text-[10px] text-rose-600 border border-rose-200\" title={updateError}><AlertCircle className=\"h-3 w-3\" /><span>????</span></div>",
  "          </div>",
  "        )}",
  "        {appVersion && updateStatus === \"idle\" && (",
  "          <span className=\"text-[10px] text-slate-400 mr-1\" style={{ WebkitAppRegion: \"no-drag\" } as React.CSSProperties}>v{appVersion}</span>",
  "        )}",
];
lines.splice(insertAfter + 1, 0, ...ui2);
fs.writeFileSync(p, lines.join("\n"));
console.log("UI part 2 added");
