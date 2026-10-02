#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把 electron-builder 的构建产物发布到对象存储（阿里云 OSS / 兼容 S3 的对象存储）。

用途：
  Gitee 只托管源码，安装包放对象存储，客户端通过 electron-updater 的
  generic provider 从对象存储检查并下载更新。

前置：
  1. pip install oss2
  2. 配置环境变量（不要写进代码或提交到仓库）：
       OSS_ACCESS_KEY_ID      AccessKey ID
       OSS_ACCESS_KEY_SECRET  AccessKey Secret
       OSS_ENDPOINT           如 https://oss-cn-hangzhou.aliyuncs.com
       OSS_BUCKET             如 cinside-release
       OSS_PREFIX             可选，对象前缀，默认 cinside/releases

  该前缀必须与 frontend/package.json 中 build.publish[0].url 的后半段一致，
  例如 url = https://<bucket>.<endpoint>/cinside/releases

用法：
  cd frontend
  python scripts/publish-oss.py                 # 发布 dist-electron 下的最新版本
  python scripts/publish-oss.py --dry-run       # 只列出将上传的文件，不实际上传
  python scripts/publish-oss.py --dir ../dist-electron
"""

import argparse
import os
import sys
import re
from pathlib import Path

try:
    import yaml
except ImportError:
    yaml = None


def load_latest_yml(out_dir: Path) -> dict:
    """读取 electron-builder 生成的 latest.yml。"""
    yml_path = out_dir / "latest.yml"
    if not yml_path.is_file():
        sys.exit(f"[x] 找不到 {yml_path}，请先执行 npm run electron:build 生成安装包。")
    text = yml_path.read_text(encoding="utf-8")
    if yaml is not None:
        return yaml.safe_load(text)
    # 没装 PyYAML 时的极简解析（只取本脚本需要的字段）
    data = {"files": []}
    cur = None
    for line in text.splitlines():
        m = re.match(r"^version:\s*(.+)$", line)
        if m:
            data["version"] = m.group(1).strip()
        m = re.match(r"^path:\s*(.+)$", line)
        if m:
            data["path"] = m.group(1).strip()
        m = re.match(r"^-?\s*url:\s*(.+)$", line)
        if m:
            cur = {"url": m.group(1).strip()}
            data["files"].append(cur)
    return data


def resolve_local_file(out_dir: Path, url_name: str, version: str) -> Path | None:
    """
    latest.yml 里的 url 名（如 CINSIDE-Setup-0.7.9.exe）与磁盘文件名
    （如 'CINSIDE Setup 0.7.9.exe'，带空格）不一定一致，需要按版本号兜底匹配。
    """
    direct = out_dir / url_name
    if direct.is_file():
        return direct

    # 把 url 名里的连字符还原为空格再试
    alt = out_dir / url_name.replace("-", " ")
    if alt.is_file():
        return alt

    # 按版本号 + 后缀兜底扫描
    suffix = Path(url_name).suffix
    for f in out_dir.iterdir():
        if f.is_file() and version in f.name and f.suffix == suffix:
            if "Setup" in f.name or "Setup" in url_name:
                if "Setup" in f.name:
                    return f
            else:
                return f
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description="发布构建产物到对象存储")
    default_dir = Path(__file__).resolve().parent.parent.parent / "dist-electron"
    ap.add_argument("--dir", default=str(default_dir), help="构建产物目录（默认仓库根 dist-electron）")
    ap.add_argument("--prefix", default=os.environ.get("OSS_PREFIX", "cinside/releases"),
                    help="对象前缀，默认 cinside/releases")
    ap.add_argument("--dry-run", action="store_true", help="只列出将上传的文件")
    ap.add_argument("--allow-version-mismatch", action="store_true",
                    help="跳过 package.json 与 latest.yml 的版本一致性校验（危险，仅特殊情况下使用）")
    args = ap.parse_args()

    out_dir = Path(args.dir).resolve()
    if not out_dir.is_dir():
        sys.exit(f"[x] 目录不存在：{out_dir}")

    meta = load_latest_yml(out_dir)
    version = str(meta.get("version", "")).strip()
    if not version:
        sys.exit("[x] latest.yml 里读不到 version 字段。")

    # ---- 版本一致性校验 ----
    # 防止把旧的构建产物当成最新版发布（会让客户端「降级」）。
    # latest.yml 由 electron-builder 依据 package.json 的 version 生成，
    # 两者不一致说明产物目录是历史的、没有重新构建过。
    pkg_json = Path(__file__).resolve().parent.parent / "package.json"
    pkg_version = ""
    if pkg_json.is_file():
        try:
            import json as _json
            pkg_version = str(_json.loads(pkg_json.read_text(encoding="utf-8")).get("version", "")).strip()
        except Exception:  # noqa: BLE001
            pkg_version = ""

    if pkg_version and pkg_version != version and not args.allow_version_mismatch:
        sys.exit(
            f"[x] 版本不一致，拒绝发布。\n"
            f"    package.json 版本：{pkg_version}\n"
            f"    产物 latest.yml 版本：{version}\n\n"
            f"    说明：{out_dir} 里是旧版本的构建产物（例如本机停留在上次本地构建的版本），\n"
            f"    直接上传会把旧版当成最新版推给客户端，导致已安装用户收到「降级」更新。\n\n"
            f"    请先重新构建：cd frontend && npm run electron:build\n"
            f"    确认无误后重跑本脚本；如确实要强制发布，加 --allow-version-mismatch。"
        )

    print(f"package.json 版本：{pkg_version or '(未知)'}    产物版本：{version}")

    # 需要上传的文件对：(本地路径, 对象存储里的名字)
    uploads: list[tuple[Path, str]] = []

    for entry in meta.get("files", []):
        url_name = entry.get("url")
        if not url_name:
            continue
        local = resolve_local_file(out_dir, url_name, version)
        if local is None:
            sys.exit(f"[x] 找不到 latest.yml 声明的文件：{url_name}（版本 {version}）")
        uploads.append((local, url_name))
        # blockmap 用于增量更新，存在就一起传
        bm = Path(str(local) + ".blockmap")
        if not bm.is_file():
            bm = local.with_name(local.name.replace(".exe", ".exe.blockmap"))
        if bm.is_file():
            uploads.append((bm, url_name + ".blockmap"))

    uploads.append((out_dir / "latest.yml", "latest.yml"))

    print(f"版本：{version}")
    print(f"目标：oss://$OSS_BUCKET/{args.prefix}/")
    print("待上传：")
    total = 0
    for local, name in uploads:
        size = local.stat().st_size
        total += size
        print(f"  {size/1048576:8.1f} MB  {name}   <- {local.name}")
    print(f"合计：{total/1048576:.1f} MB")

    if args.dry_run:
        print("\n[dry-run] 未实际上传。")
        return 0

    # ---- 依赖与配置检查 ----
    try:
        import oss2
    except ImportError:
        sys.exit("\n[x] 缺少依赖 oss2，请先执行：pip install oss2")

    ak = os.environ.get("OSS_ACCESS_KEY_ID", "").strip()
    sk = os.environ.get("OSS_ACCESS_KEY_SECRET", "").strip()
    endpoint = os.environ.get("OSS_ENDPOINT", "").strip()
    bucket = os.environ.get("OSS_BUCKET", "").strip()
    missing = [k for k, v in {
        "OSS_ACCESS_KEY_ID": ak, "OSS_ACCESS_KEY_SECRET": sk,
        "OSS_ENDPOINT": endpoint, "OSS_BUCKET": bucket,
    }.items() if not v]
    if missing:
        sys.exit(
            "\n[x] 缺少环境变量：" + ", ".join(missing) +
            "\n    请先配置（PowerShell 示例，仅当前窗口有效）：\n"
            "      $env:OSS_ACCESS_KEY_ID='...'\n"
            "      $env:OSS_ACCESS_KEY_SECRET='...'\n"
            "      $env:OSS_ENDPOINT='https://oss-cn-hangzhou.aliyuncs.com'\n"
            "      $env:OSS_BUCKET='your-bucket'\n"
        )

    auth = oss2.Auth(ak, sk)
    bucket_obj = oss2.Bucket(auth, endpoint, bucket)

    ok = 0
    for local, name in uploads:
        key = f"{args.prefix.strip('/')}/{name}"
        try:
            bucket_obj.put_object_from_file(key, str(local))
            ok += 1
            print(f"  [ok] {key}")
        except Exception as e:  # noqa: BLE001
            print(f"  [!!] {key} 上传失败：{e}")

    if ok != len(uploads):
        sys.exit(f"\n[x] 有 {len(uploads)-ok} 个文件上传失败。")

    base = f"https://{bucket}.{endpoint.replace('https://','').replace('http://','')}/{args.prefix.strip('/')}"
    print("\n发布完成。")
    print(f"  更新清单：{base}/latest.yml")
    print(f"  安装包下载：{base}/{meta.get('path', '')}")
    print("\n提示：请确认 frontend/package.json 的 build.publish[0].url 与该地址前缀一致。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
