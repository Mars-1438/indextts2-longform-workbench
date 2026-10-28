# -*- coding: utf-8 -*-
"""生成长篇工作台「补丁包」（zip）：纯增量文件 + 安装器，不含模型/音频/测试脚本。

产物：dist/IndexTTS2_全能音声工作台补丁_v0.20.zip
内容：
  payload/longform_api.py lf_import.py timeline_api.py hrir.py rooms.py
  payload/web/{longform,timeline}.{html,css,js} emoctl.js
  payload/assets/hrir/*.sofa|npz  + README
  payload/_vendor/h5py（读 .sofa 用，cp311-win_amd64）
  payload/vendor2/（Demucs 分离 + 内置 htdemucs 权重，离线可用）
  payload/bin/ffmpeg.exe（视频抽音频，离线可用）
  payload/web/guide.html + web/guide/*.png（「第一次用？」图文教程）
  payload/longform/{refs,scripts,...}/.keep
  install.py / 安装.bat（纯 ASCII）/ 说明.md / docs/…

跑法：runtime\\python.exe tools\\make_patch.py
"""
import os
import shutil
import sys
import time
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
NAME = "IndexTTS2_全能音声工作台补丁_v0.20"
STAGE = os.path.join(DIST, NAME)
PAYLOAD = os.path.join(STAGE, "payload")

# lf_static.py 里放静态资源白名单（两个页面共用一份），必须一起打包
CORE_PY = ["longform_api.py", "lf_import.py", "timeline_api.py", "hrir.py", "rooms.py",
           "lf_static.py"]


def _web_files():
    """前端清单从 lf_static.py 的白名单生成 —— 加一个共用脚本只改那一处，
    不用再回来改这份列表（漏一次就是线上 404 / 装完缺文件）。"""
    try:
        import sys as _sys
        if ROOT not in _sys.path:
            _sys.path.insert(0, ROOT)
        from lf_static import asset_files
        out = []
        for page in ("longform", "timeline"):
            for fn in asset_files(os.path.join(ROOT, "web"), page):
                rel = "web/" + fn
                if rel not in out:
                    out.append(rel)
        out.append("web/guide.html")
        return out or ["web/longform.html"]
    except Exception as e:  # noqa: BLE001
        print(f"  ! 读 lf_static 失败（{e}），退回内置清单")
        return ["web/longform.html", "web/longform.css", "web/longform.js",
                "web/timeline.html", "web/timeline.css", "web/timeline.js",
                "web/emoctl.js", "web/genparams.js", "web/guide.html"]


WEB = _web_files()
BIN = ["bin/ffmpeg.exe"]
HRIR = ["assets/hrir/MIT_KEMAR_normal_pinna.sofa",
        "assets/hrir/KU100_near.npz",
        "assets/hrir/KU100_near_circ.npz",
        "assets/hrir/README.md"]
DOCS = ["技术路线_长篇台本与时间轴.md", "使用说明.txt"]
DATA_KEEP = ["longform/refs", "longform/scripts", "longform/sfx", "longform/materials",
             "longform/presets", "longform/_import", "longform/_trash", "outputs", "logs"]


def copy_file(rel, dst_rel=None, base=None):
    src = os.path.join(ROOT, rel)
    if not os.path.isfile(src):
        raise SystemExit("缺文件：" + rel)
    dst = os.path.join(base or PAYLOAD, dst_rel or rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)
    return os.path.getsize(dst)


def copy_tree(rel, skip_pycache=True, skip_pyc=True):
    src_root = os.path.join(ROOT, rel)
    if not os.path.isdir(src_root):
        raise SystemExit("缺目录：" + rel)
    n = 0
    for dirpath, dirs, files in os.walk(src_root):
        if skip_pycache:
            dirs[:] = [d for d in dirs if d != "__pycache__"]
        for fn in files:
            if skip_pyc and fn.endswith((".pyc", ".pyo")):
                continue
            s = os.path.join(dirpath, fn)
            r = os.path.relpath(s, ROOT)
            d = os.path.join(PAYLOAD, r)
            os.makedirs(os.path.dirname(d), exist_ok=True)
            shutil.copy2(s, d)
            n += 1
    return n


def main():
    if not os.path.isdir(DIST):
        os.makedirs(DIST)
    if os.path.isdir(STAGE):
        shutil.rmtree(STAGE)
    os.makedirs(PAYLOAD)

    total = 0
    print("== 主体模块 ==")
    for f in CORE_PY:
        sz = copy_file(f)
        total += sz
        print(f"  + {f}  {sz/1024:.0f} KB")

    print("== 前端 ==")
    for f in WEB:
        sz = copy_file(f)
        total += sz
        print(f"  + {f}  {sz/1024:.0f} KB")

    print("== HRIR 数据 ==")
    for f in HRIR:
        sz = copy_file(f)
        total += sz
        print(f"  + {f}  {sz/1048576:.1f} MB")

    print("== 内置 ffmpeg（视频抽音频，离线可用） ==")
    for f in BIN:
        sz = copy_file(f)
        total += sz
        print(f"  + {f}  {sz/1048576:.1f} MB")

    print("== 可选依赖 ==")
    n = copy_tree("_vendor")
    print(f"  + _vendor/（h5py，读 .sofa 用）{n} 个文件")
    n2 = copy_tree("vendor2")
    print(f"  + vendor2/（Demucs 分离）{n2} 个文件")

    print("== 教程截图 ==")
    n3 = copy_tree("web/guide", skip_pycache=False, skip_pyc=False)
    print(f"  + web/guide/（教程配图）{n3} 个文件")

    print("== 数据目录骨架 ==")
    for d in DATA_KEEP:
        os.makedirs(os.path.join(PAYLOAD, d), exist_ok=True)
        with open(os.path.join(PAYLOAD, d, ".keep"), "w", encoding="utf-8") as f:
            f.write("")
    print(f"  + {len(DATA_KEEP)} 个目录（带 .keep，解压后保持空目录）")

    print("== 安装器与文档 ==")
    for f, dst in [("packaging/install.py", "install.py"),
                   ("packaging/安装.bat", "安装.bat"),
                   ("packaging/说明.md", "说明.md")]:
        sz = copy_file(f, dst, STAGE)
        total += sz
        print(f"  + {dst}  {sz/1024:.0f} KB")
    os.makedirs(os.path.join(STAGE, "docs"), exist_ok=True)
    for f in DOCS:
        sz = copy_file(f, os.path.join("docs", os.path.basename(f)), STAGE)
        total += sz
        print(f"  + docs/{os.path.basename(f)}  {sz/1024:.0f} KB")

    zip_path = os.path.join(DIST, NAME + ".zip")
    if os.path.exists(zip_path):
        os.remove(zip_path)
    t0 = time.time()
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for dirpath, _dirs, files in os.walk(STAGE):
            for fn in files:
                full = os.path.join(dirpath, fn)
                arc = os.path.join(NAME, os.path.relpath(full, STAGE)).replace(os.sep, "/")
                z.write(full, arc)
    size = os.path.getsize(zip_path)
    count = sum(len(fs) for _d, _s, fs in os.walk(STAGE))
    print()
    print(f"完成：{zip_path}")
    print(f"  {count} 个文件，压缩后 {size/1048576:.1f} MB，用时 {time.time()-t0:.1f}s")
    print("  解压到目标整合包根目录 → 双击 安装.bat")


if __name__ == "__main__":
    main()
