const fs=require("fs");
const p="d:/CINSIDE/frontend/src/App.tsx";
let c=fs.readFileSync(p,"utf8");
const bt=String.fromCharCode(96);
c=c.replace("style={{width:${updateProgress}%}}", "style={{ width: "+bt+"${updateProgress}%"+bt+" }}");
fs.writeFileSync(p,c,"utf8");
console.log("Fixed with charcode");