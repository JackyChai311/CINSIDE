const fs=require("fs");
const p="d:/CINSIDE/frontend/src/App.tsx";
let c=fs.readFileSync(p,"utf8");
c=c.replace("  AlertCircle,\n  AlertCircle,", "  AlertCircle,");
fs.writeFileSync(p,c,"utf8");
console.log("Removed duplicate AlertCircle");