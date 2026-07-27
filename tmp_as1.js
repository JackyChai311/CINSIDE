const fs = require("fs");
const p = "d:/CINSIDE/frontend/src/App.tsx";
let c = fs.readFileSync(p, "utf8");
let lines = c.split("\n");

// Find App function start
let appFuncLine = -1;
for (let i = 0; i < 1000; i++) {
  if (lines[i] && lines[i].includes("export default function App()")) {
    appFuncLine = i;
    break;
  }
}
console.log("App at", appFuncLine + 1);

// Find line to insert states: look for logEndRef which is near the end of state declarations
let insertAfter = -1;
for (let i = appFuncLine; i < appFuncLine + 200; i++) {
  if (lines[i] && lines[i].includes("const logEndRef")) {
    insertAfter = i;
    break;
  }
}
if (insertAfter < 0) {
  // fallback: find selected = records.find
  for (let i = appFuncLine; i < appFuncLine + 300; i++) {
    if (lines[i] && lines[i].includes("const selected = records.find")) {
      insertAfter = i - 1;
      break;
    }
  }
}
console.log("Insert states after line", insertAfter + 1);
console.log("Line content:", lines[insertAfter]);

const updaterStates = [
  "  // === ?????? ===",
  "  const [updateStatus, setUpdateStatus] = useState<\"idle\" | \"checking\" | \"available\" | \"downloading\" | \"downloaded\" | \"error\">(\"idle\");",
  "  const [updateInfo, setUpdateInfo] = useState<{ version: string } | null>(null);",
  "  const [updateProgress, setUpdateProgress] = useState(0);",
  "  const [updateError, setUpdateError] = useState<string | null>(null);",
  "  const [appVersion, setAppVersion] = useState(\"\");",
  ""
];

lines.splice(insertAfter + 1, 0, ...updaterStates);
fs.writeFileSync(p, lines.join("\n"));
console.log("States added");
