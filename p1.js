const fs=require('fs');
const p='d:/CINSIDE/frontend/src/App.tsx';
let c=fs.readFileSync(p,'utf8');
let lines=c.split('\n');
const at=4462;
const part1=[
'        {/* UPDATER */}',
'        <div className="flex items-center gap-2" style={{WebkitAppRegion:"no-drag"}as React.CSSProperties}>',
'          {updateStatus==="available"&&updateInfo&&(',
'            <div className="flex items-center gap-2 rounded-lg bg-indigo-50 px-2 py-1 text-[11px] text-indigo-700 border border-indigo-200">',
'              <span className="font-semibold">发现新版本 v{updateInfo.version}</span>',
'              <button onClick={()=>{window.electronAPI?.updateDownloadUpdate();setUpdateStatus("downloading");setUpdateProgress(0);}} className="rounded bg-indigo-600 px-2 py-0.5 text-white hover:bg-indigo-700 text-[11px] font-medium">立即下载</button>',
'            </div>',
'          )}',
'          {updateStatus==="downloading"&&(',
'            <div className="flex items-center gap-2 rounded-lg bg-violet-50 px-2 py-1 text-[11px] text-violet-700 border border-violet-200 min-w-[160px]">',
'              <Loader2 className="h-3 w-3 animate-spin"/>',
'              <span className="font-medium">下载中</span>',
'              <div className="flex-1 h-1.5 bg-violet-200 rounded-full overflow-hidden"><div className="h-full bg-violet-600 transition-all" style={{width:${updateProgress}%}}/></div>',
'              <span className="text-violet-600 font-mono text-[10px]">{updateProgress}%</span>',
'            </div>',
'          )}',
];
lines.splice(at+1,0,...part1);
fs.writeFileSync(p,lines.join('\n'),'utf8');
console.log('Part1 done');