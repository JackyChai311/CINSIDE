"""PPT 教育风格模板库。

预制多套围绕教育学习用途的视觉风格，供 AI 生成 PPT 时选用；
也支持从参考 PPT 解析出的风格（StyleProfile 结构一致，可互换）。

设计风格时约定：
- palette: (accent 主色, tint 浅色底) 列表，逐页轮换
- cover_layout / content_layout: 版式变体标识
- title_size / body_size: 字号基调
- decor: 装饰元素开关（top_bar 顶部色带 / title_bar 标题竖条 / page_dot 页码圆点 / corner_chip 角落色块）
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict


@dataclass
class StyleProfile:
    """一套 PPT 视觉风格。字段保持扁平、可 JSON 化，方便 vision 解析参考 PPT 后填充。"""

    name: str = "scholar"                      # 风格标识
    display_name: str = "学术经典"              # 展示名
    palette: list[tuple[str, str]] = field(default_factory=list)  # [(accent, tint), ...]
    title_size: int = 30
    body_size: int = 18
    title_color: str = "#111827"
    body_color: str = "#334155"
    cover_layout: str = "center"               # center 居中 / split 上图下文
    content_layout: str = "card"               # card 正文卡片 / minimal 极简留白 / sidebar 侧边色块
    decor: list[str] = field(default_factory=lambda: ["top_bar", "title_bar"])
    style_notes: str = ""                      # 风格描述（给 LLM 看，也用于调试）

    def to_dict(self) -> dict:
        d = asdict(self)
        d["palette"] = [list(p) for p in self.palette]
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "StyleProfile":
        """从 dict 构造（用于参考 PPT 解析结果 / 前端传参），宽容处理缺失字段。"""
        if not isinstance(d, dict):
            return get_preset("scholar")
        palette_raw = d.get("palette") or []
        palette: list[tuple[str, str]] = []
        for p in palette_raw:
            if isinstance(p, (list, tuple)) and len(p) >= 2:
                palette.append((str(p[0]), str(p[1])))
        base = get_preset(str(d.get("name", "scholar")))
        return cls(
            name=str(d.get("name") or base.name),
            display_name=str(d.get("display_name") or base.display_name),
            palette=palette or base.palette,
            title_size=_safe_int(d.get("title_size"), base.title_size, 18, 44),
            body_size=_safe_int(d.get("body_size"), base.body_size, 12, 24),
            title_color=_safe_color(d.get("title_color"), base.title_color),
            body_color=_safe_color(d.get("body_color"), base.body_color),
            cover_layout=d.get("cover_layout") if d.get("cover_layout") in ("center", "split") else base.cover_layout,
            content_layout=d.get("content_layout") if d.get("content_layout") in ("card", "minimal", "sidebar") else base.content_layout,
            decor=[str(x) for x in (d.get("decor") or base.decor) if isinstance(x, str)],
            style_notes=str(d.get("style_notes") or ""),
        )


def _safe_int(v, default: int, lo: int, hi: int) -> int:
    try:
        n = int(v)
        return max(lo, min(hi, n))
    except (TypeError, ValueError):
        return default


def _safe_color(v, default: str) -> str:
    s = str(v or "").strip()
    if len(s) == 7 and s.startswith("#"):
        return s.upper()
    return default


# ---- 预制教育风格 ----

_PRESETS: dict[str, StyleProfile] = {}


def _register(p: StyleProfile) -> None:
    _PRESETS[p.name] = p


_register(StyleProfile(
    name="scholar",
    display_name="学术经典",
    palette=[
        ("#1E3A8A", "#EFF6FF"),  # 藏青
        ("#0F766E", "#F0FDFA"),  # 墨绿
        ("#7C2D12", "#FFF7ED"),  # 赭石
        ("#334155", "#F8FAFC"),  # 岩灰
    ],
    title_size=30,
    body_size=18,
    cover_layout="center",
    content_layout="card",
    decor=["top_bar", "title_bar"],
    style_notes="藏青主色、衬线感标题、正文卡片底，适合正式课程、讲座、学术汇报",
))

_register(StyleProfile(
    name="nature",
    display_name="清新自然",
    palette=[
        ("#059669", "#ECFDF5"),  # 翠绿
        ("#0D9488", "#F0FDFA"),  # 青碧
        ("#65A30D", "#F7FEE7"),  # 芽绿
        ("#0284C7", "#F0F9FF"),  # 天青
    ],
    title_size=30,
    body_size=18,
    cover_layout="split",
    content_layout="card",
    decor=["top_bar", "title_bar", "page_dot"],
    style_notes="绿色系、圆角卡片、留白充足，护眼清新，适合生物、地理、自然科学课件",
))

_register(StyleProfile(
    name="vibrant",
    display_name="活力橙",
    palette=[
        ("#EA580C", "#FFF7ED"),  # 暖橙
        ("#D97706", "#FFFBEB"),  # 琥珀
        ("#DC2626", "#FEF2F2"),  # 朱红
        ("#0891B2", "#ECFEFF"),  # 湖蓝
    ],
    title_size=32,
    body_size=18,
    cover_layout="split",
    content_layout="sidebar",
    decor=["top_bar", "corner_chip", "page_dot"],
    style_notes="暖橙主色、大标题、侧边色块，节奏明快，适合低龄课堂、活动课、动员宣讲",
))

_register(StyleProfile(
    name="violet",
    display_name="紫韵探索",
    palette=[
        ("#7C3AED", "#F5F3FF"),  # 紫罗兰
        ("#4F46E5", "#EEF2FF"),  # 靛蓝
        ("#C026D3", "#FDF4FF"),  # 品红
        ("#2563EB", "#EFF6FF"),  # 宝蓝
    ],
    title_size=30,
    body_size=18,
    cover_layout="center",
    content_layout="card",
    decor=["top_bar", "title_bar", "page_dot"],
    style_notes="紫蓝渐变感、梦幻探索氛围，适合科普、天文、人工智能、未来主题",
))

_register(StyleProfile(
    name="picture",
    display_name="绘本风",
    palette=[
        ("#EC4899", "#FDF2F8"),  # 柔粉
        ("#F59E0B", "#FFFBEB"),  # 奶黄
        ("#10B981", "#ECFDF5"),  # 薄荷
        ("#0EA5E9", "#F0F9FF"),  # 天蓝
    ],
    title_size=32,
    body_size=17,
    cover_layout="split",
    content_layout="card",
    decor=["top_bar", "corner_chip"],
    style_notes="糖果配色、圆润元素、大标题短句，适合儿童故事、绘本阅读、幼儿启蒙",
))

# 给 LLM 选风格用的简述
STYLE_CHOICES_BRIEF = "\n".join(
    f'- "{p.name}"（{p.display_name}）：{p.style_notes}' for p in _PRESETS.values()
)


def get_preset(name: str) -> StyleProfile:
    """按名取预设；未知名回退学术经典。"""
    return _PRESETS.get(name, _PRESETS["scholar"])


def list_presets() -> list[dict]:
    """所有预设风格（供前端/接口展示）。"""
    return [p.to_dict() for p in _PRESETS.values()]
