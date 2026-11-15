"""Excel 对象的操控层。

设计取舍：
  * **绝不改动用户原文件** —— 打开时先复制一份工作副本，所有写入落在副本上，
    显式 `export` 才落回用户指定路径。用户在任务中途叫停也不会毁掉源数据。
  * 单元格寻址同时支持 A1 记法（`B7`）与表头名（`姓名`/`C` 列名 + 行号），
    模型不用先记住列序号。
  * 只依赖 openpyxl（项目已有），CSV 也统一转成 xlsx 工作副本，写入语义一致。
"""
from __future__ import annotations

import asyncio
import csv
import os
import re
import shutil
import time
from pathlib import Path
from typing import Any

MAX_READ_ROWS = 400
MAX_SHEET_ROWS = 20000


class ExcelError(RuntimeError):
    pass


def col_to_index(col: str) -> int:
    """A → 1, Z → 26, AA → 27。"""
    n = 0
    for ch in col.strip().upper():
        if not ("A" <= ch <= "Z"):
            raise ExcelError(f"列标识非法：{col}")
        n = n * 26 + (ord(ch) - 64)
    return n


def index_to_col(idx: int) -> str:
    out = ""
    idx = max(1, int(idx))
    while idx:
        idx, rem = divmod(idx - 1, 26)
        out = chr(65 + rem) + out
    return out


def _coerce(value: Any) -> Any:
    """数字样式的字符串转成数字，其余保持原样。前导 0 的编号保持字符串。"""
    if value is None:
        return None
    if isinstance(value, (int, float, bool)):
        return value
    s = str(value)
    if not s.strip():
        return ""
    if re.fullmatch(r"-?\d{1,15}", s) and not (len(s.lstrip("-")) > 1 and s.lstrip("-").startswith("0")):
        try:
            return int(s)
        except ValueError:
            return s
    if re.fullmatch(r"-?\d{1,15}\.\d{1,8}", s):
        try:
            return float(s)
        except ValueError:
            return s
    return s


class ExcelTarget:
    """一个 Excel 工作簿目标。"""

    def __init__(self, source_path: str, work_dir: str, *, label: str = "Excel"):
        self.source_path = os.path.abspath(source_path) if source_path else ""
        self.label = label
        self.work_dir = Path(work_dir)
        self.work_dir.mkdir(parents=True, exist_ok=True)
        self._wb = None
        self._work_path = ""
        self._dirty = False
        self._lock = asyncio.Lock()
        self.writes = 0
        self.opened_at = 0.0
        self.kind = ""

    # ---------- 打开 ----------

    def _open_sync(self) -> None:
        from openpyxl import Workbook, load_workbook

        src = Path(self.source_path)
        if not self.source_path or not src.exists():
            raise ExcelError(f"Excel 文件不存在：{self.source_path}")

        suffix = src.suffix.lower()
        stem = re.sub(r"[^\w\-\u4e00-\u9fff]+", "_", src.stem)[:40] or "workbook"
        self._work_path = str(self.work_dir / f"{stem}.work.xlsx")

        if suffix in (".xlsx", ".xlsm"):
            # 直接在工作副本上改，源文件只读
            shutil.copyfile(src, self._work_path)
            self._wb = load_workbook(self._work_path, data_only=False)
            self.kind = suffix.lstrip(".")
        elif suffix == ".csv":
            wb = Workbook()
            ws = wb.active
            ws.title = src.stem[:28] or "Sheet1"
            with open(src, "r", encoding="utf-8-sig", newline="") as f:
                sample = f.read(4096)
                f.seek(0)
                try:
                    dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
                except csv.Error:
                    dialect = csv.excel
                for row in csv.reader(f, dialect):
                    ws.append([_coerce(c) for c in row])
            wb.save(self._work_path)
            self._wb = load_workbook(self._work_path)
            self.kind = "csv"
        else:
            raise ExcelError(f"不支持的表格格式：{suffix or '未知'}（HARNESS 支持 .xlsx / .xlsm / .csv）")

        self.opened_at = time.time()

    async def open(self) -> "ExcelTarget":
        if self._wb is not None:
            return self
        await asyncio.to_thread(self._open_sync)
        return self

    # ---------- 内部工具 ----------

    def _ws(self, sheet: str = ""):
        if self._wb is None:
            raise ExcelError("工作簿未打开")
        if sheet:
            if sheet not in self._wb.sheetnames:
                raise ExcelError(f"没有名为「{sheet}」的工作表，可用：{self._wb.sheetnames}")
            return self._wb[sheet]
        return self._wb[self._wb.sheetnames[0]]

    @staticmethod
    def _header_row(ws) -> int:
        """第一个非空行视为表头行。"""
        for row in ws.iter_rows(min_row=1, max_row=min(30, ws.max_row or 1)):
            if any(c.value is not None and str(c.value).strip() != "" for c in row):
                return row[0].row
        return 1

    def _headers(self, ws) -> dict[str, int]:
        hr = self._header_row(ws)
        out: dict[str, int] = {}
        for cell in ws[hr]:
            if cell.value is None:
                continue
            name = str(cell.value).strip()
            if name and name not in out:
                out[name] = cell.column
        return out

    def _resolve_column(self, ws, spec: str) -> int:
        """把 'B' / '2' / '姓名' 解析成列号。"""
        s = str(spec or "").strip()
        if not s:
            raise ExcelError("列标识为空")
        headers = self._headers(ws)
        if s in headers:
            return headers[s]
        # 大小写/空格宽松匹配
        norm = {re.sub(r"\s+", "", k).lower(): v for k, v in headers.items()}
        key = re.sub(r"\s+", "", s).lower()
        if key in norm:
            return norm[key]
        if re.fullmatch(r"[A-Za-z]{1,2}", s):
            return col_to_index(s)
        if re.fullmatch(r"\d{1,3}", s):
            return int(s)
        # 模糊包含
        for name, idx in norm.items():
            if key and (key in name or name in key):
                return idx
        raise ExcelError(f"找不到列「{spec}」，现有表头：{list(headers)[:30]}")

    @staticmethod
    def _parse_range(ws, cell_range: str) -> tuple[int, int, int, int]:
        """解析 'A1:D20' → (min_row, max_row, min_col, max_col)。支持 'A1' 单格。"""
        rng = (cell_range or "").strip().replace("$", "").upper()
        if not rng:
            hr = ExcelTarget._header_row(ws)
            return hr, min(ws.max_row or hr, hr + MAX_READ_ROWS), 1, max(ws.max_column or 1, 1)
        m = re.fullmatch(r"([A-Z]{1,3})?(\d+)?(?::([A-Z]{1,3})?(\d+)?)?", rng)
        if not m or not any(m.groups()):
            raise ExcelError(f"区域写法不对：{cell_range}（示例：A1:D20、C5、A:C）")
        c1, r1, c2, r2 = m.groups()
        last_col = max(ws.max_column or 1, 1)
        last_row = max(ws.max_row or 1, 1)

        has_span = ":" in rng
        if has_span:
            min_col = col_to_index(c1) if c1 else 1
            max_col = col_to_index(c2) if c2 else last_col
            min_row = int(r1) if r1 else 1
            max_row = int(r2) if r2 else min(last_row, MAX_READ_ROWS)
        elif c1 and not r1:
            # 只给了列：整列
            min_col = max_col = col_to_index(c1)
            min_row = 1
            max_row = min(last_row, MAX_READ_ROWS)
        elif r1 and not c1:
            # 只给了行：整行
            min_row = max_row = int(r1)
            min_col = 1
            max_col = last_col
        else:
            # 单格
            min_col = max_col = col_to_index(c1) if c1 else 1
            min_row = max_row = int(r1) if r1 else 1

        if max_col < min_col:
            min_col, max_col = max_col, min_col
        if max_row < min_row:
            min_row, max_row = max_row, min_row
        return min_row, min(max_row, MAX_SHEET_ROWS), min_col, min(max_col, 200)

    def _autosave(self) -> None:
        if self._wb is None:
            return
        self._wb.save(self._work_path)

    # ---------- 观察 ----------

    def _summary_sync(self, max_rows: int) -> dict:
        assert self._wb is not None
        sheets = []
        for name in self._wb.sheetnames:
            ws = self._wb[name]
            hr = self._header_row(ws)
            headers = list(self._headers(ws).keys())
            sample = []
            for row in ws.iter_rows(min_row=hr + 1, max_row=min(ws.max_row or hr, hr + max_rows)):
                sample.append([("" if c.value is None else str(c.value))[:60] for c in row])
            sheets.append(
                {
                    "name": name,
                    "header_row": hr,
                    "headers": headers[:60],
                    "rows": max(0, (ws.max_row or hr) - hr),
                    "cols": max(ws.max_column or 0, len(headers)),
                    "sample": [r for r in sample if any(str(x).strip() for x in r)][:6],
                }
            )
        return {
            "file": os.path.basename(self.source_path),
            "work_copy": self._work_path,
            "kind": self.kind,
            "active": self._wb.sheetnames[0],
            "sheets": sheets,
            "writes": self.writes,
        }

    async def summary(self, max_rows: int = 6) -> dict:
        async with self._lock:
            await self.open()
            return await asyncio.to_thread(self._summary_sync, max_rows)

    def _read_sync(self, sheet: str, cell_range: str, with_header: bool) -> dict:
        ws = self._ws(sheet)
        r1, r2, c1, c2 = self._parse_range(ws, cell_range)
        rows = []
        for r in range(r1, r2 + 1):
            vals = [ws.cell(row=r, column=c).value for c in range(c1, c2 + 1)]
            if all(v is None or str(v).strip() == "" for v in vals):
                continue
            # 每行首元素是该行起始单元格地址（A2 / B2 …），方便模型说"写到 A7"
            rows.append([f"{index_to_col(c1)}{r}"] + [("" if v is None else v) for v in vals])
            if len(rows) >= MAX_READ_ROWS:
                break
        head: list[str] = []
        if with_header:
            hr = self._header_row(ws)
            head = [
                ("" if ws.cell(row=hr, column=c).value is None else str(ws.cell(row=hr, column=c).value))
                for c in range(c1, c2 + 1)
            ]
        return {
            "sheet": ws.title,
            "range": f"{index_to_col(c1)}{r1}:{index_to_col(c2)}{r2}",
            "header": head,
            "rows": rows,
            "returned": len(rows),
        }

    async def read(self, sheet: str = "", cell_range: str = "", with_header: bool = True) -> dict:
        async with self._lock:
            await self.open()
            return await asyncio.to_thread(self._read_sync, sheet, cell_range, with_header)

    def _write_sync(self, updates: list[dict]) -> dict:
        assert self._wb is not None
        written = []
        errors = []
        for up in updates[:200]:
            try:
                sheet = str(up.get("sheet") or "")
                cell = str(up.get("cell") or "").strip()
                if not cell:
                    raise ExcelError("缺少 cell")
                ws = self._ws(sheet)
                # 支持「表头名+行号」：姓名@7 / 姓名7
                m = re.fullmatch(r"(.+?)[@＠]?(\d+)$", cell)
                if not re.fullmatch(r"[A-Za-z]{1,3}\d+", cell) and m:
                    col = self._resolve_column(ws, m.group(1))
                    coord = f"{index_to_col(col)}{m.group(2)}"
                else:
                    coord = cell.upper()
                ws[coord] = _coerce(up.get("value"))
                written.append(f"{ws.title}!{coord}")
            except Exception as e:  # 单格失败不打断整批
                errors.append({"cell": up.get("cell"), "error": str(e)})
        if written:
            self.writes += len(written)
            self._dirty = True
            self._autosave()
        return {"ok": not errors, "written": written, "count": len(written), "errors": errors[:10]}

    async def write(self, updates: list[dict]) -> dict:
        async with self._lock:
            await self.open()
            return await asyncio.to_thread(self._write_sync, updates)

    def _fill_column_sync(
        self, sheet: str, column: str, values: list[Any], start_row: int
    ) -> dict:
        ws = self._ws(sheet)
        col = self._resolve_column(ws, column)
        start = int(start_row or (self._header_row(ws) + 1))
        for i, v in enumerate(values[:MAX_SHEET_ROWS]):
            ws.cell(row=start + i, column=col, value=_coerce(v))
        self.writes += min(len(values), MAX_SHEET_ROWS)
        self._dirty = True
        self._autosave()
        label = index_to_col(col)
        if str(column).strip().upper() != label:
            label = f"{label}（{column}）"
        return {
            "ok": True,
            "sheet": ws.title,
            "column": label,
            "start_row": start,
            "filled": min(len(values), MAX_SHEET_ROWS),
        }

    async def fill_column(
        self, sheet: str, column: str, values: list[Any], start_row: int = 0
    ) -> dict:
        async with self._lock:
            await self.open()
            return await asyncio.to_thread(self._fill_column_sync, sheet, column, values, start_row)

    def _append_row_sync(self, sheet: str, values: list[Any]) -> dict:
        ws = self._ws(sheet)
        ws.append([_coerce(v) for v in values])
        self.writes += 1
        self._dirty = True
        self._autosave()
        return {"ok": True, "sheet": ws.title, "row": ws.max_row, "cols": len(values)}

    async def append_row(self, sheet: str, values: list[Any]) -> dict:
        async with self._lock:
            await self.open()
            return await asyncio.to_thread(self._append_row_sync, sheet, values)

    def _find_sync(self, sheet: str, query: str, limit: int, column: str) -> dict:
        ws = self._ws(sheet)
        q = str(query or "").strip().lower()
        if not q:
            raise ExcelError("查询内容为空")
        col_filter = self._resolve_column(ws, column) if column else 0
        hits = []
        for row in ws.iter_rows(min_row=1, max_row=min(ws.max_row or 1, MAX_SHEET_ROWS)):
            cells = row if not col_filter else [row[col_filter - 1]] if len(row) >= col_filter else []
            if any(c.value is not None and q in str(c.value).lower() for c in cells):
                hits.append(
                    {"row": row[0].row, "values": [("" if c.value is None else str(c.value))[:80] for c in row]}
                )
            if len(hits) >= limit:
                break
        return {"ok": True, "sheet": ws.title, "query": query, "hits": hits, "count": len(hits)}

    async def find(self, sheet: str, query: str, limit: int = 20, column: str = "") -> dict:
        async with self._lock:
            await self.open()
            return await asyncio.to_thread(self._find_sync, sheet, query, limit, column)

    # ---------- 工作表 ----------

    def _sheet_sync(
        self, action: str, name: str, new_name: str, headers: list[Any] | None
    ) -> dict:
        assert self._wb is not None
        act = (action or "list").strip().lower()
        if act == "list":
            return {"ok": True, "sheets": list(self._wb.sheetnames), "active": self._wb.sheetnames[0]}

        if act == "create":
            target = (name or "").strip()
            if not target:
                raise ExcelError("创建工作表需要 name")
            if target in self._wb.sheetnames:
                return {"ok": False, "error": f"已存在同名工作表「{target}」，可用 action=rename 或换个名字"}
            ws = self._wb.create_sheet(title=target[:31])
            if headers:
                ws.append([_coerce(v) for v in headers[:100]])
            self._dirty = True
            self._autosave()
            return {
                "ok": True,
                "created": ws.title,
                "header_written": bool(headers),
                "sheets": list(self._wb.sheetnames),
                "next_row": 2 if headers else 1,
            }

        if act == "rename":
            src = (name or "").strip()
            if src not in self._wb.sheetnames:
                raise ExcelError(f"没有名为「{src}」的工作表，可用：{self._wb.sheetnames}")
            dst = (new_name or "").strip()
            if not dst:
                raise ExcelError("重命名需要 new_name")
            if dst in self._wb.sheetnames:
                raise ExcelError(f"目标工作表「{dst}」已存在")
            self._wb[src].title = dst[:31]
            self._dirty = True
            self._autosave()
            return {"ok": True, "renamed": [src, dst], "sheets": list(self._wb.sheetnames)}

        if act == "delete":
            src = (name or "").strip()
            if src not in self._wb.sheetnames:
                raise ExcelError(f"没有名为「{src}」的工作表")
            if len(self._wb.sheetnames) <= 1:
                raise ExcelError("工作簿至少要保留一个工作表，删除被拒绝")
            del self._wb[src]
            self._dirty = True
            self._autosave()
            return {"ok": True, "deleted": src, "sheets": list(self._wb.sheetnames)}

        raise ExcelError(f"不支持的操作：{action}（可用 create / rename / delete / list）")

    async def sheet(
        self,
        action: str = "list",
        name: str = "",
        new_name: str = "",
        headers: list[Any] | None = None,
    ) -> dict:
        async with self._lock:
            await self.open()
            return await asyncio.to_thread(self._sheet_sync, action, name, new_name, headers)

    # ---------- 落盘 / 导出 ----------

    async def save_as(self, dest_path: str) -> dict:
        """把工作副本另存到用户指定路径。"""
        async with self._lock:
            await self.open()
            if not dest_path:
                raise ExcelError("导出路径为空")
            dest = Path(dest_path)
            if dest.suffix.lower() != ".xlsx":
                dest = dest.with_suffix(".xlsx")
            dest.parent.mkdir(parents=True, exist_ok=True)

            def _do() -> str:
                self._autosave()  # 确保副本是最新的
                shutil.copyfile(self._work_path, dest)
                return str(dest)

            path = await asyncio.to_thread(_do)
            return {"ok": True, "saved": path, "writes": self.writes}

    async def preview_changes(self, limit: int = 30) -> list[dict]:
        """返回前若干行当前值，供 UI 展示「改成了什么」。"""
        async with self._lock:
            await self.open()
            return await asyncio.to_thread(self._preview_sync, limit)

    def _preview_sync(self, limit: int) -> list[dict]:
        ws = self._ws("")
        hr = self._header_row(ws)
        headers = [("" if c.value is None else str(c.value)) for c in ws[hr]]
        out = []
        for row in ws.iter_rows(min_row=hr + 1, max_row=min(ws.max_row or hr, hr + limit)):
            rec = {"_row": row[0].row}
            for i, cell in enumerate(row):
                name = headers[i] if i < len(headers) else index_to_col(cell.column)
                if name:
                    rec[name] = "" if cell.value is None else str(cell.value)
            out.append(rec)
        return out
