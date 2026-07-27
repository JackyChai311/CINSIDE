const fs = require("fs");
const p = "d:/CINSIDE/frontend/src/App.tsx";
let c = fs.readFileSync(p, "utf8");
let lines = c.split("\n");
const appFuncLine = 385; // 0-based
console.log("App function at", appFuncLine + 1);
// Check lines around where states end
for (let i = appFuncLine; i < appFuncLine + 300; i++) {
  if (lines[i] && (lines[i].includes("logEndRef") || lines[i].includes("const selected = records.find") || lines[i].includes("useCallback") || lines[i].includes("useEffect"))) {
    console.log(i + 1, JSON.stringify(lines[i].substring(0, 100)));
  }
}
