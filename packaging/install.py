# -*- coding: utf-8 -*-
"""IndexTTS2 · 长篇台本 + 时间轴 工作台 补丁安装器

设计目标：把「一份已经验证过的功能」搬到另一个 **同款 IndexTTS2 v3 整合包**里，
不需要重新装依赖、不需要手工改代码。

它只做四件事，全部可重复执行（幂等）：
  1. 复制文件（payload/ → 目标包根目录），覆盖前先备份到 _patch_backup/<时间>/
  2. 在 server.py 里插入扩展注册块（已经有就跳过）
  3. 在 web/index.html 里插入「长篇台本」入口（已经有就跳过）
  4. 建好数据目录（longform/*、outputs/）

用法（在目标包根目录里）：
    runtime\\python.exe install.py                 # 自动找包根
    runtime\\python.exe install.py --target D:\\包  # 指定包根
    runtime\\python.exe install.py --dry-run        # 只看会做什么
    runtime\\python.exe install.py --restore        # 从最近一次备份还原

最省事的用法：双击同目录的「安装.bat」。
它只用 ASCII 写（不会像中文 .bat 那样在 GBK 控制台里变乱码），
会自动找 runtime\\python.exe，找不到再试系统里的 py / python。
"""
from __future__ import annotations

import argparse
import filecmp
import json
import os
import re
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PAYLOAD = os.path.join(HERE, "payload")
PATCH_VERSION = "0.19 / 2026-10-27"
BACKUP_NAME = "_patch_backup"

# 这几个模块是本补丁的「主体」；version 用文件大小+哈希做粗校验
CORE_FILES = ["longform_api.py", "lf_import.py", "timeline_api.py", "hrir.py", "rooms.py"]

DATA_DIRS = [
    "longform", "longform/refs", "longform/scripts", "longform/sfx",
    "longform/materials", "longform/presets", "longform/_import",
    "longform/_trash", "outputs", "logs",
]

TAB_HTML = (
    '    <a class="tab" href="/longform" title="长篇台本：分行编辑、批量设置情感与音色、断点续跑"\n'
    '       style="text-decoration:none;display:inline-flex;align-items:center;gap:5px">长篇台本</a>\n'
)

# 注册块里这些主机变量是「有就用、没有给兜底」的
FALLBACKS = {
    "logger": '__import__("logging").getLogger("uvicorn.error")',
    "current_dir": 'os.path.dirname(os.path.abspath(__file__))',
    "verbose": "False",
}


def log(msg=""):
    print(msg, flush=True)


# 控制台编码兜底：英文版 Windows（cp437/cp1252）控制台打不出中文时不让它崩，
# 只把打不出的字换成 ?，安装流程照常走完。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(errors="replace")
    except Exception:  # noqa: BLE001
        pass


def sha1(path, limit=1 << 20):
    import hashlib
    h = hashlib.sha1()
    with open(path, "rb") as f:
        while True:
            b = f.read(65536)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def looks_like_host(root):
    return (os.path.isfile(os.path.join(root, "server.py"))
            and os.path.isdir(os.path.join(root, "web")))


def find_target(explicit):
    if explicit:
        return os.path.abspath(explicit)
    # 补丁包通常解压在包根目录里（<包>/补丁/install.py）或包根旁边
    for cand in (os.path.dirname(HERE), os.path.join(HERE, "..", "..")):
        c = os.path.abspath(cand)
        if looks_like_host(c):
            return c
    cwd = os.path.abspath(os.getcwd())
    if looks_like_host(cwd):
        return cwd
    return None


def backup_path(root, rel):
    stamp = time.strftime("%Y%m%d_%H%M%S")
    dst = os.path.join(root, BACKUP_NAME, stamp, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    return dst, stamp


def copy_payload(root, dry=False):
    """按 payload 的结构铺到目标包；内容一样的跳过，不一样先备份。"""
    stats = {"new": [], "same": [], "replaced": []}
    if not os.path.isdir(PAYLOAD):
        raise SystemExit("补丁不完整：缺少 payload/ 目录")
    for dirpath, dirs, files in os.walk(PAYLOAD):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for fn in files:
            if fn.endswith((".pyc", ".pyo")):
                continue
            src = os.path.join(dirpath, fn)
            rel = os.path.relpath(src, PAYLOAD)
            dst = os.path.join(root, rel)
            if os.path.exists(dst) and filecmp.cmp(src, dst, shallow=False):
                stats["same"].append(rel)
                continue
            if os.path.exists(dst):
                stats["replaced"].append(rel)
                if not dry:
                    b, _ = backup_path(root, rel)
                    shutil.copy2(dst, b)
            else:
                stats["new"].append(rel)
            if not dry:
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy2(src, dst)
    return stats


def _server_block(src):
    """按目标 server.py 里实际存在的变量，拼出注册块（有的用、没有兜底）。"""
    def has(name):
        return re.search(rf"^\s*{re.escape(name)}\s*(?::[^=]+)?=", src, re.M) is not None

    lf_deps = []
    lf_deps.append('"tts": tts,' if has("tts") else '"tts": None,')
    lf_deps.append('"infer_lock": _INFER_LOCK,'
                   if has("_INFER_LOCK") else '"infer_lock": __import__("threading").Lock(),')
    lf_deps.append('"logger": logger,' if has("logger") else
                   '"logger": ' + FALLBACKS["logger"] + ',')
    lf_deps.append('"project_dir": current_dir,' if has("current_dir") else
                   '"project_dir": ' + FALLBACKS["current_dir"] + ',')
    lf_deps.append('"web_dir": os.path.join('
                   + ('current_dir' if has("current_dir") else FALLBACKS["current_dir"])
                   + ', "web"),')
    lf_deps.append('"verbose": cmd_args.verbose,' if has("cmd_args") else
                   '"verbose": ' + FALLBACKS["verbose"] + ',')
    lf_body = "\n".join("        " + x for x in lf_deps)

    tl_deps = []
    tl_deps.append('"project_dir": current_dir,' if has("current_dir") else
                   '"project_dir": ' + FALLBACKS["current_dir"] + ',')
    tl_deps.append('"web_dir": os.path.join('
                   + ('current_dir' if has("current_dir") else FALLBACKS["current_dir"])
                   + ', "web"),')
    tl_deps.append('"verbose": cmd_args.verbose,' if has("cmd_args") else
                   '"verbose": ' + FALLBACKS["verbose"] + ',')
    tl_body = "\n".join("        " + x for x in tl_deps)

    return f'''
# ---- 长篇台本扩展（longform） --------------------------------------------------
# 纯增量：独立模块、独立路由前缀 /api/v1/lf、独立页面 /longform。
# 上面的既有路由、任务队列、推理锁一律不改；扩展注册失败也不会拖垮主服务。
# 补丁版本 {PATCH_VERSION}
try:
    from longform_api import register_longform
    register_longform(app, api, deps={{
{lf_body}
    }})
except Exception as _lf_err:  # noqa: BLE001
    logger.error("Longform extension failed to load: %s", _lf_err, exc_info=True)

# ---- 长篇台本 · 时间轴工程（timeline） ----------------------------------------
# 同样纯增量：独立模块、独立页面 /timeline、路由前缀 /api/v1/lf/tl。
try:
    from timeline_api import register_timeline
    register_timeline(app, deps={{
{tl_body}
    }})
except Exception as _tl_err:  # noqa: BLE001
    logger.error("Timeline extension failed to load: %s", _tl_err, exc_info=True)


'''


def patch_server(root, dry=False):
    path = os.path.join(root, "server.py")
    with open(path, encoding="utf-8") as f:
        src = f.read()
    if "from longform_api import register_longform" in src:
        return "skip", "server.py 已经注册过（跳过）"
    if not re.search(r"^\s*app\s*=", src, re.M):
        return "fail", "server.py 里找不到 app（不是 FastAPI 主程序？）"
    if not re.search(r"^\s*api\s*=\s*APIRouter", src, re.M):
        return "fail", ("server.py 里没有 api = APIRouter(...)："
                        "目标包的路由结构不同，需要手工把 register_longform 挂到它的 router 上")
    block = _server_block(src)
    # 插到 if __name__ == "__main__" 之前；没有就插到最后一个 include_router 之后
    m = re.search(r"^if\s+__name__\s*==\s*['\"]__main__['\"]\s*:", src, re.M)
    if m:
        idx = m.start()
    else:
        matches = list(re.finditer(r"^app\.include_router\([^\n]*\)\s*$", src, re.M))
        if not matches:
            return "fail", "server.py 里找不到插入点（既没有 __main__ 也没有 include_router）"
        idx = matches[-1].end() + 1
    out = src[:idx] + block + src[idx:]
    try:
        compile(out, path, "exec")      # 只编译不写盘，语法错就中止
    except SyntaxError as e:
        return "fail", f"插入后语法错误，已中止：{e}"
    if not dry:
        b, _ = backup_path(root, "server.py")
        shutil.copy2(path, b)
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(out)
    return "ok", f"server.py 已插入注册块（第 {src[:idx].count(chr(10)) + 1} 行）"


def patch_index(root, dry=False):
    rel = os.path.join("web", "index.html")
    path = os.path.join(root, rel)
    if not os.path.isfile(path):
        return "fail", "找不到 web/index.html"
    with open(path, encoding="utf-8") as f:
        src = f.read()
    if 'href="/longform"' in src:
        return "skip", "web/index.html 已经有入口（跳过）"
    m = re.search(r'^\s*<nav class="tabs"', src, re.M)
    if not m:
        return "fail", "web/index.html 里找不到 <nav class=\"tabs\"：请手工加一个 <a href=\"/longform\">"
    out = src[:m.start()] + TAB_HTML + src[m.start():]
    if not dry:
        b, _ = backup_path(root, rel)
        shutil.copy2(path, b)
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(out)
    return "ok", "web/index.html 已加「长篇台本」入口"


def ensure_dirs(root, dry=False):
    made = []
    for d in DATA_DIRS:
        p = os.path.join(root, d)
        if not os.path.isdir(p):
            made.append(d)
            if not dry:
                os.makedirs(p, exist_ok=True)
    return made


def check_env(root):
    """在目标包的 runtime 里做一次导入自检（不加载模型）。"""
    py = os.path.join(root, "runtime", "python.exe")
    if not os.path.isfile(py):
        py = sys.executable
        log(f"  · 目标包没有 runtime/python.exe，用当前解释器自检：{py}")
    code = (
        "import sys, os;"
        "sys.path.insert(0, %r);"
        "os.chdir(%r);"
        "import longform_api, timeline_api, hrir, rooms, lf_import;"
        "print('IMPORT_OK')"
        % (root, root)
    )
    import subprocess
    try:
        p = subprocess.run([py, "-c", code], capture_output=True, text=True, timeout=180)
    except Exception as e:  # noqa: BLE001
        return False, f"自检没跑起来：{e}"
    if "IMPORT_OK" in (p.stdout or ""):
        return True, "模块导入正常"
    tail = ((p.stderr or "") + (p.stdout or "")).strip().splitlines()[-6:]
    return False, "导入失败：\n    " + "\n    ".join(tail)


def do_install(root, dry):
    log(f"目标包：{root}")
    log(f"补丁版本：{PATCH_VERSION}{'（演练模式，不写盘）' if dry else ''}")
    log("")
    st = copy_payload(root, dry)
    log(f"[1/4] 复制文件：新增 {len(st['new'])}，覆盖 {len(st['replaced'])}，"
        f"相同跳过 {len(st['same'])}")
    for x in st["new"][:6]:
        log(f"      + {x}")
    if len(st["new"]) > 6:
        log(f"      … 还有 {len(st['new']) - 6} 个")
    for x in st["replaced"][:6]:
        log(f"      ~ {x}（旧文件已备份）")

    code, msg = patch_server(root, dry)
    log(f"[2/4] server.py：{msg}")
    if code == "fail":
        return False
    code2, msg2 = patch_index(root, dry)
    log(f"[3/4] 首页入口：{msg2}")
    if code2 == "fail":
        log("      入口没加上，但功能本身可用：手工打开 /longform 也能进")
    made = ensure_dirs(root, dry)
    log(f"[4/4] 数据目录：{('新建 ' + '、'.join(made)) if made else '已齐全'}")

    log("")
    ok, detail = check_env(root)
    log(("环境自检：" + detail) if ok else ("环境自检未通过：" + detail))
    log("")
    if ok:
        log("完成。重启服务（start_server.bat）后，首页右上角会多一个「长篇台本」。")
        log("  时间轴从台本页右上角「时间轴」按钮进入。")
        log("  第一次用：点台本页顶栏「🎓 第一次用？看看这里」，有带截图的六步教程（离线）。")
        log("  ffmpeg 已内置在 bin\\ffmpeg.exe（视频可直接拖进导入台抽音频，不用另装）。")
    else:
        log("文件已经铺好了，但导入自检没过。多半是目标包缺 numpy / soundfile / fastapi，"
            "或者 server.py 结构差异较大 —— 请看 说明.md 的「排错」。")
    return ok


def do_restore(root):
    base = os.path.join(root, BACKUP_NAME)
    if not os.path.isdir(base):
        log("没有找到备份目录 _patch_backup/，无从还原。")
        return False
    stamps = sorted(os.listdir(base))
    if not stamps:
        log("备份目录是空的。")
        return False
    stamp = stamps[-1]
    src = os.path.join(base, stamp)
    n = 0
    for dirpath, _dirs, files in os.walk(src):
        for fn in files:
            s = os.path.join(dirpath, fn)
            rel = os.path.relpath(s, src)
            d = os.path.join(root, rel)
            os.makedirs(os.path.dirname(d), exist_ok=True)
            shutil.copy2(s, d)
            n += 1
            log(f"  还原 {rel}")
    log(f"已从备份 {stamp} 还原 {n} 个文件（server.py / index.html 回到补丁前）。")
    log("注意：补丁**新增**的文件不会被删除。要彻底撤掉，请删掉 longform_api.py、"
        "lf_import.py、timeline_api.py、hrir.py、rooms.py、web\\longform.*、"
        "web\\timeline.*、web\\emoctl.js（assets\\hrir、_vendor、vendor2 可留可删）。")
    return True


def main():
    ap = argparse.ArgumentParser(description="IndexTTS2 长篇工作台补丁安装器")
    ap.add_argument("--target", help="目标整合包根目录（含 server.py）")
    ap.add_argument("--dry-run", action="store_true", help="只显示会做什么，不写盘")
    ap.add_argument("--restore", action="store_true", help="从最近一次备份还原")
    a = ap.parse_args()

    root = find_target(a.target)
    if not root or not looks_like_host(root):
        log("没找到目标整合包根目录（需要有 server.py 和 web/）。")
        log("请用：runtime\\python.exe install.py --target D:\\你的整合包")
        sys.exit(2)
    if a.restore:
        sys.exit(0 if do_restore(root) else 1)
    ok = do_install(root, a.dry_run)
    log("")
    log("提示：本补丁不包含模型权重，也不改你的 index.html 之外任何页面；"
        "卸载见 install.py --restore。")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
