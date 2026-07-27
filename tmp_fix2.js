const fs = require("fs");
const p = "d:/CINSIDE/frontend/src/App.tsx";
let c = fs.readFileSync(p, "utf8");
let lines = c.split("\n");

// Find where imports end (first import block ends at first non-import line)
let lastBadLine = -1;
for (let i = 0; i < 50; i++) {
  if (lines[i] && (lines[i].includes("updateStatus") || lines[i].includes("updateDownloadProgress") || lines[i].includes("updateQuitAndInstall") || lines[i].includes("???") || lines[i].includes("????") || lines[i].includes("v{appVersion}"))) {
    lastBadLine = i;
  }
}
console.log("Last bad line at", lastBadLine + 1);
// Find where imports start again
let importStart = -1;
for (let i = 0; i < 50; i++) {
  if (lines[i] && lines[i].startsWith("import ")) {
    importStart = i;
    break;
  }
}
console.log("Import starts at", importStart + 1);
// Remove bad lines: everything before importStart
if (importStart > 0) {
  lines = lines.slice(importStart);
  fs.writeFileSync(p, lines.join("\n"));
  console.log("Removed bad lines. First line now:", lines[0].substring(0, 80));
} else {
  console.log("No fix needed");
}
