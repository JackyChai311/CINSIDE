"""内置本地 OCR 引擎（RapidOCR / PP-OCRv6）——「核显加速」开关的实际执行者。

设计：
- 开关开启时，umi 引擎的识别请求不再走 UMI-OCR 的 HTTP 接口，改走本模块内置引擎。
- 后端三选一（自检实测决定，每台机器各自跑一遍小图）：
    1. DirectML GPU（DirectX 12 通用推理，Intel / AMD / NVIDIA 显卡通吃）
    2. OpenVINO CPU（对 Intel CPU 有指令级优化；AMD 也能跑，慢则自动弃用）
    3. onnxruntime CPU（永久的兜底）
  任何候选输出乱码或反而更慢就落到下一档——绝不允许"开了加速反而变慢"。
- OpenVINO 直接读包内置的 PP-OCRv6 onnx 模型（OV 原生支持 onnx 输入），
  零联网下载；与 CPU 路径同模型，对比公平。
- DirectML 探测放子进程（老显卡驱动可能卡死数分钟，必须可强杀）；
  OpenVINO / onnxruntime 探测在进程内完成。
- 自检在后台线程执行（首次 OCR 前完成；应用启动时也会预热），结果缓存于内存。

实测参考（i5-1155G7，2026-08）：ORT-CPU≈750ms/张；
OpenVINO≈405ms/张（快 46%，文本逐字一致）；DirectML 在 Iris Xe 老驱动上
54~225s/张且乱码 → 本机自检结果应为 openvino。
"""
from __future__ import annotations

import io
import re
import subprocess
import threading
import time

from ..config import _USER_DATA_DIR


def _flog(msg: str) -> None:
    """关键事件落 extract.log（与 document_extract 同文件同格式）——
    Electron 打包后 stdout 不落盘，不写文件事后无法查证加速是否生效。"""
    try:
        p = _USER_DATA_DIR / "extract.log"
        if p.exists() and p.stat().st_size > 2 * 1024 * 1024:
            p.unlink()
        with p.open("a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")
    except Exception:
        pass


_lock = threading.Lock()
_state: dict = {
    "installed": False,     # rapidocr 包是否可用
    "backend": "",          # 实际锁定的后端：directml | cpu
    "tested": False,        # 自检是否已完成
    "testing": False,       # 自检进行中
    "detail": "",           # 人类可读状态说明
    "gpu_name": "",         # 自检通过时记录的显卡名
    "last_ms": 0,           # 最近一次识别耗时（毫秒）
    "install_error": "",    # import 失败原因
}
_engine = None          # 锁定后端的 RapidOCR 实例
_engine_backend = ""    # _engine 对应的后端名

# 自检超时：GPU 后端在一张 360x120 小图上超过该秒数即判"过慢"（正常应 <2s）
_SELFTEST_TIMEOUT_S = 30.0


def _try_import():
    """尝试导入 rapidocr，更新 installed 状态。"""
    if _state["installed"]:
        return True
    try:
        from rapidocr import RapidOCR  # noqa: F401
        _state["installed"] = True
        _state["install_error"] = ""
    except Exception as e:  # ImportError 及依赖缺失
        _state["installed"] = False
        _state["install_error"] = str(e)
    return _state["installed"]


def reset_for_reinstall():
    """依赖一键安装完成后调用：清掉旧引擎单例与自检结果，让下次重新探测。

    （pip 装新包后，进程内已有的失败导入结果与旧实例都不可信，必须重置。）
    """
    global _engine, _engine_backend
    with _lock:
        _engine = None
        _engine_backend = ""
        _state.update(tested=False, testing=False, backend="", detail="", gpu_name="", last_ms=0)


def _dml_available() -> bool:
    """onnxruntime 是否带 DirectML 后端。"""
    try:
        import onnxruntime as ort
        return "DmlExecutionProvider" in ort.get_available_providers()
    except Exception:
        return False


def _selftest_image() -> bytes:
    """生成自检图：中等尺寸（推理耗时有区分度）+ 单行清晰印刷文本。"""
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("RGB", (640, 220), (255, 255, 255))
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", 48)
    except Exception:
        font = ImageFont.load_default()
    d.text((30, 80), "GPU TEST 12345", fill=(0, 0, 0), font=font)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _warm_infer(engine, content: bytes, runs: int = 3) -> tuple[float, str]:
    """热跑计时：跑 runs 次，返回 (第2次起最快耗时ms, 最后一次的识别文本)。

    首轮包含引擎初始化/模型编译/着色器生成等一次性开销，必须剔除——
    否则会错杀真实更快的后端（如 OpenVINO 首跑慢、热跑快 46%）。
    """
    times: list[float] = []
    text = ""
    for i in range(runs):
        t0 = time.perf_counter()
        r = engine(content)
        times.append(time.perf_counter() - t0)
        txts = getattr(r, "txts", None) or []
        text = " ".join(str(t) for t in txts)
    warm = min(times[1:]) if len(times) > 1 else times[0]
    return warm * 1000, text


def _norm_text(s: str) -> str:
    """自检文本归一化：只留字母数字大写，忽略空白。"""
    return re.sub(r"[^A-Z0-9]", "", (s or "").upper())


def _bundled_models_dir():
    """包内置模型目录（rapidocr/models），OpenVINO 直接读这些 onnx，零下载。"""
    from pathlib import Path

    import rapidocr

    return Path(rapidocr.__file__).parent / "models"


def _make_engine(backend: str):
    """按后端名构建 RapidOCR 实例：directml | openvino | cpu。

    准确性调参（对全部后端统一生效，基准实测无速度回归）：
    - box_thresh 0.5→0.45： faint 文本行（低对比 MRZ/灰色小字）不再被检测阶段丢弃
    - unclip_ratio 1.6→1.8：检测框外扩更多 padding，识别模型不再吃到被削边的字符
      （PaddleOCR 官方"准确"档预设即 1.8）
    - text_score 0.5→0.45：低置信行保留（后续 MRZ 校验和/LLM 排版会再过滤）

    模型档位教训（2026-08-15）：曾试升 medium/medium（合成劣化图基准 100% 准确），
    但真实 1600px 投喂图 OV 后端要 9~21s/张（合成小图仅 2~3s 完全测不出），
    叠加 ocr_bytes 串行锁排队 → 批量提取连环超时。已回退包内置 small。
    medium 模型留在 backend/ocr-models/ 备用，勿直接上生产。
    """
    from rapidocr import RapidOCR

    accuracy = {
        "Global.text_score": 0.45,
        "Det.box_thresh": 0.45,
        "Det.unclip_ratio": 1.8,
    }
    if backend == "directml":
        return RapidOCR(params={**accuracy, "EngineConfig.onnxruntime.use_dml": True})
    if backend == "openvino":
        from rapidocr.utils.typings import EngineType

        models = _bundled_models_dir()
        return RapidOCR(params={
            **accuracy,
            "Det.engine_type": EngineType.OPENVINO,
            "Cls.engine_type": EngineType.OPENVINO,
            "Rec.engine_type": EngineType.OPENVINO,
            "Det.model_path": str(models / "PP-OCRv6_det_small.onnx"),
            "Cls.model_path": str(models / "ch_ppocr_mobile_v2.0_cls_mobile.onnx"),
            "Rec.model_path": str(models / "PP-OCRv6_rec_small.onnx"),
        })
    return RapidOCR(params=accuracy)


def _run_engine_text(engine, content: bytes) -> str:
    r = engine(content)
    txts = getattr(r, "txts", None)
    if not txts:
        return ""
    return " ".join(str(t) for t in txts)


def _probe_dml_subprocess(content: bytes) -> tuple[str, float]:
    """在子进程里探测 DirectML（老显卡驱动可能卡死数分钟，必须可强杀）。

    只计热跑推理耗时（跑 2 次取第 2 次），剔除 python 启动/导入/引擎初始化
    等一次性开销——否则健康显卡会因 init 慢被冤枉。返回 (识别文本, 热跑ms)。
    """
    import json as _json
    import os
    import subprocess as _sp
    import sys as _sys
    import tempfile

    code = (
        "import sys, json, time\n"
        "from rapidocr import RapidOCR\n"
        "e = RapidOCR(params={'EngineConfig.onnxruntime.use_dml': True})\n"
        "img = open(sys.argv[1], 'rb').read()\n"
        "e(img)  # 首跑：含驱动着色器编译等一次性开销，不计\n"
        "t0 = time.perf_counter()\n"
        "r = e(img)\n"
        "ms = (time.perf_counter() - t0) * 1000\n"
        "txt = ' '.join(map(str, r.txts or []))\n"
        "print(json.dumps({'text': txt, 'ms': ms}))\n"
    )
    with tempfile.TemporaryDirectory() as td:
        img_path = os.path.join(td, "probe.png")
        with open(img_path, "wb") as f:
            f.write(content)
        proc = _sp.run(
            [_sys.executable, "-c", code, img_path],
            capture_output=True, text=True,
            timeout=_SELFTEST_TIMEOUT_S,
            creationflags=getattr(_sp, "CREATE_NO_WINDOW", 0),
        )
        last = (proc.stdout or "").strip().splitlines()[-1] if (proc.stdout or "").strip() else ""
        d = _json.loads(last)
        return d.get("text", ""), float(d.get("ms", 0))


def run_selftest() -> dict:
    """GPU 后端自检入口：正确性（与 CPU 逐字一致）+ 速度（不得比 CPU 慢）。

    返回最新状态字典。线程安全；已在跑时直接返回当前状态。
    """
    with _lock:
        if _state["testing"]:
            return dict(_state)
        _state["testing"] = True
    try:
        _do_selftest()
    finally:
        with _lock:
            _state["testing"] = False
    return dict(_state)


def _do_selftest() -> None:
    if not _try_import():
        _state.update(tested=True, backend="", detail=f"内置引擎未安装：{_state['install_error'][:120]}")
        return

    content = _selftest_image()
    expect = "GPUTEST12345"

    # 1) CPU 基准（始终可用；热跑计时，剔除首跑编译开销）
    try:
        cpu_engine = _make_engine("cpu")
        cpu_ms, cpu_text = _warm_infer(cpu_engine, content)
    except Exception as e:
        _state.update(tested=True, backend="", detail=f"内置引擎初始化失败（{type(e).__name__}），已回退 UMI-OCR 通道")
        return
    if _norm_text(cpu_text) != expect:
        _state.update(tested=True, backend="", detail="内置引擎 CPU 自身识别异常，已回退 UMI-OCR 通道")
        return

    # 2) DirectML 候选（Intel/AMD/NVIDIA 通用；子进程探测防驱动卡死）
    dml_note = ""
    if _dml_available():
        try:
            dml_text, dml_ms = _probe_dml_subprocess(content)
            if _norm_text(dml_text) != expect:
                dml_note = "显卡 DirectML 输出异常（乱码）"
            elif dml_ms > cpu_ms * 1.2:
                dml_note = f"显卡 DirectML 更慢（{dml_ms:.0f}ms vs CPU {cpu_ms:.0f}ms）"
            else:
                gpu_name = ""
                try:
                    from .gpu_detect import get_primary_gpu_name
                    gpu_name = get_primary_gpu_name()
                except Exception:
                    pass
                _state.update(tested=True, backend="directml", gpu_name=gpu_name,
                              detail=f"显卡加速已启用（DirectML，GPU {dml_ms:.0f}ms vs CPU {cpu_ms:.0f}ms）")
                return
        except subprocess.TimeoutExpired:
            dml_note = f"显卡 DirectML 过慢（超 {_SELFTEST_TIMEOUT_S:.0f}s）"
        except Exception as e:
            dml_note = f"DirectML 初始化失败（{type(e).__name__}）"
    else:
        dml_note = "未检测到 DirectML 运行时"

    # 3) OpenVINO CPU 候选（Intel CPU 指令级优化；AMD 也能跑，慢则弃）
    ov_note = ""
    try:
        import openvino  # noqa: F401

        ov_engine = _make_engine("openvino")
        ov_ms, ov_text = _warm_infer(ov_engine, content)
        if _norm_text(ov_text) != expect:
            ov_note = "OpenVINO 输出异常"
        elif ov_ms > cpu_ms * 0.85:
            ov_note = f"OpenVINO 无优势（{ov_ms:.0f}ms vs CPU {cpu_ms:.0f}ms）"
        else:
            _state.update(tested=True, backend="openvino",
                          detail=f"CPU 加速已启用（OpenVINO，{ov_ms:.0f}ms vs 基准 {cpu_ms:.0f}ms）")
            return
    except ImportError:
        ov_note = "OpenVINO 未安装"
    except Exception as e:
        ov_note = f"OpenVINO 初始化失败（{type(e).__name__}）"

    # 4) 兜底：onnxruntime CPU（如实带上前面候选被拒的原因）
    notes = "; ".join(n for n in (dml_note, ov_note) if n)
    _state.update(tested=True, backend="cpu",
                  detail=f"已用 CPU 内置引擎（onnxruntime）{('——' + notes) if notes else ''}")


def start_background_selftest() -> None:
    """应用启动时后台预热自检（守护线程，不阻塞启动）。"""
    if _state["tested"] or _state["testing"]:
        return
    t = threading.Thread(target=run_selftest, name="gpu-ocr-selftest", daemon=True)
    t.start()


def get_status() -> dict:
    """当前内置引擎状态（供设置面板展示）。"""
    return dict(_state)


def _ensure_engine():
    """按自检锁定的后端懒加载引擎单例。"""
    global _engine, _engine_backend
    if not _state["tested"]:
        run_selftest()
    backend = _state["backend"] or "cpu"
    if _engine is None or _engine_backend != backend:
        _engine = _make_engine(backend)
        _engine_backend = backend
    return _engine, backend


def ocr_bytes(content: bytes) -> tuple[str, list, tuple[int, int]]:
    """同步识别图片字节，返回 (全文文本, 文本框列表, (宽, 高))。

    返回形状与 document_extract._call_umi_ocr(want_boxes=True) 一致。
    失败抛异常，由调用方回退 UMI-OCR。
    """
    t0 = time.perf_counter()
    engine, backend = _ensure_engine()
    with _lock:  # 推理串行化，避免高速模式并发下会话竞争
        result = engine(content)
    _state["last_ms"] = int((time.perf_counter() - t0) * 1000)

    txts = list(getattr(result, "txts", None) or [])
    boxes_raw = getattr(result, "boxes", None)
    boxes: list = []
    if boxes_raw is not None:
        try:
            boxes = [b.tolist() for b in boxes_raw]
        except Exception:
            boxes = list(boxes_raw)
    text = "\n".join(str(t) for t in txts).strip()

    # 图片尺寸（投喂图坐标系，供上层按文本区域裁图）
    size = (0, 0)
    try:
        from PIL import Image as _Img
        with _Img.open(io.BytesIO(content)) as im:
            size = (im.size[0], im.size[1])
    except Exception:
        pass
    if backend in ("directml", "openvino", "cpu"):
        print(f"[GPU-OCR] {backend} 识别完成 {len(txts)} 块，{_state['last_ms']}ms", flush=True)
        _flog(f"[GPU-OCR] {backend} 识别完成 {len(txts)} 块，{_state['last_ms']}ms")
    return text, boxes, size
