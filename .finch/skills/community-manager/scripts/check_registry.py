#!/usr/bin/env python3
"""社区索引巡检：一次调用完成「npm 版本比对」+「线上分发健康检查」。

用法：
    python3 check_registry.py            # 两项都跑
    python3 check_registry.py versions   # 只比对 npm 版本
    python3 check_registry.py health     # 只检查线上端点

退出码：0 = 无问题；1 = 有问题需要人工处理；2 = 脚本自身出错。

设计约束（都是踩过的坑）：
- 必须并发。串行逐个查 npm registry 在弱网下 43 个包要 2 分钟以上，
  会把巡检任务拖到 timed_out；并发实测 0.5 秒内返回。
- 只读，不写任何文件。写入仍走 manage_registry.py，由它做版本存在性校验。
- 线上内容与本地不一致只算 WARN：Worker 有边缘缓存，刚推的提交短时间
  读到旧内容属正常；真正的故障信号是非 200。
"""

from __future__ import annotations

import concurrent.futures
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
COMMUNITY_DIR = REPO_ROOT / "community"
BASE_URL = "https://community.finchwork.app"
TIMEOUT = 20
MAX_WORKERS = 16

# 线上必须可访问的 JSON（与 community/ 下实际文件保持一致）
SERVED_FILES = [
    "mini-tools.json",
    "mini-tools.zh-CN.json",
    "skills.json",
    "skills.zh-CN.json",
    "categories.json",
]


def http_get_json(url: str):
    req = urllib.request.Request(
        url, headers={"User-Agent": "finch-community-check/1.0"}
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def http_get_text(url: str):
    req = urllib.request.Request(
        url, headers={"User-Agent": "finch-community-check/1.0"}
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        raw = resp.read()
        return resp.status, raw.decode("utf-8", errors="replace")


def load_index(name: str):
    path = COMMUNITY_DIR / name
    if not path.exists():
        raise FileNotFoundError(f"缺少文件：{path}")
    return json.loads(path.read_text(encoding="utf-8"))


# ── 1. npm 版本比对 ──────────────────────────────────────────────────────────


def check_one_package(entry: dict) -> dict:
    pkg = entry["npm"]
    url = f"https://registry.npmjs.org/{urllib.parse.quote(pkg, safe='')}/latest"
    try:
        data = http_get_json(url)
    except urllib.error.HTTPError as exc:
        return {"id": entry["id"], "pkg": pkg, "state": "ERR",
                "detail": f"HTTP {exc.code}"}
    except Exception as exc:  # noqa: BLE001 - 网络异常统一归类
        return {"id": entry["id"], "pkg": pkg, "state": "ERR",
                "detail": f"{type(exc).__name__}"}
    latest = data.get("version")
    if latest != entry.get("version"):
        return {"id": entry["id"], "pkg": pkg, "state": "BEHIND",
                "index": entry.get("version"), "latest": latest}
    return {"id": entry["id"], "pkg": pkg, "state": "OK"}


def cmd_versions() -> int:
    items = load_index("mini-tools.json")
    targets = [it for it in items if it.get("npm")]
    skipped = len(items) - len(targets)

    with concurrent.futures.ThreadPoolExecutor(MAX_WORKERS) as pool:
        results = list(pool.map(check_one_package, targets))

    behind = [r for r in results if r["state"] == "BEHIND"]
    errors = [r for r in results if r["state"] == "ERR"]

    print(f"[versions] 检查 {len(targets)} 个带 npm 字段的条目"
          f"（跳过 {skipped} 个无 npm 字段）")
    if behind:
        print(f"[versions] 待更新 {len(behind)} 个：")
        for r in sorted(behind, key=lambda x: x["id"]):
            print(f"  - {r['id']}: {r['index']} -> {r['latest']}  (npm: {r['pkg']})")
    else:
        print("[versions] 全部条目与 npm latest 一致")
    if errors:
        print(f"[versions] 查询失败 {len(errors)} 个（跳过，不要写入）：")
        for r in sorted(errors, key=lambda x: x["id"]):
            print(f"  - {r['id']} ({r['pkg']}): {r['detail']}")

    # 待更新不算失败，属于巡检的正常产出；只有查询失败需要人看
    return 1 if errors else 0


# ── 2. 线上分发健康检查 ──────────────────────────────────────────────────────


def check_one_endpoint(name: str) -> dict:
    url = f"{BASE_URL}/{name}"
    try:
        status, body = http_get_text(url)
    except urllib.error.HTTPError as exc:
        return {"file": name, "state": "DOWN", "detail": f"HTTP {exc.code}"}
    except Exception as exc:  # noqa: BLE001
        return {"file": name, "state": "DOWN", "detail": type(exc).__name__}

    if status != 200:
        return {"file": name, "state": "DOWN", "detail": f"HTTP {status}"}
    try:
        json.loads(body)
    except json.JSONDecodeError:
        return {"file": name, "state": "DOWN", "detail": "返回非合法 JSON"}

    local_path = COMMUNITY_DIR / name
    if local_path.exists():
        local = local_path.read_text(encoding="utf-8")
        if local.strip() != body.strip():
            return {"file": name, "state": "STALE", "detail": "线上内容与仓库不一致"}
    return {"file": name, "state": "OK"}


def cmd_health() -> int:
    with concurrent.futures.ThreadPoolExecutor(MAX_WORKERS) as pool:
        results = list(pool.map(check_one_endpoint, SERVED_FILES))

    down = [r for r in results if r["state"] == "DOWN"]
    stale = [r for r in results if r["state"] == "STALE"]

    print(f"[health] 探测 {BASE_URL} 共 {len(SERVED_FILES)} 个端点")
    for r in results:
        mark = {"OK": "OK  ", "STALE": "WARN", "DOWN": "FAIL"}[r["state"]]
        extra = f"  {r['detail']}" if r.get("detail") else ""
        print(f"  [{mark}] /{r['file']}{extra}")

    if down:
        print(f"[health] {len(down)} 个端点不可用 —— 社区市场此刻对所有用户都是坏的")
        print("[health] 先查 Worker 的 GITHUB_TOKEN secret 是否过期："
              "raw 对坏 token 返 404，api.github.com 返 401")
    if stale:
        print(f"[health] {len(stale)} 个端点内容与仓库不一致 —— "
              "Worker 边缘缓存约 60 秒，刚提交后短暂不一致属正常；"
              "持续不一致才需要查 CACHE_VERSION")

    return 1 if down else 0


# ── 入口 ─────────────────────────────────────────────────────────────────────


def main() -> int:
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    if what not in {"all", "versions", "health"}:
        print(__doc__)
        return 2
    codes = []
    try:
        if what in {"all", "versions"}:
            codes.append(cmd_versions())
        if what in {"all", "health"}:
            codes.append(cmd_health())
    except Exception as exc:  # noqa: BLE001
        print(f"[error] 脚本执行失败：{type(exc).__name__}: {exc}")
        return 2
    return 1 if any(codes) else 0


if __name__ == "__main__":
    sys.exit(main())
