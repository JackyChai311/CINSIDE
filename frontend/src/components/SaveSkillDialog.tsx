import { useEffect, useState } from "react";
import { X, Check } from "lucide-react";
import { getDefaultIcons } from "../lib/skills";

interface SaveSkillDialogProps {
  open: boolean;
  defaultName: string;
  onClose: () => void;
  onSave: (name: string, icon: string) => void;
  onSaveAndRun?: (name: string, icon: string) => void;
}

export default function SaveSkillDialog({ open, defaultName, onClose, onSave, onSaveAndRun }: SaveSkillDialogProps) {
  const [name, setName] = useState(defaultName);
  const [icon, setIcon] = useState("🔍");

  useEffect(() => {
    if (open) {
      setName(defaultName);
      setIcon("🔍");
    }
  }, [open, defaultName]);

  if (!open) return null;

  const icons = getDefaultIcons();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[min(420px,calc(100vw-2rem))] overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <span className="text-sm font-semibold text-slate-800">保存为 SKILL</span>
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
              onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) onSave(name.trim(), icon); if (e.key === "Escape") onClose(); }}
              placeholder="给这个 SKILL 起个名字，例如：XX大学学信网核验"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-200"
            />
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
              onClick={() => name.trim() && onSaveAndRun(name.trim(), icon)}
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
            onClick={() => name.trim() && onSave(name.trim(), icon)}
            disabled={!name.trim()}
            className={[
              "flex items-center gap-1 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-all",
              name.trim() ? "bg-emerald-600 text-white hover:bg-emerald-700" : "cursor-not-allowed bg-slate-200 text-slate-400",
            ].join(" ")}
          >
            <Check className="h-3 w-3" />
            保存 SKILL
          </button>
        </div>
      </div>
    </div>
  );
}
