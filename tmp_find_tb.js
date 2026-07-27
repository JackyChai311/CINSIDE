const fs = require("fs");
const p = "d:/CINSIDE/frontend/src/App.tsx";
let c = fs.readFileSync(p, "utf8");
let lines = c.split("\n");

// Find WebkitAppRegion
for (let i = 4400; i < lines.length; i++) {
  if (lines[i] && lines[i].includes("WebkitAppRegion")) {
    console.log("Found titlebar region at line", i + 1);
    for (let j = Math.max(0, i - 20); j < Math.min(i + 60, lines.length); j++) {
      console.log(j + 1, lines[j]);
    }
    break;
  }
}
