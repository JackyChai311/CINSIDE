const fs = require("fs");
const p = "d:/CINSIDE/frontend/src/App.tsx";
let c = fs.readFileSync(p, "utf8");
let lines = c.split("\n");

// Insert after line 651 (index 650, the "}, [selectMode]);" line)
const insertAt = 651;
console.log("Insert after line", insertAt + 1, ":", lines[insertAt]);

const updaterUseEffect = [
  "",
  "  // === ???????? ===",
  "  useEffect(() => {",
  "    if (!window.electronAPI) return;",
  "    window.electronAPI.getAppVersion().then(v => setAppVersion(v)).catch(() => {});",
  "    const offAvailable = window.electronAPI.onUpdateAvailable((info) => {",
  "      setUpdateInfo({ version: info.version });",
  "      setUpdateStatus(\"available\");",
  "      setUpdateError(null);",
  "    });",
  "    const offNotAvailable = window.electronAPI.onUpdateNotAvailable(() => {",
  "      setUpdateStatus(\"idle\");",
  "    });",
  "    const offProgress = window.electronAPI.onUpdateDownloadProgress((progress) => {",
  "      setUpdateStatus(\"downloading\");",
  "      setUpdateProgress(Math.round(progress.percent || 0));",
  "    });",
  "    const offDownloaded = window.electronAPI.onUpdateDownloaded((info) => {",
  "      setUpdateInfo({ version: info.version });",
  "      setUpdateStatus(\"downloaded\");",
  "      setUpdateProgress(100);",
  "    });",
  "    const offError = window.electronAPI.onUpdateError((err) => {",
  "      setUpdateError(err.message);",
  "      setUpdateStatus(\"error\");",
  "    });",
  "    return () => {",
  "      offAvailable?.();",
  "      offNotAvailable?.();",
  "      offProgress?.();",
  "      offDownloaded?.();",
  "      offError?.();",
  "    };",
  "  }, []);",
  ""
];

lines.splice(insertAt + 1, 0, ...updaterUseEffect);
fs.writeFileSync(p, lines.join("\n"));
console.log("Updater useEffect added, lines:", updaterUseEffect.length);
