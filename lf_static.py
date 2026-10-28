"""前端静态资源的登记表 —— 两个 API 模块共用（**移植时只改这一个文件**）

为什么单独拎出来：台本页与时间轴页各有一个 `/xxx-assets/{name}` 路由，
以前白名单分别写死在 `longform_api.py` 与 `timeline_api.py` 里，
再加一个共用脚本（比如 `genparams.js`）就要同时改两处 + `tools/make_patch.py`
+ `packaging/install.py` 的卸载提示，漏一处就是线上 404。

现在：
  · 白名单 = 本文件的 `CORE_ASSETS` / `PAGE_ASSETS`；
  · 路由只调 `serve_asset()`；
  · 打包清单也读 `CORE_ASSETS`（见 tools/make_patch.py），不再各写一份。
"""

import os

from fastapi import HTTPException
from fastapi.responses import FileResponse

# 两个页面都要用的脚本（工作台的「中立层」：生成参数字段表 + 预设控件）
CORE_ASSETS = ("emoctl.js", "genparams.js")

# 各页自己的资源。前缀规则用 "*." 表示「这个前缀下的都放行」。
PAGE_ASSETS = {
    "longform": ("longform.js", "longform.css"),
    "timeline": ("timeline.*",),
}

NO_CACHE = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
}

_MIME = {
    ".js": "application/javascript",
    ".css": "text/css",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
}


def allows(page, base):
    """base 这个文件名是否允许从 page 页取。"""
    if base in CORE_ASSETS:
        return True
    for rule in PAGE_ASSETS.get(page, ()):
        if rule.endswith("*"):
            if base.startswith(rule[:-1]):
                return True
        elif base == rule:
            return True
    return False


def serve_asset(web_dir, page, name):
    """返回 FileResponse；不在白名单或文件不存在都 404（不泄露目录结构）。"""
    base = os.path.basename(name or "")
    if not base or not allows(page, base):
        raise HTTPException(404, "Not found")
    path = os.path.join(web_dir, base)
    if not os.path.exists(path):
        raise HTTPException(404, "Not found")
    ext = os.path.splitext(base)[1].lower()
    return FileResponse(path, media_type=_MIME.get(ext), headers=NO_CACHE)


def asset_files(web_dir, page):
    """打包用：列出某一页要带上的真实文件（含共用脚本）。"""
    out = []
    for rule in list(CORE_ASSETS) + list(PAGE_ASSETS.get(page, ())):
        if rule.endswith("*"):
            prefix = rule[:-1]
            try:
                for fn in sorted(os.listdir(web_dir)):
                    if fn.startswith(prefix) and os.path.isfile(os.path.join(web_dir, fn)):
                        out.append(fn)
            except OSError:
                continue
        elif os.path.exists(os.path.join(web_dir, rule)):
            out.append(rule)
    seen, uniq = set(), []
    for fn in out:
        if fn not in seen:
            seen.add(fn)
            uniq.append(fn)
    return uniq
