/**
 * 开发前自清理（preelectron:dev 钩子）：杀掉上一次 dev 会话的残留进程。
 *
 * 背景：Windows 上 npm 的 cmd shim 在终端被强杀/任务被停止时不会带走子进程，
 * 每跑一次 electron:dev 就留下 npm/concurrently/vite/wait-on 四五个 node 残留，
 * 几天能攒几百个、吃光内存（2026-08-17 实测 243 个 node 占 2.7GB，系统只剩 0.9GB），
 * 且旧 vite 会一直占着 5173——新会话的 wait-on 命中旧服务，Electron 加载的是
 * 几天前的旧前端代码（新改动全部不生效）。
 *
 * 清理目标（按命令行精确匹配，排除自身祖先链与 trae 相关进程，不误伤）：
 *  1. 命令行含本项目路径或 npm-cli/concurrently/vite/wait-on 的 node 进程
 *  2. 正在监听 5173 的进程（旧 vite）
 *  3. electron.exe（上一个 dev 会话的 Electron；已安装的正式版叫 CINSIDE.exe，不受影响）
 *  4. 命令行含 npm 的 cmd 包装壳
 */
const { execSync } = require("child_process");

const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$own = ${process.pid}
$skip = @{}
$p = Get-CimInstance Win32_Process -Filter "ProcessId=$own"
while ($p) { $skip[[int]$p.ProcessId] = $true; $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $p.ParentProcessId) }
$pat = 'CINSIDE|npm-cli\\.js|concurrently|vite\\.js|wait-on'
$n = 0
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match $pat -and $_.CommandLine -notmatch 'trae' -and -not $skip.ContainsKey([int]$_.ProcessId) } | ForEach-Object { Stop-Process -Id ([int]$_.ProcessId) -Force; $n++ }
Get-NetTCPConnection -LocalPort 5173 -State Listen | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }
Get-Process electron | Stop-Process -Force
$c = 0
Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -match 'npm' -and $_.CommandLine -notmatch 'trae' -and -not $skip.ContainsKey([int]$_.ProcessId) } | ForEach-Object { Stop-Process -Id ([int]$_.ProcessId) -Force; $c++ }
Write-Output ("node=" + $n + " cmd=" + $c)
`;

try {
  const enc = Buffer.from(ps, "utf16le").toString("base64");
  const out = execSync(`powershell -NoProfile -EncodedCommand ${enc}`, { stdio: "pipe" }).toString().trim();
  console.log(`[dev-clean] 上次会话残留已清理: ${out}`);
} catch {
  // 清理失败不阻塞启动（最坏情况只是延续旧问题）
  console.log("[dev-clean] 清理异常（忽略，继续启动）");
}
