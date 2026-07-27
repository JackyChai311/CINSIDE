const fs = require("fs");
const p = "d:/CINSIDE/frontend/src/App.tsx";
let c = fs.readFileSync(p, "utf8");
let lines = c.split("\n");

// Find App function
let appFuncLine = -1;
for (let i = 0; i < 500; i++) {
  if (lines[i] && lines[i].includes("export default function App()")) {
    appFuncLine = i;
    break;
  }
}
console.log("App function at line", appFuncLine + 1);

// Find logEndRef
let logEndRefLine = -1;
for (let i = appFuncLine; i < appFuncLine + 200; i++) {
  if (lines[i] && lines[i].includes("const logEndRef")) {
    logEndRefLine = i;
    break;
  }
}
console.log("logEndRef at line", logEndRefLine + 1, "content:", lines[logEndRefLine]);

// Print surrounding lines
for (let i = logEndRefLine - 2; i <= logEndRefLine + 5; i++) {
  console.log(i + 1, JSON.stringify(lines[i]));
}
