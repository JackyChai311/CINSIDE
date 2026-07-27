const fs = require("fs");
const p = "d:/CINSIDE/frontend/src/App.tsx";
let c = fs.readFileSync(p, "utf8");
let lines = c.split("\n");

// Insert after line 509 (startBatchAfterTeaching) which is index 508
const insertAt = 509; // after line 509 (0-based index 509)
const updaterStates = [
  "  // === ?????? ===",
  "  const [updateStatus, setUpdateStatus] = useState<\"idle\" | \"checking\" | \"available\" | \"downloading\" | \"downloaded\" | \"error\">(\"idle\");",
  "  const [updateInfo, setUpdateInfo] = useState<{ version: string } | null>(null);",
  "  const [updateProgress, setUpdateProgress] = useState(0);",
  "  const [updateError, setUpdateError] = useState<string | null>(null);",
  "  const [appVersion, setAppVersion] = useState(\"\");",
  ""
];

// Verify the insertion point
console.log("Insert after line", insertAt + 1, ":", lines[insertAt]);
console.log("Next line:", lines[insertAt + 1]);

lines.splice(insertAt + 1, 0, ...updaterStates);
fs.writeFileSync(p, lines.join("\n"));
console.log("States added");
