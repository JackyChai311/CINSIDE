const fs=require('fs');
const p='d:/CINSIDE/frontend/src/App.tsx';
let c=fs.readFileSync(p,'utf8');
let lines=c.split('\n');
const at=4462+16;
const part2=[
'          {updateStatus==="downloaded"&&updateInfo&&(',
'            <div className="flex items-center gap-2 rounded-lg bg-emerald-50 px-2 py-1 text-[11px] text-emerald-700 border border-emerald-200">',
'              <CheckCircle2 className="h-3.5 w-3.5"/>',
'              <span className="font-semibold">v{updateInfo.version} 已下载</span>',
'              <button onClick={()=>window.electronAPI?.updateQuitAndInstall()} className="rounded bg-emerald-600 px-2 py-0.5 text-white hover:bg-emerald-700 text-[11px] font-medium">立即重启安装</button>',
'            </div>',
'          )}',
'          {updateStatus==="error"&&updateError&&(',
'            <div className="flex items-center gap-1.5 rounded-lg bg-rose-50 px-2 py-1 text-[10px] text-rose-600 border border-rose-200" title={updateError}><AlertCircle className="h-3 w-3"/><span>更新失败</span></div>',
'          )}',
'          {appVersion&&updateStatus==="idle"&&(<span className="text-[10px] text-slate-400">v{appVersion}</span>)}',
'        </div>',
];
lines.splice(at+1,0,...part2);
fs.writeFileSync(p,lines.join('\n'),'utf8');
console.log('Part2 done, lines now:',lines.length);