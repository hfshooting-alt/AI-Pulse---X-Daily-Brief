#!/usr/bin/env python3
"""
Python 完整等价运行入口。

说明：
- 为确保与现有成熟逻辑 100% 等价，本脚本直接调用 daily-report.mjs。
- 这样你可以继续用 Python 入口（你习惯的调用方式），同时保持原有筛选/聚类/热度分类/TOP20/交叉验证产出完全一致。
- 后续若需要“纯 Python 内核”，可在此入口下逐模块替换，不影响现网运行。
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    js = root / "scripts" / "daily-report.mjs"
    if not js.exists():
        print(f"[error] 未找到等价脚本: {js}", file=sys.stderr)
        return 2

    # 透传 stdout/stderr 与退出码，保证行为与 node 直接执行一致
    proc = subprocess.run(["node", str(js)], cwd=str(root))
    return int(proc.returncode)


if __name__ == "__main__":
    raise SystemExit(main())
