# CINSIDE

信息核验自动化工具。通过浏览器自动化 + AI 视觉识别，批量核验人员信息。

## 下载

最新版安装包：

- **Windows 安装版 / macOS dmg**：[Releases 页面](https://github.com/JackyChai311/CINSIDE/releases/latest)（文件名带版本号，如 `CINSIDE-Setup-0.8.6.exe`）
- **自动更新清单**：[latest.yml](https://github.com/JackyChai311/CINSIDE/releases/latest/download/latest.yml)

> 安装包体积约 250 MB，超过代码托管平台的单文件限制，因此随 tag 由 CI 构建并发布到 Release。
> 已安装的客户端会在启动后自动检查并提示升级（更新源为 GitHub Releases）。

## 发布

打 `v*` tag 推送后，GitHub Actions 会构建 Windows x64 与 macOS arm64/x64 安装包，
并自动创建对应的 GitHub Release：

```bash
git tag v0.8.6
git push origin main --tags
```

对象存储（可选的备用分发通道）发布脚本仍在 `frontend/scripts/publish-oss.py`，
使用前需把 `frontend/package.json` 的 `build.publish` 改为 `generic` provider 并填入真实域名。

## 技术栈

- **前端**：React 18 + TypeScript + Vite + Tailwind CSS
- **桌面**：Electron 31 + electron-builder
- **后端**：Python 3.12 + FastAPI + PyInstaller
- **AI**：视觉模型 OCR / 字段比对

## 项目结构

```
CINSIDE/
├── frontend/           # React + Electron 前端
│   ├── electron/       # Electron 主进程 & preload
│   └── src/            # React 源码
├── backend/            # FastAPI 后端
│   └── app/
│       ├── routers/    # API 路由
│       └── services/   # 业务逻辑（OCR、比对、Excel解析）
├── assets/             # 应用图标
├── demo-pages/         # 演示页面
└── samples/            # 示例数据
```

## 开发

### 环境要求

- Node.js 18+
- Python 3.12+
- Windows 10/11

### 启动开发环境

```bash
# 后端
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python run.py

# 前端
cd frontend
npm install
npm run electron:dev
```

### 构建

```bash
cd frontend
npm run electron:build          # 生成 NSIS 安装包 + 便携版
npm run electron:build:portable # 仅便携版
```

构建产物输出到 `dist-electron/`。

### 发布新版本

1. 改版本号（`frontend/package.json` 的 `version`），然后构建：

```bash
cd frontend
npm run electron:build
```

2. 配置对象存储凭据（只对当前终端窗口生效，不要写进仓库）：

```powershell
$env:OSS_ACCESS_KEY_ID='你的AccessKeyId'
$env:OSS_ACCESS_KEY_SECRET='你的AccessKeySecret'
$env:OSS_ENDPOINT='https://oss-cn-hangzhou.aliyuncs.com'
$env:OSS_BUCKET='你的bucket名'
```

3. 先预演看要传哪些文件，确认无误后正式上传：

```bash
npm run publish:oss:dry   # 只列出，不上传
npm run publish:oss       # 上传安装包 + blockmap + latest.yml
```

上传脚本会自动按 `latest.yml` 声明的文件名重命名后上传，客户端据此完成自动更新。

4. 确认 `frontend/package.json` 里 `build.publish[0].url` 与实际上传地址一致。

发布脚本依赖 `oss2`：`pip install oss2`。

## 核心功能

- **Excel 批量导入**：从 Excel 框选数据范围，生成人物卡片
- **浏览器自动化**：自动搜索、定位、提取网页信息
- **AI 视觉核验**：OCR 提取 + 字段比对，生成验证报告
- **SKILL 模板系统**：保存配置模板，拖拽应用到不同学校
- **验证报告**：字段对比、文档对比、AI 视野三卡片并排展示
- **自动更新**：内置 electron-updater，支持版本检测和一键升级

## License

Private
