# CINSIDE

信息核验自动化工具。通过浏览器自动化 + AI 视觉识别，批量核验人员信息。

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

## 核心功能

- **Excel 批量导入**：从 Excel 框选数据范围，生成人物卡片
- **浏览器自动化**：自动搜索、定位、提取网页信息
- **AI 视觉核验**：OCR 提取 + 字段比对，生成验证报告
- **SKILL 模板系统**：保存配置模板，拖拽应用到不同学校
- **验证报告**：字段对比、文档对比、AI 视野三卡片并排展示
- **自动更新**：内置 electron-updater，支持版本检测和一键升级

## License

Private
