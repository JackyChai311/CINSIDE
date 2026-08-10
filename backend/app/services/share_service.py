"""LOOP 卡片分享服务：通过 GitHub Gist 实现联网短码分享。

- 创建分享：用 GITHUB_GIST_TOKEN 调用 GitHub API 创建 public gist，返回 gist ID
- 获取分享：读取 public gist 无需 token，任何人联网即可获取
- 无 token 或网络失败时，前端会回退到离线 base64 分享码
"""
from __future__ import annotations

import json
from typing import Any

import httpx

from app.config import settings

GIST_API = "https://api.github.com/gists"
GIST_FILE_NAME = "cinside-loop.json"
# 国内访问 GitHub API 的镜像（只读，用于获取 gist）
GIST_MIRRORS = [
    "https://ghfast.top/https://api.github.com/gists",
    "https://gh-proxy.com/https://api.github.com/gists",
    "https://ghproxy.net/https://api.github.com/gists",
]


def _sanitize_template(tpl: dict) -> dict:
    """剥离不适合分享的大体积/机器相关字段，与前端 skillShare.ts 保持一致。"""
    clean = {
        "name": tpl.get("name", "未命名模板"),
        "description": tpl.get("description"),
        "icon": tpl.get("icon"),
        "iconImage": tpl.get("iconImage"),
        "mode": tpl.get("mode", "loop"),
        "dataSourceMarks": tpl.get("dataSourceMarks", []),
        "reviewMarks": tpl.get("reviewMarks", []),
        "entryMarks": tpl.get("entryMarks", []),
        "mappings": tpl.get("mappings"),
        "flowGraph": tpl.get("flowGraph"),
        "hasSearchSteps": tpl.get("hasSearchSteps", False),
        "hasSubmitStep": tpl.get("hasSubmitStep", False),
    }

    # 剥离 marks 中的本地文件内容和绝对路径
    for key in ("dataSourceMarks", "reviewMarks", "entryMarks"):
        marks = clean.get(key) or []
        for m in marks:
            if not isinstance(m, dict):
                continue
            local_files = m.get("docLocalFiles")
            if isinstance(local_files, list):
                m["docLocalFiles"] = [{"name": f.get("name", "")} for f in local_files if isinstance(f, dict)]
            m.pop("docLocalRootPath", None)

    return clean


def create_gist_share(tpl: dict) -> dict[str, Any]:
    """创建 GitHub Gist 分享。

    Returns:
        {"ok": True, "code": "CSG:<gist_id>", "id": "..."} 或
        {"ok": False, "error": "..."}
    """
    token = settings.github_gist_token.strip()
    if not token:
        return {"ok": False, "error": "未配置 GITHUB_GIST_TOKEN，无法联网分享，请使用离线码"}

    clean = _sanitize_template(tpl)
    payload = {
        "description": f"CINSIDE LOOP Share: {clean.get('name', '')}",
        "public": True,
        "files": {
            GIST_FILE_NAME: {
                "content": json.dumps(clean, ensure_ascii=False),
            }
        },
    }

    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
    }

    try:
        with httpx.Client(timeout=15.0, trust_env=True, follow_redirects=True) as client:
            resp = client.post(GIST_API, headers=headers, json=payload)
            if resp.status_code == 201:
                data = resp.json()
                gist_id = data.get("id", "")
                if gist_id:
                    return {"ok": True, "code": f"CSG:{gist_id}", "id": gist_id}
                return {"ok": False, "error": "GitHub 返回了空的 gist ID"}
            # 401/403 = token 问题
            if resp.status_code in (401, 403):
                return {"ok": False, "error": f"GitHub 认证失败（HTTP {resp.status_code}），请检查 GITHUB_GIST_TOKEN"}
            # 其他错误
            try:
                err_msg = resp.json().get("message", resp.text[:200])
            except Exception:
                err_msg = resp.text[:200]
            return {"ok": False, "error": f"GitHub API 错误（HTTP {resp.status_code}）：{err_msg}"}
    except httpx.TimeoutException:
        return {"ok": False, "error": "连接 GitHub 超时，请检查网络或使用离线码"}
    except Exception as e:
        return {"ok": False, "error": f"网络错误：{e}"}


def get_gist_share(code: str) -> dict[str, Any]:
    """根据分享码获取 GitHub Gist 中的模板数据。

    Args:
        code: 分享码，格式 "CSG:<gist_id>" 或纯 gist ID

    Returns:
        {"ok": True, "template": {...}} 或 {"ok": False, "error": "..."}
    """
    gist_id = code.strip()
    if gist_id.upper().startswith("CSG:"):
        gist_id = gist_id[4:].strip()

    if not gist_id or not all(c in "0123456789abcdefABCDEF" for c in gist_id):
        return {"ok": False, "error": "无效的分享码格式"}

    # 构建尝试的 URL 列表：直连 + 镜像
    urls = [f"{GIST_API}/{gist_id}"]
    for mirror in GIST_MIRRORS:
        urls.append(f"{mirror}/{gist_id}")

    headers = {"Accept": "application/vnd.github+json"}
    token = settings.github_gist_token.strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"

    last_error = ""
    for url in urls:
        try:
            with httpx.Client(timeout=10.0, trust_env=True, follow_redirects=True) as client:
                resp = client.get(url, headers=headers)
                if resp.status_code == 200:
                    data = resp.json()
                    files = data.get("files", {})
                    gist_file = files.get(GIST_FILE_NAME)
                    if not gist_file:
                        # 可能文件名不同，取第一个文件
                        if files:
                            gist_file = next(iter(files.values()))
                        else:
                            last_error = "Gist 中没有找到文件"
                            continue
                    content = gist_file.get("content", "")
                    if not content:
                        last_error = "Gist 文件内容为空"
                        continue
                    template = json.loads(content)
                    return {"ok": True, "template": template}
                if resp.status_code == 404:
                    return {"ok": False, "error": "分享码不存在或已被删除"}
                last_error = f"HTTP {resp.status_code}"
        except httpx.TimeoutException:
            last_error = "连接超时"
            continue
        except Exception as e:
            last_error = str(e)
            continue

    return {"ok": False, "error": f"所有下载源均失败：{last_error}"}
