export type ViewSide = "left" | "right";

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 元素选择时拾取到的元素信息 */
export interface PickedElement {
  selector: string;
  label: string;
  value: string;
  tag: string;
  type: string;
  rect: { x: number; y: number; width: number; height: number };
  text: string;
}

/** 来自 BrowserView 内部的消息 */
export interface ViewMessage {
  side: ViewSide;
  payload:
    | { kind: "element-picked"; [k: string]: unknown }
    | { kind: string; [k: string]: unknown };
  /** 消息来自 window.open 弹窗 BrowserView（弹窗内拾取/中继） */
  fromPopup?: boolean;
}

/** 高亮框定义 */
export interface HighlightBox {
  selector: string;
  status: "match" | "mismatch" | "missing" | "partial" | "pending" | "unknown" | "entry" | "review";
  label?: string;
}

/** 更新信息 */
export interface UpdateInfo {
  version: string;
  releaseDate?: string;
  releaseNotes?: string;
}

/** 更新下载进度 */
export interface UpdateDownloadProgress {
  bytesPerSecond: number;
  percent: number;
  transferred: number;
  total: number;
}

export interface ElectronAPI {
  backendStatus: () => Promise<boolean>;
  onBackendReady: (callback: () => void) => void;
  openExternal: (url: string) => void;

  // === 自动更新 ===
  updateCheckNow: () => Promise<{ ok: boolean; message?: string; result?: unknown }>;
  updateDownloadUpdate: () => Promise<{ ok: boolean; message?: string }>;
  updateQuitAndInstall: () => Promise<{ ok: boolean }>;
  onUpdateAvailable: (callback: (info: UpdateInfo) => void) => () => void;
  onUpdateNotAvailable: (callback: (info: UpdateInfo) => void) => () => void;
  onUpdateDownloadProgress: (callback: (progress: UpdateDownloadProgress) => void) => () => void;
  onUpdateDownloaded: (callback: (info: UpdateInfo) => void) => () => void;
  onUpdateError: (callback: (error: { message: string }) => void) => () => void;
  getAppVersion: () => Promise<string>;

  // === 无边框窗口控制 ===
  windowMinimize: () => void;
  windowMaximize: () => void;
  windowClose: () => void;
  windowIsMaximized: () => Promise<boolean>;

  // === 防误关：通知主进程是否启用 ===
  setPreventClose: (enabled: boolean) => void;
  // 真正退出应用（绕过防误关拦截）
  quitApp: () => void;

  // === 双 BrowserView 控制 ===
  viewLoad: (side: ViewSide, url: string) => Promise<void>;
  viewShow: (side: ViewSide, bounds?: Bounds, url?: string | null) => Promise<void>;
  viewHide: (side: ViewSide) => Promise<void>;
  viewHideAll: () => Promise<void>;
  viewSetZoom: (side: ViewSide, factor: number) => Promise<void>;
  viewSetBrightness: (side: ViewSide, value: number) => Promise<void>;

  viewExecuteJS: (side: ViewSide, script: string) => Promise<unknown>;
  viewInsertCSS: (side: ViewSide, css: string) => Promise<unknown>;

  // 元素选择模式
  viewStartPicking: (side: ViewSide) => Promise<unknown>;
  viewStopPicking: (side: ViewSide) => Promise<unknown>;
  // 浏览器回退（网页提取时点错撤销）
  viewGoBack: (side: ViewSide) => Promise<{ ok: boolean; reason?: string }>;
  // 浏览器前进（保底机制过度回退后恢复页面）
  viewGoForward: (side: ViewSide) => Promise<{ ok: boolean; reason?: string }>;

  // 一键直传：把文件直接填入网页 file input
  viewQuickUpload: (
    side: ViewSide,
    fileInputSelector: string,
    filename: string,
    mime: string,
    base64Data: string
  ) => Promise<{ ok: boolean; name?: string; size?: number; multiple?: boolean; reason?: string; error?: string }>;
  // 弹窗一键直传：把文件直接填入弹窗中的 file input
  popupQuickUpload: (
    side: ViewSide,
    fileInputSelector: string,
    filename: string,
    mime: string,
    base64Data: string
  ) => Promise<{ ok: boolean; name?: string; size?: number; multiple?: boolean; reason?: string; error?: string }>;

  // 元素屏蔽规则（注入 display:none 或折叠 CSS，导航后自动重注入）
  viewSetBlockRules: (side: ViewSide, rules: { selector: string; mode?: "hide" | "collapse" }[]) => Promise<{ ok: boolean }>;

  // 高亮
  viewHighlightBoxes: (side: ViewSide, boxes: HighlightBox[]) => Promise<unknown>;
  viewClearHighlight: (side: ViewSide) => Promise<unknown>;

  // 绑定输入模式右键菜单：开启/关闭
  viewSetBindInputMode: (side: ViewSide, enabled: boolean) => Promise<unknown>;
  // 框选模式（日格子多选）：true=拖拽框选，false=单点选择
  viewSetMarqueeMode: (side: ViewSide, enabled: boolean) => Promise<unknown>;
  // 回传 Excel 列列表到 picker 脚本（右键菜单响应）
  viewCtxMenuResponse: (side: ViewSide, columns: string[], currentField: string) => Promise<unknown>;

  // 截图指定 view 中的元素区域（用于头像提取）
  viewCaptureElement: (side: ViewSide, rect: { x: number; y: number; width: number; height: number }) => Promise<{ ok: boolean; dataUrl?: string; error?: string }>;

  // === 下载捕获（文件提取模式） ===
  setDownloadCapture: (side: ViewSide, enabled: boolean) => Promise<{ ok: boolean }>;
  // === LOOP 运行时阻止息屏 ===
  setPowerSave: (enabled: boolean) => Promise<{ ok: boolean; active: boolean }>;
  onDownloadCaptured: (callback: (data: { side: string; filename: string; dataUrl: string; size: number; mime: string; path: string }) => void) => () => void;
  onDownloadStarted: (callback: (data: { side: string; filename: string }) => void) => () => void;
  onDownloadProgress: (callback: (data: { side: string; filename: string; received: number; total: number; percent: number }) => void) => () => void;
  onDownloadFailed: (callback: (data: { side: string; filename: string; error?: string; state?: string }) => void) => () => void;

  // === 文件提取保底机制 ===
  // 获取页面上所有可下载链接（<a href> 指向文件的链接）
  viewGetDownloadableLinks: (side: ViewSide) => Promise<{ ok: boolean; links?: Array<{ url: string; text: string; filename?: string }>; error?: string }>;
  // 批量下载URL列表并返回文件数据
  viewBatchDownloadUrls: (side: ViewSide, urls: string[], timeoutMs?: number) => Promise<{ ok: boolean; files?: Array<{ url: string; filename: string; dataUrl: string; size: number; mime: string }>; error?: string }>;
  // 图片直览页抓取：点击后直接预览图片（无下载按钮）时，按 URL 主动下载
  viewDownloadSingleUrl: (side: ViewSide, url: string, timeoutMs?: number) => Promise<{ ok: boolean; filename?: string; dataUrl?: string; size?: number; mime?: string; error?: string }>;

  // === 本地文件提取：选择目录 + 读取文件 ===
  pickLocalDirectory: () => Promise<{ canceled: boolean; rootPath: string; files: Array<{ relativePath: string; name: string; size: number; ext: string }> }>;
  /** 本地文件提取：直接多选文件（不经根目录，渲染层自行推导根目录+路径模板） */
  pickLocalDocFiles: () => Promise<{ canceled: boolean; files: Array<{ file_path: string; file_name: string; size: number; ext: string }> }>;
  /** 本地文件提取：展开「文件夹/压缩包/散文件」混合输入为具体文档文件列表（文件夹递归扫描、zip/tar 解压到临时目录，只收 PDF/图片格式） */
  expandLocalDocPaths: (paths: string[]) => Promise<{ ok: boolean; files: string[]; extractedArchives: number; warnings: string[]; message: string }>;
  readLocalDocFile: (rootPath: string, relativePath: string) => Promise<{ ok: boolean; dataUrl?: string; filename?: string; mime?: string; size?: number; error?: string }>;
  checkLocalFileExists: (rootPath: string, relativePath: string) => Promise<{ exists: boolean }>;
  saveExportedFile: (defaultName: string, base64: string) => Promise<{ ok: boolean; canceled?: boolean; path?: string; size?: number; error?: string }>;

  // === 幻灯片任务：选择 PPT 文件 ===
  pickPptFiles: () => Promise<{ canceled: boolean; files: Array<{ file_path: string; file_name: string; size: number }> }>;
  pickPptDirectory: () => Promise<{ canceled: boolean; rootPath: string; files: Array<{ relativePath: string; name: string; size: number; ext: string; file_path: string }> }>;
  /** 参考资料：选择 PPT/PDF 文件（支持多选） */
  pickReferenceFiles: () => Promise<{ canceled: boolean; files: Array<{ file_path: string; file_name: string; size: number; ext: string }> }>;
  /** 获取拖拽放入的 File 对象对应的真实磁盘路径 */
  getPathForFile: (file: File) => string;
  /** 在文件管理器中显示文件（打开所在目录并选中） */
  showItemInFolder: (filePath: string) => void;

  // 接收 BrowserView 内部消息
  onViewMessage: (callback: (msg: ViewMessage) => void) => () => void;

  // === 面板脱离（拖拽到其他屏幕） ===
  panelDetach: (side: "left" | "bottom" | "browser-left" | "browser-right" | "browser-excel") => Promise<boolean>;
  panelBroadcastState: (side: "left" | "bottom" | "browser-left" | "browser-right" | "browser-excel", state: unknown) => void;
  panelSendAction: (action: string, payload?: unknown) => void;
  rendererLog: (msg: string) => void;
  onPanelState: (callback: (state: unknown) => void) => () => void;
  onPanelAction: (callback: (action: string, payload?: unknown) => void) => () => void;
  onPanelReattached: (callback: (side: string) => void) => () => void;
  onDetachedViewReady: (callback: (side: string) => void) => () => void;

  // === 脱离的浏览器面板视图控制 ===
  detachedViewShow: (side: string, bounds: Bounds, url?: string | null) => Promise<void>;
  detachedViewHide: (side: string) => Promise<void>;
  detachedViewLoad: (side: string, url: string) => Promise<void>;
  detachedViewExecuteJS: (side: string, script: string) => Promise<unknown>;
  detachedViewStartPicking: (side: string) => Promise<unknown>;
  detachedViewStopPicking: (side: string) => Promise<unknown>;
  detachedViewHighlightBoxes: (side: string, boxes: HighlightBox[]) => Promise<unknown>;
  detachedViewClearHighlight: (side: string) => Promise<unknown>;
  detachedViewInsertCSS: (side: string, css: string) => Promise<unknown>;

  // === 兼容旧 API（指向 right view） ===
  loadBrowserViewUrl: (url: string) => Promise<void>;
  showBrowserView: (bounds: Bounds, url: string) => Promise<void>;
  hideBrowserView: () => Promise<void>;
  resizeBrowserView: (bounds: Bounds) => Promise<void>;

  // === 弹窗（window.open 拦截）控制 ===
  popupClose: (side: ViewSide) => Promise<void>;
  popupStartPicking: (side: ViewSide) => Promise<unknown>;
  popupStopPicking: (side: ViewSide) => Promise<unknown>;
  popupHighlightBoxes: (side: ViewSide, boxes: HighlightBox[]) => Promise<unknown>;
  popupClearHighlight: (side: ViewSide) => Promise<unknown>;
  popupExecuteJS: (side: ViewSide, script: string) => Promise<unknown>;
  onPopupCreated: (callback: (data: { parentSide: ViewSide; url: string }) => void) => () => void;
  onPopupClosed: (callback: (data: { parentSide: ViewSide }) => void) => () => void;

  // === 外挂插件：屏幕边缘悬浮条 ===
  dockToggle: () => Promise<{ open: boolean }>;
  dockIsOpen: () => Promise<boolean>;
  pluginApi: (path: string, method?: string, body?: unknown) => Promise<{ ok: boolean; status: number; data: unknown }>;
  onDockState: (callback: (data: { open: boolean }) => void) => () => void;

  // === 账号密码两段式粘贴 ===
  /** 启动两段式粘贴：主进程会拦截对应 side 的 Ctrl+V，第一次粘贴 username，第二次粘贴 password */
  startTwoStepPaste: (side: ViewSide, username: string, password: string) => Promise<{ ok: boolean }>;
  /** 取消两段式粘贴 */
  cancelTwoStepPaste: () => Promise<{ ok: boolean }>;
  /** 查询两段式粘贴状态 */
  getTwoStepPasteState: () => Promise<{ active: boolean; step: 0 | 1; side: ViewSide | null }>;
  /** 当两段式粘贴步骤变化时通知前端（step 0→1→完成） */
  onTwoStepPasteProgress: (callback: (data: { side: ViewSide | null; step: 0 | 1; done: boolean }) => void) => () => void;

  // === 模态覆盖层：临时隐藏所有原生 BrowserView 防止穿模 ===
  modalOverlayEnter: () => Promise<void>;
  modalOverlayExit: () => Promise<void>;
  onModalOverlayExited: (callback: () => void) => () => void;
}

interface CinsideZoom {
  setFactor: (factor: number) => void;
  getFactor: () => number;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
    cinsideZoom?: CinsideZoom;
  }
}

export {};
