import { useState } from "react";
import { Eye, EyeOff, KeyRound, Plus, Trash2, X, Copy, Check } from "lucide-react";
import type { Credential } from "../lib/credentials";

interface Props {
  /** 当前网站 host（用于筛选相关凭证） */
  currentHost?: string;
  /** 全部凭证 */
  credentials: Credential[];
  /** 当前激活两段式粘贴的凭证 id */
  activePasteId: string | null;
  /** 当前两段式粘贴的步骤（0=待粘贴用户名，1=待粘贴密码） */
  pasteStep: 0 | 1;
  /** 添加凭证 */
  onAdd: (data: { host: string; name: string; username: string; password: string; note?: string }) => void;
  /** 删除凭证 */
  onRemove: (id: string) => void;
  /** 点击 COPY 按钮：激活两段式粘贴 */
  onCopy: (cred: Credential) => void;
  /** 取消两段式粘贴 */
  onCancelPaste: () => void;
  onClose: () => void;
}

export default function CredentialsPanel({
  currentHost,
  credentials,
  activePasteId,
  pasteStep,
  onAdd,
  onRemove,
  onCopy,
  onCancelPaste,
  onClose,
}: Props) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [newHost, setNewHost] = useState(currentHost || "");
  const [newName, setNewName] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newNote, setNewNote] = useState("");
  const [showPasswordId, setShowPasswordId] = useState<string | null>(null);

  const handleAdd = () => {
    if (!newHost.trim() || !newUsername.trim() || !newPassword.trim()) return;
    onAdd({
      host: newHost.trim(),
      name: newName.trim() || newHost.trim(),
      username: newUsername.trim(),
      password: newPassword,
      note: newNote.trim() || undefined,
    });
    setNewName("");
    setNewUsername("");
    setNewPassword("");
    setNewNote("");
    setShowAddForm(false);
  };

  // 当前网站的凭证排前面
  const sortedCreds = [...credentials].sort((a, b) => {
    if (currentHost) {
      const aMatch = a.host === currentHost ? 0 : 1;
      const bMatch = b.host === currentHost ? 0 : 1;
      if (aMatch !== bMatch) return aMatch - bMatch;
    }
    return b.createdAt - a.createdAt;
  });

  return (
    <div className="fixed right-4 top-12 z-[9998] flex max-h-[calc(100vh-6rem)] w-80 flex-col rounded-lg border border-slate-200 bg-white shadow-xl">
      {/* 标题栏 */}
      <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <KeyRound className="h-3.5 w-3.5 text-indigo-500" />
          <span className="text-xs font-semibold text-slate-700">账号密码</span>
          {currentHost && <span className="text-[10px] text-slate-400">{currentHost}</span>}
        </div>
        <button onClick={onClose} className="rounded p-0.5 text-slate-400 hover:bg-slate-100">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 两段式粘贴状态提示 */}
      {activePasteId && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-amber-100 bg-amber-50 px-3 py-1.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[11px] font-medium text-amber-700">
              两段式粘贴已激活
            </p>
            <p className="text-[10px] text-amber-600">
              {pasteStep === 0 ? "下一步：Ctrl+V 粘贴用户名" : "下一步：Ctrl+V 粘贴密码"}
            </p>
          </div>
          <button
            onClick={onCancelPaste}
            className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 hover:bg-amber-200"
          >
            取消
          </button>
        </div>
      )}

      {/* 凭证列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {sortedCreds.length === 0 ? (
          <p className="py-6 text-center text-[11px] text-slate-400">
            暂无保存的账号密码
            <br />
            点击下方"添加"按钮创建
          </p>
        ) : (
          <ul className="space-y-2">
            {sortedCreds.map((cred) => {
              const isActive = activePasteId === cred.id;
              const isCurrentHost = currentHost && cred.host === currentHost;
              const showPwd = showPasswordId === cred.id;
              return (
                <li
                  key={cred.id}
                  className={`rounded-md border p-2 transition-colors ${
                    isActive
                      ? "border-amber-300 bg-amber-50"
                      : isCurrentHost
                      ? "border-indigo-200 bg-indigo-50/40"
                      : "border-slate-200 bg-slate-50"
                  }`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1">
                        <span className="truncate text-[11px] font-semibold text-slate-700">
                          {cred.name}
                        </span>
                        {isCurrentHost && (
                          <span className="shrink-0 rounded bg-indigo-100 px-1 text-[9px] text-indigo-600">
                            当前
                          </span>
                        )}
                      </div>
                      <p className="truncate text-[9px] text-slate-400">{cred.host}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <button
                        onClick={() => setShowPasswordId(showPwd ? null : cred.id)}
                        className="rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-600"
                        title={showPwd ? "隐藏密码" : "显示密码"}
                      >
                        {showPwd ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                      </button>
                      <button
                        onClick={() => onRemove(cred.id)}
                        className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-500"
                        title="删除"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                  <div className="mt-1.5 space-y-1">
                    <div className="flex items-center gap-1.5">
                      <span className="w-8 shrink-0 text-[9px] text-slate-400">用户</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-700">
                        {cred.username}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="w-8 shrink-0 text-[9px] text-slate-400">密码</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-700">
                        {showPwd ? cred.password : "•".repeat(Math.min(cred.password.length, 12))}
                      </span>
                    </div>
                    {cred.note && (
                      <p className="mt-0.5 truncate text-[9px] italic text-slate-400">{cred.note}</p>
                    )}
                  </div>
                  <button
                    onClick={() => onCopy(cred)}
                    className={`mt-2 flex w-full items-center justify-center gap-1.5 rounded-md py-1 text-[10px] font-medium transition-colors ${
                      isActive
                        ? "bg-amber-500 text-white hover:bg-amber-600"
                        : "bg-slate-200 text-slate-600 hover:bg-slate-300"
                    }`}
                    title={isActive ? "两段式粘贴中，点击取消" : "点击激活两段式粘贴：第一次 Ctrl+V 粘贴用户名，第二次粘贴密码"}
                  >
                    {isActive ? (
                      <>
                        <Check className="h-3 w-3" />
                        {pasteStep === 0 ? "等待粘贴用户名" : "等待粘贴密码"}
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" />
                        COPY
                      </>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* 添加表单 / 添加按钮 */}
      {showAddForm ? (
        <div className="shrink-0 space-y-1.5 border-t border-slate-100 px-3 py-2">
          <div className="flex gap-1.5">
            <input
              value={newHost}
              onChange={(e) => setNewHost(e.target.value)}
              placeholder="网站域名（如 jwxt.edu.cn）"
              className="min-w-0 flex-1 rounded border border-slate-200 px-2 py-1 text-[11px] focus:border-indigo-400 focus:outline-none"
            />
          </div>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="名称（如 教务系统，可选）"
            className="w-full rounded border border-slate-200 px-2 py-1 text-[11px] focus:border-indigo-400 focus:outline-none"
          />
          <input
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
            placeholder="用户名"
            className="w-full rounded border border-slate-200 px-2 py-1 text-[11px] focus:border-indigo-400 focus:outline-none"
          />
          <input
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            type="password"
            placeholder="密码"
            className="w-full rounded border border-slate-200 px-2 py-1 text-[11px] focus:border-indigo-400 focus:outline-none"
          />
          <input
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            placeholder="备注（可选）"
            className="w-full rounded border border-slate-200 px-2 py-1 text-[11px] focus:border-indigo-400 focus:outline-none"
          />
          <div className="flex gap-1.5">
            <button
              onClick={() => setShowAddForm(false)}
              className="flex-1 rounded bg-slate-100 py-1 text-[11px] text-slate-500 hover:bg-slate-200"
            >
              取消
            </button>
            <button
              onClick={handleAdd}
              disabled={!newHost.trim() || !newUsername.trim() || !newPassword.trim()}
              className="flex-1 rounded bg-indigo-500 py-1 text-[11px] font-medium text-white hover:bg-indigo-600 disabled:opacity-40"
            >
              保存
            </button>
          </div>
        </div>
      ) : (
        <div className="shrink-0 border-t border-slate-100 px-3 py-2">
          <button
            onClick={() => {
              setNewHost(currentHost || "");
              setShowAddForm(true);
            }}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-indigo-50 py-1.5 text-[11px] font-medium text-indigo-600 transition-colors hover:bg-indigo-100"
          >
            <Plus className="h-3 w-3" />
            添加账号密码
          </button>
        </div>
      )}
    </div>
  );
}
