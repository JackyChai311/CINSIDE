import { useEffect, useState } from "react";
import { X, Check, FolderPlus } from "lucide-react";
import { getDefaultIcons } from "../lib/skills";

interface SaveSkillDialogProps {
  open: boolean;
  defaultName: string;
  /** 已存在的分组名列表（供选择） */
  groups?: string[];
  /** 预选分组（连续设计链：清空步骤再保存时自动归入上一个 LOOP 的分组） */
  defaultGroup?: string;
  onClose: () => void;
  onSave: (name: string, icon: string, group?: string) => void;
  onSaveAndRun?: (name: string, icon: string, group?: string) => void;
}

export default function SaveSkillDialog({ open, defaultName, groups, defaultGroup, onClose, onSave, onSaveAndRun }: SaveSkillDialogProps) {
  const [name, setName] = useState(defaultName);
  const [icon, setIcon] = useState("🔍");
  // group: undefined=不分组；""=正在新建（输入中）；非空=已选/已输入的分组名
  const [group, setGroup] = useState<string | undefined>(undefined);
  const [newGroup, setNewGroup] = useState("");

  useEffect(() => {
    if (open) {
      setName(defaultName);
      setIcon("🔍");
      setGroup(defaultGroup || undefined);
      setNewGroup("");
    }
  }, [open, defaultName, defaultGroup]);

  if (!open) return null;

  const icons = getDefaultIcons();
  const effectiveGroup = group === "" ? newGroup.trim() : group;

  const handleSave = (fn: (name: string, icon: string, group?: string) => void) => {
    if (!name.trim()) return;
    fn(name.trim(), icon, effectiveGroup || undefined);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[min(420px,calc(100vw-2rem))] overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <span className="text-sm font-semibold text-slate-800">保存为 LOOP</span>
          <button onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-4">
          <div>
            <label className="mb-1 block text-[11px] font-medium text-slate-600">图标</label>
            <div className="flex flex-wrap gap-1.5">
              {icons.map((ic) => (
                <button
                  key={ic}
                  onClick={() => setIcon(ic)}
                  className={`flex h-9 w-9 items-center justify-center rounded-lg text-xl transition-all ${icon === ic ? "bg-indigo-100 ring-2 ring-indigo-400" : "bg-slate-50 hover:bg-slate-100"}`}
                >
                  {ic}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-medium text-slate-600">名称</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) handleSave(onSave); if (e.key === "Escape") onClose(); }}
              placeholder="给这个 LOOP 起个名字，例如：XX大学学信网核验"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-200"
            />
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-medium text-slate-600">分组（GROUP，可选）</label>
            {group === "" ? (
              /* 新建分组：输入名字 */
              <div className="flex items-center gap-1.5">
                <input
                  autoFocus
                  value={newGroup}
                  onChange={(e) => setNewGroup(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); if (newGroup.trim()) setGroup(newGroup.trim()); }
                    if (e.key === "Escape") setGroup(undefined);
                  }}
                  placeholder="输入新分组名，如：XX大学核验"
                  className="min-w-0 flex-1 rounded-lg border border-indigo-300 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-200"
                />
                <button
                  onClick={() => { if (newGroup.trim()) setGroup(newGroup.trim()); }}
                  disabled={!newGroup.trim()}
                  className="shrink-0 rounded-lg bg-indigo-600 px-2.5 py-2 text-[12px] font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
                >
                  确定
                </button>
                <button
                  onClick={() => { setGroup(undefined); setNewGroup(""); }}
                  className="shrink-0 rounded-lg px-2 py-2 text-[12px] text-slate-500 hover:bg-slate-100"
                >
                  取消
                </button>
              </div>
            ) : (
              /* 选择已有分组 或 不分组 */
              <div className="flex flex-wrap gap-1.5">
                <button
                  onClick={() => setGroup(undefined)}
                  className={`rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-all ${group === undefined ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
                >
                  不分组
                </button>
                {(groups || []).map((g) => (
                  <button
                    key={g}
                    onClick={() => setGroup(g)}
                    className={`rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-all ${group === g ? "bg-indigo-600 text-white" : "bg-indigo-50 text-indigo-700 hover:bg-indigo-100"}`}
                  >
                    {g}
                  </button>
                ))}
                <button
                  onClick={() => setGroup("")}
                  className="flex items-center gap-1 rounded-lg border border-dashed border-slate-300 px-2.5 py-1.5 text-[12px] font-medium text-slate-500 hover:border-indigo-400 hover:text-indigo-600"
                >
                  <FolderPlus className="h-3.5 w-3.5" /> 新建分组
                </button>
              </div>
            )}
            {group !== "" && group && group === defaultGroup && (
              <p className="mt-1.5 text-[10px] text-indigo-500">连续设计：已自动延续上一个 LOOP 的分组，点「不分组」可退出</p>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3">
          <button
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-slate-600 hover:bg-slate-200"
          >
            取消
          </button>
          {onSaveAndRun && (
            <button
              onClick={() => handleSave(onSaveAndRun)}
              disabled={!name.trim()}
              className={[
                "flex items-center gap-1 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-all",
                name.trim() ? "bg-brand-600 text-white hover:bg-brand-700" : "cursor-not-allowed bg-slate-200 text-slate-400",
              ].join(" ")}
            >
              保存并执行
            </button>
          )}
          <button
            onClick={() => handleSave(onSave)}
            disabled={!name.trim()}
            className={[
              "flex items-center gap-1 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-all",
              name.trim() ? "bg-emerald-600 text-white hover:bg-emerald-700" : "cursor-not-allowed bg-slate-200 text-slate-400",
            ].join(" ")}
          >
            <Check className="h-3 w-3" />
            保存 LOOP
          </button>
        </div>
      </div>
    </div>
  );
}
