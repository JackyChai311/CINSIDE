# CINSIDE 代码质量整改日志

> 本文件记录一轮以「不破坏现有功能」为硬约束的质量整改全过程，供交接与后续复盘使用。
> 后续「去臃肿」阶段的改动请追加到本文件末尾，不要另开新文件。

## 0. 状态速览

| 项 | 值 |
|---|---|
| 工作分支 | `chore/quality-guardrails`（`main` 未动） |
| 整改前基线 | `8d6733a0a562ea35c4dc0e707a0f186f1616ebf9` |
| 提交数 | 14 |
| 改动规模 | 47 文件，+5859 / −345（新增 16，修改 31） |
| 前端测试 | vitest **190 passed** / 4 文件（整改前 **0**） |
| 后端测试 | pytest **230 passed** / 9 文件（整改前 **0**，且原脚本会产生 2 个收集错误） |
| 前端 lint | ESLint **0 error / 495 warning**（整改前无 linter） |
| 后端 lint | ruff **All checks passed**（整改前无 linter） |
| 类型检查 | `tsc --noEmit` exit 0 |
| 生产构建 | exit 0，产物 `dist/assets/index-DbxzguAh.js` 1,397.08 kB（gzip 388.78 kB） |
| 仓库顶层体积 | 约 19.6 GB → **7.04 GB** |
| 已跟踪文件数 | 166（`.git` 仅 12.4 MB，仓库本身不臃肿） |

### 一条重要的验证线索

前 12 个提交（清理/重构/测试/lint/Electron 修复）期间，生产产物哈希**始终是 `index-JH7MhUmv.js`**，与整改前逐字节相同 —— 这是「零功能影响」最强的证据。

第 13 个提交（接口鉴权 `2908218`）哈希才变为 `index-DbxzguAh.js`，**这是预期且正确的**：该提交确实改变了运行时行为（给请求加鉴权头），而非重构。

## 1. 整改前的关键事实核查

动手前先用 git 核实了两件事，结果与最初的怀疑相反，必须记录以免后人重复踩坑：

| 最初的怀疑 | 实测结果 |
|---|---|
| `backend/.env` 可能曾入库 → 需轮换密钥 | **从未提交**。`git log --all -- backend/.env` 为空，`git ls-files --error-unmatch` 报 unknown。`.env.example` 正常跟踪。**不是安全事件，无需轮换** |
| `.bak` / 临时文件可能已入库 → 需 `git rm --cached` | **全部未跟踪且被 `.gitignore` 覆盖**。`git ls-files` 过滤 `\.bak-\|_tmp_\|asar_temp\|_repack\|frametol\|artifact\.json` 结果为空 → 纯本地磁盘问题，无需 git 手术 |

另一个坑：用 ripgrep 搜 `.git/index` 判断文件是否被跟踪**不可靠** —— ripgrep 会跳过二进制文件并报 "no files matched"，与"确实不存在"无法区分。我第一次就因此得出了错误结论（用已知存在的路径做对照才发现）。判断跟踪状态请一律用 `git ls-files`。

## 2. 改动逐项记录

### 2.1 工作区清理（`ec694cf`、`57948cc`）

**问题**：顶层堆着大量未跟踪垃圾 —— 20 个 `.bak-*`（含 6 份 `App.tsx` 整份拷贝）、12 份历史构建副本、10 个 `diag*.cjs`、101 张会话截图、发布流程临时文件、`.cred_in_tmp` 等。

**改动**：
- 删除未跟踪垃圾约 1.55 GB（含 `release-assets-*` 约 1.5 GB、`_ex/`、`_tmp_wave/`、`asar_temp/`、`.repack_tmp/`、20 个 `.bak-*`）
- 删除 12 份 `dist-electron-*` 历史构建副本，释放 **6.86 GB**（0.5.4~0.7.3；当前 0.8.6，正式产物目录 `dist-electron` 保留）
- 补齐 `.gitignore`：`_ex/`、`_tmp_wave/`、`_repack/`、`*.artifact.json`、顶层 `/*.jpg` `/*.png`

**未动**（刻意保留）：`start-backend.bat`、`start-electron.bat`、`start-frontend.bat`、`start-electron-hidden.vbs` —— 这些是**已跟踪**的启动脚本，删了会破坏启动流程。这是"删垃圾"时最容易误伤的地方。

**安全校验**：删除前逐项用 `git ls-files --error-unmatch` 确认未跟踪；用 `[System.IO.Path]::GetFullPath` 校验绝对路径在仓库内，并拒绝任何非 `dist-electron-<版本>` 命名的目录。

### 2.2 前端 lint（`49bd06a`）

**改动**：新增 `frontend/eslint.config.mjs`（ESLint 9 扁平配置）、`.prettierrc.json`、`lint`/`lint:fix`/`format`/`format:check` 脚本。

规则策略：存量债（`no-unused-vars`、`no-explicit-any`、`exhaustive-deps`）先设 **warn**；真正的正确性规则 `rules-of-hooks` 保持 **error**。`.cjs` 文件关闭 `no-require-imports`（CommonJS 里 `require` 是正确写法）。

**顺带修掉的 7 个真实 error**：

| 位置 | 问题 |
|---|---|
| `ElementSelectBar.tsx:481,497` | `if (!active) return null;` 位于两个 `useEffect` **之前** → `active` 由 false 变 true 时 hook 数量变化，会触发 React 崩溃。已把早退移到所有 hook 之后 |
| `AIStudio.tsx:139,146,381` | 三元表达式当语句用（`no-unused-expressions`），改为 if/else，语义等价 |
| `formatNormalize.ts:28` | 正则里的 U+3000 全角空格是**该函数的匹配目标**，保留字符、精确放行规则 |
| `main.cjs:2810` | `isDetach \|\| true` 恒为真 → 上方窗口探测逻辑整段是死代码。**疑似调试遗留**，只放行并加注释标注，未改行为 |

**注意**：`ElementSelectBar.tsx`（1,562 行）经核实是**死代码** —— `App.tsx` 只 `import type` 了它的类型，组件本身无任何渲染方。上述 rules-of-hooks 修复发生在死代码中，所以零运行时风险。

### 2.3 后端 lint（`eea4913`）

**改动**：新增 `backend/pyproject.toml`，**刻意不含 `[project]` 与 `[build-system]`** —— 因此 pip 与 PyInstaller 均不读取它，打包仍由 `cinside-backend.spec` 驱动。pytest/ruff 只装进 `.venv`，**不写入 `requirements.txt`**（避免改变正式构建产物）。

**修掉的真实缺陷**：

| 位置 | 问题 |
|---|---|
| `app/agents/__init__.py` F821 | **NameError**：`ScreenshotEvent` 只在某个方法内部局部 import，但 `verify()` 方法也在用它 → 该截图上报路径一旦执行就抛 NameError。已提升到模块级。**这是 ruff 抓到的，靠人眼几乎不可能发现** |
| `app/services/excel_parser.py` F601 | 字典键 `studentname` 重复（两处值相同，属冗余） |

**清理的死绑定**（行为等价）：未使用导入 `uuid` / `VerificationResult` / `FieldMapping`（已确认无任何模块从 `app.agents` 重新导入这三者）、`document_extract.py` 未使用的 `resp`、`task_manager.py` 未使用的 except 变量、`agents/__init__.py` 未使用的 `fields_list`；`ruff --fix` 安全修复 18 处未使用导入。

### 2.4 测试体系（`d9d0a72`、`4eddebb`、`0c03ec4`、`38125c4`、`2908218`）

**整改前的真实状态**：全项目**不存在任何 `def test_*`**。grep 命中的 5 个 `test_*` 全是 FastAPI 路由名（`test_vision` 等）。`backend/tests/*_smoke.py` 是 `asyncio.run(main())` 独立脚本，**pytest 实际收集到 0 个用例**，而且它们 `from backend.app...` 的导入在 rootdir=backend 下会失败 → **实际产生 2 个收集错误**（不只是"没有测试"）。

**前端 190 用例**（Vitest，独立 `vitest.config.ts`，未动 `vite.config.ts`）：
`formatNormalize` 75、`flowGraph` 60、`skills` 30、`blockRules` 25。node 环境无 `localStorage`，用 `vi.stubGlobal` 注入最小内存 Storage 替身（非 mock 模块内部逻辑）。

**后端 230 用例**：
- `test_config.py` 82 —— `_coerce_value` 类型转换与兜底、`effective_text_llm` / `effective_analysis_llm` 的逐项继承回退链
- `test_comparison.py` 54
- `test_mrz_parser.py` 30 —— `_icao_check` / `_mrz_char_val` / `_repair_mrz_line2` / `_parse_mrz` / `_normalize_for_compare`
- `test_api_contract.py` 15 —— **接口契约**
- `test_mrz_noise.py` 12（从 `backend/` 根目录迁入）
- `test_highlight_export.py` 5
- `test_ocr_inflight_smoke.py` 4、`test_sideways_rescue_smoke.py` 3（脚本 → 真正的 pytest 用例）

**脚本改造的语义保真**：逐条断言原样保留，未放宽也未加强；手写 `orig=/try/finally` 改为 `monkeypatch`；并**逐例隔离模块级 `_ocr_cache` / `_ocr_inflight`**，消除了原脚本对用例执行顺序的隐式依赖（比原版更严格）。唯一的两处计数重述（`3`→`2`、LRU 用例自行预热）已在注释中说明缘由。

**接口契约测试的价值**：93 个端点（86 个唯一路径）**零 `response_model`**，响应结构无 schema。契约测试锁定了 6 个端点的 key 集合，**为后续补 `response_model` 提供安全网** —— FastAPI 的 `response_model` 会按 schema 过滤字段，若前端依赖了 schema 之外的字段会被静默丢掉，这批测试能当场发现。

**一个坑**：`include_router` 在 `app.routes` 顶层生成的是 `_IncludedRouter` 中间对象，直接遍历只看到 21 项，会**误判为"路由没挂上"**。真实端点数 = 12+8+22+6+20+14+2+8+1 = 93。已写进测试注释。

### 2.5 CI 门禁（`4fe6111`）

**问题**：唯一的 workflow 只有 build + publish，**无 lint / 无 test / 无独立 typecheck**；唯一门禁是 `npm run build` 里的 `tsc -b`。而且 `continue-on-error: true` 加在**整个 `build-mac` job** 上，会把编译错误、依赖安装失败一并吞掉。

**改动**：
- 新增 `quality-web`（ubuntu）：`npm ci` → ESLint → `tsc --noEmit` → vitest
- 新增 `quality-api`（ubuntu）：装轻量依赖 → ruff → pytest
- `build-mac` / `build-win` 加 `needs: [quality-web, quality-api]`
- `continue-on-error` 从整个 job **收窄到两步 `electron-builder`**（只有这两步会因 `hdiutil detach Resource busy` 偶发非零退出）

**`quality-api` 刻意不装 `requirements.txt`**（其中的 rapidocr / onnxruntime / openvino / PyMuPDF / markitdown 体积大且平台相关）。该假设**已实测验证**：用 import hook 屏蔽全部重型依赖后，`app.models` / `app.config` / `app.services.comparison` / `app.services.document_extract` / `app.services.excel_parser` / `app.services.task_manager` / `app.agents` **仍能全部导入成功**（重型依赖都是函数内惰性导入）。故最小依赖集 `pytest + ruff + pydantic + httpx + Pillow + python-dotenv` 足够。

**未验证**：该 workflow **尚未在 GitHub 上实际跑过**（需 push 分支或打 tag）。

### 2.6 Electron 修复（`cba30d0`）

**真实缺陷：`showItemInFolder` 一直静默失效。**

```js
// preload.cjs 原写法
showItemInFolder: (filePath) => {
  try { const { shell } = require("electron"); shell.showItemInFolder(filePath); }
  catch (_) {}
}
```

`webPreferences` 从未设置 `sandbox`（4 个 Electron 文件全文搜不到），Electron 20+ 默认 `sandbox: true`。沙箱化 preload 只暴露 `contextBridge / crashReporter / ipcRenderer / nativeImage / webFrame / webUtils`，**不含 `shell`** → `shell` 为 `undefined` → 抛 TypeError → 被空 `catch` 吞掉 → **「在文件夹中显示」什么也不做**。

同时 `main.cjs` 本来就有一个可用的 `show-item-in-folder` IPC handler，**无人调用**。

**修复**：preload 改走 `ipcRenderer.send("show-item-in-folder", filePath)`，接到那个一直没人用的、跑在主进程（有完整 shell 权限）的 handler。无论渲染进程是否沙箱化都成立。

**同时**：
- 删除 `open-external` IPC 通道 —— 全仓只有 `electron.d.ts` 声明、preload 暴露、`main.cjs` 实现三处引用，**没有任何 React 代码调用它**，却把渲染进程传入的 url 不做协议校验就交给 `shell.openExternal`。一并从 preload 与 d.ts 删除
- `setWindowOpenHandler` 加协议白名单（http/https/mailto），其余记日志后拒绝
- `show-item-in-folder` 补参数类型与文件存在性守卫

### 2.7 MRZ 告警（`4a739a3`）

**问题**：`_repair_mrz_line2` 取「首个满足检查位的单字符变异」，但 ICAO 检查位只能证明「加权和 mod 10 成立」，**不能证明改对了**。同一组检查位下存在大量等价解：

- `L898902C3` 丢一位后，把 `'6'` 插到行首得到的 `6L89902C3` 同样满足检查位
- `8→B` 认错时，把行首 `L` 换成 `I`（加权差正好抵消）也满足检查位

两种情况下护照号都被改成了**另一个值**，而且原来是**静默**的。对核验工具来说，悄悄给出错误的护照号是最危险的失败模式。

**本次做法：只让它变响，不改判定逻辑。**

**刻意不重写修复启发式**，理由：手头没有真实 MRZ 语料可以衡量"新策略是否更准"，只凭单元测试改动它等于用猜测替换现状，很可能在真实证件上更差；且"该修复还是该放弃"属于产品决策。

改动：
- 抽出统一返回出口 `_finish()`：只要改动落在护照号本体（前 9 位）就打出 `[MRZ-REPAIR][WARN] ... 请人工复核`；只改检查位的正常修复仍走普通日志，不误报
- 修复失败原样返回时，若检查位本就不成立，打出 `[MRZ-REPAIR][WARN]` 并列出失败字段
- 所有 `print` 补 `flush=True`

**返回值零改动**：原有 25 个 MRZ 用例一条未改全部通过，包括两个把错误修复结果锁死的 characterize 用例（断言值 `6L89902C3` / `I89B902C3` 与改动前完全一致）。

### 2.8 接口鉴权（`2908218`、`668c0c7`）

**漏洞**：渲染进程的 BrowserView 用 `webSecurity: false` 加载**第三方学校网站**，该设置让页面**绕过 CORS 检查**。因此任何被载入核验的第三方页面都能直接 `fetch` 本机后端：

- `/api/config/settings` —— **明文返回全部 5 个 API Key**
- `/api/records`、`/api/verify/report/{id}` —— 含护照号等个人数据

CORS 白名单（只放行 localhost:5173）对此**无效** —— `webSecurity` 关闭后浏览器根本不执行 CORS 检查。

**方案**：Electron 主进程 `crypto.randomBytes(32)` 生成令牌 → 经环境变量 `CINSIDE_API_TOKEN` 交给 Python 后端 → 经 preload `sendSync` 注入 `window.electronAPI.apiToken` 交给自家渲染进程。**第三方网页所在的 BrowserView 没有挂 preload，所以拿不到令牌** —— 这正是它能挡住第三方页面的原因。HTTP 走 `X-CINSIDE-Token` 头，WebSocket 走 `?token=`（浏览器 WS API 无法自定义请求头），后端两者都认。

**为「不破坏现有功能」所做的关键取舍**：

| 措施 | 效果 |
|---|---|
| 未配置令牌 → **完全放行** | `python run.py`、pytest、普通浏览器调试全部不受影响（已实测 `TOKEN='' MODE='off'`） |
| 开发环境默认 **`report`**（只记日志不拦） | 开发期漏加请求头不会让整片功能失效；也允许直接用浏览器开 5173 调试 |
| **`/` 与 `/api/health` 豁免** | 健康检查不含敏感信息，而渲染进程有 2 处用它做后端就绪探测 → 豁免可确保"连不上后端"这类基础能力**永远不会**被鉴权改坏 |
| **逃生开关 `CINSIDE_API_AUTH=off`** | 线上出问题可立即关闭 |
| CORS 中间件仍为最外层 | 连 403 响应也带 CORS 头，前端能读到有意义的中文错误而不是笼统跨域失败 |

**逐处核对了每一个调用点**（不靠"改几处试试"）：

- `src/api/client.ts`：新增 `apiFetch`/`withAuth` 作为**唯一出口**，`jsonFetch` + 8 处直连 `fetch` 全部收口 —— 现在 `client.ts` 内**只剩 1 处裸 `fetch`，就在 `apiFetch` 内部**
- `SettingsModal` 的 SSE 流未走 `client.ts` → 单独补头
- `main.cjs` 的 `plugin-api` 是**主进程发起**、不过渲染进程 → 单独补头
- `App.tsx` / `LeftPanel` 的 `/api/health` → 靠豁免
- `App.tsx` 其余 4 处 `fetch` 是 `blob:`/`data:`/外部 http **图源**，与后端无关 → 未动
- WebSocket 加 `?token=`

**测试写出来的一个真实疏漏**：`PROTECTED_PREFIX = "/api"` **漏了 `/ws`**，导致中间件没在保护 WebSocket（只靠路由内的检查兜着）。已修成 `("/api", "/ws")`。

### 2.9 无关文件搬移（`57948cc`）

按用户指定位置，把与 CINSIDE 无关的文件移出仓库（**移前逐项 `git ls-files` 确认均未被跟踪**）：

| 去处 | 内容 |
|---|---|
| `D:\个人资料\` | 数学习题.pdf、习题5.1.pdf、习题5.1 (1).pdf、习题解答_5.1_5.2_5.3.docx/.md、第十章 波动.pdf、数学习题解答/、`.remote-input/` |
| `D:\个人资料\图片\` | 12 个十六进制命名的会话照片 |
| `D:\其他项目\` | `black-hole/`（独立的 Kerr 黑洞光线追踪项目）、`frametol-client/`、`dist-frametol-client/` |

约 1.63 GB（FrameTol 占绝大部分）。`black-hole/` 是先读其 README 确认为独立项目后才动的。

## 3. 遗留：需要你在方便时处理

| 项 | 说明 |
|---|---|
| 13 个 `app.asar` 空壳目录 | 12 个 `dist-electron-*` + `dist-frametol-client` 各剩一个 `win-unpacked/resources/app.asar`（共约 345 MB）+ `_repack2/`、`_repack2_check/`（314 字节）。**被 Windows Defender 实时防护占用**，`Remove-Item`/`.NET File.Delete`/`robocopy`/重命名全部失败（`Access denied`）。**重启后可直接删除** |
| CI 门禁未实证 | workflow 尚未在 GitHub 跑过，需 push 分支或打 tag |
| 后端旧构建产物 | `backend/dist`（415 MB）+ `backend/build`（86.6 MB）保留未动 —— 它们是打包必需中间产物 |

## 4. 复现验证（改完请跑这 6 条）

```powershell
cd D:\CINSIDE\frontend
npx tsc -p tsconfig.json --noEmit      # 期望 exit 0
npx vitest run                         # 期望 4 文件 / 190 passed
npm run lint                           # 期望 0 error（495 warning 为存量）
npm run build                          # 期望 exit 0

cd D:\CINSIDE\backend
.\.venv\Scripts\python.exe -m ruff check .   # 期望 All checks passed
.\.venv\Scripts\python.exe -m pytest -q      # 期望 230 passed
```

无 GUI 时 Electron 改动只能靠语法校验：

```powershell
cd D:\CINSIDE\frontend
node --check electron\main.cjs
node --check electron\preload.cjs
```

**回滚**：所有改动都在 `chore/quality-guardrails` 分支，`main` 保持基线 `8d6733a`。
`git checkout main` 即可完全复原。或 `git reset --hard 8d6733a`（会丢弃全部改动）。

## 5. 我无法验证的部分（诚实声明）

本环境无法启动 Electron GUI，因此以下几项**只能靠静态推理 + 后端测试保证**，需要你本地跑一次确认：

1. `sendSync` 令牌握手、preload 注入时机
2. 各功能是否都在生产（`enforce`）模式下带上了令牌 —— 若出现 403，日志会打 `[api-auth][BLOCKED] <路径>` 直接定位，`CINSIDE_API_AUTH=off` 可立即恢复
3. `showItemInFolder` 修复后的实际点击效果
4. 协议白名单（http/https/mailto）是否覆盖了你实际会用到的外链类型

另：本会话 shell 里 `ELECTRON_RUN_AS_NODE=1` 被设置，导致 Electron 以纯 Node 模式启动（`require("electron")` 直接报找不到模块），所以未能实测拿到 Electron 的真实 User-Agent 字符串。

## 6. 已发现但**未修**的问题（下一阶段输入）

> 「去臃肿」阶段的主要工作对象。按严重性排序，不含本次已修项。

### 6.1 单文件巨石（本次未动，风险最高）

| 文件 | 行数 | 说明 |
|---|---|---|
| `frontend/src/App.tsx` | **18,690** | 单个 `App()` 函数体 **16,877 行**（第 1223–18099 行）；含 111 `useState` / 64 `useEffect` / **238 `useCallback`** / 54 处 `xRef = useRef(x)` 镜像 |
| `frontend/src/components/ResultsPanel.tsx` | 4,738 | |
| `frontend/src/components/DocLocalExtractConfig.tsx` | 2,940 | |
| `frontend/src/components/PPTWorkflowPanel.tsx` | 2,814 | |
| `frontend/src/components/LeftPanel.tsx` | 1,990 | |
| `frontend/src/lib/widgetScripts.ts` | 1,787 | |
| `frontend/src/components/SettingsModal.tsx` | 1,605 | |
| `frontend/src/components/ElementSelectBar.tsx` | 1,562 | **死代码**：组件无任何渲染方，仅其类型被 `App.tsx` 引用 |
| `frontend/electron/main.cjs` | 4,991 | **81 个 `ipcMain.handle/on`** |
| `backend/app/services/document_extract.py` | 3,956 | **80+ 个顶层函数**，混合图像预处理 / 三种 OCR 引擎调度 / UMI-OCR 进程自愈 / MRZ 解析 / 日期抽取 / 提示词拼装 / JSON 容错 |
| `backend/app/services/ppt_service.py` | 2,040 | |
| `backend/app/services/dependency_manager.py` | 1,021 | |

**`App.tsx` 的一个具体佐证**：函数体内部存在**顶格写成第 0 列**的代码块（如第 14194–14200 行）。连大括号配对扫描都会被骗 —— 我实测扫描误判 `App()` 结束于第 14200 行，实际是 18099 行。缩进已完全不可信。

### 6.2 契约与类型

- **93 个端点零 `response_model`**。⚠️ 注意：**直接补 `response_model` 有破坏功能的风险** —— FastAPI 会按 schema **过滤**响应字段，而前端很可能依赖 schema 之外的字段。必须先有特征测试（已有 6 个端点的 key 集合锁定）再逐端点加
- `types.ts`（1,183 行）与 `models.py` 有 **12 个同名类型**靠手抄维护，且**已发生漂移**：`types.ts:78` 的 `EvidenceSource` 含 `"web"`，而 `models.py:117` 的 `Literal` 不含；后端 `_decide_evidence_source` 实际只会返回 `passport/excel/none`，所以 `Literal` 里的 `"manual"` 也是死值。更麻烦的是前端把 `c.evidence_source` 写进 `left_source` 字段，而后端该字段 `Literal` 是 `["excel","database","passport","manual"]` → `"web"` 流过去会被 422 拒掉
- `models.py` 内部并存**两代模型**：老的 `VerificationResult`/`FieldComparison`/`VerificationStep` 与新的 `VerificationReport`/`VerificationReportEntry`/`WorkflowConfig`，另有 `WebsiteField`/`WebsiteInput`/`InputBox` 语义重叠
- `tsconfig.json` 的 `noUnusedLocals` / `noUnusedParameters` 仍为 `false`
- 前端 9 处绕过 `client.ts` 的裸 `fetch(`（本次已收口到 `apiFetch`，但契约层仍未统一）
- 495 条 ESLint warning 存量

### 6.3 错误处理与可观测性

- **116 处宽泛/bare `except`**，分布 20 个文件（`document_extract.py` 34、`plugin_loop.py` 17、`dependency_manager.py` 15、`ppt_service.py` 11、`cowork_service.py` 7、`gpu_ocr.py` 6），其中多处以 `pass` 静默吞掉
- **186 处 `print(`**，14 个文件（`document_extract.py` 70、`ppt_service.py` 58），无 `logging` 模块、无级别、无落盘
- 前端 129 处 `console.*`（`App.tsx` 71、`main.cjs` 34）
- `main.py:77` 用的 `@app.on_event("startup")` 在现代 FastAPI 中已弃用，应改用 `lifespan`

### 6.4 安全（除已修的令牌外）

- **整个 Electron 层与 `index.html` 没有任何 CSP**（无 `Content-Security-Policy`、无 `onHeadersReceived`）
- `webSecurity: false` 出现 5 处、`allowRunningInsecureContent: true` 3 处（为跨域 iframe 元素拾取，属有意妥协但全局铺开、无集中说明）
- IPC 面过宽：81 个 handler + 约 70 个 `electronAPI` 方法，无参数 schema 校验，handler 普遍不检查 `_event.senderFrame`

### 6.5 可能被 WAF 拦截（与 LOOP 受阻相关）

LOOP 回放步骤打在 **Electron 的 BrowserView** 里，即用 Electron 自带 Chromium 加载学校网站。而全仓**没有任何 UA 伪装**（grep `userAgent`/`setUserAgent` 全空），Electron 默认 UA 会带上 `CINSIDE/0.8.6` 与 `Electron/31.7.7` —— 这是最强的自动化特征之一，很多高校/机构站点的 WAF 会直接 403 或弹验证码。叠加 `webSecurity: false` 与主进程开启 CDP 调试端口，可检测特征更多。

**结论：这与接口鉴权改动无关**（鉴权不触碰第三方页面请求，已逐条核实）。修复方向是**只做 UA 对齐**（换成同版本真实 Chrome UA），**不建议**做反检测注入（改 `navigator.webdriver`、伪造指纹那类）—— 后者维护成本高、易随 Chromium 升级失效，也有合规灰区。

### 6.6 其它已记录的怪癖

- `comparison.compare_field`：仅网页有值时判成 `mismatch` 且 `evidence_source="none"`；`partial` 只在 excel 与 passport 同时存在时才可能出现；`surname`/`nationality` 是**大小写敏感**比对（`Ivanov` vs `IVANOV` 判为不一致）
- `config._coerce_value`：`str(raw or "")` 会把 `0` 这类 falsy 非字符串变成 `""`；非法 float 兜底 1.0 而非法 int 兜底 0；`"12.9"` 转 int 得 0
- 前端：`looksLikePhone("12.11.2008") === true`（日期被判成电话）；`normalizeNationality("U.S.A.") === ""`；`cloneNodes` 对 ifelse 生成前缀是 `ife_`（`kind.slice(0,3)`）而非 `if_`
- `_repair_mrz_line2` 只在国家码属于 `_ISO3_COUNTRY_CODES` 时才修；ICAO 官方样板码 `UTO` 不在白名单里
- 现存 `test_mrz_noise.py` 的样本自称"标准 TD3 MRZ"，实际 L1 是 47 字符（应 44）、L2 有 3 个检查位不成立。数据已按原样保留（该用例本就是"噪声"场景），新测试另用 `_icao_check` 现算构造真正合法的行

## 7. 「去臃肿」阶段的建议顺序

按「收益 ÷ 风险」排序，建议自上而下：

1. **`App.tsx` 拆解** —— 收益最大但风险最高。**必须先产出职责地图**（按 111 个 `useState` 的归属切分业务域），再自叶子域逐个抽 hook，每抽一个域提交一次。**不能先动核心的批量执行状态机。**
2. **`backend/app/services/document_extract.py` 拆分** —— 其 `mrz.py` 部分（纯函数、零依赖、已有 30 个测试）**最适合先拆**，风险最低，且能立刻提升可测试性。
3. **`ElementSelectBar.tsx`（1,562 行死代码）处理** —— 需先把被引用的类型迁出，再删除文件。收益确定、风险低。
4. **`main.cjs` 按域拆分 IPC** —— 81 个 handler 分域注册，但需逐个确认无顺序依赖。
5. **契约统一** —— 先补特征测试，再逐端点加 `response_model`；用 `openapi-typescript` 生成类型替代手抄的 12 个同名类型。
6. **错误处理与日志** —— 收窄 116 处宽泛 except、`print` → `logging`。

**贯穿要求**：每一步都必须保持本文第 4 节的 6 条验证全绿；纯重构应尽量让生产产物哈希不变（哈希变化即意味着行为变了，需单独说明）。
