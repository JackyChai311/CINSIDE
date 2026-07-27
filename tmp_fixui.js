const fs = require("fs");
const p = "d:/CINSIDE/frontend/src/App.tsx";
let c = fs.readFileSync(p, "utf8");
let lines = c.split("\n");

// Remove the incorrectly inserted UI lines (4465-4483) which are inside the right buttons div
const startRemove = 4464; // 0-based index for line 4465
const endRemove = 4483;   // 0-based index for line 4484
console.log("Removing lines", startRemove + 1, "to", endRemove);
console.log("First line to remove:", lines[startRemove].substring(0, 60));
lines.splice(startRemove, endRemove - startRemove);
fs.writeFileSync(p, lines.join("\n"), "utf8");
console.log("Removed bad UI. Line 4464 now:", lines[4464] ? lines[4464].substring(0, 80) : "N/A");
