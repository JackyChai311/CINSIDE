const fs = require("fs");
const p = "d:/CINSIDE/frontend/src/App.tsx";
let c = fs.readFileSync(p, "utf8");
let lines = c.split("\n");

// Remove incorrectly inserted lines at the beginning (first 7 lines)
const badPrefix = "  // === ";
if (lines[0] && lines[0].includes("??????")) {
  console.log("Removing bad prefix, first line:", JSON.stringify(lines[0]));
  lines = lines.slice(7);
  fs.writeFileSync(p, lines.join("\n"));
  console.log("Fixed. First line now:", lines[0]);
} else {
  console.log("File looks OK, first line:", lines[0]);
}
