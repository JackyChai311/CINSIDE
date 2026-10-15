"""兼容入口：MRZ 噪声用例已迁到 tests/test_mrz_noise.py（由 pytest 收集）。

为什么迁走：pyproject.toml 里 testpaths = ["tests"]，放在 backend/ 根目录的文件
默认不会被 pytest 收集；而且本脚本原来的 print 会在 Windows GBK 控制台抛
UnicodeEncodeError。用例本体（含全部断言）原样保留在 tests/test_mrz_noise.py。

用法（两种等价）:
    .venv\\Scripts\\python.exe test_mrz_noise.py      # 本脚本转调 pytest
    .venv\\Scripts\\python.exe -m pytest tests/test_mrz_noise.py -q
"""
import subprocess
import sys
from pathlib import Path

if __name__ == "__main__":
    target = Path(__file__).resolve().parent / "tests" / "test_mrz_noise.py"
    raise SystemExit(subprocess.call([sys.executable, "-m", "pytest", str(target), "-q"]))
