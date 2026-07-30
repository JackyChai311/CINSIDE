/**
 * 账号密码凭证持久化存储
 * 按 hostname 分组，存储账号密码数组
 * 仿照 blockRules.ts 的 localStorage 模式
 */

const STORAGE_KEY = "cinside_credentials";

export interface Credential {
  id: string;
  /** 网站 hostname，用于匹配 */
  host: string;
  /** 网站名称（显示用，如"教务系统"） */
  name: string;
  /** 用户名 */
  username: string;
  /** 密码 */
  password: string;
  /** 备注（可选） */
  note?: string;
  createdAt: number;
}

/** 全部凭证（不分组） */
type CredentialMap = Record<string, Credential>;

function loadAll(): CredentialMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as CredentialMap;
  } catch {
    return {};
  }
}

function saveAll(map: CredentialMap) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

/** 从 URL 提取 hostname */
export function getHost(url: string): string {
  try {
    return new URL(url).hostname || "unknown";
  } catch {
    return "unknown";
  }
}

/** 获取全部凭证（数组） */
export function getAllCredentials(): Credential[] {
  const map = loadAll();
  return Object.values(map).sort((a, b) => b.createdAt - a.createdAt);
}

/** 获取指定 host 的凭证 */
export function getCredentialsByHost(host: string): Credential[] {
  return getAllCredentials().filter((c) => c.host === host);
}

/** 添加凭证，返回新的全部凭证数组 */
export function addCredential(data: Omit<Credential, "id" | "createdAt">): Credential[] {
  const map = loadAll();
  const id = `cred-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const cred: Credential = { ...data, id, createdAt: Date.now() };
  map[id] = cred;
  saveAll(map);
  return getAllCredentials();
}

/** 更新凭证 */
export function updateCredential(id: string, patch: Partial<Omit<Credential, "id" | "createdAt">>): Credential[] {
  const map = loadAll();
  if (!map[id]) return getAllCredentials();
  map[id] = { ...map[id], ...patch };
  saveAll(map);
  return getAllCredentials();
}

/** 删除凭证 */
export function removeCredential(id: string): Credential[] {
  const map = loadAll();
  delete map[id];
  saveAll(map);
  return getAllCredentials();
}
