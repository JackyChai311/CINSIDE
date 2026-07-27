const fs = require('fs');
const p = 'd:/CINSIDE/frontend/electron/main.cjs';
let c = fs.readFileSync(p, 'utf8');
c = c.replace(
  'const { spawn } = require(\"child_process\");\n\n// 统一日志文件',
  'const { spawn } = require(\"child_process\");\nconst { autoUpdater } = require(\"electron-updater\");\n\n// 统一日志文件'
);
fs.writeFileSync(p, c);
console.log('Contains autoUpdater:', c.includes('autoUpdater'));
