const fs = require("fs");
const p = "d:/CINSIDE/frontend/src/App.tsx";
let c = fs.readFileSync(p, "utf8");
let lines = c.split("\n");
let insertAt = -1;
for (let i = 4455; i < 4475; i++) {
  if (lines[i] && lines[i].includes("flex items-center gap-1") && lines[i].includes("WebkitAppRegion")) {
    insertAt = i - 1;
    break;
  }
}
if (insertAt < 0) { console.log("ERROR"); process.exit(1); }
console.log("Insert after line", insertAt + 1);