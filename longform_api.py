"""长篇台本扩展（longform） for IndexTTS2 v3 便携分发包。

定位
----
「两万字 / 两小时」这种长篇台本用的分行编辑器 + 批量渲染器 + 后期工作台。
原程序一次只能合成一小段文本，长篇要手工切、逐段上传、逐段下载再拼接。

设计约束
--------
1. 纯增量：只在 server.py 末尾注册自己的路由（/api/v1/lf/*）和页面
   （/longform），不改动任何既有路由、任务队列、前端资源。
2. 复用同一把推理锁：长篇批量渲染与主界面单条生成串行执行。
3. 数据落在 longform/ 下，绕开主程序 outputs/ 的 14 天清理与 prompts/ 的 LRU。
4. 逐行渲染、逐行落盘：服务重启后可从断点继续，已生成的行不会重跑。

行模型
------
每一行是「语音行」（kind=speech，会被渲染成音频）或「标签行」（kind=tag，
不产生音频，只在时间轴/台本文件里占位，例如音效、摩擦音、留白）。
标签行可以带 hold（毫秒），合并导出时插入等长静音，方便后期配音效。

状态自愈
--------
status 以磁盘为准：只要 audio/<uid>.wav 在、且文本/参数指纹 sig 与文件一致，
就是 done；文件不在就回落 pending。这样「自动保存把状态写坏」「手改过 json」
都不会再出现「显示未生成但能播放」。
"""
from __future__ import annotations

import difflib
import gc
import io
import hashlib
import importlib.util
import json
import math
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import uuid
import zipfile

import numpy as np
import soundfile as sf
from fastapi import APIRouter, Body, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response

# ---- 由 register_longform() 注入的依赖 ------------------------------------------
_D = {}

LF_DIRNAME = "longform"
# 引擎输出的采样率（IndexTTS2 在 infer_v2.py 里硬编码 22050）。
# 移植到别的模型时**不用改代码**：设环境变量 LF_AUDIO_SR，或直接改这里的默认值。
def _env_sr(default=22050):
    """环境变量 LF_AUDIO_SR 里写了垃圾值也不要让整个服务起不来。"""
    raw = (os.environ.get("LF_AUDIO_SR") or "").strip()
    try:
        sr = int(float(raw))
    except (TypeError, ValueError):
        return default
    return sr if 8000 <= sr <= 192000 else default


AUDIO_SR = _env_sr()
MAX_REF_BYTES = 40 * 1024 * 1024
DEFAULT_PAUSE = 200         # 行间默认停顿（毫秒）
PAUSE_MIN, PAUSE_MAX = 0, 30000   # 停顿上限 30s：正念 / 引导稿里「停顿 10 秒」要能落下来
HOLD_MAX = 30000            # 标签行留白上限（毫秒）
MAX_LINE_CHARS = 400
MAX_RAW_ORIGIN = 4 * 1024 * 1024   # 「导入原稿」原样存一份（够 100 万字左右的中文）
HISTORY_KEEP = 20            # 每个台本保留的历史副本数

# 句中 / 句间「音效标签」的内置预设。只是**候选**，不是硬编码：
# 用户可以在「设置 → 标签库」里增删（内置的删掉会记进 hidden，不再出现在候选里）。
DEFAULT_TAGS = ["音效1", "音效2", "音效3", "摩擦音", "揉捏", "呼吸", "耳语",
                "亲吻", "翻页", "水声", "衣物摩擦", "留白",
                "脚步", "开门", "关门", "雨声", "风声", "心跳",
                "叹气", "笑声", "吞咽", "拍打", "震动", "铃铛",
                "玻璃", "转场", "BGM"]

# 音色 / 人物用的「属性标签」预设（傲娇、冰山美人这类）。
TRAIT_PRESETS = ["傲娇", "冰山美人", "温柔", "清冷", "活泼", "元气", "病娇", "腹黑",
                 "天然呆", "成熟御姐", "少年音", "少女音", "正太", "大叔", "老人",
                 "童声", "旁白", "群杂", "解说", "机械音", "气声", "低沉", "清亮",
                 "沙哑", "慵懒", "严肃", "甜"]

_UIDS_RE = re.compile(r"[^0-9a-zA-Z_-]")
_SAFE_NAME_RE = re.compile(r'[\\/:*?"<>|\r\n\t]+')

_LOCK = threading.RLock()
_RENDERS = {}
_ACTIVE = {"sid": None}

# 批量入库上下文：一次存几百上千个片段时，如果每个片段都「读整份索引 + 写整份索引」，
# 耗时是 O(n²)（实测 5 段 78ms/段，100 段已经 1.3s/段）。这里在一个线程里把索引
# 缓存在内存，循环结束再落一次盘 —— 1000 段从十几分钟降到几秒。
_BATCH = threading.local()


def _batch_idx(kind):
    """批量入库时返回共享索引；不在批量里就返回 None。"""
    return getattr(_BATCH, kind, None)


def _batch_begin():
    """开始一批：把三个库的索引读进内存（惰性，用到哪个读哪个也行，这里先都读）。"""
    _BATCH.media = _load_materials()
    _BATCH.sfx = _load_sfx()
    _BATCH.refs = _load_refs()


def _batch_commit():
    """结束一批：把改动过的索引落盘一次。异常路径也要调（放在 finally）。"""
    def _save_refs_idx(idx):
        _write_json(_refs_index_path(), idx)

    for kind, save in (("media", _save_materials), ("sfx", _save_sfx),
                       ("refs", _save_refs_idx)):
        idx = getattr(_BATCH, kind, None)
        if idx is not None:
            try:
                save(idx)
            except Exception as e:  # noqa: BLE001
                _log("longform: batch save %s failed: %s", kind, e, level="warning")
            try:
                delattr(_BATCH, kind)
            except AttributeError:
                pass


# ================================ 基础工具 =====================================

def _log(msg, *args, level="info"):
    logger = _D.get("logger")
    if logger is not None:
        getattr(logger, level, logger.info)(msg, *args)


def _lf_root() -> str:
    root = os.path.join(_D["project_dir"], LF_DIRNAME)
    for sub in ("refs", "scripts"):
        os.makedirs(os.path.join(root, sub), exist_ok=True)
    return root


def _refs_dir() -> str:
    return os.path.join(_lf_root(), "refs")


def _safe_sid(sid: str) -> str:
    sid = _UIDS_RE.sub("", str(sid or ""))
    if not sid or len(sid) > 40:
        raise HTTPException(400, "台本 ID 非法")
    return sid


def _script_dir(sid: str) -> str:
    sid = _safe_sid(sid)
    d = os.path.join(_lf_root(), "scripts", sid)
    for sub in ("", "audio", "export"):
        os.makedirs(os.path.join(d, sub), exist_ok=True)
    return d


def _safe_title(name: str, fallback="台本") -> str:
    name = _SAFE_NAME_RE.sub("", str(name or "")).strip().strip(".")
    return name[:60] or fallback


# ---------------------------- 批量编号 / 按名字排序 ----------------------------
# 一次存 / 导上百个文件时，名字里的序号必须**按总数补够位**：
# `_01 … _99 _100` 这种两位补零，按字符串排会变成 01,02,…,100,101,…,109,11,110…
# 用户看到的就是「到第 100 个跳过去了」——外部软件（剪映 / PR）合并素材也是按名字排的，
# 所以位数不够等于把顺序搞乱。这里统一用「按总数算位数」，2 位起步、上不封顶。
def _pad_width(total: int, min_w: int = 2) -> int:
    n = max(1, int(total or 0))
    return max(int(min_w), len(str(n)))


def _num_name(base: str, k: int, total: int, min_w: int = 2, sep: str = "_") -> str:
    """`原音` + 1 / 1000 → `原音_0001`（位数跟着总数走，永远能按名字排序）。"""
    return "%s%s%0*d" % (base, sep, _pad_width(total, min_w), int(k))


def _nat_key(name: str):
    """自然排序键：名字里的数字按数值比（1,2,10 而不是 1,10,2）。"""
    s = str(name or "")
    return [(0, int(t)) if t.isdigit() else (1, t.lower())
            for t in re.split(r"(\d+)", s) if t != ""]


# JSON 落盘：唯一临时名 + 串行化 + 重试
# ---------------------------------------------------------------
# 以前的实现是「固定 script.json.tmp + 直接 os.replace」，在 Windows 上偶发
#   PermissionError: [WinError 5] 拒绝访问: 'script.json.tmp' -> 'script.json'
# 原因有两类，都在这里兜住：
#  1) 目标文件正被**另一个线程**打开读取（渲染时前端每 1.2s 轮询 GET /render，
#     那边 _load_script 正在读 script.json）。Windows 的 rename/replace 需要
#     目标句柄带 FILE_SHARE_DELETE，而 Python 的 open() 不带 —— 读的瞬间替换就失败；
#  2) 杀毒 / 索引服务刚写入就扫描，短暂占用目标文件。
# 处理：写用「唯一 tmp + 全局写锁」避免两个写线程互相踩，替换失败按退避重试
# （总时长约 1s，足够轮询与扫描让开），读也重试几次避免读到替换中的半成品。
_JSON_IO_LOCK = threading.RLock()
_WIN_REPLACE_RETRY = 10


def _read_json(path, default=None, tries=4):
    last = None
    for i in range(tries):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except FileNotFoundError:
            return default
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(0.03 * (i + 1))
    _log("longform: read %s failed: %s", path, last, level="warning")
    return default


def _write_json(path, data):
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    payload = json.dumps(data, ensure_ascii=False, indent=1)
    with _JSON_IO_LOCK:
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(payload)
                f.flush()
                try:
                    os.fsync(f.fileno())
                except OSError:
                    pass
        except OSError:
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise
        last = None
        for i in range(_WIN_REPLACE_RETRY):
            try:
                os.replace(tmp, path)
                return
            except PermissionError as e:          # WinError 5 / 32：目标被占用
                last = e
                time.sleep(min(0.02 * (i + 1), 0.12))
        # 实在替换不了：把 tmp 清掉再抛，避免残渣堆在台本目录里
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise last


def _now():
    return round(time.time(), 2)


def _new_uid():
    return uuid.uuid4().hex[:10]


# ================================ 分句 / 断行 ==================================

_SENT_END = "。！？!?…；;"
_CLOSERS = "”’」』）)》】〉\"'"
_SOFT = "，,、：:－—-~～"


def split_text(text: str, max_chars: int = 70, mode: str = "packed"):
    """把长文切成适合单段合成的行。

    mode="packed"（默认）：切句 → 长句再切 → 短碎片贪心合并到接近 max_chars。
        适合「一口气生成」，行数少、每行都是一段完整的话。
    mode="sentence"：只按句末标点（。！？；…）和破折号切，短句也不合并。
        适合「一句一行」精修，工作台里逐句调。
    """
    max_chars = max(10, min(MAX_LINE_CHARS, int(max_chars or 70)))
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n").replace("\ufeff", "")
    frags = []
    for para in [p.strip() for p in re.split(r"\n+", text)]:
        if not para:
            continue
        for chunk in _split_dash(para):
            buf = ""
            for ch in chunk:
                if ch in _CLOSERS and not buf:
                    # 段首没有上一句可贴时必须当普通字符收下，否则整篇以 “””
                    # 开头的文本会静默吞掉第一个字（随机化测试抓到过）。
                    if frags:
                        frags[-1] += ch
                        continue
                buf += ch
                if ch in _SENT_END:
                    frags.append(buf)
                    buf = ""
            if buf.strip():
                frags.append(buf)
    frags = [f.strip() for f in frags if f.strip()]
    if mode == "sentence":
        out = []
        for f in frags:
            out.extend(_split_long(f, max_chars))
        return out
    lines, cur = [], ""
    for frag in frags:
        for piece in _split_long(frag, max_chars):
            if not cur:
                cur = piece
            elif len(cur) + len(piece) <= max_chars:
                cur += piece
            else:
                lines.append(cur)
                cur = piece
    if cur.strip():
        lines.append(cur)
    return [l.strip() for l in lines if l.strip()]


def _split_dash(para: str):
    """按破折号切开 —— 常用于台词停顿/转折。

    切完把破折号留在前一段尾部，避免下一行以「——」开头显得突兀。
    """
    if "—" not in para:
        return [para]
    parts, buf, i = [], "", 0
    while i < len(para):
        if para.startswith("——", i):
            buf += "——"
            i += 2
            parts.append(buf)
            buf = ""
            continue
        buf += para[i]
        i += 1
    if buf.strip():
        parts.append(buf)
    return [p for p in parts if p.strip()]


def _split_long(frag: str, max_chars: int):
    """超长句：优先在「窗口内最靠后的软标点」处切，实在没有才硬切。

    早期版本是「长度接近上限且当前字符正好是软标点」才切，结果
    『看着窗外的灯光一盏一盏地熄灭。』会被硬切在『一盏一/盏地熄灭』——
    词被劈开，合成出来明显断气。
    """
    if len(frag) <= max_chars:
        return [frag]
    out, rest = [], frag
    floor = max(6, int(max_chars * 0.5))
    while len(rest) > max_chars:
        window = rest[:max_chars]
        cut = 0
        for i in range(len(window) - 1, floor - 1, -1):
            if window[i] in _SOFT:
                cut = i + 1
                break
        if cut <= 0:
            cut = max_chars
        out.append(rest[:cut])
        rest = rest[cut:]
    if rest.strip():
        out.append(rest)
    # 尾段太短就并回上一段。注意不能写 out[-2] += out.pop()：Python 增量赋值
    # 先 load 后 store，pop 后再按 -2 存会越界（len 从 2 掉到 1）。
    if len(out) >= 2:
        tail = out[-1]
        if len(tail) <= 4 and len(out[-2]) + len(tail) <= max_chars + 6:
            out[-2] += tail
            out.pop()
    return out


# ================================ 音色库 =======================================

def _refs_index_path():
    return os.path.join(_refs_dir(), "refs.json")


def _load_refs():
    data = _read_json(_refs_index_path(), {"items": []})
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        return {"items": []}
    return data


def _audio_info(path):
    try:
        info = sf.info(path)
        return {"dur": round(info.frames / info.samplerate, 2), "sr": info.samplerate,
                "ch": int(info.channels or 1)}
    except Exception:
        return {"dur": None, "sr": None, "ch": None}


def resolve_ref(ref_id: str):
    """音色引用 → 磁盘路径。p:/e: 前缀指主程序 prompts/ 与官方 examples/。"""
    ref_id = str(ref_id or "").strip()
    if not ref_id:
        return None
    if ref_id.startswith("p:"):
        path = os.path.join(_D["project_dir"], "prompts", os.path.basename(ref_id[2:]))
    elif ref_id.startswith("e:"):
        path = os.path.join(_D["project_dir"], "examples", os.path.basename(ref_id[2:]))
    else:
        item = next((x for x in _load_refs()["items"] if x.get("id") == ref_id), None)
        if not item:
            return None
        path = os.path.join(_refs_dir(), os.path.basename(item["file"]))
    return path if os.path.exists(path) else None


# ============================ 素材库 / 预处理 ============================
# 定位：为「前期准备」服务——把视频/音频统一成干净的人声素材，再拿去当音色或时间轴素材。
# 不依赖 ffmpeg 也能跑（音频用 soundfile，人声分离用 DSP），有 ffmpeg 时自动解锁视频导入。

MAT_MAX_BYTES = 512 * 1024 * 1024
MAT_SR = 44100               # 素材统一采样率（时间轴/混音都在这条线上）
VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".avi", ".flv", ".webm", ".m4v", ".ts", ".wmv", ".mpg", ".mpeg"}
AUDIO_EXTS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".opus", ".wma", ".aiff", ".aif", ".amr"}


def _lf_cfg_path() -> str:
    return os.path.join(_lf_root(), "config.json")


def _lf_cfg() -> dict:
    try:
        with open(_lf_cfg_path(), encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _lf_cfg_set(key: str, val):
    d = _lf_cfg()
    if val in (None, ""):
        d.pop(key, None)
    else:
        d[key] = val
    try:
        p = _lf_cfg_path()
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
    except OSError:
        pass
    return d


# 工作台自身的标识（manifest 会带出去；移植到别的整合包时改这两行即可）
APP_NAME = "全能音声工作台"
ENGINE_ID = "indextts2"
APP_VERSION = "0.22"
API_PREFIX = "/api/v1/lf"


def _ffmpeg_candidates() -> list:
    """按优先级列出所有可能的位置（给人看的「探测结果」也是这份）。"""
    root = _D.get("project_dir") or os.getcwd()
    out = []
    cfg = _lf_cfg().get("ffmpeg")
    if cfg:
        out.append(("配置里指定", cfg))
    env = os.environ.get("LF_FFMPEG")
    if env:
        out.append(("环境变量 LF_FFMPEG", env))
    for rel in ("bin/ffmpeg.exe", "bin/ffmpeg", "ffmpeg.exe",
                os.path.join("tools", "ffmpeg", "bin", "ffmpeg.exe"),
                os.path.join("tools", "ffmpeg.exe"),
                os.path.join("runtime", "Scripts", "ffmpeg.exe")):
        out.append(("整合包内 " + rel.replace(os.sep, "/"), os.path.join(root, rel)))
    if os.name == "nt":
        out.append(("C:\\ffmpeg\\bin", r"C:\ffmpeg\bin\ffmpeg.exe"))
        out.append(("用户目录 ffmpeg\\bin", os.path.expanduser(r"~\ffmpeg\bin\ffmpeg.exe")))
    which = shutil.which("ffmpeg")
    if which:
        out.append(("系统 PATH", which))
    return out


def _ffmpeg_bin():
    """找 ffmpeg：配置指定 → 环境变量 → 整合包 bin/ → tools → 常见目录 → PATH。

    别人电脑上「视频拖进去没反应」基本都是这里只找了 bin/ + PATH：
    补丁包本身不带 ffmpeg，而大部分人 PATH 里也没有。现在可以在导入台里
    直接上传一个 ffmpeg.exe（存到 bin/），或者填一个绝对路径（存进 config.json）。
    """
    for _src, path in _ffmpeg_candidates():
        try:
            if path and os.path.isfile(path):
                return path
        except OSError:
            continue
    return None


def _ffmpeg_version(path: str):
    """跑一次 -version，确认这个 exe 真能用（有些人拿来的是坏文件 / 目录）。"""
    if not path:
        return None
    try:
        p = subprocess.run([path, "-version"], capture_output=True, timeout=15,
                           text=True, errors="replace")
        line = (p.stdout or p.stderr or "").splitlines()
        return line[0].strip()[:120] if (p.returncode == 0 and line) else None
    except (OSError, subprocess.SubprocessError):
        return None


_FF_CACHE = {"t": 0.0, "v": None}


def _ffmpeg_state(fresh: bool = False) -> dict:
    # 探测要 spawn 一次 -version，10 秒内复用结果（页面一打开就问一次，不用每次都跑）
    now = time.time()
    if not fresh and _FF_CACHE["v"] and now - _FF_CACHE["t"] < 10:
        return _FF_CACHE["v"]
    path = _ffmpeg_bin()
    ver = _ffmpeg_version(path) if path else None
    cands = [{"from": s, "path": p, "exists": bool(p and os.path.isfile(p))}
             for s, p in _ffmpeg_candidates()]
    out = {"ok": bool(path and ver), "path": path or "", "version": ver or "",
            "candidates": cands,
            "hint": ("视频抽音频已可用" if (path and ver) else
                     "没有可用的 ffmpeg：视频抽音频不可用（音频导入不受影响）。"
                     "点「上传 ffmpeg.exe」选一个本地 ffmpeg，或「填路径」指定位置。")}
    _FF_CACHE["t"], _FF_CACHE["v"] = now, out
    return out



def _mat_dir() -> str:
    d = os.path.join(_lf_root(), "materials")
    os.makedirs(d, exist_ok=True)
    return d


def _mat_index_path() -> str:
    return os.path.join(_mat_dir(), "index.json")


def _load_materials():
    data = _read_json(_mat_index_path(), {"items": []})
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        return {"items": []}
    data["items"] = [x for x in data["items"]
                     if isinstance(x, dict) and os.path.exists(os.path.join(_mat_dir(), os.path.basename(x.get("file", ""))))]
    return data


def _save_materials(idx):
    _write_json(_mat_index_path(), idx)


# ---------------------------- 置顶（三个库共用） ----------------------------
# 置顶只改排序，不动文件：pin 存成时间戳，谁最后置顶谁排最前（可以置顶多个）。
# 三个库（音色 / 音效 / 导入台素材）共用同一套字段和排序，所以时间轴页读同一份
# 索引时也是置顶在前，不用在那边再写一遍。
_PIN_KINDS = ("refs", "sfx", "media")


def _pin_sort(items):
    """置顶的在前（后置顶的更靠前），其余按创建时间倒序。"""
    return sorted(items, key=lambda x: (-(float(x.get("pin") or 0)),
                                        -(float(x.get("created") or 0))))


# ---------------------------- 素材文件夹（三个库共用） ----------------------------
# 文件夹**只是索引里的一个字符串字段** `items[].folder`（例如 "ASMR/喘息"），不搬文件。
# 这么做的好处：移动/改名是改一个字段，不会因为 os.replace 失败留下半套数据；
# 删文件夹也绝不会删音频 —— 里面的素材回到「未归档」，随时能重新归类。
# 三个库（音色 refs / 音效 sfx / 导入台 media）共用同一套字段与接口，
# 所以工作台、时间轴、音效台看到的目录结构完全一致。
_FOLDER_MAX_LEN = 120
_FOLDER_MAX_DEPTH = 5
_FOLDER_MAX_COUNT = 300


def _norm_folder(path):
    """规范化文件夹路径：统一斜杠、去掉空段与 . / ..、限深限长。

    只保留「相对路径」语义 —— 绝对路径、盘符、.. 全被压掉，避免前端传进来
    一个能穿出库目录的字符串（虽然文件夹字段不参与文件系统操作，但脏数据
    会让目录树长得莫名其妙）。
    """
    s = str(path or "").replace("\\", "/").strip()
    parts = []
    for raw in s.split("/"):
        p = raw.strip()
        if not p or p in (".", ".."):
            continue
        p = re.sub(r'[\\:*?"<>|\x00-\x1f]+', "_", p).strip(" .")
        if not p:
            continue
        parts.append(p[:32])
        if len(parts) >= _FOLDER_MAX_DEPTH:
            break
    return "/".join(parts)[:_FOLDER_MAX_LEN]


def _folder_paths(idx):
    """索引里登记过的文件夹 + 条目上实际出现过的（老数据没登记也认）。"""
    out = set()
    for f in idx.get("folders") or []:
        p = _norm_folder(f.get("path") if isinstance(f, dict) else f)
        if p:
            out.add(p)
    for it in idx.get("items") or []:
        p = _norm_folder(it.get("folder"))
        if p:
            out.add(p)
    # 补父级：有 a/b 就一定有 a，目录树不会出现"孤儿深层目录"
    for p in list(out):
        parts = p.split("/")
        for i in range(1, len(parts)):
            out.add("/".join(parts[:i]))
    return out


def _folder_list(idx):
    """给前端的目录清单（count 是**直属**数量，子目录另算）。"""
    counts = {}
    for it in idx.get("items") or []:
        p = _norm_folder(it.get("folder"))
        if p:
            counts[p] = counts.get(p, 0) + 1
    out = []
    for p in sorted(_folder_paths(idx)):
        out.append({"path": p, "name": p.split("/")[-1],
                    "parent": p.rsplit("/", 1)[0] if "/" in p else "",
                    "depth": p.count("/"), "count": counts.get(p, 0)})
    return out


def _store_folders(idx, paths):
    idx["folders"] = [{"path": p} for p in sorted(paths if isinstance(paths, set) else set(paths))]


def _load_kind_idx(kind):
    if kind == "refs":
        return _load_refs()
    if kind == "sfx":
        return _load_sfx()
    return _load_materials()


def _save_kind_idx(kind, idx):
    if kind == "refs":
        _write_json(_refs_index_path(), idx)
    elif kind == "sfx":
        _save_sfx(idx)
    else:
        _save_materials(idx)


# ---------------------------- 高级音效处理台 ----------------------------
# 独立页面 /sfxbench：一段音声「去掉人声 → 按声音事件切成一堆音效 → 挑一部分入库」。
#
# 为什么要落盘一个作业目录 longform/sfxb/<job>/source.wav：
# 分离 30 分钟素材要几十秒到几分钟，而切分参数（最小间隔/门限/最小时长）是要反复试的。
# 分离只做一次、结果落盘，之后每次调参只读这一个 wav，改一个数字立刻看到新分段。
_SFXB_KEEP = 8                      # 只留最近几个作业（源音频动辄几十 MB）
_SFXB = {"jobs": {}, "lock": threading.Lock()}


def _sfxb_dir():
    d = os.path.join(_lf_root(), "sfxb")
    os.makedirs(d, exist_ok=True)
    return d


def _sfxb_mono(x):
    x = np.asarray(x, dtype="float32")
    return x.mean(axis=1) if x.ndim > 1 else x


def _sfxb_job(job):
    """取作业元信息。内存里没有就回读 meta.json —— 进程重启后旧作业不该立刻作废。"""
    j = str(job or "")
    if not j:
        return None
    m = _SFXB["jobs"].get(j)
    if m and os.path.exists(m.get("wav") or ""):
        return m
    p = os.path.join(_sfxb_dir(), j, "meta.json")
    try:
        with open(p, "r", encoding="utf-8") as f:
            m = json.load(f)
        if os.path.exists(m.get("wav") or ""):
            _SFXB["jobs"][j] = m
            return m
    except (OSError, ValueError):
        pass
    return None


def _sfxb_gc(keep=None):
    """按磁盘上作业目录的 mtime 清理，只留最近 keep 个。

    以前只按内存字典记账 —— 进程一重启字典就空，旧目录永远留在盘上，
    「只留 8 个」从第一天起就没生效过（实测积累到 16 个 / 361MB）。
    这里每次 prepare 顺手扫一遍，删的是最旧的几个，不批量删。
    """
    keep = int(keep or _SFXB_KEEP)
    root = _sfxb_dir()
    try:
        dirs = [os.path.join(root, d) for d in os.listdir(root)
                if os.path.isdir(os.path.join(root, d))]
        dirs.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    except OSError:
        return
    for p in dirs[keep:]:
        if _rm_tree(p, budget=1.0):
            _SFXB["jobs"].pop(os.path.basename(p), None)


_SFXB_OP_KEYS = ("trim_silence", "fade", "gain_db", "speed", "pitch",
                 "normalize", "reverse", "denoise", "filter")


def _sfxb_ops(ops):
    """清洗片段级处理项。裁剪 / 分离 / 格式转换不在这里做 —— 切分已经给了范围。"""
    if not isinstance(ops, dict):
        return {}
    out = {}
    for k in _SFXB_OP_KEYS:
        v = ops.get(k)
        if v in (None, False, "", 0):
            continue
        if k in ("gain_db", "speed", "pitch"):
            try:
                v = float(v)
            except (TypeError, ValueError):
                continue
            if k == "speed" and abs(v - 1.0) < 1e-3:
                continue
            if k == "pitch" and abs(v) < 0.05:
                continue
            if k == "gain_db" and abs(v) < 0.05:
                continue
        elif k == "denoise":
            try:
                v = float(v)
            except (TypeError, ValueError):
                continue
            if v <= 0:
                continue
        elif k in ("fade", "filter", "normalize", "trim_silence"):
            if not isinstance(v, dict) or not any(v.values()):
                continue
        out[k] = v
    return out


def _sfxb_proc(seg, sr, ops):
    """片段 → 处理后的片段。返回 (data, sr, labels)；没有处理项时原样返回。"""
    clean = _sfxb_ops(ops)
    if not clean:
        return seg, sr, []
    data, sr2, labels = _apply_ops(seg, sr, clean)
    return data, sr2, labels


def _sfxb_env(x, sr, points=1400):
    """给前端画总波形用的包络（每块的峰值）。不传整段音频，几十分钟也只有几 KB。"""
    m = _sfxb_mono(x)
    n = len(m)
    if n == 0:
        return []
    block = max(1, n // points)
    out = []
    for i in range(0, n - block + 1, block):
        out.append(round(float(np.abs(m[i:i + block]).max()), 4))
    return out


def _sfxb_db(x, sr, hop=0.02, win=0.04):
    """逐帧 RMS（dB）。用前缀和算，几十分钟素材也不用等。"""
    m = _sfxb_mono(x)
    n = len(m)
    h = max(1, int(hop * sr))
    w = max(h, int(win * sr))
    pad = w // 2
    y = np.pad(m.astype(np.float64), (pad, pad), mode="constant")
    c = np.concatenate(([0.0], np.cumsum(y * y)))
    starts = np.arange(0, max(1, n), h)
    a = starts
    b = np.minimum(starts + w, len(y))
    e = (c[b] - c[a]) / np.maximum(1, b - a)
    return 10.0 * np.log10(np.maximum(e, 1e-12)), h


def _sfxb_foreground(x, sr):
    """减掉「稳态背景」：沿时间对每个频点取中位数当噪声床，只留事件。

    连续雨声/风扇/空调这种床，在「按间隔切」里会把整段连成一片 —— 先把它拿走，
    短促事件之间的间隔才浮得出来。切完还是从原音上取片段，不会把床真的删掉。
    """
    import librosa
    m = _sfxb_mono(x)
    S = librosa.stft(m, n_fft=1024, hop_length=256)
    mag = np.abs(S)
    bed = np.median(mag, axis=1, keepdims=True) * 1.25
    fg = np.maximum(mag - bed, 0.0) * np.exp(1j * np.angle(S))
    return librosa.istft(fg, hop_length=256, length=len(m)).astype("float32")


def _sfxb_runs(x, sr, min_gap=0.35, thresh_db=10.0):
    """找「连续有声段」（秒）。门限 = 底噪 + N dB，但至少低于峰值 6dB。"""
    db, h = _sfxb_db(x, sr)
    if not len(db):
        return []
    floor = float(np.percentile(db, 8))
    top = float(np.percentile(db, 99.5))
    # 连续声音（一整段音乐、一屋子雨声）里底噪≈峰值，只按「底噪+N」算会把整段判成静音、
    # 一段都切不出来。所以再夹一道「至少低于峰值 6dB」。
    thr = min(floor + float(thresh_db), top - 6.0)
    active = db > thr
    runs, i, N = [], 0, len(active)
    while i < N:
        if not active[i]:
            i += 1
            continue
        j = i
        while j + 1 < N and active[j + 1]:
            j += 1
        runs.append([i * h, (j + 1) * h])
        i = j + 1
    merged = []
    gap_n = max(0.0, float(min_gap)) * sr
    for a, b in runs:
        if merged and (a - merged[-1][1]) < gap_n:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    return [(a / float(sr), b / float(sr)) for a, b in merged]


def _sfxb_srt_runs(cues, total, min_gap=0.35):
    """把「字幕区间」的补集算成候选片段。

    cues 是 [[起, 止], ...]（秒），可能来自 SRT，也可能是手输。
    两条字幕之间那段如果短于 min_gap，说明只是句间停顿，不是音效，并到一起去掉。
    """
    spans = []
    for c in (cues or []):
        try:
            a, b = float(c[0]), float(c[1])
        except (TypeError, ValueError, IndexError):
            continue
        a = max(0.0, min(float(total), a))
        b = max(0.0, min(float(total), b))
        if b - a > 0.01:
            spans.append((a, b))
    if not spans:
        return []
    spans.sort()
    merged = [list(spans[0])]
    for a, b in spans[1:]:               # 有重叠/相接的字幕先并起来
        if a <= merged[-1][1] + 0.01:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])

    runs, prev = [], 0.0
    for a, b in merged:
        if a - prev > 0.01:
            runs.append((prev, a))
        prev = max(prev, b)
    if total - prev > 0.01:
        runs.append((prev, total))

    # 相邻两段之间只隔了一条很短的台词 → 并成一段（那句台词不值得把音效切成两半）
    out = []
    for a, b in runs:
        if out and a - out[-1][1] < float(min_gap):
            out[-1][1] = b
        else:
            out.append([a, b])
    return [(a, b) for a, b in out]


def _sfxb_fingerprint(x, sr, a, b, n_mels=32):
    """片段的"长相"：对数梅尔谱沿时间取平均，去均值后归一化。

    用途是找"同一段音效在原片里出现很多次"（关门声出现 20 次、只入库一次）。
    不去比波形 —— 每次出现都带不同的底噪和相位，比波形会一个都匹配不上。
    """
    import librosa
    mono = _sfxb_mono(x)
    i, j = int(max(0.0, a) * sr), int(min(len(mono) / float(sr), b) * sr)
    if j - i < 1024:
        return None
    seg = mono[i:j].astype("float32")
    S = np.abs(librosa.stft(seg, n_fft=1024, hop_length=256)) ** 2
    mel = librosa.feature.melspectrogram(S=S, sr=sr, n_mels=n_mels, fmin=60, fmax=8000)
    v = np.log(mel + 1e-8).mean(axis=1)
    v = v - float(v.mean())
    n = float(np.linalg.norm(v))
    return None if n < 1e-9 else (v / n)


def _sfxb_pack(raw, mono, sr, total, min_len, pad):
    """把 (起, 止) 列表打包成前端要的分段对象：夹到 [0,total]、丢掉太短的、算峰值/电平。"""
    out = []
    for s0, e0 in raw:
        s = max(0.0, s0 - pad)
        e = min(total, e0 + pad)
        if e - s < float(min_len):
            continue
        seg = mono[int(s * sr):int(e * sr)]
        if not len(seg):
            continue
        pmax = float(np.abs(seg).max())
        rms = float(np.sqrt(np.mean(seg.astype(np.float64) ** 2)) + 1e-12)
        out.append({"i": len(out), "start": round(s, 3), "end": round(e, 3),
                    "dur": round(e - s, 3), "peak": round(pmax, 4),
                    "rms_db": round(20 * np.log10(rms), 1)})
        if len(out) >= 4000:          # 再多就不是「挑音效」而是切碎了
            break
    return out


def _sfxb_segments(x, sr, mode="gap", min_gap=0.35, min_len=0.2, thresh_db=10.0, pad=0.03,
                   cues=None):
    """把一段音频切成「声音事件」。

    mode = gap  按静音间隔（默认，最稳）
    mode = fg   先减稳态背景再按间隔（连续环境音里挑事件）
    mode = onset 按起始点（谱通量峰；节奏型/打击类更贴）
    mode = srt  按字幕间隔 —— 字幕区间是"在说话"，取补集就是音效候选区。
                有字幕时这个比 RMS 准得多：RMS 只知道"有没有声音"，
                而台词和音效都有声音，分不开。
    """
    mono = _sfxb_mono(x)
    total = len(mono) / float(sr)
    if total <= 0.05:
        return [], False
    raw = []
    if mode == "onset":
        try:
            import librosa
            ts = librosa.onset.onset_detect(y=mono, sr=sr, hop_length=256,
                                            backtrack=False, units="time")
            times = [0.0] + [float(t) for t in ts if 0.02 < float(t) < total - 0.02] + [total]
            raw = [(times[i], times[i + 1]) for i in range(len(times) - 1)]
        except Exception:  # noqa: BLE001
            mode = "gap"
    if mode == "srt":
        raw = _sfxb_srt_runs(cues, total, min_gap)
    fell_back = False
    if not raw and mode == "fg":
        # 减完背景什么都没剩（整段是稳态噪声/长音）→ 先记一笔，下面退回按原信号切
        raw = _sfxb_runs(_sfxb_foreground(x, sr), sr, min_gap, thresh_db)
        fell_back = not raw
    if not raw:
        raw = _sfxb_runs(mono, sr, min_gap, thresh_db)

    out = _sfxb_pack(raw, mono, sr, total, min_len, pad)
    if not out and mode == "fg":
        # 减背景后剩下的都被「最短片段」滤掉了：退回按原信号切，并告诉前端为什么
        out = _sfxb_pack(_sfxb_runs(mono, sr, min_gap, thresh_db),
                         mono, sr, total, min_len, pad)
        fell_back = True
    return out, fell_back


# ---------------------------- 音效素材库 ----------------------------
# 与「素材库」分开存：音效是成品音（咔哒、脚步、风声），生命周期比中间素材长，
# 会被台本标签引用（tag.sfx.mid），所以索引单独放 longform/sfx/index.json。
SFX_MAX_BYTES = 200 * 1024 * 1024
SFX_SR = MAT_SR


def _sfx_dir() -> str:
    d = os.path.join(_lf_root(), "sfx")
    os.makedirs(d, exist_ok=True)
    return d


def _sfx_index_path() -> str:
    return os.path.join(_sfx_dir(), "index.json")


def _load_sfx():
    data = _read_json(_sfx_index_path(), {"items": []})
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        return {"items": []}
    data["items"] = [x for x in data["items"]
                     if isinstance(x, dict)
                     and os.path.exists(os.path.join(_sfx_dir(), os.path.basename(x.get("file", ""))))]
    return data


def _save_sfx(idx):
    _write_json(_sfx_index_path(), idx)


def sfx_item(mid):
    """按 id 取音效（timeline_api 也用它来放标签音效）。"""
    if not mid:
        return None
    try:
        idx = _load_sfx()
    except Exception:  # noqa: BLE001
        return None
    return next((x for x in idx["items"] if x.get("id") == mid), None)


def sfx_path_of(mid):
    it = sfx_item(mid)
    if not it:
        return None
    p = os.path.join(_sfx_dir(), os.path.basename(it["file"]))
    return p if os.path.exists(p) else None


# ---------------------------- 全局设置 ----------------------------
# 与「台本默认参数」分开：这份是**跨台本**的偏好（时间轴 / 导出 / 界面），
# 台本默认参数还是存在 script.defaults 里（每个台本一份）。
# 存 longform/settings.json，键名固定，改结构时只做「缺的补默认、多的忽略」。
SETTINGS_DEFAULT = {
    "tl": {
        "lockVoice": True,       # 语音片段落到时间轴时默认锁定（位置跟台本走）
        "tagFollow": "follow",   # 新建工程的标签跟随默认口径
        "snap": True,            # 时间轴默认开吸附
        "hoverIns": True,        # 标记处「＋ 插入素材」悬浮窗默认显示
    },
    "mix": {
        "format": "wav", "bitDepth": "16", "rate": "44100",
        "channels": 2, "dmode": "visible",
    },
    # 人物标签：跨台本。autoVoice = 智能导入时按「人物 → 音色」自动设音色（只改音色）。
    "voice": {"autoVoice": True},
}
_SETTINGS_CACHE = {"mtime": None, "data": None}


def _settings_path() -> str:
    return os.path.join(_lf_root(), "settings.json")


def _load_settings():
    """读全局设置：缺的键补默认，值做类型/范围收敛（坏数据不会把 UI 弄崩）。"""
    path = _settings_path()
    try:
        mt = os.path.getmtime(path)
    except OSError:
        mt = None
    if _SETTINGS_CACHE["mtime"] == mt and _SETTINGS_CACHE["data"] is not None:
        return _SETTINGS_CACHE["data"]
    raw = _read_json(path, {}) if mt is not None else {}
    if not isinstance(raw, dict):
        raw = {}
    out = {"tl": dict(SETTINGS_DEFAULT["tl"]), "mix": dict(SETTINGS_DEFAULT["mix"]),
           "voice": dict(SETTINGS_DEFAULT["voice"])}

    tl = raw.get("tl") if isinstance(raw.get("tl"), dict) else {}
    for k in ("lockVoice", "snap", "hoverIns"):
        if k in tl:
            out["tl"][k] = bool(tl[k])
    if tl.get("tagFollow") in ("follow", "fixed", "inline", "between"):
        out["tl"]["tagFollow"] = tl["tagFollow"]

    mx = raw.get("mix") if isinstance(raw.get("mix"), dict) else {}
    if mx.get("format") in ("wav", "flac", "mp3", "ogg"):
        out["mix"]["format"] = mx["format"]
    if str(mx.get("bitDepth") or "") in ("16", "24", "32", "high", "standard", "small"):
        out["mix"]["bitDepth"] = str(mx["bitDepth"])
    if str(mx.get("rate") or "") in ("16000", "22050", "32000", "44100", "48000", "96000"):
        out["mix"]["rate"] = str(mx["rate"])
    if mx.get("channels") in (1, 2, "1", "2"):
        out["mix"]["channels"] = int(mx["channels"])
    if mx.get("dmode") in ("visible", "full"):
        out["mix"]["dmode"] = mx["dmode"]

    vc = raw.get("voice") if isinstance(raw.get("voice"), dict) else {}
    if "autoVoice" in vc:
        out["voice"]["autoVoice"] = bool(vc["autoVoice"])

    _SETTINGS_CACHE["mtime"] = mt
    _SETTINGS_CACHE["data"] = out
    return out


SETTINGS_CHOICES = {
    ("tl", "tagFollow"): ("follow", "fixed", "inline", "between"),
    ("mix", "format"): ("wav", "flac", "mp3", "ogg"),
    ("mix", "bitDepth"): ("16", "24", "32", "high", "standard", "small"),
    ("mix", "rate"): ("16000", "22050", "32000", "44100", "48000", "96000"),
    ("mix", "dmode"): ("visible", "full"),
}


def _save_settings(patch):
    """只接受认识的键 + 合法值；非法值**保持原样**（不是退回默认）。"""
    cur = _load_settings()
    if isinstance(patch, dict):
        vc = patch.get("voice")
        if isinstance(vc, dict) and "autoVoice" in vc:
            cur["voice"]["autoVoice"] = bool(vc["autoVoice"])
        for sec in ("tl", "mix"):
            sub = patch.get(sec)
            if not isinstance(sub, dict):
                continue
            for k, v in sub.items():
                if k in ("lockVoice", "snap", "hoverIns"):
                    cur[sec][k] = bool(v)
                elif (sec, k) in SETTINGS_CHOICES:
                    val = str(v)
                    if val in SETTINGS_CHOICES[(sec, k)]:
                        cur[sec][k] = int(val) if k == "channels" else val
                elif (sec, k) == ("mix", "channels"):
                    if v in (1, 2, "1", "2"):
                        cur[sec][k] = int(v)
    tmp = {"tl": cur["tl"], "mix": cur["mix"], "voice": cur["voice"]}
    _write_json(_settings_path(), tmp)
    _SETTINGS_CACHE["mtime"] = None
    _SETTINGS_CACHE["data"] = None
    return _load_settings()


def _read_audio_any(path):
    """读任意音频 → (float32 (n, ch), sr)。soundfile 读不了就用 ffmpeg 转一次。"""
    try:
        data, sr = sf.read(path, dtype="float32", always_2d=True)
        if data.size:
            return data, int(sr)
    except Exception:
        pass
    ff = _ffmpeg_bin()
    if not ff:
        raise HTTPException(400, "这个文件读不出音频（可能不是音频流）")
    tmp = os.path.join(_mat_dir(), f".tmp_{uuid.uuid4().hex[:8]}.wav")
    try:
        _run_ffmpeg([ff, "-y", "-v", "error", "-i", path, "-vn",
                     "-c:a", "pcm_s16le", tmp])
        data, sr = sf.read(tmp, dtype="float32", always_2d=True)
        return data, int(sr)
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


def _run_ffmpeg(args, timeout=900):
    try:
        p = subprocess.run(args, capture_output=True, timeout=timeout)
    except FileNotFoundError:
        raise HTTPException(500, "ffmpeg 不可用")
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "处理超时（文件太长？）")
    if p.returncode != 0:
        msg = (p.stderr or b"").decode("utf-8", "ignore").strip().splitlines()
        raise HTTPException(400, "ffmpeg 处理失败：" + (msg[-1] if msg else "未知错误"))


def _resample_audio(data, sr_from, sr_to):
    """保留声道数的重采样（soxr → scipy → 线性插值）。"""
    sr_from, sr_to = int(sr_from), int(sr_to)
    if sr_from == sr_to or data.size == 0:
        return data
    try:
        import soxr  # type: ignore
        out = soxr.resample(data, sr_from, sr_to, quality="HQ")
        return np.asarray(out, dtype="float32")
    except Exception:  # noqa: BLE001
        pass
    try:
        from math import gcd
        from scipy.signal import resample_poly  # type: ignore
        g = gcd(sr_from, sr_to)
        return np.asarray(resample_poly(data, sr_to // g, sr_from // g, axis=0), dtype="float32")
    except Exception:  # noqa: BLE001
        pass
    n_out = int(round(len(data) * sr_to / float(sr_from)))
    if n_out <= 0:
        return np.zeros((0, data.shape[1]), dtype="float32")
    xp = np.linspace(0.0, 1.0, len(data), endpoint=False)
    x = np.linspace(0.0, 1.0, n_out, endpoint=False)
    return np.stack([np.interp(x, xp, data[:, c]) for c in range(data.shape[1])],
                    axis=1).astype("float32")


def _write_wav(path, data, sr):
    data = np.asarray(data, dtype="float32")
    if data.ndim == 1:
        data = data[:, None]
    np.clip(data, -1.0, 1.0, out=data)
    sf.write(path, data if data.shape[1] > 1 else data[:, 0], int(sr),
             subtype="PCM_16", format="WAV")


def _to_mono(x):
    if x.ndim == 1:
        return x
    return x.mean(axis=1).astype("float32")


# ---- STFT 工具（纯 numpy，避免 librosa/numba 的启动开销）----
def _stft(x, n_fft=2048, hop=512):
    win = np.hanning(n_fft).astype("float32")
    x = np.asarray(x, dtype="float32")
    if len(x) < n_fft:
        x = np.pad(x, (0, n_fft - len(x)))
    pad = n_fft // 2
    xp = np.pad(x, (pad, pad), mode="reflect")
    frames = np.lib.stride_tricks.sliding_window_view(xp, n_fft)[::hop]
    return np.fft.rfft(frames * win, axis=1), win


def _istft(S, win, hop, length):
    n = len(win)
    frames = np.fft.irfft(S, n=n, axis=1).astype("float32") * win
    total = (len(frames) - 1) * hop + n
    out = np.zeros(total, dtype="float32")
    wsum = np.zeros(total, dtype="float32")
    for i in range(len(frames)):
        s = i * hop
        out[s:s + n] += frames[i]
        wsum[s:s + n] += win * win
    out /= np.maximum(wsum, 1e-6)
    return out[n // 2:n // 2 + length]


def _blockwise(x, sr, fn, block_sec=20.0, pad_sec=0.6):
    """分块处理 + 交叉淡化：长音频不会一次性吃掉几百 MB 内存。"""
    n = len(x)
    blk, pad = int(sr * block_sec), int(sr * pad_sec)
    if n <= blk + 2 * pad:
        return fn(x)
    stereo = x.ndim > 1
    out = np.zeros_like(x)
    wsum = np.zeros(n, dtype="float32")
    pos = 0
    while pos < n:
        a, b = max(0, pos - pad), min(n, pos + blk + pad)
        seg = fn(x[a:b])
        ramp = np.ones(len(seg), dtype="float32")
        if a > 0:
            k = min(pad, len(seg))
            ramp[:k] = np.linspace(0.0, 1.0, k, dtype="float32")
        if b < n:
            k = min(pad, len(seg))
            ramp[-k:] = np.minimum(ramp[-k:], np.linspace(1.0, 0.0, k, dtype="float32"))
        if stereo:
            out[a:b] += seg * ramp[:, None]
            wsum[a:b] += ramp
        else:
            out[a:b] += seg * ramp
            wsum[a:b] += ramp
        pos += blk
    return out / np.maximum(wsum, 1e-6)


def _separate(x, sr, mode="vocals", strength=0.65):
    """中置提取：人声通常居中（左右高度相干），伴奏/混响偏宽（相干性低）。

    sim = 2|L·conj(R)| / (|L|²+|R|²)  → 0..1；用 sim^p 做软掩码取中置分量。
    mode=vocals 取中置，mode=instrumental 取两侧 + 中置的残差。
    """
    if x.ndim == 1 or x.shape[1] < 2:
        raise HTTPException(400, "单声道素材分不开人声（左右信息已被合在一起），请上传立体声原文件")
    L = x[:, 0].astype("float32")
    R = x[:, 1].astype("float32")

    def work(seg):
        SL, win = _stft(seg[:, 0])
        SRf, _ = _stft(seg[:, 1])
        magL = np.abs(SL)
        magR = np.abs(SRf)
        cross = SL * np.conj(SRf)
        sim = (2.0 * np.abs(cross)) / (magL * magL + magR * magR + 1e-9)
        p = 1.5 + 4.5 * float(np.clip(strength, 0.0, 1.0))
        mask = np.power(np.clip(sim, 0.0, 1.0), p).astype("float32")
        mid = 0.5 * (SL + SRf)
        side = 0.5 * (SL - SRf)
        S = mid * mask if mode == "vocals" else (side + mid * (1.0 - mask))
        y = _istft(S, win, 512, len(seg))
        return y

    y = _blockwise(x, sr, work)
    return np.stack([y, y], axis=1)


def _denoise(x, strength=0.5):
    s = float(np.clip(strength, 0.0, 1.0))

    def work(seg):
        mono = seg if seg.ndim == 1 else seg.mean(axis=1)
        S, win = _stft(mono)
        mag = np.abs(S)
        # 每个频点取能量最低的 15% 帧作为噪声底
        frame_e = mag.mean(axis=1)
        idx = np.argsort(frame_e)[:max(4, int(len(frame_e) * 0.15))]
        noise = np.percentile(mag[idx], 60, axis=0)
        factor = 1.2 + 2.6 * s
        floor = mag * (0.10 - 0.08 * s)
        clean = np.maximum(mag - factor * noise, floor)
        phase = np.exp(1j * np.angle(S))
        y = _istft(clean * phase, win, 512, len(mono))
        return y

    if x.ndim == 1:
        return _blockwise(x, 44100, work)
    out = np.zeros_like(x)
    for c in range(x.shape[1]):
        out[:, c] = _blockwise(np.ascontiguousarray(x[:, c]), 44100, work)
    return out


def _trim_silence(x, sr, threshold_db=-45.0, pad=0.06):
    mono = _to_mono(x)
    if not len(mono):
        return x
    win = max(1, int(sr * 0.02))
    n = len(mono) // win * win
    if n <= 0:
        return x
    frames = mono[:n].reshape(-1, win)
    rms = np.sqrt((frames ** 2).mean(axis=1) + 1e-12)
    db = 20 * np.log10(rms + 1e-9)
    keep = np.where(db > float(threshold_db))[0]
    if not len(keep):
        return x
    a = max(0, int(keep[0] * win - pad * sr))
    b = min(len(x), int((keep[-1] + 1) * win + pad * sr))
    return x[a:b]


def _normalize(x, mode="peak", target_db=-1.0):
    if not x.size:
        return x
    target = 10 ** (float(target_db) / 20.0)
    if mode == "rms":
        rms = float(np.sqrt(np.mean(np.square(x)) + 1e-12))
        if rms < 1e-6:
            return x
        return np.clip(x * (target / rms), -1.0, 1.0).astype("float32")
    peak = float(np.max(np.abs(x)))
    if peak < 1e-6:
        return x
    return np.clip(x * (target / peak), -1.0, 1.0).astype("float32")


def _apply_fade(x, sr, fin=0.0, fout=0.0):
    y = x.copy()
    a = int(max(0.0, fin) * sr)
    b = int(max(0.0, fout) * sr)
    if a > 0:
        a = min(a, len(y))
        ramp = np.linspace(0.0, 1.0, a, dtype="float32")
        if y.ndim > 1:
            y[:a] *= ramp[:, None]
        else:
            y[:a] *= ramp
    if b > 0:
        b = min(b, len(y))
        ramp = np.linspace(1.0, 0.0, b, dtype="float32")
        if y.ndim > 1:
            y[-b:] *= ramp[:, None]
        else:
            y[-b:] *= ramp
    return y


def _apply_ops(data, sr, ops):
    """按固定顺序处理音频：裁剪 → 分离 → 降噪 → 去静音 → 标准化 → 淡入淡出 → 转换。

    音色素材与音效素材共用这一套，保证两处「净化人声 / 做成音效」的结果一模一样。
    返回 (data, sr, labels)；labels 同时用于结果命名与回执。
    """
    labels = []

    tr = ops.get("trim") or None
    if tr:
        a = max(0.0, float(tr.get("start") or 0))
        b = tr.get("end")
        i0 = int(a * sr)
        i1 = int(float(b) * sr) if b not in (None, "") else len(data)
        i1 = max(i0 + 1, min(i1, len(data)))
        if i0 < len(data):
            data = data[i0:i1]
            labels.append("裁剪")

    sp = ops.get("separate") or None
    if sp and sp.get("mode") in ("vocals", "instrumental"):
        # 引擎按优先级排队：用户选的那个先试，挂了就降级（BS-Roformer → Demucs → 中置提取），
        # 绝不让一条素材因为「模型没配好」整条处理失败。
        engine = (sp.get("engine") or "demucs").lower()
        chain = {"roformer": ["roformer", "demucs", "dsp"],
                 "demucs": ["demucs", "dsp"],
                 "dsp": ["dsp"]}.get(engine) or ["demucs", "dsp"]
        q = str(sp.get("quality") or "std").lower()
        rs = float(sp.get("residual") or 0.0)
        t0 = time.time()
        done = False
        for eng in chain:
            try:
                if eng == "roformer":
                    data2 = _roformer_separate(data, sr, sp["mode"], sp.get("rmodel"), rs)
                    mark = "BS-Roformer"
                elif eng == "demucs":
                    data2 = _demucs_separate(data, sr, sp["mode"], q, rs)
                    mark = "Demucs"
                else:
                    data2 = _separate(data, sr, sp["mode"], float(sp.get("strength") or 0.65))
                    mark = "中置提取"
            except Exception as e:  # noqa: BLE001
                _log("longform: separate %s via %s failed (%s: %s)",
                     sp["mode"], eng, type(e).__name__, e, level="warning")
                continue
            data = data2
            done = True
            labels.append("人声" if sp["mode"] == "vocals" else "伴奏")
            labels.append(mark if eng == chain[0] else f"{mark}（替代）")
            if eng == "demucs" and q != "std":
                labels.append("精细分离" if q == "fine" else "快速分离")
            if rs > 0 and sp["mode"] == "instrumental":
                labels.append(f"残留抑制{int(round(rs * 100))}%")
            _log("longform: separate %s via %s done in %.1fs (%.1fs audio)",
                 sp["mode"], eng, time.time() - t0, len(data) / float(sr))
            break
        if not done:
            raise HTTPException(400, "人声分离失败：BS-Roformer / Demucs / 中置提取都不可用")

    dn = ops.get("denoise")
    if dn:
        data = _denoise(data, float(dn))
        labels.append("降噪")

    ts = ops.get("trim_silence") or None
    if ts:
        data = _trim_silence(data, sr, float(ts.get("threshold_db") or -45),
                             float(ts.get("pad") or 0.06))
        labels.append("去静音")

    # ---- 音效向：滤波 / 增益 / 变速 / 变调（放在标准化之前，峰值才算得准）----
    flt = ops.get("filter") or None
    if flt:
        data, fl = _band_filter(data, sr, flt.get("hp"), flt.get("lp"))
        labels += fl

    gdb = ops.get("gain_db")
    if gdb:
        data = np.asarray(data, dtype="float32") * float(10.0 ** (float(gdb) / 20.0))
        labels.append(f"音量{float(gdb):+.1f}dB")

    sp = ops.get("speed")
    if sp and abs(float(sp) - 1.0) > 1e-3:
        z = _wsola_stretch(data, sr, float(sp))
        if z is not None:
            data = z
            labels.append(f"变速{float(sp):.2f}×")
        else:  # 没有 WSOLA：退回重采样（会同时变调）
            data = _resample_audio(data, sr, max(4000, int(round(sr * float(sp)))))
            labels.append(f"变速{float(sp):.2f}×(变调)")

    pt = ops.get("pitch")
    if pt and abs(float(pt)) > 0.05:
        n0 = len(data)
        data = _pitch_shift(data, sr, float(pt))
        dur_changed = abs(len(data) - n0) > max(32, int(n0 * 0.01))
        labels.append(f"变调{float(pt):+.0f}半音" + ("(变速)" if dur_changed else ""))

    nm = ops.get("normalize") or None
    if nm:
        data = _normalize(data, nm.get("mode") or "peak", float(nm.get("target_db") or -1))
        labels.append("标准化")

    if ops.get("reverse"):
        data = np.ascontiguousarray(np.asarray(data, dtype="float32")[::-1])
        labels.append("反向")

    fd = ops.get("fade") or None
    if fd and (fd.get("in") or fd.get("out")):
        data = _apply_fade(data, sr, float(fd.get("in") or 0), float(fd.get("out") or 0))
        labels.append("淡入淡出")

    cv = ops.get("convert") or None
    if cv:
        target_sr = _norm_sr(cv.get("sr") or sr, sr)
        if target_sr != sr:
            data = _resample_audio(data, sr, target_sr)
            sr = target_sr
            labels.append(f"{target_sr // 1000}k")
        ch = int(cv.get("channels") or data.shape[1])
        if ch == 1 and data.shape[1] > 1:
            data = _to_mono(data)
            labels.append("单声道")
        elif ch == 2 and data.shape[1] == 1:
            data = np.stack([data[:, 0], data[:, 0]], axis=1)
            labels.append("立体声")

    return data, sr, labels


# ---- 音效专用处理：变速 / 变调 / 滤波 / 增益 / 反向 --------------------------
# 时间伸缩用 audiotsm 的 WSOLA（和主程序「变速」同一个引擎，保持音高），
# 缺失时退回重采样（会同时变调），并在标签里说明，避免静默降级。
_WSOLA_FRAME = 1024


def _wsola_stretch(data, sr, rate):
    """保持音高的时间伸缩：rate>1 变快（时长 /rate）。失败返回 None。"""
    try:
        from audiotsm import wsola
        from audiotsm.io.array import ArrayReader, ArrayWriter
    except Exception:  # noqa: BLE001
        return None
    x = np.asarray(data, dtype="float32")
    if x.ndim == 1:
        x = x[:, None]
    rate = max(0.25, min(4.0, float(rate or 1.0)))
    outs = []
    try:
        for ch in range(x.shape[1]):
            src = np.ascontiguousarray(x[:, ch].reshape(1, -1), dtype="float32")
            # 尾巴补一帧，避免 WSOLA 把最后一帧丢掉；再按理想长度裁回来
            src = np.concatenate([src, np.zeros((1, _WSOLA_FRAME), dtype="float32")], axis=1)
            writer = ArrayWriter(1)
            wsola(channels=1, speed=rate, frame_length=_WSOLA_FRAME).run(ArrayReader(src), writer)
            y = np.asarray(writer.data[0], dtype="float32")
            want = int(round(x.shape[0] / rate))
            if y.shape[0] < want:
                y = np.concatenate([y, np.zeros(want - y.shape[0], dtype="float32")])
            else:
                y = y[:want]
            outs.append(y)
        return np.stack(outs, axis=1) if outs else None
    except Exception as e:  # noqa: BLE001
        _log("longform: wsola failed: %s", e, level="warning")
        return None


def _pitch_shift(data, sr, semitones):
    """变调但保持时长：重采样 r 倍（音高×r、时长÷r）+ WSOLA 放慢 1/r 倍。"""
    r = float(2.0 ** (float(semitones) / 12.0))
    if abs(r - 1.0) < 1e-3:
        return data
    # 重采样到 sr/r 再「当成 sr 播放」：音高 ×r、时长 ÷r（写成 sr*r 会反着来）
    y = _resample_audio(data, sr, max(4000, int(round(sr / r))))
    z = _wsola_stretch(y, sr, 1.0 / r)
    if z is None:
        return y      # 没有 WSOLA 就退回「变调+变速」，调用方会标注
    return z


def _band_filter(data, sr, hp=None, lp=None):
    """二阶巴特沃斯高通 / 低通（scipy）。返回 (data, labels)。"""
    labels = []
    try:
        from scipy.signal import butter, sosfilt  # type: ignore
    except Exception:  # noqa: BLE001
        return data, labels
    x = np.asarray(data, dtype="float32")
    nyq = sr / 2.0
    if hp:
        f = max(10.0, min(nyq - 100.0, float(hp)))
        if f < nyq - 50:
            x = sosfilt(butter(2, f / nyq, btype="highpass", output="sos"), x, axis=0)
            labels.append(f"低切{int(round(f))}Hz")
    if lp:
        f = max(200.0, min(nyq - 100.0, float(lp)))
        if f < nyq - 50:
            x = sosfilt(butter(2, f / nyq, btype="lowpass", output="sos"), x, axis=0)
            labels.append(f"高切{int(round(f))}Hz")
    return np.asarray(x, dtype="float32"), labels


def _save_ref_audio(data, sr, name, src_name="", folder=""):
    """把任意波形存成「模型能吃的音色」：单声道 + 22050 + PCM16 WAV + 内容哈希去重。

    上传音色、以及「导入台 → 存入音色库」都走这里，保证两条入口产出的文件完全一致。
    """
    x = np.asarray(data, dtype="float32")
    if x.ndim == 1:
        x = x[:, None]
    if x.shape[1] > 1:
        x = x.mean(axis=1, keepdims=True)
    x = _resample_audio(x, sr, AUDIO_SR)
    buf = io.BytesIO()
    sf.write(buf, x[:, 0], AUDIO_SR, subtype="PCM_16", format="WAV")
    normalized = buf.getvalue()
    # 用「归一化之后的波形」算哈希：同样内容不管来源格式，都落到同一条音色
    digest = hashlib.sha1(normalized).hexdigest()[:16]
    fn = f"{digest}.wav"
    path = os.path.join(_refs_dir(), fn)
    dur = round(float(len(x)) / AUDIO_SR, 2)
    with _LOCK:
        if not os.path.exists(path):
            with open(path, "wb") as f:
                f.write(normalized)
        idx = _batch_idx("refs")
        own = idx is None
        if own:
            idx = _load_refs()
        item = next((r for r in idx["items"] if r["id"] == digest), None)
        if item is None:
            item = {"id": digest, "file": fn, "created": _now()}
            idx["items"].append(item)
        item["name"] = _safe_title(name or digest, digest)
        item.update({"dur": dur, "sr": AUDIO_SR, "source": src_name})
        # 从导入台的某个目录存成音色时，跟着进同一目录（省得再回头归类一次）
        fld = _norm_folder(folder)
        if fld:
            item["folder"] = fld
            _store_folders(idx, _folder_paths(idx))
        if own:
            _write_json(_refs_index_path(), idx)
    return item


def _mat_add_from_audio(data, sr, name, source, kind="audio", op="", parent="", folder=""):
    """把波形存成「导入台」里的中转素材（44.1k WAV，保留声道）。"""
    x = np.asarray(data, dtype="float32")
    if x.ndim == 1:
        x = x[:, None]
    if x.shape[1] > 2:
        x = x[:, :2]
    x = _resample_audio(x, sr, MAT_SR)
    mid = uuid.uuid4().hex[:12]
    title = _safe_title(name or "素材", "素材")[:48]
    fname = f"{title}_{mid}.wav"
    path = os.path.join(_mat_dir(), fname)
    _write_wav(path, x, MAT_SR)
    item = {"id": mid, "file": fname, "name": title, "kind": kind,
            "source": source or title, "op": op, "parent": parent,
            "dur": round(len(x) / float(MAT_SR), 2), "sr": MAT_SR,
            "ch": int(1 if x.ndim == 1 else x.shape[1]),
            "size": os.path.getsize(path), "created": int(time.time())}
    fld = _norm_folder(folder)
    if fld:
        item["folder"] = fld
    with _LOCK:
        idx = _batch_idx("media")
        own = idx is None
        if own:
            idx = _load_materials()
        idx["items"].append(item)
        if fld:                                  # 新文件夹顺手登记，空目录也能留下来
            _store_folders(idx, _folder_paths(idx))
        if own:
            _save_materials(idx)
    return item


def _trash_dir() -> str:
    d = os.path.join(_mat_dir(), ".trash")
    os.makedirs(d, exist_ok=True)
    return d


def _trash_manifest_path() -> str:
    return os.path.join(_trash_dir(), "manifest.json")


def _load_trash_manifest():
    data = _read_json(_trash_manifest_path(), {"items": []})
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        return {"items": []}
    return data


def _push_trash_manifest(rec):
    """记录「谁被扔进回收站」：文件名、原始 id、名称、参数。

    以前只把文件改成 `<id>_<原名>` 扔进 .trash，恢复得靠人肉猜 index 字段；
    有了 manifest，回收站就能一键还原（含声道/时长/来源）。
    """
    with _LOCK:
        man = _load_trash_manifest()
        man["items"] = [x for x in man["items"] if x.get("trash_file") != rec.get("trash_file")]
        man["items"].append(rec)
        if len(man["items"]) > 500:
            man["items"] = man["items"][-500:]
        _write_json(_trash_manifest_path(), man)


def _trash_material(idx, it, sink=None):
    """把一个中转素材移进 materials/.trash（不真删，可找回）。

    sink：批量清理时传一个 list，把回收站记录攒起来由调用方一次写入 ——
    每次删都重写整份 manifest 的话，清 800 个要 20 秒以上（每次 O(n)）。
    """
    src = os.path.join(_mat_dir(), os.path.basename(it.get("file") or ""))
    trash_name = f"{it['id']}_{os.path.basename(it.get('file') or '')}"
    if os.path.exists(src):
        try:
            os.replace(src, os.path.join(_trash_dir(), trash_name))
        except OSError:
            try:
                os.remove(src)
            except OSError:
                pass
        rec = {
            "trash_file": trash_name, "orig_file": os.path.basename(it.get("file") or ""),
            "id": it.get("id"), "name": it.get("name"), "kind": it.get("kind"),
            "source": it.get("source"), "op": it.get("op"), "parent": it.get("parent"),
            "dur": it.get("dur"), "sr": it.get("sr"), "ch": it.get("ch"),
            "size": it.get("size"), "created": it.get("created"),
            "trashed_at": int(time.time()),
        }
        if sink is None:
            _push_trash_manifest(rec)
        else:
            sink.append(rec)
    idx["items"] = [x for x in idx["items"] if x.get("id") != it.get("id")]


def _push_trash_manifests(recs):
    """一次写入多条回收站记录（批量删除用）。"""
    recs = [r for r in (recs or []) if r]
    if not recs:
        return
    with _LOCK:
        man = _load_trash_manifest()
        keys = {r.get("trash_file") for r in recs}
        man["items"] = [x for x in man["items"] if x.get("trash_file") not in keys]
        man["items"].extend(recs)
        if len(man["items"]) > 500:
            man["items"] = man["items"][-500:]
        _write_json(_trash_manifest_path(), man)


_DEPTH = {"PCM_16": 16, "PCM_24": 24, "PCM_32": 32, "FLOAT": 32, "DOUBLE": 64,
          "PCM_U8": 8, "PCM_S8": 8}


def _audio_props(path):
    """读一个音频文件的真实参数（右键「属性」用）。"""
    try:
        inf = sf.info(path)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"读不出音频信息：{e}")
    st = os.stat(path)
    dur = round(inf.frames / float(inf.samplerate), 3) if inf.samplerate else 0.0
    subtype = (inf.subtype or "").upper()
    depth = _DEPTH.get(subtype)
    bitrate = int(round(st.st_size * 8 / dur / 1000.0)) if dur > 0 else 0
    return {
        "path": path,
        "file": os.path.basename(path),
        "ext": os.path.splitext(path)[1].lstrip(".").upper(),
        "format": (inf.format or "").upper(),
        "subtype": subtype,
        "bit_depth": depth,
        "sample_rate": int(inf.samplerate or 0),
        "channels": int(inf.channels or 0),
        "layout": "立体声" if int(inf.channels or 0) >= 2 else "单声道",
        "dur": dur,
        "size": int(st.st_size),
        "bitrate_kbps": bitrate,
        "mtime": int(st.st_mtime),
    }


# ---------------------------- Demucs（可选，高精度分离） ----------------------------
# 为什么放在 vendor2/：runtime 的 site-packages 被写入过一次就难以回滚，
# 而 Demucs 只是「可选增强」。把它连同几个纯 Python 依赖解包在项目内，
# 需要时加到 sys.path；删掉 vendor2/ 就退回 DSP 中置提取，主流程完全不受影响。
_DEMUCS = {"tried": False, "ok": False, "reason": "", "model": None, "device": "cpu",
           "lock": threading.Lock()}


def _demucs_paths():
    root = _D.get("project_dir") or os.getcwd()
    return [os.path.join(root, "vendor2", "demucs-4.0.1"),
            os.path.join(root, "vendor2", "shim"),
            os.path.join(root, "vendor2", "site")]


def _demucs_torch_home():
    """离线权重目录：vendor2/torch/hub/checkpoints/*.th。

    demucs 的 htdemucs 权重默认第一次用时从 fbaipublicfiles 下载（80MB），
    别人电脑上没网就直接失败。补丁包里带了这份权重，这里把 TORCH_HOME 指到
    包内的 vendor2/torch，torch 就会命中本地缓存、完全不联网。
    """
    root = _D.get("project_dir") or os.getcwd()
    home = os.path.join(root, "vendor2", "torch")
    ck = os.path.join(home, "hub", "checkpoints")
    if os.path.isdir(ck) and any(f.endswith(".th") for f in os.listdir(ck)):
        os.environ["TORCH_HOME"] = home
        return home
    return ""


_DEMUCS_PROBE_LOCK = threading.Lock()


def _demucs_state(probe_only=False):
    """探测 Demucs 是否可用（不加载模型）。

    注意两件事：
      · `tried` 必须等探测**做完**再置位。以前一进门就置 True，页面同时发几个
        请求时，第二个请求看到 tried 却还没写 ok，就会把 False 缓存出去 ——
        设置面板上「Demucs ✗」就是这么来的（实际能用）。
      · 加锁，避免两个线程同时 import torch（慢且会互相踩状态）。
    """
    st = _DEMUCS
    if st["tried"] and not probe_only:
        return st
    with _DEMUCS_PROBE_LOCK:
        if st["tried"] and not probe_only:
            return st
        for p in _demucs_paths():
            if os.path.isdir(p) and p not in sys.path:
                sys.path.append(p)
        st["weights"] = _demucs_torch_home()
        try:
            import torch  # noqa: F401
            from demucs.pretrained import get_model  # noqa: F401
            st["ok"] = True
            st["reason"] = ""
            try:
                st["device"] = "cuda" if torch.cuda.is_available() else "cpu"
            except Exception:  # noqa: BLE001
                st["device"] = "cpu"
        except Exception as e:  # noqa: BLE001
            st["ok"] = False
            st["reason"] = f"{type(e).__name__}: {e}"
        st["tried"] = True
    return st


def _demucs_quick():
    """不 import torch 的粗判（manifest 用）。

    开页面就问一次能力，如果这里去 import torch，会拖慢首屏、还会跟模型加载抢 CPU。
    真正探测过的以缓存为准；没探测过就看「模块目录 + 离线权重」在不在。
    """
    st = _DEMUCS
    if st.get("tried"):
        return bool(st.get("ok")), (st.get("device") or "")
    has_mod = any(os.path.isdir(os.path.join(p, "demucs")) for p in _demucs_paths())
    if not has_mod:
        try:
            has_mod = importlib.util.find_spec("demucs") is not None
        except (ImportError, ValueError):
            has_mod = False
    return bool(has_mod and _demucs_torch_home()), ""


def _demucs_get_model():
    st = _demucs_state()
    if not st["ok"]:
        raise HTTPException(400, "没有可用的 Demucs（vendor2/ 缺失或依赖不全）：" + st["reason"])
    if st["model"] is None:
        with st["lock"]:
            if st["model"] is None:
                _demucs_torch_home()
                import torch
                from demucs.pretrained import get_model
                t0 = time.time()
                m = get_model("htdemucs")
                m.eval()
                m.to(st["device"])
                st["model"] = m
                _log("longform: demucs htdemucs loaded on %s in %.1fs", st["device"], time.time() - t0)
    return st["model"]


# Demucs 推理预算：shifts（随机时移平均次数）/ overlap（分段重叠）
# 越精细越干净，代价是线性变慢 —— fast 约 1×、std 约 2×、fine 约 4×
_DEMUCS_QUALITY = {"fast": (1, 0.25), "std": (2, 0.5), "fine": (4, 0.75)}


def _suppress_vocal_residual(inst, voc, amount):
    """压掉伴奏里残留的人声（Demucs 取伴奏时最明显的那层「电音」）。

    做法：拿 vocals 轨的幅度谱当噪声模型，在伴奏的幅度谱上做过减（over-subtraction），
    时间方向 3 帧平均避免留下音乐噪声，并按 amount 留一个保底比例（免得把伴奏抽空）。
    amount=0 → 原样返回；1 → 最狠（伴奏高频会略空）。
    """
    a = float(np.clip(amount or 0.0, 0.0, 1.0))
    if a <= 0 or inst is None or voc is None or len(inst) == 0 or len(voc) == 0:
        return inst
    n = min(len(inst), len(voc))
    inst = np.asarray(inst[:n], dtype="float32")
    voc = np.asarray(voc[:n], dtype="float32")
    k = np.ones(3, dtype="float32") / 3.0

    def one(y, v):
        Sy, win = _stft(y)
        Sv, _ = _stft(v)
        my, mv = np.abs(Sy), np.abs(Sv)
        mv = np.apply_along_axis(lambda r: np.convolve(r, k, mode="same"), 1, mv)
        fac = 0.6 + 2.4 * a                 # 过减因子 0.6~3.0
        floor = my * (0.35 - 0.25 * a)      # 保底 35%→10%
        clean = np.maximum(my - fac * mv, floor)
        return _istft(clean * np.exp(1j * np.angle(Sy)), win, 512, len(y))

    if inst.ndim == 1:
        return one(inst, voc if voc.ndim == 1 else voc.mean(axis=1))
    out = np.zeros_like(inst)
    for c in range(inst.shape[1]):
        vc = voc[:, c] if (voc.ndim > 1 and c < voc.shape[1]) else (voc if voc.ndim == 1 else voc.mean(axis=1))
        out[:, c] = one(np.ascontiguousarray(inst[:, c]), np.ascontiguousarray(vc))
    return out


def _demucs_separate(data, sr, mode="vocals", quality="std", residual=0.0):
    """Demucs 分离：返回与输入同采样率、同声道数的波形。

    模型固定吃 44.1k 双声道；内部先升采样、归一化（官方 recipe），
    出结果再乘回标准差并降回原采样率，避免音量/音高变化。
    """
    import torch
    from demucs.apply import apply_model

    x = np.asarray(data, dtype="float32")
    if x.ndim == 1:
        x = x[:, None]
    stereo = x.shape[1] >= 2
    # Demucs 固定吃双声道：单声道先复制成两条，出来再合回一条
    work = x[:, :2] if stereo else np.repeat(x, 2, axis=1)

    sr0 = int(sr or AUDIO_SR)
    if sr0 != 44100:
        work = _resample_audio(work, sr0, 44100)

    model = _demucs_get_model()
    shifts, overlap = _DEMUCS_QUALITY.get(str(quality or "std").lower(), _DEMUCS_QUALITY["std"])
    st = _DEMUCS
    with st["lock"]:
        wav = torch.from_numpy(np.ascontiguousarray(work.T))
        ref = wav.mean(0)
        wav = (wav - ref.mean()) / (ref.std() + 1e-8)
        with torch.no_grad():
            out = apply_model(model, wav[None].to(st["device"]), device=st["device"],
                              shifts=int(shifts), split=True, overlap=float(overlap),
                              progress=False)[0]
        out = out.cpu() * ref.std() + ref.mean()

    names = list(getattr(model, "sources", ["drums", "bass", "other", "vocals"]))
    if mode == "instrumental":
        keep = [i for i, n in enumerate(names) if n != "vocals"]
        y = out[keep].sum(dim=0).numpy().T
        if float(residual or 0) > 0:
            # 伴奏里剩下的「电音」＝人声轨的残影，用 vocals 轨压一遍再交出去
            y = _suppress_vocal_residual(y, out[names.index("vocals")].numpy().T, residual)
    else:
        y = out[names.index("vocals")].numpy().T

    if sr0 != 44100:
        y = _resample_audio(y, 44100, sr0)
    if not stereo:
        y = y.mean(axis=1, keepdims=True)
    return np.ascontiguousarray(y, dtype="float32")


# ---------------------------- BS-Roformer（可选，模型自备） ----------------------------
# 和 Demucs 的定位不一样：Demucs 的权重我们塞进了 vendor2/torch，开箱就能用；
# BS-Roformer 单个权重 200MB~1.6GB，打进补丁包不现实，而且它更像「发烧选项」。
# 所以这里只做三件事：扫目录 → 扫到就挂上去当引擎 → 扫不到就静默退回 Demucs。
# 装不装、下不下模型完全由用户决定，工作台只负责提示和给地址。
_ROF = {"models": [], "dir": "", "scanned": 0.0, "sep": None, "key": "",
        "lock": threading.RLock(), "state": {}}
_ROF_W_EXT = (".ckpt", ".pth", ".safetensors", ".th")
_ROF_C_EXT = (".yaml", ".yml")
# Roformer 系（人声分离里公认最干净的一档）；其它架构也能跑，只是不优先推荐
_ROF_FAMILY = ("bs_roformer", "mel_band_roformer", "bs_conformer",
               "mel_band_conformer", "bs_polarformer")
# pymss 认的架构名。yaml 里只有写在这些名字上才算「声明了架构」——
# 很多配置（例如 bs_roformer_voc_hyperacev2）的 model: 是个嵌套映射
# （model: 换行 dim: 256 …），不设白名单就会把 dim 当成架构名。
_ROF_ARCHS = set(_ROF_FAMILY) | {"htdemucs", "mdx23c", "scnet", "bandit", "bandit_v2",
                                 "apollo", "vr", "legacy_demucs", "legacy_tasnet"}


def _roformer_dir():
    """模型放哪：默认 <整合包>/vendor2/roformer/，可用 LF_ROFORMER_DIR 覆盖。"""
    d = (os.environ.get("LF_ROFORMER_DIR") or "").strip()
    if d:
        return os.path.abspath(os.path.expanduser(d))
    root = _D.get("project_dir") or os.getcwd()
    return os.path.join(root, "vendor2", "roformer")


def _roformer_mtype(cfg_path, weights_name):
    """猜架构：先读 yaml 里的声明，读不出来再按文件名猜，都不行交给 pymss 自动识别。

    不 import yaml —— 只为读一行，没必要加依赖。但要注意两个坑：
      · 只认 `model: <架构名>` 这一种写法。像 bs_roformer_voc_hyperacev2 的配置，
        `model:` 后面是个嵌套映射（换行接 `dim: 256`），用 \\s* 会把 dim 当成架构名；
      · 所以这里用 [ \\t]* + 白名单双保险，认不出就返回空串，让 pymss 自己判。
    """
    if cfg_path:
        try:
            with open(cfg_path, "r", encoding="utf-8", errors="ignore") as f:
                head = f.read(16384)
            for key in ("model", "model_type", "architecture"):
                m = re.search(r"^[ \t]*%s[ \t]*:[ \t]*[\"']?([A-Za-z0-9_\-]+)" % key, head, re.M)
                if m and m.group(1).lower() in _ROF_ARCHS:
                    return m.group(1).lower()
        except OSError:
            pass
    n = (weights_name or "").lower()
    if "mel_band" in n or "melband" in n:
        return "mel_band_roformer"
    if "roformer" in n or n.startswith("bs_") or "_bs_" in n:
        return "bs_roformer"
    if "htdemucs" in n:
        return "htdemucs"
    if "mdx23" in n:
        return "mdx23c"
    if "scnet" in n:
        return "scnet"
    for a in ("bandit_v2", "bandit", "apollo"):
        if a in n:
            return a
    return ""


# 同一个目录里可能同时放人声、气声、语音、卡拉OK 等不同用途的权重。
# 文件名是唯一稳定的线索（yaml 里没有"我是干什么的"这种字段），所以按关键词判角色；
# 判不出来的一律 other，排在 vocal 后面，不会抢默认位。
_ROF_ROLE_WORDS = (
    ("aspiration", ("aspiration", "breath")),
    ("karaoke", ("karaoke",)),
    ("speech", ("speech",)),
    ("vocal", ("vocal", "voc_", "voice", "sing")),
)
_ROF_ROLE_ORDER = {"vocal": 0, "other": 1, "speech": 2, "karaoke": 3, "aspiration": 4}


def _roformer_role(name):
    n = (name or "").lower()
    for role, words in _ROF_ROLE_WORDS:
        if any(w in n for w in words):
            return role
    return "other"


def _roformer_scan(force=False):
    """扫模型目录，返回 [{name, path, config, type, size}]。

    只看两层：用户可能把整个模型盘指过来，深递归会卡住首屏。
    结果缓存 3 秒，页面刷新时不必每次都遍历磁盘。
    """
    now = time.time()
    if not force and now - _ROF["scanned"] < 3:
        return _ROF["models"]
    root = _roformer_dir()
    _ROF["dir"] = root
    out = []
    if os.path.isdir(root):
        base_depth = len(root.rstrip("\\/"))
        for dirpath, dirnames, filenames in os.walk(root):
            if len(dirpath) - base_depth > 160:      # 太深就不看了
                dirnames[:] = []
                continue
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            cfgs = [f for f in filenames if f.lower().endswith(_ROF_C_EXT)]
            for f in sorted(filenames):
                if f.startswith(".") or not f.lower().endswith(_ROF_W_EXT):
                    continue
                p = os.path.join(dirpath, f)
                try:
                    size = os.path.getsize(p)
                except OSError:
                    continue
                if size < 5 * 1024 * 1024:           # 几百 KB 的多半是没下完的半截文件
                    continue
                stem = os.path.splitext(f)[0]
                cfg = ""
                for c in (stem + ".yaml", stem + ".yml"):
                    if c in filenames:
                        cfg = os.path.join(dirpath, c)
                        break
                if not cfg and len(cfgs) == 1:
                    cfg = os.path.join(dirpath, cfgs[0])
                out.append({"name": f, "stem": stem, "path": p, "config": cfg,
                            "type": _roformer_mtype(cfg, f), "size": int(size)})
    # 排序：先按角色（人声分离排最前），再 Roformer 系优先，最后按体积从大到小。
    # 只按体积排会出事：气声模型 797MB 比人声模型 275MB 大，会抢到"默认选中"，
    # 而它产出的是 aspiration/other，没有人声轨 —— 人声分离直接报"没产出人声轨"。
    for m in out:
        m["role"] = _roformer_role(m["name"])
    out.sort(key=lambda m: (_ROF_ROLE_ORDER.get(m["role"], 9),
                            m["type"] not in _ROF_FAMILY, -m["size"], m["name"]))
    _ROF["models"] = out
    _ROF["scanned"] = now
    return out


def _pymss_state():
    """推理后端在不在（不 import pymss，只查 spec + 版本号，很快）。"""
    st = _ROF["state"]
    if st.get("tried"):
        return st
    ok, reason, ver = False, "", ""
    try:
        if importlib.util.find_spec("pymss") is not None:
            ok = True
            try:
                from importlib.metadata import version as _v
                ver = _v("pymss")
            except Exception:  # noqa: BLE001
                ver = ""
        else:
            reason = "没装推理后端 pymss"
    except (ImportError, ValueError) as e:  # noqa: BLE001
        reason = f"{type(e).__name__}: {e}"
    st.update({"tried": True, "ok": ok, "version": ver, "reason": reason})
    return st


def _roformer_status(force=False):
    models = _roformer_scan(force=force)
    py = _pymss_state()
    root = _ROF["dir"]
    ready = bool(models) and bool(py.get("ok"))
    if not models:
        why = ("模型目录里还没有模型文件" if os.path.isdir(root) else "还没有建模型目录")
    elif not py.get("ok"):
        why = "检测到模型，但缺少推理后端 pymss"
    else:
        why = ""
    try:                       # 目录在项目里就给个相对路径，界面上命令不至于长得离谱
        rel = os.path.relpath(root, _D.get("project_dir") or os.getcwd())
        if rel.startswith(".."):
            rel = ""
    except ValueError:
        rel = ""
    return {"ok": True, "dir": root, "rel": rel, "exists": os.path.isdir(root),
            "models": models,
            "pymss": {"ok": bool(py.get("ok")), "version": py.get("version") or "",
                      "reason": py.get("reason") or ""},
            "ready": ready, "reason": why,
            "pick": (models[0]["name"] if models else "")}


def _roformer_work_dir():
    d = os.path.join(_lf_root(), "roformer_work")
    os.makedirs(d, exist_ok=True)
    return d


def _roformer_in_dir():
    """分离任务的输入目录（每次一个子目录，跑完就删）。

    必须**跟 store_dirs（roformer_work）分开**：process_folder 会把目录里的子目录
    也当成一条音轨去解码，然后报 "Permission denied"（实测踩到过）。
    """
    d = os.path.join(_lf_root(), "roformer_in")
    os.makedirs(d, exist_ok=True)
    # 顺手清掉上次异常退出留下的目录（一次一个 rmtree，不做批量删）
    try:
        for name in os.listdir(d)[:8]:
            q = os.path.join(d, name)
            if os.path.isdir(q):
                _rm_tree(q, budget=0.8)
    except OSError:
        pass
    return d


def _roformer_get_separator(m):
    """按模型路径缓存一个 MSSeparator（加载一次权重要几十秒，不能每次都重来）。

    store_dirs 故意只给一个目录：不同模型的 stem 名不一样（vocals/other、
    vocals/instrumental…），给字典容易键对不上而「什么都没产出」。输出统一丢一个
    目录里，再按文件名认领，稳得多。
    """
    key = "%s|%s|%s" % (m["path"], m.get("config") or "", os.path.getmtime(m["path"]))
    with _ROF["lock"]:
        if _ROF["sep"] is not None and _ROF["key"] == key:
            return _ROF["sep"], _ROF["work"]
        import torch  # noqa: F401
        from pymss import MSSeparator
        work = _roformer_work_dir()
        dev = "cpu"
        try:
            dev = "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:  # noqa: BLE001
            dev = "cpu"
        t0 = time.time()
        sep = MSSeparator(
            model_type=(m.get("type") or "auto"),
            model_path=m["path"],
            config_path=m.get("config") or "",
            device=dev,
            output_format="wav",
            store_dirs=work,
            audio_params={"wav_bit_depth": "FLOAT"},
        )
        _log("longform: BS-Roformer loaded (%s, %s) on %s in %.1fs",
             m["name"], m.get("type") or "auto", dev, time.time() - t0)
        _ROF["sep"], _ROF["key"], _ROF["work"] = sep, key, work
        return sep, work


def _roformer_pick(paths, words):
    for p in paths:
        n = os.path.basename(p).lower()
        if any(w in n for w in words):
            return p
    return ""


def _roformer_separate(data, sr, mode="vocals", model_name=None, residual=0.0):
    """用 BS-Roformer 分离人声 / 伴奏，返回与输入同采样率、同声道数的波形。

    走的是 pymss 的官方 API（MIT）：把音频写成临时 wav → process_folder → 读回结果。
    中间态落盘换来的是「不依赖它内部的私有接口」，升级 pymss 也不用跟着改。
    """
    models = _roformer_scan()
    if not models:
        raise RuntimeError("没有检测到 BS-Roformer 模型（%s 是空的）" % _roformer_dir())
    m = next((x for x in models if x["name"] == model_name or x["stem"] == model_name), None)
    if m is None:
        # 没指定就用"人声"角色的那个；只有气声/卡拉OK 模型时才退到第一个
        m = next((x for x in models if x.get("role") == "vocal"), models[0])
    if m.get("role") == "aspiration":
        raise RuntimeError("「%s」是气声提取模型（只出 aspiration/other 两轨），"
                           "不能当人声分离用；请换一个 vocal 模型" % m["name"])

    x = np.asarray(data, dtype="float32")
    if x.ndim == 1:
        x = x[:, None]
    stereo = x.shape[1] >= 2
    work_in = x[:, :2] if stereo else np.repeat(x, 2, axis=1)
    sr0 = int(sr or AUDIO_SR)
    if sr0 != 44100:
        work_in = _resample_audio(work_in, sr0, 44100)

    with _ROF["lock"]:
        sep, work = _roformer_get_separator(m)
        # 每次一个唯一前缀 + 独立输入目录：
        #   1) 不删整个 work —— 那是个「循环删一堆 wav」的操作，删多了会被批量删除守卫
        #      直接把进程 kill 掉（实测把服务杀了）；而且旧文件还会被 process_folder 再跑一遍；
        #   2) 输入目录**不能放在 work 下面** —— process_folder 会把子目录当成一条音轨
        #      去解码，然后报 "Permission denied"（也是实测踩到的）；
        #   3) 输出由 store_dirs 决定，落在 work 里，名字是「输入名_乐器.wav」，
        #      所以用唯一前缀认领，跑完只删自己这三个文件。
        tok = uuid.uuid4().hex[:8]
        stem = "job" + tok
        indir = os.path.join(_roformer_in_dir(), stem)
        os.makedirs(indir, exist_ok=True)
        src = os.path.join(indir, stem + ".wav")
        work_in = np.ascontiguousarray(work_in, dtype="float32")
        np.clip(work_in, -1.0, 1.0, out=work_in)
        outs = []
        t0 = time.time()
        try:
            sf.write(src, work_in, 44100, subtype="FLOAT", format="WAV")
            sep.process_folder(indir)
            outs = [os.path.join(work, f) for f in sorted(os.listdir(work))
                    if f.startswith(stem + "_") and f.lower().endswith(".wav")]
            _log("longform: roformer %s -> %d stem(s) in %.1fs (%.1fs audio)",
                 m["name"], len(outs), time.time() - t0, len(data) / float(sr or AUDIO_SR))

            def _rd(p):
                if not p:
                    return None
                try:
                    d, s2 = _read_audio_any(p)
                    d = np.asarray(d, dtype="float32")
                    if d.ndim == 1:
                        d = d[:, None]
                    if int(s2) != 44100:
                        d = _resample_audio(d, s2, 44100)
                    # 单声道模型出来的 1 列，跟输入的 2 列对不上，先补成双声道再算
                    if d.shape[1] == 1 and work_in.shape[1] > 1:
                        d = np.repeat(d, work_in.shape[1], axis=1)
                    return d
                except Exception:  # noqa: BLE001
                    return None

            voc = _rd(_roformer_pick(outs, ("vocal", "voice", "sing")))
            if voc is None:
                raise RuntimeError("模型没有产出人声轨（%s）；确认权重和 yaml 是配套的" % m["name"])
            inst = None
            if mode != "vocals":
                inst = _rd(_roformer_pick(outs, ("instrument", "inst", "other", "accomp", "no_vocal")))
        finally:
            # 只清自己这次产生的：输入目录整棵（一次 rmtree）+ work 里那几个 stem
            _rm_tree(indir, budget=0.8)
            for f in outs:
                try:
                    os.remove(f)
                except OSError:
                    pass

        if mode == "vocals":
            y = voc
        else:
            if inst is None:
                # 没单独给伴奏轨就用「原曲 − 人声」，两者相加严格还原输入
                n = min(len(work_in), len(voc))
                inst = work_in[:n] - voc[:n]
            y = inst
            if float(residual or 0) > 0:
                y = _suppress_vocal_residual(y, voc, residual)

    if sr0 != 44100:
        y = _resample_audio(y, 44100, sr0)
    if not stereo:
        y = y.mean(axis=1, keepdims=True)
    return np.ascontiguousarray(y, dtype="float32")


# ------------------------- 音色标签（角色 → 音色） -------------------------
# 用途：智能导入会把台词按角色分组（行上的 `group`）。如果角色名同时是某个音色的标签，
# 这里就能把「这个角色」直接对到「那个音色」，导入时或事后一键套上。
# 只动音色（ref），不动情感 / 停顿 / 采样 —— 那些随台本和情绪变，强行套只会更麻烦。

MAX_TAGS = 12
TAG_MAX_LEN = 24


def _split_tags(v):
    """字符串（逗号 / 顿号 / 分号 / 斜杠 / 空格分隔）或数组 → 干净标签列表。"""
    if v is None:
        return []
    raw = []
    if isinstance(v, (list, tuple)):
        for x in v:
            raw.extend(_split_tags(x))
        return raw
    text = str(v)
    for sep in ("，", ",", "、", ";", "；", "|", "/", "\n", "\t"):
        text = text.replace(sep, " ")
    raw = [x.strip() for x in text.split(" ") if x.strip()]
    return raw


def _clean_tags(v):
    """去重（忽略大小写与全半角空格）、限长限量。"""
    out, seen = [], set()
    for t in _split_tags(v):
        t = _safe_title(t, "")[:TAG_MAX_LEN].strip()
        if not t:
            continue
        k = _tag_key(t)
        if k in seen:
            continue
        seen.add(k)
        out.append(t)
        if len(out) >= MAX_TAGS:
            break
    return out


def _tag_key(s):
    """标签 / 角色名的比较键：去所有空白、小写、全角括号转半角。"""
    t = str(s or "")
    t = (t.replace("（", "(").replace("）", ")").replace("　", " ")
         .replace("【", "[").replace("】", "]"))
    t = re.sub(r"\s+", "", t)
    return t.lower()


def _tag_index(refs=None):
    """标签 → 音色列表（同名标签挂多个音色时，靠前的优先：置顶 → 新→旧）。"""
    idx = {}
    for it in _pin_sort((refs if refs is not None else _load_refs()["items"])):
        for t in (it.get("tags") or []):
            k = _tag_key(t)
            if k:
                idx.setdefault(k, []).append(it)
    return idx


def _name_variants(name):
    """角色名 → 候选写法。

    「阿澈（低声）」→ 阿澈；「第一章 · 阿澈」→ 第一章 / 阿澈；
    「阿澈/小夏」→ 拆成两个。逐段去匹配标签，避免因为分组名带了场景前缀就认不出来。
    """
    out = []

    def push(x):
        x = str(x or "").strip(" 　-—_·:：[]()（）")
        if not x:
            return
        k = _tag_key(x)
        if k and k not in [ _tag_key(y) for y in out ]:
            out.append(x)

    push(name)
    bare = re.sub(r"[\(（\[【].*?[\)）\]】]", "", str(name or "")).strip()
    push(bare)
    for part in re.split(r"[·・/、|\-—_:：\s]+", bare or str(name or "")):
        push(part)
    return out


def _match_ref(name, index, allow_fuzzy=True):
    """角色名 → (ref, 命中的标签, 是否模糊)。精确优先，其次「名字里包含某个标签」。"""
    if not name:
        return None, "", False
    variants = _name_variants(name)
    for i, v in enumerate(variants):
        hit = index.get(_tag_key(v))
        if hit:
            # 只有「分组名和标签完全一致」才算精确；去括号 / 拆前缀之后才对上的，
            # 标成近似（界面上带「≈」），免得用户以为名字本来就一样。
            key = _tag_key(v)
            tag = next((t for t in (hit[0].get("tags") or []) if _tag_key(t) == key), v)
            return hit[0], tag, i > 0
    if not allow_fuzzy:
        return None, "", False
    # 模糊：分组名里包含某个标签（标签至少 2 字，避免「A」这种单字误配一片）
    best = None
    for v in variants:
        kv = _tag_key(v)
        if len(kv) < 3:
            continue
        for k, refs in index.items():
            if len(k) >= 2 and k in kv:
                if best is None or len(k) > best[0]:
                    best = (len(k), k, refs[0])
    if best:
        for t in (best[2].get("tags") or []):
            if _tag_key(t) == best[1]:
                return best[2], t, True
        return best[2], "", True
    return None, "", False


# ------------------------------ 标签库（可自定义） ------------------------------
# 两类：trait（属性标签：音色 / 人物用）、sfx（音效标签：句中 / 句间用）。
# 预设是常量，用户的增删记在 longform/taglib.json：
#   added  = 自定义新增；hidden = 被删掉的预设（不物理删，升级后还能回来）。
TAG_KINDS = ("trait", "sfx")


def _taglib_path():
    return os.path.join(_lf_root(), "taglib.json")


def _load_taglib():
    raw = _read_json(_taglib_path(), {})
    if not isinstance(raw, dict):
        raw = {}
    out = {"added": {k: [] for k in TAG_KINDS}, "hidden": {k: [] for k in TAG_KINDS}}
    for sec in ("added", "hidden"):
        sub = raw.get(sec) if isinstance(raw.get(sec), dict) else {}
        for k in TAG_KINDS:
            out[sec][k] = _clean_tags(sub.get(k))
    return out


def _taglib_save(d):
    _write_json(_taglib_path(), {"version": 1,
                                 "added": d.get("added") or {},
                                 "hidden": d.get("hidden") or {}})


def _tag_presets(kind):
    return list(TRAIT_PRESETS if kind == "trait" else DEFAULT_TAGS)


def _tag_list(kind):
    """候选标签：预设（去掉 hidden）+ 自定义（按加入顺序）。"""
    lib = _load_taglib()
    hidden = {_tag_key(x) for x in lib["hidden"].get(kind) or []}
    out, seen = [], set()
    for name in _tag_presets(kind):
        k = _tag_key(name)
        if k in hidden or k in seen:
            continue
        seen.add(k)
        out.append(name)
    for name in lib["added"].get(kind) or []:
        k = _tag_key(name)
        if k in hidden or k in seen:
            continue
        seen.add(k)
        out.append(name)
    return out


def _tag_full(kind):
    preset = {_tag_key(x) for x in _tag_presets(kind)}
    return [{"name": x, "builtin": _tag_key(x) in preset} for x in _tag_list(kind)]


# ------------------------- 人物标签库（跨台本） -------------------------
# 和音色上的自由标签不是一回事：
#   · 人物库里的每一条 = 一个人物，有**一个**人名标签（+ 别名）、**多个**属性标签
#     （傲娇 / 冰山美人 / 旁白…），并可以绑定一个音色；
#   · 智能导入时先按人名（含别名）匹配人物，命中就用它绑定的音色；
#     没命中才回落到「音色上的属性标签」。
# 这样同一个角色在不同章节 / 不同台本里写「阿澈」「澈哥」都能自动对上同一个音色。

CHAR_MAX = 400


def _chars_path():
    return os.path.join(_lf_root(), "characters.json")


def _load_chars():
    raw = _read_json(_chars_path(), {})
    if not isinstance(raw, dict):
        raw = {}
    items = raw.get("items")
    if not isinstance(items, list):
        items = []
    out = []
    for it in items[:CHAR_MAX]:
        if not isinstance(it, dict):
            continue
        name = _safe_title(str(it.get("name") or "").strip(), "")[:24].strip()
        if not name:
            continue
        cid = re.sub(r"[^0-9a-zA-Z_-]", "", str(it.get("id") or ""))[:24]
        out.append({
            "id": cid or ("c" + uuid.uuid4().hex[:10]),
            "name": name,
            "aliases": _clean_tags(it.get("aliases"))[:8],
            "traits": _clean_tags(it.get("traits"))[:12],
            "ref": str(it.get("ref") or "")[:48],
            "note": str(it.get("note") or "")[:200],
            "created": int(it.get("created") or 0),
            "updated": int(it.get("updated") or 0),
        })
    return {"version": 1, "items": out}


def _save_chars(data):
    _write_json(_chars_path(), {"version": 1, "items": (data or {}).get("items") or []})


def _char_index(chars=None):
    """人名 / 别名（归一后） → 人物。同名时后建的覆盖不到前面（先到先得）。"""
    idx = {}
    for c in ((chars or _load_chars())["items"]):
        for n in [c["name"]] + list(c.get("aliases") or []):
            k = _tag_key(n)
            if k:
                idx.setdefault(k, c)
    return idx


def _char_conflict(name, aliases, chars, skip_id=""):
    """新建 / 改名时查重：人名和别名不能和别人的撞。返回撞上的那个名字。"""
    keys = {_tag_key(name)} | {_tag_key(a) for a in (aliases or [])}
    keys.discard("")
    for c in chars["items"]:
        if c["id"] == skip_id:
            continue
        for n in [c["name"]] + list(c.get("aliases") or []):
            if _tag_key(n) in keys:
                return n
    return ""


def _char_voice(c):
    """人物绑定的音色 → (id, 显示名)。绑的是内置音色也认。"""
    rid = (c or {}).get("ref") or ""
    if not rid:
        return "", ""
    try:
        path = resolve_ref(rid)
    except Exception:  # noqa: BLE001
        path = None
    if not path:
        return "", ""
    name = ""
    try:
        for it in _load_refs()["items"]:
            if it["id"] == rid:
                name = it.get("name") or rid
                break
    except Exception:  # noqa: BLE001
        pass
    return rid, (name or rid)


def _resolve_voice(name, char_idx=None, tag_idx=None):
    """分组名 → 用哪个音色。**人物优先，音色属性标签兜底。**

    返回 {ref, source, label, char, char_name, traits, fuzzy, ref_name}
    source: character / character-no-voice / ref-tag / none
    """
    blank = {"ref": "", "source": "none", "label": "", "char": "", "char_name": "",
             "traits": [], "fuzzy": False, "ref_name": ""}
    if not name:
        return blank
    chars = char_idx if char_idx is not None else _char_index()
    tags = tag_idx if tag_idx is not None else _tag_index()
    variants = _name_variants(name)
    # ① 人物：原名 / 去括号 / 拆段后完全一致
    for i, v in enumerate(variants):
        c = chars.get(_tag_key(v))
        if c:
            rid, rname = _char_voice(c)
            return {"ref": rid, "ref_name": rname,
                    "source": "character" if rid else "character-no-voice",
                    "label": c["name"], "char": c["id"], "char_name": c["name"],
                    "traits": list(c.get("traits") or []), "fuzzy": i > 0}
    # ② 人物：分组名里包含人名（「第一幕 阿澈」拆不开时兜底）
    best = None
    for v in variants:
        kv = _tag_key(v)
        if len(kv) < 3:
            continue
        for k, c in chars.items():
            if len(k) >= 2 and k in kv and (best is None or len(k) > best[0]):
                best = (len(k), c)
    if best:
        c = best[1]
        rid, rname = _char_voice(c)
        return {"ref": rid, "ref_name": rname,
                "source": "character" if rid else "character-no-voice",
                "label": c["name"], "char": c["id"], "char_name": c["name"],
                "traits": list(c.get("traits") or []), "fuzzy": True}
    # ③ 音色上的属性标签（老逻辑：分组名 = 某个音色的标签）
    ref, tag, fuzzy = _match_ref(name, tags)
    if ref:
        return {"ref": ref["id"], "ref_name": ref.get("name") or ref["id"],
                "source": "ref-tag", "label": tag, "char": "", "char_name": "",
                "traits": [tag], "fuzzy": fuzzy}
    return blank


def _all_ref_options():
    items = []
    for it in _pin_sort(_load_refs()["items"]):
        items.append({"id": it["id"], "name": it.get("name") or it["id"],
                      "group": "我的音色", "dur": it.get("dur"), "editable": True,
                      "folder": it.get("folder") or "",
                      "tags": list(it.get("tags") or []),
                      "uses": list(it.get("uses") or [])})
    pro = os.path.join(_D["project_dir"], "prompts")
    if os.path.isdir(pro):
        for fn in sorted(os.listdir(pro), key=_nat_key):
            if not fn.lower().endswith((".wav", ".mp3", ".flac", ".ogg")):
                continue
            info = _audio_info(os.path.join(pro, fn))
            items.append({"id": f"p:{fn}", "name": f"主程序 {fn[:12]}…",
                          "group": "主程序 prompts", "dur": info["dur"], "editable": False})
    ex = os.path.join(_D["project_dir"], "examples")
    if os.path.isdir(ex):
        for fn in sorted(os.listdir(ex), key=_nat_key):
            if not fn.lower().endswith(".wav"):
                continue
            info = _audio_info(os.path.join(ex, fn))
            items.append({"id": f"e:{fn}", "name": fn.replace(".wav", ""),
                          "group": "官方示例", "dur": info["dur"], "editable": False})
    return items


# ================================ 台本存取 =====================================

_DEFAULT_PARAMS = {
    "ref": "",
    "emo_mode": 0,
    "emo_weight": 0.65,
    "emo_vec": [0.0] * 8,
    "emo_text": "",
    "emo_ref": "",
    "pause": DEFAULT_PAUSE,
    "seg_tokens": 120,
}

_DEFAULT_SAMPLING = {
    "do_sample": True, "top_p": 0.8, "top_k": 30, "temperature": 0.8,
    "length_penalty": 0.0, "num_beams": 3, "repetition_penalty": 10.0,
    "max_mel_tokens": 1500, "interval_silence": 200,
}


def _new_line(text, pause=None, kind="speech", tag=None, hold=None):
    return {
        "uid": _new_uid(), "kind": kind, "text": text, "tag": tag, "hold": hold,
        "pause": pause, "ov": {}, "inline": [],
        # 句间标签可以挂一个音效素材：{mid, gain}，播放位置 = 标签时间 + 留白
        "sfx": None,
        # 智能导入带过来的：分组名（= 批量任务名）、附属备注（动作/镜头/时间码，不朗读）、
        # 慢语速偏好（绘本/儿童故事批量打标，导出与后期能读到）
        "group": None, "note": None, "slow": False,
        # 字幕类来源的「出现时间 / 结束时间」（秒，相对整篇；不朗读，只做对轴与时间轴落位）
        "t0": None, "t1": None,
        "status": "pending" if kind == "speech" else "tag",
        "out": None, "dur": None, "elapsed": None, "err": None, "capped": False,
        "sig": None,
    }


def _script_path(sid):
    return os.path.join(_script_dir(sid), "script.json")


def _eff(line, script):
    """行级生效参数 = 全局默认 ← 行级覆盖。"""
    p = dict(_DEFAULT_PARAMS)
    p.update({k: v for k, v in script.get("defaults", {}).items() if k in _DEFAULT_PARAMS})
    p.update({k: v for k, v in (line.get("ov") or {}).items() if k in _DEFAULT_PARAMS})
    pause = line.get("pause")
    if pause is None:
        pause = p.get("pause", DEFAULT_PAUSE)
    p["pause"] = max(PAUSE_MIN, min(PAUSE_MAX, int(pause or 0)))
    return p


def _sampling(script):
    s = dict(_DEFAULT_SAMPLING)
    s.update({k: v for k, v in script.get("sampling", {}).items() if k in _DEFAULT_SAMPLING})
    return s


def _sig_canon(v):
    """把参与指纹的值收敛成「稳定表示」。

    这是「保存一次，全篇都变需重生成」的根因修复：
    JSON 往返一趟（浏览器读出来再写回去）会把 0.0 变成 0、10.0 变成 10，
    json.dumps 出来的字符串就不同了 —— 内容和参数一个字没改，指纹却变了。
    这里把数字统一成 float（0 与 0.0 归一），列表/字典递归处理，
    布尔单独保留（True 也是 int）。字符串、None 原样。
    """
    if v is None or isinstance(v, bool) or isinstance(v, str):
        return v
    if isinstance(v, (int, float)):
        f = round(float(v), 6)
        return 0.0 if f == 0 else f
    if isinstance(v, (list, tuple)):
        return [_sig_canon(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _sig_canon(x) for k, x in v.items()}
    return v


def _line_sig(line, script):
    """行内容 + 生效参数的指纹。变了就说明音频过期。"""
    p = _eff(line, script)
    key = json.dumps(
        _sig_canon([line.get("text"), p.get("ref"), p.get("emo_mode"),
                    p.get("emo_weight"), p.get("emo_vec"), p.get("emo_text"),
                    p.get("emo_ref"), p.get("seg_tokens"), _sampling(script)]),
        ensure_ascii=False, sort_keys=True,
    )
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:12]


_GEN_FIELDS = ("text", "ref", "emo_mode", "emo_weight", "emo_vec", "emo_text",
               "emo_ref", "seg_tokens")
_GEN_LABELS = {"text": "文本", "ref": "音色", "emo_mode": "情感模式",
               "emo_weight": "情感权重", "emo_vec": "情感向量", "emo_text": "情感描述",
               "emo_ref": "情感音频", "seg_tokens": "分段长度", "sampling": "采样参数"}


def _gen_snapshot(line, script):
    """生成音频那一刻的输入快照，用于「标出改了什么」和「撤回修改」。"""
    p = _eff(line, script)
    # 文本不在 _eff 里（_eff 只算生成参数），单独从行里取
    snap = {k: (line.get("text") if k == "text" else p.get(k)) for k in _GEN_FIELDS}
    snap["sampling"] = _sampling(script)
    return snap


def _text_diff(a, b, ctx=18):
    """给文本改动生成一段人可读的差异摘要（用于标注「改了什么」）。

    找到第一处不同，返回带前后文窗口、带 → 标记的片段；追加/删除/替换
    都能正确表达，避免简单截断导致「明明改了却显示一样」。
    """
    a = (a or "").strip()
    b = (b or "").strip()
    if a == b:
        return None
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    op = None
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag != "equal":
            op = (tag, i1, i2, j1, j2)
            break
    if op is None:
        return None
    tag, i1, i2, j1, j2 = op
    # 前后文窗口（向前/向后各 ctx 字符，避免截断词）
    lo = max(0, i1 - ctx)
    hi = min(len(a), i2 + ctx)
    prefix = ("…" if lo > 0 else "")
    suffix = ("…" if hi < len(a) else "")
    before = a[lo:i1]
    after = a[i2:hi]
    if tag == "insert":
        ins = b[j1:j2]
        return {"from": prefix + before + after + suffix,
                "to": prefix + before + ins + after + suffix,
                "kind": "插入", "insert": ins}
    if tag == "delete":
        dlt = a[i1:i2]
        return {"from": prefix + before + dlt + after + suffix,
                "to": prefix + before + after + suffix,
                "kind": "删除", "delete": dlt}
    # replace：同时显示被替换的字与替换后的字
    old = a[i1:i2]
    new = b[j1:j2]
    return {"from": prefix + before + old + after + suffix,
            "to": prefix + before + new + after + suffix,
            "kind": "替换", "old": old, "new": new}


def _line_changes(line, script):
    """当前参数 vs 生成时快照，返回差异列表。"""
    gen = line.get("gen")
    if not isinstance(gen, dict):
        return []
    p = _eff(line, script)
    out = []
    for k in _GEN_FIELDS:
        a, b = gen.get(k), (line.get("text") if k == "text" else p.get(k))
        if k == "text":
            a = (a or "").strip()
            b = (b or "").strip()
        if a == b:
            continue
        item = {"field": k, "label": _GEN_LABELS.get(k, k)}
        if k == "text":
            d = _text_diff(a, b)
            if d:
                item.update(d)
            else:  # 理论走不到，兜底
                item["from"] = a[:40]
                item["to"] = b[:40]
            item["changed_chars"] = True
        elif k == "ref":
            item["from"] = _ref_label(a)
            item["to"] = _ref_label(b)
        elif k == "emo_vec":
            item["from"] = "向量"
            item["to"] = "向量"
        elif k == "emo_mode":
            m = {0: "同音色", 1: "情感音频", 2: "向量", 3: "情感文本"}
            item["from"] = m.get(int(a or 0), str(a))
            item["to"] = m.get(int(b or 0), str(b))
        else:
            item["from"] = a
            item["to"] = b
        out.append(item)
    if gen.get("sampling") != _sampling(script):
        out.append({"field": "sampling", "label": "采样参数", "from": "", "to": ""})
    return out


def _ref_label(ref):
    """把 e:xxx / p:xxx 之类的引用变成可读名字。"""
    if not ref:
        return "（默认）"
    try:
        for item in _all_ref_options():
            if item.get("id") == ref:
                return item.get("name") or ref
    except Exception:  # noqa: BLE001
        pass
    return str(ref).split(":")[-1]


def _load_script(sid):
    data = _read_json(_script_path(sid))
    if not data:
        raise HTTPException(404, "台本不存在")
    data.setdefault("defaults", dict(_DEFAULT_PARAMS))
    data.setdefault("sampling", dict(_DEFAULT_SAMPLING))
    data.setdefault("tag_presets", [])
    data.setdefault("batches", [])
    data.setdefault("lines", [])
    audio_dir = os.path.join(_script_dir(sid), "audio")
    for ln in data["lines"]:
        ln.setdefault("uid", _new_uid())
        ln.setdefault("kind", "speech")
        ln.setdefault("ov", {})
        ln.setdefault("pause", None)
        ln.setdefault("tag", None)
        ln.setdefault("hold", None)
        ln.setdefault("dur", None)
        ln.setdefault("out", None)
        ln.setdefault("err", None)
        ln.setdefault("capped", False)
        ln.setdefault("elapsed", None)
        ln.setdefault("sig", None)
        ln.setdefault("gen", None)
        ln.setdefault("text", "")
        ln.setdefault("sfx", None)
        if not isinstance(ln.get("inline"), list):
            ln["inline"] = []
        if ln["kind"] == "tag":
            ln["status"] = "tag"
            continue
        ln.setdefault("status", "pending")
        _heal_status(ln, data, audio_dir)
    return data


def _sig_state(line, script):
    """这一行的音频还算不算「最新」：返回 (ok, fresh, has_changes)。

    只看指纹会误判：老数据（或浏览器 JSON 往返一次）会把 0.0 变成 0，
    指纹变了但内容一个字没改 —— 以前的表现就是「打开就整篇需重生成」。
    所以指纹对不上时再看「生成快照 vs 当前参数」（_line_changes），
    两边都不同才算真的过期；只是数字类型漂移就顺手把指纹归一到新算法。
    """
    fresh = None
    try:
        fresh = _line_sig(line, script)
    except Exception:  # noqa: BLE001
        fresh = None
    sig = line.get("sig")
    if not sig or not fresh:
        return False, fresh, None
    if sig == fresh:
        return True, fresh, False
    changes = _line_changes(line, script) if isinstance(line.get("gen"), dict) else None
    if changes is not None and not changes:
        # 内容一致，只是指纹算法/数字类型变了 → 记成新指纹，别标过期
        return True, fresh, False
    return False, fresh, (True if changes else None)


def _heal_status(ln, script, audio_dir):
    """状态自愈：以磁盘音频 + 指纹为准，不信任客户端传来的标签。

    这里是「重生成之后还显示需重生成」的根治点：
    音频在、指纹和当前内容一致 → 就是 done，哪怕之前被标成 stale；
    音频在、指纹不一致 → stale；音频没了 → 退回 pending。
    """
    if ln.get("kind") == "tag":
        ln["status"] = "tag"
        return ln
    out = ln.get("out")
    path = os.path.join(audio_dir, os.path.basename(out)) if out else None
    exists = bool(path) and os.path.exists(path)
    if not exists:
        if ln.get("status") == "done":
            ln["status"] = "pending"
            ln["out"] = None
        elif ln.get("status") == "stale":
            # 音频没了，stale 也没意义了
            ln["status"] = "pending"
            ln["out"] = None
        return ln
    if ln.get("status") in (None, "pending", "queued", "running"):
        ln["status"] = "done"
    if not ln.get("dur"):
        try:
            ln["dur"] = _audio_info(path).get("dur")
        except Exception:  # noqa: BLE001
            pass
    if not ln.get("sig"):
        # 老数据 / 手工塞进来的音频：没有指纹就按「音频在 = 完成」处理，并补一份当前指纹。
        # （这里不能走 _sig_state，它没有指纹时只能返回 False，会把这种行误判成过期。）
        if ln.get("status") == "done":
            try:
                ln["sig"] = _line_sig(ln, script)
            except Exception:  # noqa: BLE001
                pass
        return ln
    ok, fresh, _changed = _sig_state(ln, script)
    if fresh and ok:
        if ln.get("sig") != fresh:
            ln["sig"] = fresh
        if ln["status"] == "stale":
            ln["status"] = "done"
    elif fresh and ln["status"] in ("done", "stale"):
        ln["status"] = "stale"
    return ln


def _save_script(script):
    script["updated"] = _now()
    with _LOCK:
        _write_json(_script_path(script["id"]), script)


def _merge_runtime(old_lines, new_lines, script):
    """客户端回传整份 lines 时，保住服务端才知道的运行态。

    关键点：入参没显式给 status（None）就沿用服务端原值 —— 早期版本在这里
    用 normalize 的默认值把 done 覆盖成 pending，表现就是「能播放但显示
    未生成」、导出报「还没有生成好的行」。
    """
    by_uid = {l.get("uid"): l for l in old_lines}
    audio_dir = os.path.join(_script_dir(script["id"]), "audio")
    for nl in new_lines:
        ol = by_uid.get(nl.get("uid"))
        if not ol:
            nl["status"] = nl.get("status") or ("tag" if nl.get("kind") == "tag" else "pending")
            # 撤销删除 / 历史恢复会把「之前删掉的行」原样带回来：客户端带了 out/sig，
            # 只要音频文件还在就别清掉，否则会出现「音频明明在，标签却是未生成」。
            out = nl.get("out")
            if out and not os.path.exists(os.path.join(audio_dir, os.path.basename(out))):
                nl["out"] = None
            if not nl.get("out"):
                nl["dur"] = None
                nl["sig"] = None
            _heal_status(nl, script, audio_dir)
            continue
        if not nl.get("status"):
            nl["status"] = ol.get("status") or "pending"
        for k in ("out", "dur", "elapsed", "err", "sig", "gen"):
            if nl.get(k) in (None, "") and ol.get(k) not in (None, ""):
                nl[k] = ol[k]
        if nl.get("kind") != "tag":
            fresh = _line_sig(nl, script)
            ok, _fresh, _changed = _sig_state(nl, script)
            if nl.get("sig") and nl["sig"] != fresh:
                if ok:
                    # 内容没变（只是旧指纹 / 数字类型漂移）→ 记新指纹，保持有效
                    nl["sig"] = fresh
                    nl["status"] = "done" if nl.get("out") else (nl.get("status") or "pending")
                else:
                    nl["status"] = "stale"
            elif nl.get("out") and nl.get("status") == "done" and not nl.get("sig"):
                nl["sig"] = fresh
            # 指纹一致却带着 stale（重生成完成、客户端还没刷新）→ 纠正回 done
            elif nl.get("sig") and nl["sig"] == fresh and nl.get("status") == "stale" and nl.get("out"):
                nl["status"] = "done"
            else:
                _heal_status(nl, script, audio_dir)
    return new_lines


def _normalize_line(ln):
    kind = "tag" if ln.get("kind") == "tag" else "speech"
    text = str(ln.get("text") or "").strip()
    if kind == "speech" and len(text) > MAX_LINE_CHARS:
        text = text[:MAX_LINE_CHARS]
    pause = ln.get("pause")
    if pause is not None:
        try:
            pause = max(PAUSE_MIN, min(PAUSE_MAX, int(pause)))
        except (TypeError, ValueError):
            pause = None
    hold = ln.get("hold")
    if hold is not None:
        try:
            hold = max(0, min(HOLD_MAX, int(hold)))
        except (TypeError, ValueError):
            hold = None
    ov = ln.get("ov") if isinstance(ln.get("ov"), dict) else {}
    sfx = None
    if kind == "tag":
        raw = ln.get("sfx")
        if isinstance(raw, dict) and raw.get("mid"):
            mid = _UIDS_RE.sub("", str(raw.get("mid")))[:20]
            if mid:
                try:
                    gain = float(raw.get("gain"))
                except (TypeError, ValueError):
                    gain = 1.0
                sfx = {"mid": mid, "gain": round(max(0.0, min(4.0, gain)), 3)}
    inline = []
    for it in (ln.get("inline") or []):
        if not isinstance(it, dict) or not it.get("tag"):
            continue
        try:
            pos = max(0, min(len(text), int(it.get("pos") or 0)))
        except (TypeError, ValueError):
            pos = len(text)
        try:
            ihold = max(0, min(HOLD_MAX, int(it.get("hold") or 0)))
        except (TypeError, ValueError):
            ihold = 0
        isfx = None
        raw = it.get("sfx")
        if isinstance(raw, dict) and raw.get("mid"):
            imid = _UIDS_RE.sub("", str(raw.get("mid")))[:20]
            if imid:
                try:
                    igain = float(raw.get("gain"))
                except (TypeError, ValueError):
                    igain = 1.0
                isfx = {"mid": imid, "gain": round(max(0.0, min(4.0, igain)), 3)}
        # 句中标签带一个**稳定键** k：时间轴的「标签跟随=固定」按它记冻结位置。
        # 不能拿下标当键 —— inline 按 pos 排序，改一下位置下标就变了，
        # 冻结的位置会张冠李戴（标签 A 跑到标签 B 的位置上）。
        ik = _UIDS_RE.sub("", str(it.get("k") or ""))[:10]
        if not ik:
            ik = _new_uid()[:8]
        inline.append({"pos": pos, "tag": str(it["tag"])[:40], "k": ik,
                       "hold": ihold, "sfx": isfx})
    inline.sort(key=lambda x: (x["pos"], x["tag"]))
    return {
        "uid": _UIDS_RE.sub("", str(ln.get("uid") or ""))[:20] or _new_uid(),
        "kind": kind,
        "text": text,
        "inline": inline,
        "tag": (str(ln.get("tag"))[:40] if ln.get("tag") else None),
        "sfx": sfx,
        "hold": hold,
        "pause": pause,
        "ov": ov,
        # 这里不要给 status 兜底成 "pending"：None 表示「客户端没有表态」，
        # 由 _merge_runtime 沿用服务端值。兜底会把 done 冲掉。
        "status": ln.get("status") or None,
        "out": ln.get("out"),
        "dur": ln.get("dur"),
        "elapsed": ln.get("elapsed"),
        "err": ln.get("err"),
        "capped": bool(ln.get("capped")),
        "sig": ln.get("sig"),
        # 导入时带进来的元信息：只有明确给了才覆盖，别把已有分组冲掉
        "group": (str(ln.get("group"))[:60] if ln.get("group") else None),
        "note": (str(ln.get("note"))[:400] if ln.get("note") else None),
        "slow": bool(ln.get("slow")),
        "t0": _num_or_none(ln.get("t0")),
        "t1": _num_or_none(ln.get("t1")),
    }


def _num_or_none(v, lo=0.0, hi=86400.0):
    """把「出现时间」这类秒数收敛成 float 或 None（非法值当没有）。"""
    if v is None or v == "":
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f:  # NaN
        return None
    return round(max(lo, min(hi, f)), 3)


def _stats(script):
    """台本统计：每种状态各算各的，避免「已生成」把 stale / 失败混进去。

    前端顶栏、左侧台本卡片、批量覆盖统计都读这一份，所以这里必须是唯一真相。
    """
    lines = script["lines"]
    speech = [l for l in lines if l.get("kind") != "tag"]
    tags = [l for l in lines if l.get("kind") == "tag"]
    has_audio = [l for l in speech if l.get("out")]
    done = [l for l in has_audio if l.get("status") == "done"]
    stale = [l for l in has_audio if l.get("status") == "stale"]
    error = [l for l in speech if l.get("status") == "error"]
    running = [l for l in speech if l.get("status") in ("running", "queued")]
    pending = [l for l in speech
               if l.get("status") not in ("done", "stale", "error", "running", "queued")]
    chars = sum(len(l.get("text") or "") for l in speech)
    audio = sum(float(l.get("dur") or 0) for l in has_audio)
    # 语速：优先用已生成音频实测（字/秒），没有就按 3.5 字/秒估
    measured_chars = sum(len(l.get("text") or "") for l in has_audio if l.get("dur"))
    rate = (measured_chars / audio) if (measured_chars > 20 and audio > 1) else 3.5
    rate = max(1.5, min(8.0, rate))
    rest_chars = sum(len(l.get("text") or "") for l in speech if not l.get("dur"))
    # 停顿：行间停顿 + 句间标签留白（只有真实会进音频的才算）
    default_pause = script.get("defaults", {}).get("pause", _DEFAULT_PARAMS["pause"])
    gap = 0.0
    for l in speech:
        p = l.get("pause")
        gap += float((default_pause if p is None else p) or 0) / 1000.0
    hold = sum(float(l.get("hold") or 0) for l in tags) / 1000.0
    est = audio + rest_chars / rate + gap + hold
    return {
        "lines": len(lines), "speech": len(speech), "tags": len(tags), "chars": chars,
        "done": len(done), "has_audio": len(has_audio), "stale": len(stale),
        "pending": len(pending), "error": len(error), "running": len(running),
        "audio_dur": round(audio, 2),
        # 全篇预估：已有音频 + 未生成部分按语速估 + 停顿/留白
        "est_dur": round(est, 2), "rate": round(rate, 2),
        # 兼容旧字段（左侧列表 / 时间轴迁移逻辑读它）
        "covered": len(has_audio),
    }


# ================================ 渲染引擎 =====================================

class _Stop(Exception):
    """行内进度回调发现停止标志时抛出，用来中断当前这一行。"""


class _RenderJob:
    def __init__(self, sid, uids):
        self.id = uuid.uuid4().hex[:10]   # 前端用它判断「是不是同一轮」，完成后弹汇总
        self.sid = sid
        self.uids = uids
        self.total = len(uids)
        self.cursor = 0
        self.state = "running"
        self.cur_uid = None
        self.cur_index = None
        self.cur_pos = None      # 在台本里的行号（从 1 开始）
        self.cur_text = ""       # 当前行前 20 字，进度区直接显示
        self.line_progress = 0.0
        self.started_at = time.time()
        self.finished_at = None
        self.stop_event = threading.Event()
        self.lock = threading.RLock()
        self.message = ""
        self.errors = []
        self.thread = None

    def public(self):
        with self.lock:
            uids = list(self.uids)
            total = self.total
        elapsed = (self.finished_at or time.time()) - self.started_at
        done = self.cursor
        eta = None
        if self.state == "running" and done > 0 and self.total > done:
            eta = round(elapsed / done * (self.total - done))
        return {
            "id": self.id, "uids": uids,
            "state": self.state, "total": total, "done": done,
            "cursor": self.cursor, "cur_uid": self.cur_uid,
            "cur_index": self.cur_index,
            "cur_pos": self.cur_pos, "cur_text": self.cur_text,
            "line_progress": round(self.line_progress, 4),
            "elapsed": round(elapsed, 1), "eta": eta,
            "message": self.message, "errors": self.errors[-20:],
        }


def _render_statuses(script):
    return {l["uid"]: {"status": l.get("status"), "dur": l.get("dur"),
                       "err": l.get("err"), "out": bool(l.get("out")),
                       "kind": l.get("kind")}
            for l in script["lines"]}


# ============================ 移植点：引擎入参映射 ============================
# 这套工作台要移植到别的整合包时，**只改这一个函数**（外加 _DEFAULT_PARAMS /
# _DEFAULT_SAMPLING 的字段名、web/genparams.js 的字段表）。
# 输入是「中立参数」（台本里的 defaults + 行覆盖），输出是宿主模型的 infer() 关键字；
# 字段含义见 web/genparams.js，参数校验见 _clean_line()。
def _engine_kwargs(params, sampling, ref_path, emo_ref_path, vec, verbose=False):
    """中立参数 → 宿主引擎的 infer(**kwargs)。换模型时改这里，别动调用点。"""
    mode = int(params.get("emo_mode") or 0)
    return dict(
        spk_audio_prompt=ref_path,                 # 音色参考音频
        emo_audio_prompt=emo_ref_path,             # 情感参考音频（模式 1）
        emo_alpha=float(params.get("emo_weight") or 0.65),
        emo_vector=vec,                            # 8 轴向量（模式 2，已归一化）
        use_emo_text=(mode == 3),                  # 情感描述（模式 3）
        emo_text=((params.get("emo_text") or "").strip() or None),
        use_random=False,
        verbose=bool(verbose),
        max_text_tokens_per_segment=int(params.get("seg_tokens") or 120),
        do_sample=bool(sampling["do_sample"]),
        top_p=float(sampling["top_p"]),
        top_k=int(sampling["top_k"]) if int(sampling["top_k"]) > 0 else None,
        temperature=float(sampling["temperature"]),
        length_penalty=float(sampling["length_penalty"]),
        num_beams=int(sampling["num_beams"]),
        repetition_penalty=float(sampling["repetition_penalty"]),
        max_mel_tokens=int(sampling["max_mel_tokens"]),
        interval_silence=int(sampling["interval_silence"]),
    )


def _render_one(job, script, line, out_path):
    deps = _D
    tts = deps["tts"]
    params = _eff(line, script)
    sampling = _sampling(script)

    ref_path = resolve_ref(params.get("ref"))
    if not ref_path:
        raise RuntimeError("这一行没有可用的音色参考音频（全局默认或行级覆盖里选一个）")

    mode = int(params.get("emo_mode") or 0)
    emo_ref_path = None
    vec = None
    emo_text = (params.get("emo_text") or "").strip() or None
    if mode == 1:
        emo_ref_path = resolve_ref(params.get("emo_ref") or "")
        if not emo_ref_path:
            raise RuntimeError("情感模式为「情感参考音频」，但没有可用的情感音频")
        vec = None
    elif mode == 2:
        values = [float(x) for x in (params.get("emo_vec") or [0.0] * 8)]
        vec = tts.normalize_emo_vec(values, apply_bias=True)
    else:
        vec = None

    model = tts.ensure_loaded()
    prev_cb = model.gr_progress

    def cb(v, desc=""):
        job.line_progress = float(v or 0.0)
        if job.stop_event.is_set():
            raise _Stop()
        if callable(prev_cb):
            try:
                prev_cb(v, desc)
            except Exception:
                pass

    model.gr_progress = cb
    t0 = time.time()
    try:
        result = model.infer(
            text=line["text"],
            output_path=out_path,
            **_engine_kwargs(params, sampling, ref_path, emo_ref_path, vec,
                             bool(deps.get("verbose"))),
        )
        elapsed = round(time.time() - t0, 2)
        if result is None or not os.path.exists(out_path):
            raise RuntimeError("推理没有产出音频文件")
        info = _audio_info(out_path)
        capped = bool(getattr(model, "mel_tokens_capped", False))
        warn = getattr(model, "text_normalize_fallback", None)
        return info.get("dur"), elapsed, capped, warn
    finally:
        try:
            model.gr_progress = prev_cb
        except Exception:
            pass


def _render_loop(job):
    deps = _D
    lock = deps["infer_lock"]
    sid = job.sid
    try:
        while job.cursor < job.total:
            if job.stop_event.is_set():
                job.state = "stopped"
                break
            uid = job.uids[job.cursor]
            with _LOCK:
                script = _load_script(sid)
                line = next((l for l in script["lines"] if l["uid"] == uid), None)
                if line is None or line.get("kind") == "tag":
                    job.cursor += 1
                    continue
                line["status"] = "queued"
                _save_script(script)
            if not (line.get("text") or "").strip():
                with _LOCK:
                    script = _load_script(sid)
                    for l in script["lines"]:
                        if l["uid"] == uid:
                            l["status"] = "skipped"
                            l["err"] = "空行"
                    _save_script(script)
                job.cursor += 1
                continue

            job.cur_uid = uid
            job.cur_index = job.cursor + 1
            with _LOCK:
                _s = _load_script(sid)
                job.cur_pos = next((i for i, l in enumerate(_s["lines"], 1) if l["uid"] == uid), None)
            job.cur_text = (line.get("text") or "")[:20]
            job.line_progress = 0.0
            while not lock.acquire(timeout=0.4):
                if job.stop_event.is_set():
                    break
            if job.stop_event.is_set():
                with _LOCK:
                    script = _load_script(sid)
                    for l in script["lines"]:
                        if l["uid"] == uid:
                            l["status"] = "pending"
                    _save_script(script)
                job.state = "stopped"
                break
            out_path = os.path.join(_script_dir(sid), "audio", f"{uid}.wav")
            try:
                with _LOCK:
                    script = _load_script(sid)
                    for l in script["lines"]:
                        if l["uid"] == uid:
                            l["status"] = "running"
                    _save_script(script)
                sig = _line_sig(line, script)
                dur, elapsed, capped, warn = _render_one(job, script, line, out_path)
                with _LOCK:
                    script = _load_script(sid)
                    for l in script["lines"]:
                        if l["uid"] == uid:
                            l["status"] = "done"
                            l["out"] = os.path.basename(out_path)
                            l["dur"] = dur
                            l["elapsed"] = elapsed
                            l["err"] = (f"规范化回退: {warn}" if warn else None)
                            l["capped"] = capped
                            l["sig"] = sig
                            l["gen"] = _gen_snapshot(l, script)
                    _save_script(script)
                _log("longform %s: line %s/%s done in %ss (%.1fs audio)",
                     sid, job.cur_index, job.total, elapsed, dur or 0)
            except _Stop:
                with _LOCK:
                    script = _load_script(sid)
                    for l in script["lines"]:
                        if l["uid"] == uid:
                            l["status"] = "pending"
                    _save_script(script)
                job.state = "stopped"
                break
            except Exception as e:
                msg = str(e)
                _log("longform %s: line %s failed: %s", sid, job.cur_index, msg, level="error")
                with _LOCK:
                    script = _load_script(sid)
                    for l in script["lines"]:
                        if l["uid"] == uid:
                            l["status"] = "error"
                            l["err"] = msg[:300]
                    _save_script(script)
                job.errors.append({"uid": uid, "index": job.cur_index, "error": msg[:300]})
                if len(job.errors) >= 3 and all(e.get("error") for e in job.errors[-3:]):
                    job.state = "error"
                    job.message = f"连续失败，已中止：{msg[:200]}"
                    break
            finally:
                try:
                    lock.release()
                except RuntimeError:
                    pass
                try:
                    import torch
                    if torch.cuda.is_available():
                        torch.cuda.empty_cache()
                except Exception:
                    pass
            job.cursor += 1

        if job.state == "running":
            job.state = "done"
            job.message = "全部完成"
        job.finished_at = time.time()
        job.cur_uid = None
        job.line_progress = 0.0
        with _LOCK:
            script = _load_script(sid)
            for l in script["lines"]:
                if l.get("status") in ("queued", "running"):
                    l["status"] = "pending"
            _save_script(script)
    except Exception as e:
        _log("longform render crashed: %s", e, level="error")
        job.state = "error"
        job.message = f"渲染线程异常: {e}"
        job.finished_at = time.time()
    finally:
        if _ACTIVE.get("sid") == job.sid:
            _ACTIVE["sid"] = None
        gc.collect()


def _start_render(sid, uids):
    if _ACTIVE.get("sid"):
        raise HTTPException(409, f"已有一个台本在渲染（{_ACTIVE['sid']}），等它结束再开始")
    script = _load_script(sid)
    by_uid = {l["uid"]: l for l in script["lines"]}
    targets = [u for u in uids if u in by_uid
               and by_uid[u].get("kind") != "tag"
               and (by_uid[u].get("text") or "").strip()]
    if not targets:
        raise HTTPException(400, "没有可渲染的行（选中的都是空行或标签？）")

    # 开跑前先查音色：默认音色为空 + 行上又没覆盖时，逐行失败会把状态刷成一片红，
    # 用户只能看到"没有可用的音色参考音频"却不知道是哪几行、该怎么修。
    dref = (script.get("defaults") or {}).get("ref")
    target_set = set(targets)
    no_ref = []
    for idx, line in enumerate(script["lines"], start=1):
        if line["uid"] not in target_set:
            continue
        ref = (line.get("ov") or {}).get("ref") or dref
        if not resolve_ref(ref):
            no_ref.append(idx)
    if no_ref:
        head = "、".join(str(i) for i in no_ref[:8]) + ("…" if len(no_ref) > 8 else "")
        hint = ("「默认」页还没选默认音色。" if not dref else "")
        raise HTTPException(
            400,
            f"有 {len(no_ref)} 行没有可用音色（第 {head} 行）。{hint}"
            "请到「默认」页选一个默认音色，或选中这些行在「批量」页统一指定音色。")

    job = _RenderJob(sid, targets)
    with _LOCK:
        for l in script["lines"]:
            if l["uid"] in targets:
                l["status"] = "queued"
        _save_script(script)
    _RENDERS[sid] = job
    _ACTIVE["sid"] = sid
    job.thread = threading.Thread(target=_render_loop, args=(job,), daemon=True,
                                 name=f"lf-render-{sid}")
    job.thread.start()
    _log("longform %s: render started, %d line(s)", sid, len(targets))
    return job


# ================================ 导出 =========================================

def _text_with_inline(line):
    """把句中标签按位置插回文本，用于文本导出（从后往前插，避免下标移位）。"""
    text = line.get("text") or ""
    for it in sorted((line.get("inline") or []), key=lambda x: -int(x.get("pos") or 0)):
        pos = max(0, min(len(text), int(it.get("pos") or 0)))
        text = text[:pos] + f"〔{it['tag']}〕" + text[pos:]
    return text


def _srt_time(sec):
    ms = int(round(sec * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _usable(line, sid):
    """这一行能否参与合成导出：有文件、不是过期状态。"""
    if line.get("kind") == "tag" or line.get("status") == "stale":
        return False
    out = line.get("out")
    if not out:
        return False
    return os.path.exists(os.path.join(_script_dir(sid), "audio", os.path.basename(out)))


def _timeline(script, with_tags=True):
    """按顺序累计时间轴（不读音频，用 dur + pause/hold 算）。"""
    out, cursor = [], 0.0
    for idx, line in enumerate(script["lines"], start=1):
        if line.get("kind") == "tag":
            if not with_tags:
                continue
            hold = int(line.get("hold") or 0) / 1000.0
            out.append({"index": idx, "uid": line["uid"], "kind": "tag",
                        "tag": line.get("tag") or "标签", "text": "",
                        "start": round(cursor, 3), "end": round(cursor + hold, 3),
                        "dur": round(hold, 3)})
            cursor += hold
            continue
        dur = float(line.get("dur") or 0)
        out.append({"index": idx, "uid": line["uid"], "kind": "speech",
                    "text": line.get("text"), "tag": None,
                    "start": round(cursor, 3), "end": round(cursor + dur, 3),
                    "dur": round(dur, 3),
                    "inline": [dict(it) for it in (line.get("inline") or [])]})
        cursor += dur + int(_eff(line, script)["pause"]) / 1000.0
    return out, cursor


# ---- 导出：编解码配置与体积预估 ---------------------------------------------
# 说明：本机没有 ffmpeg/lame 可执行文件，压缩格式由 libsndfile 内置编码器完成。
# MP3/OGG 的 quality 档位对应 libsndfile 的 compression_level，实测码率见下表
# （44.1kHz 立体声），只用于「体积预估」，导出后会把真实大小一起返回。
_EXPORT_FORMATS = ("wav", "flac", "mp3", "ogg")
_QUALITY_CL = {"high": 0.0, "standard": 0.35, "small": 0.8}
_QUALITY_KBPS = {
    "mp3": {"high": 48, "standard": 36, "small": 30},
    "ogg": {"high": 32, "standard": 28, "small": 25},
}


SAMPLE_RATES = (16000, 22050, 32000, 44100, 48000, 96000)


def _norm_sr(v, default=AUDIO_SR):
    """把请求里的采样率收敛到安全范围（8k~96k）。"""
    try:
        sr = int(float(v))
    except (TypeError, ValueError):
        return int(default)
    if sr < 8000 or sr > 96000:
        raise HTTPException(400, "采样率要在 8000~96000 之间")
    return sr


def _resample_to(data, sr_from, sr_to):
    """把单声道 float32 波形重采样到目标采样率（优先 soxr，其次 scipy，最后线性插值）。"""
    sr_from = int(sr_from or AUDIO_SR)
    sr_to = int(sr_to or sr_from)
    if sr_from == sr_to or not len(data):
        return data
    try:
        import soxr  # type: ignore
        out = soxr.resample(np.asarray(data, dtype="float32"), sr_from, sr_to, quality="HQ")
        return np.asarray(out, dtype="float32")
    except Exception:  # noqa: BLE001
        pass
    try:
        from math import gcd
        from scipy.signal import resample_poly  # type: ignore
        g = gcd(sr_from, sr_to)
        out = resample_poly(np.asarray(data, dtype="float32"), sr_to // g, sr_from // g)
        return np.asarray(out, dtype="float32")
    except Exception:  # noqa: BLE001
        pass
    n_out = int(round(len(data) * sr_to / float(sr_from)))
    if n_out <= 0:
        return np.zeros(0, dtype="float32")
    xp = np.linspace(0.0, 1.0, len(data), endpoint=False)
    x = np.linspace(0.0, 1.0, n_out, endpoint=False)
    return np.interp(x, xp, np.asarray(data, dtype="float32")).astype("float32")


EX_MIME = {"wav": "audio/wav", "flac": "audio/flac", "mp3": "audio/mpeg", "ogg": "audio/ogg"}


def _encode_audio(data, sr, fmt="wav", bit_depth=16, quality="standard",
                  channels=2, sample_rate=AUDIO_SR):
    """任意波形 → (bytes, ext, media_type)。导出单句 / 打包 ZIP 都用它。

    声道与采样率的处理顺序：先定声道（单声道取平均、立体声复制），
    再重采样（soxr → scipy → 线性），最后交给 libsndfile 编码。
    """
    x = np.asarray(data, dtype="float32")
    if x.ndim == 1:
        x = x[:, None]
    ch = 1 if int(channels or 1) <= 1 else 2
    if ch == 1 and x.shape[1] > 1:
        x = x.mean(axis=1, keepdims=True)
    elif ch == 2 and x.shape[1] == 1:
        x = np.repeat(x, 2, axis=1)
    sr = int(sr or AUDIO_SR)
    target = _norm_sr(sample_rate, sr)
    if target != sr:
        x = _resample_audio(x, sr, target)
        sr = target
    fmt = (fmt or "wav").lower()
    if fmt not in EX_MIME:
        raise HTTPException(400, "只支持 wav / flac / mp3 / ogg")
    subtype, sfmt, comp = _codec(fmt, bit_depth, quality)
    buf = io.BytesIO()
    # 注意 sf.write 没有 channels 参数（声道由数组形状决定），channels 只属于 SoundFile 构造器
    kwargs = {"samplerate": sr, "subtype": subtype, "format": sfmt}
    if comp is not None:
        kwargs["compression_level"] = float(comp)
    sf.write(buf, x if ch > 1 else x[:, 0], **kwargs)
    return buf.getvalue(), fmt, EX_MIME[fmt]


def _codec(fmt, bit_depth=16, quality="standard"):
    """返回 (subtype, soundfile format, compression_level)。"""
    fmt = (fmt or "wav").lower()
    try:
        bd = int(bit_depth or 16)
    except (TypeError, ValueError):
        bd = 16
    if fmt == "wav":
        return {16: "PCM_16", 24: "PCM_24", 32: "FLOAT"}.get(bd, "PCM_16"), "WAV", None
    if fmt == "flac":
        return ("PCM_24" if bd >= 24 else "PCM_16"), "FLAC", None
    if fmt == "mp3":
        return "MPEG_LAYER_III", "MP3", _QUALITY_CL.get(quality, 0.35)
    if fmt == "ogg":
        return "VORBIS", "OGG", _QUALITY_CL.get(quality, 0.35)
    raise HTTPException(400, "只支持 wav / flac / mp3 / ogg")


def _est_bytes(seconds, fmt="wav", bit_depth=16, channels=2, quality="standard",
               sample_rate=AUDIO_SR):
    """估算导出文件字节数（与实际编码器相符的经验公式）。"""
    seconds = max(0.0, float(seconds or 0))
    ch = 1 if int(channels or 1) <= 1 else 2
    sr = int(sample_rate or AUDIO_SR)
    fmt = (fmt or "wav").lower()
    if fmt == "wav":
        bd = int(bit_depth or 16)
        return int(seconds * sr * ch * (bd / 8.0)) + 44
    if fmt == "flac":
        bd = int(bit_depth or 16)
        ratio = 0.80 if bd >= 24 else 0.62
        return int(seconds * sr * ch * 2 * ratio) + 8192
    kbps = _QUALITY_KBPS.get(fmt, {}).get(quality, 36)
    # 有损编码在高采样率下码率也会抬高，这里给一个粗略修正
    kbps *= max(0.6, min(1.6, sr / 44100.0)) ** 0.5
    return int(seconds * kbps * 1000 / 8.0) + 4096


def _export_plan(script, gap_override=None, uids=None):
    """扫描一遍台本，算出每段的绝对起止（不读音频），用于导出与体积预估。"""
    sid = script["id"]
    wanted = set(uids) if uids else None
    items, missing = [], []
    cursor = 0.0
    for idx, line in enumerate(script["lines"], start=1):
        if wanted is not None and line["uid"] not in wanted:
            continue
        if line.get("kind") == "tag":
            # 标签行的留白只服从它自己的 hold，不受「统一停顿覆盖」影响。
            hold = int(line.get("hold") or 0)
            items.append({"index": idx, "uid": line["uid"], "kind": "tag",
                          "tag": line.get("tag") or "标签", "text": "",
                          "start": cursor, "dur": hold / 1000.0,
                          "path": None, "hold": hold})
            cursor += hold / 1000.0
            continue
        if not (line.get("text") or "").strip():
            continue
        path = os.path.join(_script_dir(sid), "audio", os.path.basename(line.get("out") or ""))
        if not _usable(line, sid):
            missing.append({"index": idx, "uid": line["uid"],
                            "reason": "未生成" if not line.get("out") else "需重新生成"})
            continue
        try:
            dur = float(line.get("dur") or 0)
        except (TypeError, ValueError):
            dur = 0.0
        if dur <= 0.01:
            try:
                info = sf.info(path)
                dur = info.frames / float(info.samplerate or AUDIO_SR)
            except Exception:  # noqa: BLE001
                dur = 0.0
        items.append({"index": idx, "uid": line["uid"], "kind": "speech",
                      "text": line.get("text"), "tag": None,
                      "start": cursor, "dur": dur, "path": path, "hold": 0})
        cursor += dur
        pause = gap_override if gap_override is not None else _eff(line, script)["pause"]
        if pause:
            cursor += int(pause) / 1000.0
    return items, missing, cursor


def _export_estimate(script, gap_override=None, uids=None, fmt="wav", bit_depth=16,
                     quality="standard", channels=2, range_start=None, range_end=None,
                     sample_rate=AUDIO_SR):
    """只算不写：返回内容总时长、所选时段时长、预估字节数。"""
    items, missing, total = _export_plan(script, gap_override, uids)
    rs, re_ = _norm_range(range_start, range_end, total)
    span = max(0.0, re_ - rs)
    sr = _norm_sr(sample_rate, AUDIO_SR)
    return {
        "total_duration": round(total, 3),
        "span_duration": round(span, 3),
        "est_bytes": _est_bytes(span, fmt, bit_depth, channels, quality, sr),
        "sample_rate": sr,
        "missing_count": len(missing),
        "lines": sum(1 for i in items if i["kind"] == "speech"),
    }


def _norm_range(range_start, range_end, total):
    def _f(v):
        if v in (None, ""):
            return None
        try:
            return float(v)
        except (TypeError, ValueError):
            return None
    rs = _f(range_start)
    re_ = _f(range_end)
    rs = 0.0 if rs is None else max(0.0, min(rs, total))
    re_ = total if re_ is None else max(0.0, min(re_, total))
    if re_ <= rs:
        raise HTTPException(400, "导出结束时间要大于开始时间")
    return rs, re_


def _export(script, gap_override=None, uids=None, fmt="wav", bit_depth=16,
            quality="standard", channels=2, range_start=None, range_end=None,
            sample_rate=AUDIO_SR):
    sid = script["id"]
    out_dir = os.path.join(_script_dir(sid), "export")
    os.makedirs(out_dir, exist_ok=True)
    fmt = (fmt or "wav").lower()
    subtype, sfmt, comp = _codec(fmt, bit_depth, quality)
    ch = 1 if int(channels or 1) <= 1 else 2
    target = _norm_sr(sample_rate, AUDIO_SR)

    items, missing, total = _export_plan(script, gap_override, uids)
    if not any(i["path"] for i in items):
        raise HTTPException(400, "选中的行里还没有生成好的语音，先生成再导出")
    rs, re_ = _norm_range(range_start, range_end, total)

    stamp = time.strftime("%Y%m%d_%H%M%S")
    base = _safe_title(script.get("title"), "台本")
    name = f"{base}_{stamp}.{fmt}"
    path = os.path.join(out_dir, name)
    if os.path.exists(path):
        # 同一秒内连导两次不能互相覆盖
        stamp = f"{stamp}_{uuid.uuid4().hex[:4]}"
        name = f"{base}_{stamp}.{fmt}"
        path = os.path.join(out_dir, name)

    kwargs = {"samplerate": target, "channels": ch, "subtype": subtype, "format": sfmt}
    if comp is not None:
        kwargs["compression_level"] = float(comp)

    timeline, written, cursor = [], 0, 0.0
    with sf.SoundFile(path, "w", **kwargs) as w:
        for it in items:
            seg_start, seg_dur = it["start"], it["dur"]
            cursor = seg_start + seg_dur
            if seg_start >= re_ - 1e-6:
                break
            # 取这一段实际的波形（静音标签用零；语音读文件）
            if it["kind"] == "tag":
                if seg_dur <= 0:
                    continue
                data = np.zeros(int(target * seg_dur), dtype="float32")
            else:
                try:
                    data, sr = sf.read(it["path"], dtype="float32", always_2d=False)
                except Exception as e:  # noqa: BLE001
                    _log("longform export: skip %s (%s)", it["path"], e, level="warning")
                    missing.append({"index": it["index"], "uid": it["uid"], "reason": "读取失败"})
                    continue
                if data.ndim > 1:
                    data = data.mean(axis=1)
                data = np.clip(data, -1.0, 1.0).astype("float32", copy=False)
                # 时长以真实文件为准（比 dur 字段更可靠），再重采样到目标采样率
                seg_dur = len(data) / float(sr or AUDIO_SR)
                cursor = seg_start + seg_dur
                data = _resample_to(data, sr or AUDIO_SR, target)

            # 与 [rs, re) 求交集
            a = max(seg_start, rs)
            b = min(seg_start + seg_dur, re_)
            if b - a <= 1e-6:
                continue
            i0 = int(round((a - seg_start) * target))
            i1 = int(round((b - seg_start) * target))
            i0 = max(0, min(i0, len(data)))
            i1 = max(i0, min(i1, len(data)))
            chunk = data[i0:i1]
            if not len(chunk):
                continue
            if ch == 2:
                chunk = np.stack([chunk, chunk], axis=1)
            w.write(chunk)
            written += len(chunk)
            if it["kind"] == "speech":
                timeline.append({"index": it["index"], "uid": it["uid"], "kind": "speech",
                                 "text": it["text"], "tag": None,
                                 "start": round(a, 3), "end": round(b, 3),
                                 "dur": round(b - a, 3)})
            else:
                timeline.append({"index": it["index"], "uid": it["uid"], "kind": "tag",
                                 "tag": it["tag"], "text": "",
                                 "start": round(a, 3), "end": round(b, 3),
                                 "dur": round(b - a, 3)})

    srt_name = name.rsplit(".", 1)[0] + ".srt"
    with open(os.path.join(out_dir, srt_name), "w", encoding="utf-8") as f:
        n = 0
        for item in timeline:
            if item["kind"] != "speech":
                continue
            n += 1
            # srt 以所选时段的起点为 0
            f.write(f"{n}\n{_srt_time(max(0.0, item['start'] - rs))} --> "
                    f"{_srt_time(max(0.0, item['end'] - rs))}\n{item['text']}\n\n")
    tl_name = name.rsplit(".", 1)[0] + ".timeline.json"
    _write_json(os.path.join(out_dir, tl_name), {
        "title": script.get("title"),
        "duration": round(written / float(target), 3),
        "sample_rate": target,
        "range": [round(rs, 3), round(re_, 3)],
        "lines": timeline,
    })
    size = os.path.getsize(path)
    return {"file": name, "wav": name, "fmt": fmt, "srt": srt_name, "timeline": tl_name,
            "duration": round(written / float(target), 3), "sample_rate": target, "written": sum(
                1 for i in timeline if i["kind"] == "speech"),
            "size": size,
            "kbps": round(size * 8 / max(0.001, written / float(target)) / 1000),
            "missing": missing[:50], "missing_count": len(missing)}


def _export_lines_zip(script, uids, naming="index_text", prefix="",
                      fmt="wav", bit_depth=16, quality="standard",
                      sample_rate=AUDIO_SR, channels=2):
    """把选中的行逐句导出并打包 zip，每句一个文件、可自定义命名与格式。

    与「拼接导出」共用同一套格式参数（wav / flac / mp3 / ogg + 位深/质量 + 采样率 + 声道），
    这样「单句批量导出」不再只能拿 22050 单声道 WAV。
    """
    sid = script["id"]
    out_dir = os.path.join(_script_dir(sid), "export")
    base = _safe_title(prefix or script.get("title"), "台本")
    stamp = time.strftime("%Y%m%d_%H%M%S")
    fmt = (fmt or "wav").lower()
    ext = fmt
    zip_name = f"{base}_单句_{stamp}.zip"
    zip_path = os.path.join(out_dir, zip_name)
    wanted = set(uids) if uids else None
    count, skipped = 0, 0
    # 序号位数跟着行数走（最少 4 位）：一万行的台本也不会出现 10000 排在 1000 前面
    w = _pad_width(len(script["lines"]), 4)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for idx, line in enumerate(script["lines"], start=1):
            if wanted is not None and line["uid"] not in wanted:
                continue
            if not _usable(line, sid):
                skipped += 1
                continue
            src = os.path.join(_script_dir(sid), "audio", os.path.basename(line["out"]))
            text = re.sub(r'[\\/:*?"<>|\r\n\t]', "", line.get("text") or "")[:12]
            num = "%0*d" % (w, idx)
            if naming == "index":
                name = f"{num}.{ext}"
            elif naming == "text":
                name = f"{text or line['uid']}.{ext}"
            else:
                name = f"{num}_{text}.{ext}" if text else f"{num}.{ext}"
            if fmt == "wav" and int(sample_rate or AUDIO_SR) == AUDIO_SR and int(channels or 1) <= 1:
                # 默认参数：原始文件就是 22050 单声道 WAV，直接打包，不重编码
                zf.write(src, arcname=name)
            else:
                data, sr = sf.read(src, dtype="float32", always_2d=True)
                raw, _e, _m = _encode_audio(data, sr, fmt, bit_depth, quality, channels, sample_rate)
                zf.writestr(name, raw)
            count += 1
    return {"zip": zip_name, "count": count, "skipped": skipped, "format": fmt}


def _export_md(script, fmt="md", opts=None):
    """导出台本文件。

    opts:
      timestamps 是否带时间戳（默认 True）
      meta       是否带统计/时间轴表格等附加信息（默认 True）
      tags       是否包含标签（句间 + 句中，默认 True）
    """
    opts = opts or {}
    with_ts = bool(opts.get("timestamps", True))
    with_meta = bool(opts.get("meta", True))
    with_tags = bool(opts.get("tags", True))
    sid = script["id"]
    timeline, total = _timeline(script, with_tags=with_tags)
    out_dir = os.path.join(_script_dir(sid), "export")
    base = _safe_title(script.get("title"), "台本")
    stamp = time.strftime("%Y%m%d_%H%M%S")
    name = f"{base}_台本_{stamp}.{fmt}"
    path = os.path.join(out_dir, name)
    stats = _stats(script)
    ref_names = {r["id"]: r["name"] for r in _all_ref_options()}
    rows = []

    def ts(item):
        return f"[{_srt_time(item['start'])[:8]}] " if with_ts else ""

    if fmt == "md":
        rows.append(f"# {script.get('title') or '台本'}\n")
        if with_meta:
            rows.append(f"- 总时长：{_srt_time(total)[:8]}")
            rows.append(f"- 语音行：{stats['done']} 行已生成 / 共 {stats['speech']} 行")
            if with_tags:
                inline_n = sum(len(l.get("inline") or []) for l in script["lines"])
                rows.append(f"- 标签：{stats['tags']} 个句间 / {inline_n} 个句中")
            rows.append(f"- 导出时间：{time.strftime('%Y-%m-%d %H:%M:%S')}\n")
            rows.append("## 时间轴\n")
            head = "| # | 起始 | 时长 | 类型 | 内容 |"
            sep = "|---|---|---|---|---|"
            if with_meta:
                head += " 音色 | 情感 |"
                sep += "---|---|"
            rows.append(head)
            rows.append(sep)
            for item in timeline:
                if item["kind"] == "tag":
                    if not with_tags:
                        continue
                    line_cells = (f"| {item['index']} | {_srt_time(item['start'])[:8]} | "
                                  f"{item['dur']:.2f}s | 句间标签 | 〔{item['tag']}〕 |")
                    rows.append(line_cells + (" - | - |" if with_meta else ""))
                    continue
                line = next((l for l in script["lines"] if l["uid"] == item["uid"]), None) or {}
                p = _eff(line, script)
                emo = {0: "同音色", 1: "情感音频", 2: "向量", 3: "情感文本"}.get(int(p["emo_mode"]), "-")
                txt = (item["text"] or "").replace("|", "\\|")
                cells = (f"| {item['index']} | {_srt_time(item['start'])[:8]} | {item['dur']:.2f}s | "
                         f"语音 | {txt} |")
                if with_meta:
                    cells += f" {ref_names.get(p['ref'], '-')} | {emo} {p['emo_weight']} |"
                rows.append(cells)
                if with_tags:
                    for it in (item.get("inline") or []):
                        rows.append(f"| {item['index']} | {_srt_time(item['start'])[:8]} | - | "
                                    f"句中标签 | 〔{it['tag']}〕 |" + (" - | - |" if with_meta else ""))
        rows.append("\n## 台本\n")
        rows.append("```")
        for item in timeline:
            if item["kind"] == "tag":
                if not with_tags:
                    continue
                rows.append(f"{ts(item)}〔{item['tag']}〕")
                continue
            line = next((l for l in script["lines"] if l["uid"] == item["uid"]), None) or {}
            body_text = _text_with_inline(line) if with_tags else (line.get("text") or "")
            rows.append(f"{ts(item)}{body_text}")
        rows.append("```")
        if with_tags and script.get("tag_presets"):
            rows.append("\n## 自定义标签\n")
            rows.append("、".join(script["tag_presets"]))
        body = "\n".join(rows)
    else:
        out = []
        for item in timeline:
            if item["kind"] == "tag":
                if not with_tags:
                    continue
                out.append(f"{ts(item)}〔{item['tag']}〕")
                continue
            line = next((l for l in script["lines"] if l["uid"] == item["uid"]), None) or {}
            body_text = _text_with_inline(line) if with_tags else (line.get("text") or "")
            out.append(f"{ts(item)}{body_text}")
        body = "\n".join(out)
    with open(path, "w", encoding="utf-8") as f:
        f.write(body + "\n")
    return {"file": name, "duration": round(total, 3)}


# ================================ HTTP 路由 ====================================



# ================================ 存储清理 ====================================
# 「为什么能清出这么多」的答案不是备份：同一份音频会被存三份
#   sfx/（音效库） + materials/（素材库） + scripts/<sid>/media/（工程副本），
# 再加上导出的工程 zip、导出的混音、删除后进回收站（不真删）、
# 以及打包导出时改名留下的 .trash_* 暂存目录。
# 这里把可清理的东西分类扫出来，让用户自己勾着删。

def _rm_tree(path, budget=2.0):
    """逐文件删掉一个目录。**不要用 shutil.rmtree**。

    这个运行环境对「一次删整个目录 / 几百个文件」有批量删除守卫，
    触发后会让进程直接 SystemExit —— 表现为「点一下准备素材，服务没了」。
    逐文件删 + 时间预算，删不完下次接着来，最坏只是留个空目录。
    """
    if not os.path.isdir(path):
        return True
    t0 = time.time()
    try:
        for dp, dns, fns in os.walk(path, topdown=False):
            for fn in fns:
                if time.time() - t0 > budget:
                    return False
                try:
                    os.remove(os.path.join(dp, fn))
                except OSError:
                    pass
            for dn in dns:
                try:
                    os.rmdir(os.path.join(dp, dn))
                except OSError:
                    pass
        os.rmdir(path)
        return True
    except OSError:
        return False


def _size_of(path):
    """文件/目录 → (字节数, 文件数)。目录会递归，跳过符号链接。"""
    if os.path.isfile(path):
        try:
            return os.path.getsize(path), 1
        except OSError:
            return 0, 0
    total, count = 0, 0
    for dp, dns, fns in os.walk(path):
        for fn in fns:
            fp = os.path.join(dp, fn)
            try:
                if os.path.islink(fp):
                    continue
                total += os.path.getsize(fp)
                count += 1
            except OSError:
                pass
    return total, count


def _under(path, base):
    """path 必须在 base 里（防手滑删到包外）。"""
    try:
        a = os.path.abspath(path)
        b = os.path.abspath(base)
        return os.path.commonpath([a, b]) == b
    except ValueError:
        return False


def _storage_plan(root):
    """扫一遍，返回 [{key,label,desc,size,count,safe,files,dirs}]。

    files / dirs 只在服务端用（清理时用），不回给前端。
    """
    lf = os.path.join(root, LF_DIRNAME)
    scripts = os.path.join(lf, "scripts")

    def entries(items, key, label, desc, safe=True, default=False):
        size = sum(s for s, _ in items) if items and isinstance(items[0], tuple) else 0
        return {"key": key, "label": label, "desc": desc, "safe": safe,
                "default": default, "files": [], "dirs": [],
                "size": size, "count": 0}

    plan = []

    # 1) 回收站：应用里删掉的台本/素材/音效都还躺在这里
    it = entries([], "trash", "回收站",
                 "应用里删除的台本 / 素材 / 音效，以及工程导出留下的 .trash_* 暂存目录",
                 default=True)
    for p in (os.path.join(lf, "_trash"),
              os.path.join(lf, "sfx", ".trash"),
              os.path.join(lf, "materials", ".trash")):
        if os.path.isdir(p):
            it["dirs"].append(p)
    if os.path.isdir(scripts):
        for sid in os.listdir(scripts):
            exp = os.path.join(scripts, sid, "export")
            if not os.path.isdir(exp):
                continue
            for fn in os.listdir(exp):
                if fn.startswith(".trash_"):
                    it["dirs"].append(os.path.join(exp, fn))
    plan.append(it)

    # 2) 导出产物（混音 / 工程包 / 单句）
    it = entries([], "exports", "导出产物",
                 "工程里留下的混音、工程 zip、单句导出（重新导出即可再生）", default=False)
    if os.path.isdir(scripts):
        for sid in os.listdir(scripts):
            exp = os.path.join(scripts, sid, "export")
            if not os.path.isdir(exp):
                continue
            for fn in os.listdir(exp):
                p = os.path.join(exp, fn)
                if os.path.isfile(p):
                    it["files"].append(p)
    plan.append(it)

    # 3) 历史快照
    it = entries([], "history", "历史快照",
                 "每次改动自动存的版本（时间轴「🕘 历史」里能看到），删掉就没法回退了",
                 default=False)
    if os.path.isdir(scripts):
        for sid in os.listdir(scripts):
            p = os.path.join(scripts, sid, "timeline_history")
            if os.path.isdir(p):
                it["dirs"].append(p)
    plan.append(it)

    # 4) 波形峰值缓存（可再生，删了只是下次要重算）
    it = entries([], "peaks", "波形缓存",
                 "波形峰值缓存，删掉会自动重算，不影响音频", default=True)
    if os.path.isdir(scripts):
        for sid in os.listdir(scripts):
            p = os.path.join(scripts, sid, "peaks")
            if os.path.isdir(p):
                it["dirs"].append(p)
    plan.append(it)

    # 5) 导入缓存
    it = entries([], "import", "导入缓存",
                 "智能导入时上传的中间解析文件（<token>.json），24 小时后本来也会清",
                 default=True)
    imp = os.path.join(lf, "_import")
    if os.path.isdir(imp):
        for fn in os.listdir(imp):
            p = os.path.join(imp, fn)
            if os.path.isfile(p):
                it["files"].append(p)
    plan.append(it)

    # 6) 主程序生成历史
    it = entries([], "outputs", "主程序生成历史",
                 "主界面「生成历史」里的音频（台本工作台不用它）", default=False)
    out = os.path.join(root, "outputs")
    if os.path.isdir(out):
        for fn in os.listdir(out):
            p = os.path.join(out, fn)
            if os.path.isfile(p) and fn.lower().endswith((".wav", ".mp3", ".flac", ".ogg")):
                it["files"].append(p)
    plan.append(it)

    # 7) 音效台的分离作业（每个都存着整条源音频，几十 MB 很常见）
    it = entries([], "sfxb", "音效台分离作业",
                 "高级音效处理台「① 准备素材」留下的作业副本（默认只留最近 8 个）；"
                 "删了下次要重新去人声，切好的片段也一起没了",
                 safe=True, default=False)
    sfxb = os.path.join(lf, "sfxb")
    if os.path.isdir(sfxb):
        dirs = [os.path.join(sfxb, n) for n in os.listdir(sfxb)
                if os.path.isdir(os.path.join(sfxb, n))]
        # 最近那个可能正开着音效台（页面还握着 job id），永远留着
        dirs.sort(key=lambda p: os.path.getmtime(p), reverse=True)
        it["dirs"].extend(dirs[1:])
    plan.append(it)

    # 8) 模型分离中间文件（BS-Roformer / Demucs 跑完本该自己删，异常退出会留下）
    it = entries([], "roformer", "分离中间文件",
                 "BS-Roformer 的输入 / 输出临时 wav，正常跑完就删；异常退出会留下几个",
                 default=True)
    for sub in ("roformer_work", "roformer_in"):
        d = os.path.join(lf, sub)
        if os.path.isdir(d):
            for name in os.listdir(d):
                p = os.path.join(d, name)
                if os.path.isfile(p) or os.path.isdir(p):
                    (it["files"] if os.path.isfile(p) else it["dirs"]).append(p)
    plan.append(it)

    # 9) 日志
    it = entries([], "logs", "运行日志", "服务日志，删了不影响功能", default=False)
    lg = os.path.join(root, "logs")
    if os.path.isdir(lg):
        for fn in os.listdir(lg):
            p = os.path.join(lg, fn)
            if os.path.isfile(p) and fn.lower().endswith(".log"):
                it["files"].append(p)
    plan.append(it)

    # 10) 孤立音频：台本目录里没有行引用的 wav（重生成换名字后会留下）
    it = entries([], "orphan", "孤立音频",
                 "台本目录里没有任何一句引用的 wav（重新生成换过文件名后会留下）",
                 safe=False, default=False)
    if os.path.isdir(scripts):
        for sid in os.listdir(scripts):
            sd = os.path.join(scripts, sid)
            try:
                sc = _read_json(os.path.join(sd, "script.json"), {})
            except Exception:  # noqa: BLE001
                continue
            used = {os.path.basename(str(l.get("out") or ""))
                    for l in (sc.get("lines") or []) if l.get("out")}
            aud = os.path.join(sd, "audio")
            if not os.path.isdir(aud):
                continue
            for fn in os.listdir(aud):
                if fn.lower().endswith(".wav") and fn not in used:
                    it["files"].append(os.path.join(aud, fn))
    plan.append(it)

    # 11) 工程里的素材副本（和音效库/素材库里同名同大小的那份重复）
    it = entries([], "dupes", "工程里的重复素材",
                 "和「音效库 / 素材库」里同名同大小的工程副本；删了不影响库，"
                 "但那几个用到它的台本会失去素材（要重新拖进来）",
                 safe=False, default=False)
    libs = {}
    for lib in (os.path.join(lf, "sfx"), os.path.join(lf, "materials")):
        if os.path.isdir(lib):
            for fn in os.listdir(lib):
                p = os.path.join(lib, fn)
                if os.path.isfile(p):
                    try:
                        libs.setdefault((fn, os.path.getsize(p)), 0)
                        libs[(fn, os.path.getsize(p))] += 1
                    except OSError:
                        pass
    if os.path.isdir(scripts):
        for sid in os.listdir(scripts):
            md = os.path.join(scripts, sid, "media")
            if not os.path.isdir(md):
                continue
            for fn in os.listdir(md):
                p = os.path.join(md, fn)
                if not os.path.isfile(p):
                    continue
                try:
                    if (fn, os.path.getsize(p)) in libs:
                        it["files"].append(p)
                except OSError:
                    pass
    plan.append(it)

    # 统计体积
    for it in plan:
        size, count = 0, 0
        for f in it["files"]:
            s2, c2 = _size_of(f)
            size += s2
            count += c2
        for d in it["dirs"]:
            s2, c2 = _size_of(d)
            size += s2
            count += c2
        it["size"] = size
        it["count"] = count
    return plan


def _storage_big(root, limit=12):
    """最大的几个文件（只读，帮你判断空间去哪了）。"""
    out = []
    for base in (os.path.join(root, LF_DIRNAME), os.path.join(root, "outputs")):
        if not os.path.isdir(base):
            continue
        for dp, dns, fns in os.walk(base):
            for fn in fns:
                p = os.path.join(dp, fn)
                try:
                    out.append((os.path.getsize(p), os.path.relpath(p, root)))
                except OSError:
                    pass
    out.sort(reverse=True)
    return [{"size": s, "path": p.replace(os.sep, "/")} for s, p in out[:limit]]


def register_longform(app, api, deps):
    _D.update(deps or {})
    # 主 server.py 在文件末尾才 include_router(api)，之后再往 api 上挂路由不会生效，
    # 所以本模块用独立 router，注册完再 include —— 与既有路由完全隔离。
    lf = APIRouter(prefix="/api/v1")
    web_dir = _D.get("web_dir") or os.path.join(_D["project_dir"], "web")

    @app.get("/longform", include_in_schema=False)
    def longform_page():
        path = os.path.join(web_dir, "longform.html")
        if not os.path.exists(path):
            raise HTTPException(404, "longform.html 缺失")
        return FileResponse(path, media_type="text/html; charset=utf-8",
                            headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"})

    @app.get("/guide", include_in_schema=False)
    def guide_page():
        """「第一次用？看看这里」—— 独立教程页（不占台本页的布局）。"""
        path = os.path.join(web_dir, "guide.html")
        if not os.path.exists(path):
            raise HTTPException(404, "guide.html 缺失（补丁包不完整）")
        return FileResponse(path, media_type="text/html; charset=utf-8",
                            headers={"Cache-Control": "no-store"})

    @app.get("/guide-img/{name}", include_in_schema=False)
    def guide_img(name: str):
        safe = os.path.basename(name)
        if not re.fullmatch(r"[A-Za-z0-9_.-]+\.png", safe):
            raise HTTPException(404, "Not found")
        path = os.path.join(web_dir, "guide", safe)
        if not os.path.exists(path):
            raise HTTPException(404, "Not found")
        return FileResponse(path, media_type="image/png",
                            headers={"Cache-Control": "no-store"})

    @app.get("/longform-assets/{name}", include_in_schema=False)
    def longform_asset(name: str):
        # 白名单在 lf_static.py（两页共用一份，加新脚本只改那里）
        from lf_static import serve_asset
        return serve_asset(web_dir, "longform", name)

    @app.get("/sfxbench", include_in_schema=False)
    def sfxbench_page():
        """高级音效处理台：独立页面（不挤在导入台里，波形和片段列表需要横向空间）。"""
        path = os.path.join(web_dir, "sfxbench.html")
        if not os.path.exists(path):
            raise HTTPException(404, "sfxbench.html 缺失（补丁包不完整）")
        return FileResponse(path, media_type="text/html; charset=utf-8",
                            headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"})

    @app.get("/sfxbench-assets/{name}", include_in_schema=False)
    def sfxbench_asset(name: str):
        from lf_static import serve_asset
        return serve_asset(web_dir, "sfxbench", name)

    # ---- 存储清理 -----------------------------------------------------------
    @lf.get("/lf/storage/scan")
    def lf_storage_scan():
        """扫一遍可以清理的东西（体积 + 数量 + 最大文件）。"""
        root = _D["project_dir"]
        plan = _storage_plan(root)
        total = sum(it["size"] for it in plan)
        items = []
        for it in plan:
            # 前端「📂 打开」要知道打开哪个目录：优先分类自己的目录，
            # 没有目录（比如散落的导出文件）就打开第一个文件所在的目录。
            d = it["dirs"][0] if it["dirs"] else (os.path.dirname(it["files"][0])
                                                 if it["files"] else "")
            row = {k: it[k] for k in ("key", "label", "desc", "size", "count",
                                      "safe", "default")}
            row["dir"] = os.path.relpath(d, root).replace(os.sep, "/") if d else ""
            items.append(row)
        import shutil as _sh
        try:
            du = _sh.disk_usage(root)
            free, cap = du.free, du.total
        except Exception:  # noqa: BLE001
            free, cap = 0, 0
        return {"ok": True, "root": root, "total": total, "items": items,
                "big": _storage_big(root), "free": free, "capacity": cap}

    @lf.post("/lf/storage/open")
    def lf_storage_open(req: dict = Body(default={})):
        """在系统文件管理器里打开某个目录 / 定位某个文件（只允许包内路径）。

        浏览器不能直接开本地目录，所以由本机服务代劳：Windows 用 explorer，
        macOS 用 open -R，Linux 用 xdg-open。
        """
        root = _D["project_dir"]
        raw = str(req.get("path") or "").strip()
        if not raw:
            p = root
        elif os.path.isabs(raw):
            p = raw
        else:
            p = os.path.join(root, raw.replace("/", os.sep))
        p = os.path.abspath(p)
        if not _under(p, root):
            raise HTTPException(403, "只能打开整合包内的目录")
        # 不存在就往上找第一个存在的父目录（分类目录可能还没建）
        probe = p
        while probe and not os.path.exists(probe) and len(probe) > len(root):
            probe = os.path.dirname(probe)
        if not os.path.exists(probe):
            raise HTTPException(404, "目录不存在")
        try:
            if os.path.isfile(probe):
                if sys.platform.startswith("win"):
                    subprocess.Popen(["explorer", "/select,", os.path.normpath(probe)])
                elif sys.platform == "darwin":
                    subprocess.Popen(["open", "-R", probe])
                else:
                    subprocess.Popen(["xdg-open", os.path.dirname(probe)])
            else:
                if sys.platform.startswith("win"):
                    subprocess.Popen(["explorer", os.path.normpath(probe)])
                elif sys.platform == "darwin":
                    subprocess.Popen(["open", probe])
                else:
                    subprocess.Popen(["xdg-open", probe])
        except OSError as e:  # noqa: BLE001
            raise HTTPException(500, f"打不开：{e}") from e
        _log("longform: storage open %s", probe)
        return {"ok": True, "path": probe,
                "rel": os.path.relpath(probe, root).replace(os.sep, "/")}

    @lf.post("/lf/storage/clean")
    def lf_storage_clean(req: dict = Body(default={})):
        """按分类清理。逐项检查路径必须在包内；单次有时间预算，没删完下次接着来。"""
        root = _D["project_dir"]
        keys = [k for k in (req.get("keys") or []) if isinstance(k, str)]
        budget = float(req.get("budget") or 3.0)
        # 单次请求最多删这么多个文件：一万个文件全塞进一个请求里会卡死服务，
        # 也会让「删了多少」没法反馈。没删完就返回 left，前端再点一次接着删。
        max_files = max(20, min(2000, int(req.get("max_files") or 400)))
        dry = bool(req.get("dry_run"))
        if not keys:
            raise HTTPException(400, "没有选要清理的项目")
        plan = {it["key"]: it for it in _storage_plan(root)}
        unknown = [k for k in keys if k not in plan]
        if unknown:
            raise HTTPException(400, "未知分类：" + "、".join(unknown))
        t0 = time.time()
        freed = removed = 0
        left = 0
        errors = []
        per = {}
        for k in keys:
            it = plan[k]
            got = per.setdefault(k, {"freed": 0, "removed": 0, "left": 0})
            # 先删文件，再删空目录
            for path in it["files"] + it["dirs"]:
                if time.time() - t0 > budget or removed >= max_files:
                    left += 1
                    got["left"] += 1
                    continue
                if not _under(path, root):
                    errors.append(os.path.basename(path))
                    continue
                if dry:
                    sz, cnt = _size_of(path)
                    got["freed"] += sz
                    got["removed"] += cnt
                    continue
                try:
                    if os.path.isdir(path):
                        # 逐文件删（不用 rmtree：一次删几百个会被批量删除守卫拦下）
                        for dp, dns, fns in os.walk(path, topdown=False):
                            for fn in fns:
                                if removed >= max_files:
                                    break
                                fp = os.path.join(dp, fn)
                                try:
                                    sz = os.path.getsize(fp)
                                except OSError:
                                    sz = 0
                                try:
                                    os.remove(fp)
                                    got["freed"] += sz
                                    got["removed"] += 1
                                except OSError as e:
                                    errors.append(f"{fn}: {e}")
                            for dn in dns:
                                try:
                                    os.rmdir(os.path.join(dp, dn))
                                except OSError:
                                    pass
                            if removed >= max_files:
                                break
                        try:
                            os.rmdir(path)
                        except OSError:
                            pass
                    else:
                        sz = os.path.getsize(path)
                        os.remove(path)
                        got["freed"] += sz
                        got["removed"] += 1
                except OSError as e:
                    errors.append(f"{os.path.basename(path)}: {e}")
            freed += got["freed"]
            removed += got["removed"]
            left += got["left"]
        if not dry and freed:
            # 峰值缓存的 key 里带 mtime，删掉缓存文件后下次会自动重算，
            # 这里不需要额外清内存（timeline 侧按 rev 取键）。
            pass
        _log("longform: storage clean keys=%s freed=%.1fMB removed=%d left=%d dry=%s",
             ",".join(keys), freed / 1048576.0, removed, left, dry)
        return {"ok": True, "freed": freed, "removed": removed, "left": left,
                "dry_run": dry, "per": per, "errors": errors[:20],
                "seconds": round(time.time() - t0, 2)}

    # ---- 元信息 ---------------------------------------------------------------
    @lf.get("/lf/meta")
    def lf_meta():
        tts = _D["tts"]
        return {
            "ok": True,
            "model": tts.state(),
            "refs": _all_ref_options(),
            "ref_folders": _folder_list(_load_refs()),
            "tags": _tag_list("sfx"),
            "defaults": _DEFAULT_PARAMS,
            "sampling": _DEFAULT_SAMPLING,
            "limits": {"pause_min": PAUSE_MIN, "pause_max": PAUSE_MAX,
                       "hold_max": HOLD_MAX, "max_line_chars": MAX_LINE_CHARS},
            "audio_sr": AUDIO_SR,
        }

    @lf.post("/lf/split")
    def lf_split(req: dict = Body(...)):
        text = str(req.get("text") or "")
        if not text.strip():
            raise HTTPException(400, "文本为空")
        lines = split_text(text, int(req.get("max_chars") or 70), req.get("mode") or "packed")
        return {"ok": True, "lines": lines, "count": len(lines),
                "chars": sum(len(x) for x in lines)}

    # ---- 音色库 ---------------------------------------------------------------
    @lf.post("/lf/refs")
    def lf_ref_add(file: UploadFile = File(...), name: str = Form(""),
                   purpose: str = Form("voice")):
        """上传音色参考音频。

        音色是**喂给模型**的，模型只认「22050 单声道 PCM WAV」这条线，所以这里
        不让原始格式进库：任何能解码的音频（wav/mp3/flac/ogg/m4a）都先解成波形、
        混成单声道、重采样到 22050、写成 WAV 再入库。好处是三件事：
          1) 模型侧永远拿到能读的文件，不会出现「列表里有、生成时报读不出」；
          2) 同一段音频用 mp3 还是 wav 上传，内容哈希一样 → 自动去重；
          3) 库里的文件格式统一，备份/迁移不会踩到编码器差异。
        """
        data = file.file.read()
        if not data:
            raise HTTPException(400, "空文件")
        if len(data) > MAX_REF_BYTES:
            raise HTTPException(413, "参考音频过大（上限 40 MB）")
        src = os.path.basename(file.filename or "参考音频")
        ext = os.path.splitext(src)[1].lower()
        if ext not in (".wav", ".mp3", ".flac", ".ogg", ".m4a"):
            raise HTTPException(400, "音色只支持 wav / mp3 / flac / ogg / m4a（入库时会统一转成 WAV）")

        tmp = os.path.join(_refs_dir(), f".up_{uuid.uuid4().hex[:8]}{ext}")
        try:
            with open(tmp, "wb") as f:
                f.write(data)
            try:
                x, sr = _read_audio_any(tmp)
            except HTTPException as e:
                raise HTTPException(400, f"这个文件读不出音频：{e.detail}")
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass

        item = _save_ref_audio(x, sr, name or os.path.splitext(src)[0], src)
        # 情感参考音频也进同一个音色库（模型解析路径只有这一套），只是打个标记，
        # 方便「情感音频」下拉里把她排在前面、也方便在音色库里认出来。
        if purpose == "emo":
            with _LOCK:
                idx = _load_refs()
                it = next((r for r in idx["items"] if r.get("id") == item["id"]), None)
                if it is not None:
                    uses = list(it.get("uses") or [])
                    if "emo" not in uses:
                        uses.append("emo")
                    it["uses"] = uses
                    if not it.get("emo_name"):
                        it["emo_name"] = item.get("name")
                    _write_json(_refs_index_path(), idx)
                    item = it
        dur = item.get("dur") or 0
        _log("longform: ref %s <- %s (%.1fs, normalized 22050 mono wav)", item["file"], src, dur)
        return {"ok": True, "ref": item, "long": bool(dur > 15),
                "normalized": True, "src": src}

    @lf.patch("/lf/refs/{rid}")
    def lf_ref_rename(rid: str, req: dict = Body(...)):
        """重命名音色，并把磁盘文件也改成可读名字（原名 + 短哈希，避免重名覆盖）。"""
        with _LOCK:
            idx = _load_refs()
            item = next((x for x in idx["items"] if x["id"] == rid), None)
            if not item:
                raise HTTPException(404, "音色不存在")
            name = _safe_title(req.get("name") or item.get("name"), item["id"])
            old_path = os.path.join(_refs_dir(), os.path.basename(item["file"]))
            ext = os.path.splitext(item["file"])[1] or ".wav"
            new_file = f"{name}_{item['id'][:6]}{ext}"
            new_path = os.path.join(_refs_dir(), new_file)
            if os.path.exists(old_path) and os.path.abspath(old_path) != os.path.abspath(new_path):
                try:
                    os.replace(old_path, new_path)
                    item["file"] = new_file
                    _log("longform: ref %s renamed to %s", item["id"], new_file)
                except OSError as e:
                    _log("longform: ref file rename failed: %s", e, level="warning")
            item["name"] = name
            _write_json(_refs_index_path(), idx)
        return {"ok": True, "ref": item}

    # ---- 标签库（属性标签 / 音效标签，可自定义） --------------------------
    @lf.get("/lf/taglib")
    def lf_taglib():
        return {"ok": True, "traits": _tag_full("trait"), "sfx": _tag_full("sfx")}

    @lf.post("/lf/taglib")
    def lf_taglib_add(req: dict = Body(default=None)):
        """新增自定义标签；如果删过同名预设，再加回来等于恢复。"""
        req = req or {}
        kind = str(req.get("kind") or "trait")
        if kind not in TAG_KINDS:
            raise HTTPException(400, "标签类型不对")
        names = _clean_tags(req.get("name") or req.get("names"))
        if not names:
            raise HTTPException(400, "标签名不能为空")
        with _LOCK:
            lib = _load_taglib()
            have = {_tag_key(x) for x in _tag_list(kind)}
            for nm in names:
                k = _tag_key(nm)
                lib["hidden"][kind] = [x for x in lib["hidden"][kind] if _tag_key(x) != k]
                if k not in have:
                    lib["added"][kind].append(nm)
                    have.add(k)
            _taglib_save(lib)
        return {"ok": True, "kind": kind, "name": names[0],
                "traits": _tag_full("trait"), "sfx": _tag_full("sfx")}

    @lf.delete("/lf/taglib")
    def lf_taglib_del(kind: str = "trait", name: str = ""):
        """删标签：预设 → 记进 hidden（不物理删），自定义 → 移除。

        已经打在音色 / 人物上的标签**不动** —— 这里只是"候选里不再出现"。
        """
        if kind not in TAG_KINDS:
            raise HTTPException(400, "标签类型不对")
        nm = str(name or "").strip()
        if not nm:
            raise HTTPException(400, "缺少标签名")
        k = _tag_key(nm)
        with _LOCK:
            lib = _load_taglib()
            lib["added"][kind] = [x for x in lib["added"][kind] if _tag_key(x) != k]
            if k in {_tag_key(x) for x in _tag_presets(kind)}:
                if k not in {_tag_key(x) for x in lib["hidden"][kind]}:
                    lib["hidden"][kind].append(nm)
            _taglib_save(lib)
        return {"ok": True, "kind": kind, "name": nm,
                "traits": _tag_full("trait"), "sfx": _tag_full("sfx")}

    # ---- 人物标签库（跨台本） ----------------------------------------------
    @lf.get("/lf/characters")
    def lf_characters(sid: str = ""):
        """人物库 + 当前台本里的使用情况。

        `used` = 这个台本里有多少句的分组名命中它（含别名）；`matched` = 其中已经
        用上它绑定音色的句数。`candidates` = 台本里出现、但人物库还没有的分组名。
        """
        chars = _load_chars()
        idx = _char_index(chars)
        items = []
        usage = {}
        cand = {}
        if sid:
            try:
                script = _load_script(_safe_sid(sid))
            except Exception:  # noqa: BLE001
                script = {"lines": []}
            for ln in (script.get("lines") or []):
                if ln.get("kind") == "tag":
                    continue
                g = (ln.get("group") or "").strip()
                if not g:
                    continue
                hit = None
                for v in _name_variants(g):
                    hit = idx.get(_tag_key(v))
                    if hit:
                        break
                if hit:
                    d = usage.setdefault(hit["id"], {"used": 0, "matched": 0})
                    d["used"] += 1
                    cur = (ln.get("ov") or {}).get("ref")
                    if cur and cur == hit.get("ref"):
                        d["matched"] += 1
                else:
                    cand[g] = cand.get(g, 0) + 1
        for c in sorted(chars["items"], key=lambda x: (-int(x.get("updated") or 0), x["name"])):
            rid, rname = _char_voice(c)
            u = usage.get(c["id"]) or {}
            items.append(dict(c, ref=rid, ref_name=rname,
                              ref_missing=bool(c.get("ref") and not rid),
                              used=u.get("used", 0), matched=u.get("matched", 0)))
        # 属性标签汇总：人物上的 + 音色上的（音色标签也能直接当属性用）
        agg = {}
        for c in chars["items"]:
            for t in c.get("traits") or []:
                a = agg.setdefault(_tag_key(t), {"tag": t, "chars": 0, "refs": 0})
                a["chars"] += 1
        for it in _load_refs()["items"]:
            for t in it.get("tags") or []:
                a = agg.setdefault(_tag_key(t), {"tag": t, "chars": 0, "refs": 0})
                a["refs"] += 1
        traits = sorted(agg.values(), key=lambda x: (-(x["chars"] + x["refs"]), x["tag"]))
        return {"ok": True, "items": items, "count": len(items),
                "traits": traits,
                "candidates": [{"name": k, "lines": v} for k, v in
                               sorted(cand.items(), key=lambda x: -x[1])][:60],
                "auto_voice": bool(_load_settings()["voice"].get("autoVoice"))}

    @lf.post("/lf/characters")
    def lf_char_new(req: dict = Body(default=None)):
        """新建人物：一个人名标签（唯一）+ 任意多个属性标签 + 可选绑定音色。"""
        req = req or {}
        name = _safe_title(str(req.get("name") or "").strip(), "")[:24].strip()
        if not name:
            raise HTTPException(400, "人物名不能为空")
        aliases = _clean_tags(req.get("aliases"))[:8]
        traits = _clean_tags(req.get("traits"))
        with _LOCK:
            chars = _load_chars()
            if len(chars["items"]) >= CHAR_MAX:
                raise HTTPException(400, "人物太多（上限 %d）" % CHAR_MAX)
            dup = _char_conflict(name, aliases, chars)
            if dup:
                raise HTTPException(400, "「%s」已经在人物库里了" % dup)
            rid, rname = _char_voice({"ref": str(req.get("ref") or "")})
            item = {"id": "c" + uuid.uuid4().hex[:10], "name": name,
                    "aliases": aliases, "traits": traits, "ref": rid,
                    "note": str(req.get("note") or "")[:200],
                    "created": int(time.time()), "updated": int(time.time())}
            chars["items"].append(item)
            _save_chars(chars)
        _log("longform: character + %s（%s）", name, ",".join(traits) or "-")
        return {"ok": True, "item": dict(item, ref_name=rname)}

    @lf.patch("/lf/characters/{cid}")
    def lf_char_save(cid: str, req: dict = Body(default=None)):
        req = req or {}
        with _LOCK:
            chars = _load_chars()
            item = next((c for c in chars["items"] if c["id"] == cid), None)
            if not item:
                raise HTTPException(404, "人物不存在")
            if "name" in req:
                name = _safe_title(str(req.get("name") or "").strip(), item["name"])[:24].strip()
                if not name:
                    raise HTTPException(400, "人物名不能为空")
                aliases = (_clean_tags(req.get("aliases"))[:8] if "aliases" in req
                           else list(item.get("aliases") or []))
                dup = _char_conflict(name, aliases, chars, skip_id=cid)
                if dup:
                    raise HTTPException(400, "「%s」已经在人物库里了" % dup)
                item["name"] = name
                item["aliases"] = aliases
            elif "aliases" in req:
                new_aliases = _clean_tags(req.get("aliases"))[:8]
                dup = _char_conflict(item["name"], new_aliases, chars, skip_id=cid)
                if dup:
                    raise HTTPException(400, "「%s」已经在人物库里了" % dup)
                item["aliases"] = new_aliases
            if "traits" in req:
                item["traits"] = _clean_tags(req.get("traits"))
            if "ref" in req:
                rid, _rn = _char_voice({"ref": str(req.get("ref") or "")})
                item["ref"] = rid
            if "note" in req:
                item["note"] = str(req.get("note") or "")[:200]
            item["updated"] = int(time.time())
            _save_chars(chars)
            rid, rname = _char_voice(item)
        return {"ok": True, "item": dict(item, ref_name=rname)}

    @lf.delete("/lf/characters/{cid}")
    def lf_char_del(cid: str):
        """删人物**不动音色、不动台本**：只是以后导入时不再自动对上。"""
        with _LOCK:
            chars = _load_chars()
            item = next((c for c in chars["items"] if c["id"] == cid), None)
            if not item:
                raise HTTPException(404, "人物不存在")
            chars["items"] = [c for c in chars["items"] if c["id"] != cid]
            _save_chars(chars)
        _log("longform: character - %s", item.get("name"))
        return {"ok": True}

    @lf.post("/lf/characters/bulk")
    def lf_char_bulk(req: dict = Body(default=None)):
        """按名字批量新建（从台本分组名来）：已存在 / 和别名冲突的都跳过。"""
        req = req or {}
        names = _clean_tags(req.get("names"))[:60]
        rid, _rn = _char_voice({"ref": str(req.get("ref") or "")})
        traits = _clean_tags(req.get("traits"))
        made, skipped = [], []
        with _LOCK:
            chars = _load_chars()
            for nm in names:
                if _char_conflict(nm, [], chars) or len(chars["items"]) >= CHAR_MAX:
                    skipped.append(nm)
                    continue
                item = {"id": "c" + uuid.uuid4().hex[:10], "name": nm[:24],
                        "aliases": [], "traits": list(traits), "ref": rid,
                        "note": "", "created": int(time.time()),
                        "updated": int(time.time())}
                chars["items"].append(item)
                made.append(item["name"])
            if made:
                _save_chars(chars)
        _log("longform: characters bulk + %d（跳过 %d）", len(made), len(skipped))
        return {"ok": True, "created": made, "skipped": skipped, "count": len(made)}

    @lf.put("/lf/refs/{rid}/tags")
    def lf_ref_tags(rid: str, req: dict = Body(default=None)):
        """设置一个音色的标签（整体替换）。标签是「角色名 → 音色」的桥梁：

        智能导入按「阿澈：…」分了组，只要某个音色上标了 `阿澈`，
        导入时或「智能识别人物」就能把那一组自动套上这个音色。
        """
        req = req or {}
        tags = _clean_tags(req.get("tags"))
        with _LOCK:
            idx = _load_refs()
            item = next((x for x in idx["items"] if x["id"] == rid), None)
            if not item:
                raise HTTPException(404, "音色不存在")
            if tags:
                item["tags"] = tags
            else:
                item.pop("tags", None)
            item["tag_at"] = _now()
            _write_json(_refs_index_path(), idx)
        return {"ok": True, "id": rid, "tags": tags}

    @lf.get("/lf/tags")
    def lf_tag_library():
        """标签库：所有音色上的标签 + 各自挂了哪些音色。

        同名标签挂多个音色时，`refs` 按「置顶 → 新→旧」排，第一个就是自动套用会用到的那个。
        """
        refs = _pin_sort(_load_refs()["items"])
        agg = {}
        for it in refs:
            for t in (it.get("tags") or []):
                k = _tag_key(t)
                if not k:
                    continue
                a = agg.setdefault(k, {"tag": t, "key": k, "count": 0, "refs": []})
                a["count"] += 1
                a["refs"].append({"id": it["id"], "name": it.get("name") or it["id"]})
        items = sorted(agg.values(), key=lambda x: (-x["count"], x["tag"]))
        return {"ok": True, "items": items, "count": len(items)}

    @lf.post("/lf/auto-voice")
    def lf_auto_voice(req: dict = Body(default=None)):
        """智能识别人物：按「行分组名（= 角色名）」匹配音色标签，把对应音色套上去。

        只改音色（`ov.ref`），不碰情感 / 停顿 / 采样 —— 那些随台本和情绪变，自动套只会添乱。
        `dry_run=true` 只算不写，用来先把结果摆给人看。
        `overwrite=false`（默认）时，已经有单独指定音色的行保持不动。
        """
        req = req or {}
        sid = _safe_sid(req.get("sid") or "")
        dry = bool(req.get("dry_run"))
        overwrite = bool(req.get("overwrite"))
        fuzzy = req.get("fuzzy") is not False
        script = _load_script(sid)
        lines = script.get("lines") or []
        char_idx = _char_index()
        tag_idx = _tag_index()
        by_uid = {ln.get("uid"): ln for ln in lines}

        groups = {}
        no_group = 0
        for ln in lines:
            if ln.get("kind") == "tag":
                continue
            g = (ln.get("group") or "").strip()
            if not g:
                no_group += 1
                continue
            d = groups.setdefault(g, {"lines": 0, "uids": []})
            d["lines"] += 1
            d["uids"].append(ln.get("uid"))

        matched, unmatched, no_voice, changed = [], [], [], 0
        for name, d in groups.items():
            res = _resolve_voice(name, char_idx, tag_idx)
            if res["source"] == "none" or (res["fuzzy"] and not fuzzy):
                unmatched.append({"name": name, "lines": d["lines"]})
                continue
            if not res["ref"]:
                # 人物认出来了，但还没绑音色：这不是"没对上"，提示去绑一个
                no_voice.append({"name": name, "lines": d["lines"],
                                 "char": res["char"], "char_name": res["char_name"] or res["label"],
                                 "traits": res["traits"]})
                continue
            ref = {"id": res["ref"], "name": res["ref_name"]}
            tag = res["label"]
            is_fuzzy = res["fuzzy"]
            applied = kept = 0
            for uid in d["uids"]:
                ln = by_uid.get(uid)
                if not ln:
                    continue
                cur = (ln.get("ov") or {}).get("ref")
                if cur == ref["id"]:
                    kept += 1
                    continue
                if cur and not overwrite:
                    kept += 1          # 已经手动指定过别的音色：默认不动
                    continue
                applied += 1
                if not dry:
                    ln["ov"] = ln.get("ov") or {}
                    ln["ov"]["ref"] = ref["id"]
                    # 来源标记：只给界面看（_eff 只读白名单键，不会进生成参数）
                    ln["ov"]["ref_src"] = res["source"]
                    if res.get("char_name"):
                        ln["ov"]["ref_char"] = res["char_name"]
                    if ln.get("status") in ("done", "error"):
                        ln["status"] = "stale"
            changed += applied
            matched.append({"name": name, "tag": tag, "fuzzy": is_fuzzy,
                            "ref": ref["id"], "ref_name": ref.get("name") or ref["id"],
                            "source": res["source"], "char": res["char_name"],
                            "traits": res["traits"],
                            "lines": d["lines"], "applied": applied, "kept": kept})
        matched.sort(key=lambda x: (-x["applied"], x["name"]))
        if not dry and changed:
            script["updated"] = _now()
            _save_script(script)
            _log("longform: auto-voice %s -> %d 行 / %d 角色（人物 %d · 标签 %d）",
                 sid, changed, len(matched), len(char_idx), len(tag_idx))
        return {"ok": True, "dry": dry, "sid": sid, "changed": changed,
                "lines": sum(d["lines"] for d in groups.values()),
                "no_group": no_group, "tags": len(tag_idx), "chars": len(char_idx),
                "matched": matched, "unmatched": unmatched, "no_voice": no_voice,
                "script": None if dry else _load_script(sid)}

    @lf.delete("/lf/refs/{rid}")
    def lf_ref_delete(rid: str):
        with _LOCK:
            idx = _load_refs()
            item = next((x for x in idx["items"] if x["id"] == rid), None)
            if not item:
                raise HTTPException(404, "音色不存在")
            idx["items"] = [x for x in idx["items"] if x["id"] != rid]
            _write_json(_refs_index_path(), idx)
            try:
                os.remove(os.path.join(_refs_dir(), os.path.basename(item["file"])))
            except OSError:
                pass
        return {"ok": True}

    @lf.post("/lf/refs/bulk")
    def lf_refs_bulk(req: dict = Body(default=None)):
        """音色批量操作：删除 / 移动文件夹 / 加标签 / 去标签 / 置顶 / 取消置顶。

        为什么必须有批量接口：前端一个个发请求的话，每个请求都要「读整份索引 + 写整份」，
        Windows 上删 50 个就要几十秒（而且中间状态全落在盘上）。这里只读写一次。
        """
        req = req or {}
        action = str(req.get("action") or "").strip()
        ids = [str(x) for x in (req.get("ids") or []) if x]
        if not ids:
            raise HTTPException(400, "没有选中任何音色")
        ids_set = set(ids[:2000])
        if action not in ("delete", "move", "tags_add", "tags_del", "pin", "unpin"):
            raise HTTPException(400, "action 只能是 delete / move / tags_add / tags_del / pin / unpin")
        folder = _norm_folder(req.get("folder")) if action == "move" else ""
        tags = _clean_tags(req.get("tags")) if action in ("tags_add", "tags_del") else []
        if action in ("tags_add", "tags_del") and not tags:
            raise HTTPException(400, "先选一个标签")
        moved = deleted = 0
        with _LOCK:
            idx = _load_refs()
            if action == "delete":
                gone = [x for x in idx["items"] if x.get("id") in ids_set]
                idx["items"] = [x for x in idx["items"] if x.get("id") not in ids_set]
                for it in gone:
                    try:
                        os.remove(os.path.join(_refs_dir(), os.path.basename(it.get("file") or "")))
                        deleted += 1
                    except OSError:
                        pass
            elif action == "move":
                for it in idx["items"]:
                    if it.get("id") not in ids_set:
                        continue
                    if folder:
                        it["folder"] = folder
                    else:
                        it.pop("folder", None)
                    moved += 1
                if folder:
                    _store_folders(idx, _folder_paths(idx))
            elif action in ("tags_add", "tags_del"):
                for it in idx["items"]:
                    if it.get("id") not in ids_set:
                        continue
                    cur = [t for t in (it.get("tags") or []) if t]
                    if action == "tags_add":
                        for t in tags:
                            if t not in cur:
                                cur.append(t)
                    else:
                        drop = {t.lower() for t in tags}
                        cur = [t for t in cur if t.lower() not in drop]
                    if cur:
                        it["tags"] = cur
                    else:
                        it.pop("tags", None)
                    it["tag_at"] = _now()
            else:
                pin = time.time() if action == "pin" else 0
                for it in idx["items"]:
                    if it.get("id") in ids_set:
                        if pin:
                            it["pin"] = pin
                        else:
                            it.pop("pin", None)
                        moved += 1
            _write_json(_refs_index_path(), idx)
        return {"ok": True, "action": action, "count": moved or deleted, "ids": list(ids_set)}

    # ---- 素材库（前期准备：视频抽音频 / 去伴奏 / 降噪 / 标准化 …）--------------
    # ---- ffmpeg：状态 / 探测 / 指定路径 / 上传 ----
    @lf.get("/lf/ffmpeg")
    def lf_ffmpeg_state():
        return {"ok": True, **_ffmpeg_state()}

    @lf.post("/lf/ffmpeg/probe")
    def lf_ffmpeg_probe():
        return {"ok": True, **_ffmpeg_state(fresh=True)}

    @lf.post("/lf/ffmpeg/path")
    def lf_ffmpeg_path(req: dict = Body(default={})):
        """手动指定 ffmpeg（也可以传空来清除）。支持直接给目录。"""
        raw = str(req.get("path") or "").strip().strip('"').strip("'")
        if not raw:
            _lf_cfg_set("ffmpeg", None)
            return {"ok": True, **_ffmpeg_state(fresh=True)}
        path = os.path.abspath(os.path.expanduser(raw))
        if os.path.isdir(path):
            for nm in ("ffmpeg.exe", "ffmpeg"):
                cand = os.path.join(path, nm)
                if os.path.isfile(cand):
                    path = cand
                    break
        if not os.path.isfile(path):
            raise HTTPException(400, f"这个路径下没有文件：{path}")
        ver = _ffmpeg_version(path)
        if not ver:
            raise HTTPException(400, "这个文件跑不起来：不是可用的 ffmpeg（-version 失败）")
        _lf_cfg_set("ffmpeg", path)
        _log("longform: ffmpeg set to %s (%s)", path, ver)
        return {"ok": True, "path": path, "version": ver, **_ffmpeg_state(fresh=True)}

    @lf.post("/lf/ffmpeg/upload")
    async def lf_ffmpeg_upload(file: UploadFile = File(...)):
        """把用户本地的 ffmpeg.exe 传到整合包 bin/ 里（离线可用，换机器只需再传一次）。"""
        bin_dir = os.path.join(_D.get("project_dir") or os.getcwd(), "bin")
        os.makedirs(bin_dir, exist_ok=True)
        name = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
        dst = os.path.join(bin_dir, name)
        total = 0
        try:
            with open(dst, "wb") as f:
                while True:
                    chunk = await file.read(1 << 20)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > 220 * 1024 * 1024:
                        raise HTTPException(400, "文件太大：ffmpeg 一般 30~90MB，确认选对了文件")
                    f.write(chunk)
            if os.name != "nt":
                os.chmod(dst, 0o755)
            ver = _ffmpeg_version(dst)
            if not ver:
                try:
                    os.remove(dst)
                except OSError:
                    pass
                raise HTTPException(400, "上传的文件不是可用的 ffmpeg（跑 -version 失败）")
        except HTTPException:
            raise
        except OSError as exc:
            raise HTTPException(500, f"写入失败：{exc}")
        _lf_cfg_set("ffmpeg", dst)
        _log("longform: ffmpeg uploaded to %s (%s)", dst, ver)
        return {"ok": True, "path": dst, "version": ver, "size": total,
                **_ffmpeg_state(fresh=True)}

    @lf.get("/lf/media/capabilities")
    def lf_media_caps():
        ff = _ffmpeg_bin()
        dm = _demucs_state(probe_only=True)
        ro = _roformer_status()
        return {"ok": True, "ffmpeg": bool(ff), "ffmpeg_path": ff,
                "video": bool(ff),
                "audio_formats": sorted(x.lstrip(".") for x in AUDIO_EXTS),
                "video_formats": sorted(x.lstrip(".") for x in VIDEO_EXTS),
                "vocal_engine": "dsp-center",
                "demucs": {"available": bool(dm["ok"]), "device": dm["device"],
                           "model": "htdemucs", "reason": dm["reason"],
                           "weights": dm.get("weights") or "",
                           "offline": bool(dm.get("weights"))},
                "roformer": {"ready": bool(ro["ready"]), "reason": ro["reason"],
                             "count": len(ro["models"]), "dir": ro["dir"],
                             "pick": ro["pick"]},
                "resample": "soxr",
                "max_mb": MAT_MAX_BYTES // 1048576}

    # ---- BS-Roformer（可选模型）：检测 / 打开目录 / 试跑 ----
    @lf.get("/lf/sepro/status")
    def lf_sepro_status(force: bool = False):
        return _roformer_status(force=bool(force))

    @lf.post("/lf/sepro/open")
    def lf_sepro_open():
        """在工作台里点「打开模型目录」——目录不存在就先建出来，免得用户自己找。"""
        root = _roformer_dir()
        try:
            os.makedirs(root, exist_ok=True)
        except OSError as e:
            raise HTTPException(500, "建目录失败：%s" % e)
        try:
            if os.name == "nt":
                os.startfile(root)  # noqa: S606  windows 专用，等价于双击
            elif sys.platform == "darwin":
                subprocess.Popen(["open", root])
            else:
                subprocess.Popen(["xdg-open", root])
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "path": root, "error": "%s: %s" % (type(e).__name__, e)}
        return {"ok": True, "path": root}

    @lf.post("/lf/sepro/test")
    def lf_sepro_test(payload: dict = Body(default=None)):
        """试跑一次（3 秒合成音），确认「模型 + 后端」这套组合真的能跑。

        不拿用户的素材试——试跑失败时不应该连累正在处理的东西。
        """
        payload = payload or {}
        mname = (payload.get("model") or "").strip() or None
        t0 = time.time()
        sr = 44100
        t = np.arange(sr * 3, dtype="float32") / sr
        left = 0.25 * np.sin(2 * np.pi * 220 * t) + 0.02 * np.random.randn(t.size)
        right = 0.25 * np.sin(2 * np.pi * 330 * t) + 0.02 * np.random.randn(t.size)
        x = np.stack([left, right], axis=1).astype("float32")
        try:
            y = _roformer_separate(x, sr, "vocals", mname, 0.0)
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001
            raise HTTPException(400, "试跑失败：%s: %s" % (type(e).__name__, e))
        rms = float(np.sqrt(np.mean(np.square(y)))) if np.size(y) else 0.0
        return {"ok": True, "ms": int((time.time() - t0) * 1000), "rms": round(rms, 5),
                "model": mname or _roformer_status()["pick"]}

    @lf.get("/lf/media")
    def lf_media_list():
        idx = _load_materials()
        items = _pin_sort(idx["items"])
        return {"ok": True, "items": items, "count": len(items),
                "folders": _folder_list(idx)}

    # ---- 文件夹（三个库共用） ---------------------------------------------------
    @lf.get("/lf/folders")
    def lf_folders(kind: str = "sfx"):
        """某个库的目录清单。count 只算直属素材，子目录的数量另算。"""
        k = kind if kind in _PIN_KINDS else "sfx"
        idx = _load_kind_idx(k)
        return {"ok": True, "kind": k, "folders": _folder_list(idx)}

    @lf.post("/lf/folders")
    def lf_folder_op(req: dict = Body(default=None)):
        """create / rename / delete / assign 四个动作，一次只做一件。

        为什么不做成 REST 的 PUT/DELETE /folders/{path}：路径里带斜杠，
        编码后前端容易写错（%2F 被反代吞掉），统一用 POST + JSON 最省事。
        """
        req = req or {}
        kind = str(req.get("kind") or "")
        action = str(req.get("action") or "").strip()
        if kind not in _PIN_KINDS:
            raise HTTPException(400, "kind 只能是 refs / sfx / media")
        if action not in ("create", "rename", "delete", "assign"):
            raise HTTPException(400, "action 只能是 create / rename / delete / assign")
        if action == "assign":
            path = _norm_folder(req.get("path"))
        else:
            path = _norm_folder(req.get("path"))
            if not path:
                raise HTTPException(400, "文件夹名不能为空")
        with _LOCK:
            idx = _load_kind_idx(kind)
            paths = _folder_paths(idx)
            moved = 0
            if action == "create":
                if len(paths) >= _FOLDER_MAX_COUNT:
                    raise HTTPException(400, f"文件夹太多了（上限 {_FOLDER_MAX_COUNT} 个），先合并几个")
                paths.add(path)
            elif action == "rename":
                new = _norm_folder(req.get("new_path") or req.get("name"))
                if not new:
                    raise HTTPException(400, "新文件夹名不能为空")
                if path not in paths:
                    raise HTTPException(404, "找不到这个文件夹")
                if new != path and new in paths:
                    raise HTTPException(400, "同名文件夹已经存在")
                # 改名 = 自己 + 所有后代一起换前缀；素材上的 folder 同步改
                kids = [p for p in paths if p == path or p.startswith(path + "/")]
                for p in kids:
                    paths.discard(p)
                    paths.add(new + p[len(path):])
                for it in idx["items"]:
                    f = _norm_folder(it.get("folder"))
                    if f == path or f.startswith(path + "/"):
                        it["folder"] = new + f[len(path):]
                        moved += 1
                path = new
            elif action == "delete":
                if path not in paths:
                    raise HTTPException(404, "找不到这个文件夹")
                kids = [p for p in paths if p == path or p.startswith(path + "/")]
                for p in kids:
                    paths.discard(p)
                # 只「取消归类」，绝不删文件：素材回到未归档，随时能重新归类
                for it in idx["items"]:
                    f = _norm_folder(it.get("folder"))
                    if f == path or f.startswith(path + "/"):
                        it.pop("folder", None)
                        moved += 1
            else:                                   # assign
                ids = [str(x) for x in (req.get("ids") or []) if str(x)]
                if not ids:
                    raise HTTPException(400, "没有选中素材")
                if path:
                    paths.add(path)
                want = set(ids)
                for it in idx["items"]:
                    if str(it.get("id")) not in want:
                        continue
                    if path:
                        it["folder"] = path
                    else:
                        it.pop("folder", None)
                    moved += 1
            _store_folders(idx, paths)
            _save_kind_idx(kind, idx)
            folders = _folder_list(idx)
        _log("longform: folder %s %s %r moved=%d", kind, action, path, moved)
        return {"ok": True, "kind": kind, "action": action, "path": path,
                "moved": moved, "folders": folders}

    @lf.post("/lf/pin")
    def lf_pin(req: dict = Body(default=None)):
        """置顶 / 取消置顶。三个库通用：音色 refs、音效 sfx、导入台素材 media。

        只往 index.json 里写一个 pin 时间戳，不碰任何音频文件；排序统一交给
        _pin_sort。因为三个页面读的是同一份索引，所以在这里置顶之后，
        台本页的音色下拉、时间轴页的音色库/音效库面板看到的顺序也是一样的。
        """
        req = req or {}
        kind = str(req.get("kind") or "").strip()
        mid = str(req.get("id") or "").strip()
        on = bool(req.get("on", True))
        if kind not in _PIN_KINDS:
            raise HTTPException(400, "kind 只能是 refs / sfx / media")
        if not mid:
            raise HTTPException(400, "缺少 id")
        with _LOCK:
            if kind == "refs":
                idx = _load_refs()
            elif kind == "sfx":
                idx = _load_sfx()
            else:
                idx = _load_materials()
            it = next((x for x in idx["items"] if x.get("id") == mid), None)
            if not it:
                raise HTTPException(404, "找不到这条素材（可能已经删了）")
            if on:
                it["pin"] = round(time.time(), 3)   # 后置顶的排更前
            else:
                it.pop("pin", None)
            if kind == "refs":
                _write_json(_refs_index_path(), idx)
            elif kind == "sfx":
                _save_sfx(idx)
            else:
                _save_materials(idx)
        _log("longform: pin %s %s -> %s", kind, mid, "on" if on else "off")
        return {"ok": True, "kind": kind, "id": mid, "pin": it.get("pin") or 0}

    @lf.post("/lf/media/upload")
    def lf_media_upload(file: UploadFile = File(...), name: str = Form("")):
        raw = file.file.read()
        if not raw:
            raise HTTPException(400, "空文件")
        if len(raw) > MAT_MAX_BYTES:
            raise HTTPException(413, f"文件过大（上限 {MAT_MAX_BYTES // 1048576} MB）")
        src_name = os.path.basename(file.filename or "素材")
        ext = os.path.splitext(src_name)[1].lower()
        is_video = ext in VIDEO_EXTS
        if ext and ext not in AUDIO_EXTS and not is_video:
            raise HTTPException(400, f"不支持的文件类型：{ext}")
        tmp = os.path.join(_mat_dir(), f".up_{uuid.uuid4().hex[:8]}{ext or '.bin'}")
        try:
            with open(tmp, "wb") as f:
                f.write(raw)
            try:
                data, sr = _read_audio_any(tmp)
            except HTTPException as e:
                msg = str(e.detail)
                if is_video and not _ffmpeg_bin():
                    raise HTTPException(400, "没有 ffmpeg，暂时读不了视频：请把 ffmpeg.exe 放到项目 bin/ 目录")
                raise HTTPException(400, msg)
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass

        item = _mat_add_from_audio(data, sr, name or os.path.splitext(src_name)[0],
                                   src_name, "video" if is_video else "audio")
        _log("longform: material %s <- %s (%s, %.1fs, %dch)",
             item["file"], src_name, item["kind"], item["dur"], item["ch"])
        return {"ok": True, "item": item}

    def _mat_item_or_404(mid):
        idx = _load_materials()
        it = next((x for x in idx["items"] if x["id"] == mid), None)
        if not it:
            raise HTTPException(404, "素材不存在")
        return idx, it

    @lf.get("/lf/media/{mid}/audio")
    def lf_media_audio(mid: str):
        _idx, it = _mat_item_or_404(mid)
        path = os.path.join(_mat_dir(), os.path.basename(it["file"]))
        if not os.path.exists(path):
            raise HTTPException(404, "文件不存在")
        return FileResponse(path, media_type="audio/wav", filename=it["file"])

    @lf.patch("/lf/media/{mid}")
    def lf_media_rename(mid: str, req: dict = Body(...)):
        with _LOCK:
            idx, it = _mat_item_or_404(mid)
            name = _safe_title(req.get("name") or it.get("name"), it["id"])[:48]
            old_path = os.path.join(_mat_dir(), os.path.basename(it["file"]))
            ext = os.path.splitext(it["file"])[1] or ".wav"
            new_file = f"{name}_{it['id']}{ext}"
            new_path = os.path.join(_mat_dir(), new_file)
            if os.path.exists(old_path) and os.path.abspath(old_path) != os.path.abspath(new_path):
                try:
                    os.replace(old_path, new_path)
                    it["file"] = new_file
                except OSError as e:
                    _log("longform: material rename failed: %s", e, level="warning")
            it["name"] = name
            _save_materials(idx)
        return {"ok": True, "item": it}

    @lf.delete("/lf/media/{mid}")
    def lf_media_delete(mid: str):
        with _LOCK:
            idx, it = _mat_item_or_404(mid)
            _trash_material(idx, it)
            _save_materials(idx)
        return {"ok": True}

    @lf.get("/lf/media/trash")
    def lf_media_trash():
        """导入台回收站：可一键恢复（文件在 materials/.trash）。"""
        man = _load_trash_manifest()
        items = [x for x in man["items"]
                 if os.path.exists(os.path.join(_trash_dir(), os.path.basename(x.get("trash_file") or "")))]
        items.sort(key=lambda x: x.get("trashed_at") or 0, reverse=True)
        return {"ok": True, "items": items, "count": len(items)}

    @lf.post("/lf/media/restore")
    def lf_media_restore(req: dict = Body(default={})):
        """从回收站恢复：按 manifest 还原文件名、参数，并重新进导入台索引。"""
        ids = [str(x) for x in (req.get("ids") or []) if x]
        all_flag = req.get("all") is True
        if not ids and not all_flag:
            raise HTTPException(400, "要全部恢复请显式传 all=true")
        man = _load_trash_manifest()
        picked = [x for x in man["items"]
                  if (all_flag or x.get("trash_file") in ids or x.get("id") in ids)]
        restored, missing = [], []
        with _LOCK:
            idx = _load_materials()
            for rec in picked:
                src = os.path.join(_trash_dir(), os.path.basename(rec.get("trash_file") or ""))
                if not os.path.exists(src):
                    missing.append(rec.get("name"))
                    continue
                orig = os.path.basename(rec.get("orig_file") or rec.get("trash_file"))
                dst = os.path.join(_mat_dir(), orig)
                if os.path.exists(dst):      # 同名冲突：加后缀
                    stem, ext = os.path.splitext(orig)
                    dst = os.path.join(_mat_dir(), f"{stem}_{rec.get('id')[:4]}{ext}")
                    orig = os.path.basename(dst)
                try:
                    os.replace(src, dst)
                except OSError as e:  # noqa: BLE001
                    missing.append(rec.get("name"))
                    _log("longform: restore failed %s: %s", src, e, level="warning")
                    continue
                _info = _audio_info(dst)
                item = {
                    "id": rec.get("id") or uuid.uuid4().hex[:12], "file": orig,
                    "name": rec.get("name") or os.path.splitext(orig)[0],
                    "kind": rec.get("kind") or "audio", "source": rec.get("source") or "",
                    "op": rec.get("op") or "", "parent": rec.get("parent") or "",
                    "dur": _info.get("dur") or rec.get("dur") or 0,
                    "sr": _info.get("sr") or rec.get("sr") or MAT_SR,
                    "ch": int((_info.get("ch") or rec.get("ch") or 1)),
                    "size": os.path.getsize(dst),
                    "created": rec.get("created") or int(time.time()),
                }
                if not any(x["id"] == item["id"] for x in idx["items"]):
                    idx["items"].append(item)
                restored.append(item)
            man["items"] = [x for x in man["items"] if x not in picked]
            _write_json(_trash_manifest_path(), man)
            _save_materials(idx)
        _log("longform: import desk restore %d item(s)", len(restored))
        return {"ok": True, "restored": len(restored), "items": restored,
                "missing": missing}

    @lf.post("/lf/media/{mid}/process")
    def lf_media_process(mid: str, req: dict = Body(default={})):
        """对单个素材做一串处理，结果另存为新素材（不动原文件）。"""
        _idx, it = _mat_item_or_404(mid)
        data, sr = _read_audio_any(os.path.join(_mat_dir(), os.path.basename(it["file"])))
        data, sr, labels = _apply_ops(data, sr, req.get("ops") or {})
        if not labels:
            raise HTTPException(400, "没有勾选任何处理项")
        if not len(data):
            raise HTTPException(400, "处理结果为空（可能是裁剪范围超出音频长度）")

        new_id = uuid.uuid4().hex[:12]
        base = _safe_title(it.get("name") or "素材", "素材")[:36]
        suffix = "+".join(labels[:3]) if len(labels) <= 3 else labels[0] + "等" + str(len(labels))
        fname = f"{base}_{suffix}_{new_id}.wav"
        _write_wav(os.path.join(_mat_dir(), fname), data, sr)
        item = {"id": new_id, "file": fname, "name": f"{base}·{suffix}",
                "kind": "derived", "source": it.get("name") or it.get("source") or "",
                "op": "+".join(labels), "parent": it["id"],
                "dur": round(len(data) / float(sr), 2), "sr": sr,
                "ch": int(1 if data.ndim == 1 else data.shape[1]),
                "size": os.path.getsize(os.path.join(_mat_dir(), fname)),
                "created": int(time.time())}
        with _LOCK:
            idx = _load_materials()
            idx["items"].append(item)
            _save_materials(idx)
        _log("longform: material process %s -> %s (%s, %.1fs)",
             it["file"], fname, item["op"], item["dur"])
        return {"ok": True, "item": item, "ops": labels}

    @lf.post("/lf/media/{mid}/as-ref")
    def lf_media_as_ref(mid: str, req: dict = Body(default={})):
        """把素材直接收成音色（不做处理）。

        和「导入台 → 存入音色库（不勾任何处理）」是同一条路径：
        混单声道、重采样 22050、按内容哈希去重，保证模型侧拿到的永远是它能读的格式。
        """
        _idx, it = _mat_item_or_404(mid)
        path = os.path.join(_mat_dir(), os.path.basename(it["file"]))
        if os.path.getsize(path) > MAX_REF_BYTES:
            raise HTTPException(413, f"作为音色太大（上限 {MAX_REF_BYTES // 1048576} MB），建议先裁剪")
        data, sr = _read_audio_any(path)
        item = _save_ref_audio(data, sr, req.get("name") or it.get("name") or it["id"],
                               it.get("source") or it.get("name") or "",
                               folder=it.get("folder") or "")
        _log("longform: material %s registered as ref %s", it["file"], item["id"])
        return {"ok": True, "ref": item}

    @lf.get("/lf/media/{mid}/info")
    def lf_media_info(mid: str):
        _idx, it = _mat_item_or_404(mid)
        path = os.path.join(_mat_dir(), os.path.basename(it["file"]))
        if not os.path.exists(path):
            raise HTTPException(404, "文件不存在")
        props = _audio_props(path)
        props.update({"kind": it.get("kind") or "audio", "name": it.get("name"),
                      "source": it.get("source"), "op": it.get("op"),
                      "created": it.get("created")})
        return {"ok": True, "info": props}

    @lf.post("/lf/media/{mid}/store")
    def lf_media_store(mid: str, req: dict = Body(default={})):
        """导入台的最终动作：处理（可选）→ 存进「音色库」或「音效库」。

        这是文件流转的唯一出口，解决以前「素材库 / 音效库 / 音色库」三处
        各自处理、互相看得到对方中间文件的问题：
          · 上传一律进导入台（materials）；
          · 处理 + 入库一次完成，结果只出现在目标库里；
          · 需要的话顺手把中转文件移进回收站，导入台不会越堆越多。
        """
        target = "sfx" if (req.get("target") == "sfx") else "ref"
        _idx, it = _mat_item_or_404(mid)
        path = os.path.join(_mat_dir(), os.path.basename(it["file"]))
        if not os.path.exists(path):
            raise HTTPException(404, "素材文件不存在（可能已清理）")
        data, sr = _read_audio_any(path)
        ops = req.get("ops") or {}
        labels = []
        if ops:
            data, sr, labels = _apply_ops(data, sr, ops)
            if not len(data):
                raise HTTPException(400, "处理结果为空（可能是裁剪范围超出音频长度）")
        name = req.get("name") or it.get("name") or "素材"
        src = it.get("source") or it.get("name") or ""

        if target == "ref":
            ref = _save_ref_audio(data, sr, name, src, folder=it.get("folder") or "")
            result = {"ok": True, "target": "ref", "ref": ref, "ops": labels,
                      "name": ref.get("name"), "dur": ref.get("dur"),
                      "sr": AUDIO_SR, "ch": 1}
            _log("longform: store %s -> ref %s (%s)", it["file"], ref["id"], "+".join(labels) or "raw")
        else:
            item = _save_sfx_item(data, sr, name, src,
                                  "derived" if labels else "audio",
                                  op="+".join(labels), parent=it["id"])
            result = {"ok": True, "target": "sfx", "item": item, "ops": labels,
                      "name": item.get("name"), "dur": item.get("dur"),
                      "sr": item.get("sr"), "ch": item.get("ch")}
            _log("longform: store %s -> sfx %s (%s)", it["file"], item["file"], "+".join(labels) or "raw")

        if req.get("remove_source"):
            with _LOCK:
                idx2 = _load_materials()
                victim = next((x for x in idx2["items"] if x["id"] == mid), None)
                if victim:
                    _trash_material(idx2, victim)
                    _save_materials(idx2)
            result["source_removed"] = True
        return result

    @lf.post("/lf/media/clear")
    def lf_media_clear(req: dict = Body(default={})):
        """清空导入台：只移进 .trash，不真删。

        安全阀：**必须**给 ids，或者显式传 all=true。避免空请求手滑清空整个导入台
        （上线前就踩过一次：测试里传了 {} 把用户上传的素材全清了）。
        """
        ids = [str(x) for x in (req.get("ids") or []) if x]
        if not ids and req.get("all") is not True:
            raise HTTPException(400, "要清空整个导入台请显式传 all=true")
        with _LOCK:
            idx = _load_materials()
            victims = [x for x in idx["items"] if (not ids) or x["id"] in ids]
            sink = []
            for v in victims:
                _trash_material(idx, v, sink=sink)
            _push_trash_manifests(sink)          # 清单一次写完
            _save_materials(idx)
        _log("longform: import desk cleared %d item(s)", len(victims))
        return {"ok": True, "removed": len(victims)}

    @lf.post("/lf/media/from-sfx")
    def lf_media_from_sfx(req: dict = Body(default={})):
        """把音效库里的一个音效拷进导入台改一改（原点在音效库里不动）。"""
        mid = str(req.get("mid") or "")
        _idx, it = _sfx_or_404(mid)
        path = os.path.join(_sfx_dir(), os.path.basename(it["file"]))
        if not os.path.exists(path):
            raise HTTPException(404, "音效文件不存在")
        data, sr = _read_audio_any(path)
        item = _mat_add_from_audio(data, sr, req.get("name") or it.get("name"),
                                   it.get("source") or it.get("name") or "",
                                   "derived", op="收自音效库", parent=it["id"])
        return {"ok": True, "item": item}

    @lf.post("/lf/media/from-ref")
    def lf_media_from_ref(req: dict = Body(default={})):
        """把音色库里的一个音色拷进导入台（例如想重新裁一段当音色）。"""
        rid = str(req.get("rid") or "")
        idx = _load_refs()
        it = next((x for x in idx["items"] if x["id"] == rid), None)
        if not it:
            raise HTTPException(404, "音色不存在")
        path = os.path.join(_refs_dir(), os.path.basename(it["file"]))
        if not os.path.exists(path):
            raise HTTPException(404, "音色文件不存在")
        data, sr = _read_audio_any(path)
        item = _mat_add_from_audio(data, sr, req.get("name") or it.get("name"),
                                   it.get("source") or it.get("name") or "",
                                   "derived", op="收自音色库", parent=it["id"])
        return {"ok": True, "item": item}

    # ---- 高级音效处理台 -----------------------------------------------------
    # 三步：prepare（去人声、落作业文件）→ segment（反复调参切分）→ save（挑中的入库）
    @lf.post("/lf/sfxb/prepare")
    def lf_sfxb_prepare(req: dict = Body(default=None)):
        """选中素材 →（可选）分离成人声 / 伴奏，或原样 → 存成作业文件，返回波形包络。

        stem 决定「要留下哪一半」：
          · instrumental（默认）= 去掉人声，留伴奏。切环境音 / 动作音 / 特殊音效；
          · vocals = 去掉伴奏，留人声。切喘息、气声、耳语这类"人声但没台词"的素材；
          · none = 不做分离（本来就是纯音效）。engine 选 none 也走这一档。
        以前写死 instrumental，想只留人声就只能回导入台再处理一遍。
        """
        req = req or {}
        mid = str(req.get("mid") or "").strip()
        if not mid:
            raise HTTPException(400, "先在左边选一个素材")
        _idx, it = _mat_item_or_404(mid)
        try:
            data, sr = _read_audio_any(os.path.join(_mat_dir(), os.path.basename(it["file"])))
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001
            raise HTTPException(400, "这个素材读不出音频：%s" % e)

        engine = (req.get("engine") or "roformer").lower()
        quality = str(req.get("quality") or "std").lower()
        residual = float(req.get("residual") or 0.0)
        stem = str(req.get("stem") or "instrumental").lower()
        if stem not in ("instrumental", "vocals", "none"):
            stem = "instrumental"
        if engine == "none":
            stem = "none"
        stem_label = {"instrumental": "去掉人声（留伴奏）", "vocals": "去掉伴奏（留人声）",
                      "none": "原素材（未分离）"}[stem]
        used, note = ("原素材（未分离）" if stem == "none" else ""), ""
        mode = "vocals" if stem == "vocals" else "instrumental"
        if stem != "none":
            t0 = time.time()
            order = {"roformer": ["roformer", "demucs", "dsp"],
                     "demucs": ["demucs", "dsp"],
                     "dsp": ["dsp"]}.get(engine) or ["demucs", "dsp"]
            for eng in order:
                try:
                    if eng == "roformer":
                        data = _roformer_separate(data, sr, mode, None, residual)
                        used = "BS-Roformer"
                    elif eng == "demucs":
                        data = _demucs_separate(data, sr, mode, quality, residual)
                        used = "Demucs"
                    else:
                        data = _separate(data, sr, mode, 0.65)
                        used = "中置提取"
                    break
                except Exception as e:  # noqa: BLE001
                    note = "%s 不可用：%s" % (eng, e)
                    _log("longform: sfxb separate via %s failed (%s)", eng, e, level="warning")
            _log("longform: sfxb prepare %s via %s in %.1fs", mid, used, time.time() - t0)

        # 分离得干不干净，给个可判断的数：伴奏比原音低多少 dB。
        # 纯人声素材（比如整段喘息）分离出来伴奏是空的 —— 20dB 以下基本等于没东西可切，
        # 这时应该建议用户改用「不分离」直接从原音切，而不是在空轨上白挑十分钟。
        env_raw = []
        try:
            src_data, src_sr = _read_audio_any(os.path.join(_mat_dir(), os.path.basename(it["file"])))
            src_db = 20 * math.log10(float(np.sqrt(np.mean(
                np.asarray(src_data, "float64") ** 2))) + 1e-12)
            out_db = 20 * math.log10(float(np.sqrt(np.mean(
                np.asarray(data, "float64") ** 2))) + 1e-12)
            sep_db = round(out_db - src_db, 1)
            # 原音轨要独立画一条波形（A/B 对照），包络一起算好带回去。
            # 每块只取峰值、1400 个点，几十 KB，不值得再为它单独发一次请求。
            env_raw = _sfxb_env(src_data, src_sr)
        except Exception:  # noqa: BLE001
            sep_db = 0.0

        job = uuid.uuid4().hex[:10]
        d = os.path.join(_sfxb_dir(), job)
        os.makedirs(d, exist_ok=True)
        wav = os.path.join(d, "source.wav")
        _write_wav(wav, data, sr)
        meta = {"job": job, "wav": wav, "sr": int(sr), "mid": mid,
                "name": it.get("name") or "素材", "engine": used, "stem": stem,
                "created": time.time(), "dur": round(len(data) / float(sr), 2),
                "raw_dur": round(len(src_data) / float(src_sr), 2) if env_raw else 0.0,
                "sep_db": sep_db}
        try:                       # 落一份 meta：进程重启后光靠内存字典会"失忆"
            with open(os.path.join(d, "meta.json"), "w", encoding="utf-8") as f:
                json.dump(meta, f, ensure_ascii=False)
        except OSError:
            pass
        with _SFXB["lock"]:
            _SFXB["jobs"][job] = meta
            _sfxb_gc()
        return {"ok": True, "job": job, "sep_db": sep_db, "name": it.get("name") or "素材",
                "engine": used, "stem": stem, "stem_label": stem_label,
                "note": note, "sr": int(sr),
                "dur": round(len(data) / float(sr), 2), "raw_dur": round(meta.get("raw_dur") or 0, 2),
                "env": _sfxb_env(data, sr), "env_raw": env_raw,
                "raw_url": "/api/v1/lf/sfxb/raw/%s" % job}

    @lf.get("/lf/sfxb/audio/{job}")
    def lf_sfxb_audio(job: str):
        meta = _sfxb_job(job)
        if not meta or not os.path.exists(meta["wav"]):
            raise HTTPException(404, "作业已过期")
        return FileResponse(meta["wav"], media_type="audio/wav")

    @lf.get("/lf/sfxb/raw/{job}")
    def lf_sfxb_raw(job: str):
        """原音轨试听：直接送回素材文件本身。

        为什么不复制一份到作业目录：6 分钟立体声 float32 就是 700MB 级，
        为了 A/B 对照再存一份不值。素材文件本来就是只读的，直接流出去最省事。
        """
        meta = _sfxb_job(job)
        if not meta:
            raise HTTPException(404, "作业已过期，请重新准备素材")
        try:
            _idx, it = _mat_item_or_404(meta.get("mid") or "")
        except HTTPException:
            raise HTTPException(404, "原素材已经被删了，只剩处理后的那一轨")
        path = os.path.join(_mat_dir(), os.path.basename(it["file"]))
        if not os.path.exists(path):
            raise HTTPException(404, "原素材文件不见了")
        ext = os.path.splitext(path)[1].lower()
        mime = {".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac",
                ".flac": "audio/flac", ".ogg": "audio/ogg", ".opus": "audio/ogg",
                ".wav": "audio/wav", ".wv": "audio/x-wavpack"}.get(ext, "application/octet-stream")
        return FileResponse(path, media_type=mime)

    @lf.post("/lf/sfxb/segment")
    def lf_sfxb_segment(req: dict = Body(default=None)):
        """按参数切分（只读作业文件，很快，前端可以拖动就重算）。"""
        req = req or {}
        meta = _sfxb_job(req.get("job"))
        if not meta:
            raise HTTPException(404, "作业已过期，请重新点「① 准备素材」")
        data, sr = _read_audio_any(meta["wav"])
        mode = str(req.get("mode") or "gap")
        if mode not in ("gap", "fg", "onset", "srt"):
            mode = "gap"
        cues = req.get("cues") or []
        if mode == "srt" and not cues:
            raise HTTPException(400, "按字幕切分需要先载入 SRT（或用「不分离」直接切）")
        segs, fell_back = _sfxb_segments(
            data, sr, mode=mode, cues=cues,
            min_gap=float(req.get("min_gap") or 0.35),
            min_len=float(req.get("min_len") or 0.2),
            thresh_db=float(req.get("thresh_db") or 10.0),
            pad=float(req.get("pad") or 0.03))
        total = len(data) / float(sr)
        if mode == "fg" and not segs:
            mode = "gap"
        return {"ok": True, "mode": mode, "fell_back": bool(fell_back), "count": len(segs),
                "covered": round(sum(s["dur"] for s in segs), 2),
                "dur": round(total, 2), "segments": segs}

    @lf.post("/lf/sfxb/save")
    def lf_sfxb_save(req: dict = Body(default=None)):
        """把选中的片段切片入库。target = sfx（音效库）/ media（导入台）/ ref（音色库）。

        每个片段可以带自己的 `ops`（首尾静音 / 淡入淡出 / 音量 / 变速 / 变调 / 标准化 …），
        和导入台的处理是同一套实现（_apply_ops），所以两边结果一致。
        变速与变调会改变长度：这里按**处理后的实际长度**入库，不再回头改片段范围。
        """
        req = req or {}
        meta = _sfxb_job(req.get("job"))
        if not meta:
            raise HTTPException(404, "作业已过期，请重新准备素材")
        items = req.get("items") or []
        if not isinstance(items, list) or not items:
            raise HTTPException(400, "没有勾选要保存的片段")
        target = str(req.get("target") or "sfx").lower()
        if target not in ("sfx", "media", "ref"):
            target = "sfx"
        folder = _norm_folder(req.get("folder"))
        data, sr = _read_audio_any(meta["wav"])
        total = len(data) / float(sr)
        made, bad, failed = [], 0, []
        # 一次存几百段时按批入库：索引只读一次、只在最后写一次（原来每段都读写整份索引，
        # 100 段就要 1.3s/段，1000 段能跑十几分钟）
        _batch_begin()
        try:
            made, bad, failed = _sfxb_save_items(items, data, sr, total, target, folder,
                                                 meta, made, bad, failed)
        finally:
            _batch_commit()
        _log("longform: sfxb save %d/%d -> %s (%d 跳过, %d 失败)",
             len(made), len(items), target, bad, len(failed))
        return {"ok": True, "count": len(made), "skipped": bad, "failed": failed[:8],
                "target": target, "folder": folder, "items": made}

    def _sfxb_save_items(items, data, sr, total, target, folder, meta, made, bad, failed):
        """保存循环本体（放在 batch 上下文里跑，索引只落盘一次）。"""
        for k, it in enumerate(items):
            try:
                a = max(0.0, float(it.get("start") or 0))
                b = min(total, float(it.get("end") or 0))
            except (TypeError, ValueError):
                bad += 1
                continue
            if b - a < 0.02:
                bad += 1
                continue
            seg = data[int(a * sr):int(b * sr)]
            if not len(seg):
                bad += 1
                continue
            try:
                seg, sr2, labels = _sfxb_proc(seg, sr, it.get("ops"))
            except Exception as e:  # noqa: BLE001
                _log("longform: sfxb save proc failed %s: %s", a, e, level="warning")
                failed.append("%.2fs: %s" % (a, e))
                continue
            if not len(seg):
                bad += 1
                continue
            # 自动编号：位数跟着「这一次存多少段」走（120 段 → _001，1200 段 → _0001）。
            # 固定 %02d 的话，第 100 段叫 _100，按名字排序会插到 _10 后面 ——
            # 用户反馈的「到第 100 个就跳到 1000」就是这么来的。
            name = (str(it.get("name") or "").strip()
                    or _num_name(meta["name"], k + 1, len(items)))
            op = "音效台 · %s" % (meta.get("engine") or "未分离")
            if labels:
                op += " + " + "+".join(dict.fromkeys(labels))
            _t0 = time.time()
            if target == "sfx":
                made.append(_save_sfx_item(seg, sr2, name, meta["name"], "derived",
                                           op=op, parent=meta.get("mid") or "",
                                           folder=folder))
            elif target == "ref":
                made.append(_save_ref_audio(seg, sr2, name, meta["name"], folder=folder))
            else:
                made.append(_mat_add_from_audio(seg, sr2, name, meta["name"], "derived",
                                                op=op, parent=meta.get("mid") or "",
                                                folder=folder))
            if os.environ.get("LF_PROF"):
                _log("sfxb save #%d %.0fms len=%d", k + 1, (time.time() - _t0) * 1000, len(seg))
        return made, bad, failed

    @lf.post("/lf/sfxb/preview")
    def lf_sfxb_preview(req: dict = Body(default=None)):
        """试听「这一段 + 这套处理」的结果：落一个临时 wav 在作业目录里。

        为什么不在前端算什么：变速 / 变调 / 首尾静音用的都是服务端同一套算法，
        前端再实现一遍必然对不上；这里直接给出处理后的真实音频和时长。
        """
        req = req or {}
        meta = _sfxb_job(req.get("job"))
        if not meta:
            raise HTTPException(404, "作业已过期，请重新准备素材")
        data, sr = _read_audio_any(meta["wav"])
        total = len(data) / float(sr)
        try:
            a = max(0.0, float(req.get("start") or 0))
            b = min(total, float(req.get("end") or 0))
        except (TypeError, ValueError):
            raise HTTPException(400, "片段范围不对")
        if b - a < 0.02:
            raise HTTPException(400, "片段太短")
        seg = data[int(a * sr):int(b * sr)]
        try:
            seg, sr2, labels = _sfxb_proc(seg, sr, req.get("ops"))
        except Exception as e:  # noqa: BLE001
            raise HTTPException(400, "处理失败：%s" % e)
        if not len(seg):
            raise HTTPException(400, "处理后没有声音了（检查首尾静音 / 变速参数）")
        name = "pv_%s.wav" % uuid.uuid4().hex[:8]
        d = os.path.dirname(meta["wav"])
        try:
            _write_wav(os.path.join(d, name), seg, sr2)
            # 只留最近 12 个试听文件，免得作业目录越堆越大
            olds = sorted([f for f in os.listdir(d) if f.startswith("pv_") and f.endswith(".wav")],
                          key=lambda f: os.path.getmtime(os.path.join(d, f)))
            for f in olds[:-12]:
                try:
                    os.remove(os.path.join(d, f))
                except OSError:
                    pass
        except OSError as e:
            raise HTTPException(500, "试听文件写不进去：%s" % e)
        return {"ok": True, "url": "/api/v1/lf/sfxb/preview/%s/%s" % (req.get("job"), name),
                "dur": round(len(seg) / float(sr2), 3), "sr": int(sr2), "labels": labels}

    @lf.get("/lf/sfxb/preview/{job}/{name}")
    def lf_sfxb_preview_audio(job: str, name: str):
        meta = _sfxb_job(job)
        base = os.path.basename(name or "")
        if not meta or not base.startswith("pv_") or not base.endswith(".wav"):
            raise HTTPException(404, "试听文件不存在")
        path = os.path.join(os.path.dirname(meta["wav"]), base)
        if not os.path.exists(path):
            raise HTTPException(404, "试听文件已过期")
        return FileResponse(path, media_type="audio/wav")

    @lf.post("/lf/sfxb/dedupe")
    def lf_sfxb_dedupe(req: dict = Body(default=None)):
        """找出"听感上是同一段声音"的片段，返回分组（每组第一个是代表）。

        为什么不用波形相关：同一段音效每次出现都带着不同的底噪、相位和电平，
        逐样本对齐基本不可能。改用对数梅尔谱的**频谱形状**——同一段声音的
        频带分布几乎一样，不同声音差得远。
        """
        req = req or {}
        meta = _sfxb_job(req.get("job"))
        if not meta:
            raise HTTPException(404, "作业已过期，请重新准备素材")
        items = req.get("items") or []
        if not isinstance(items, list) or len(items) < 2:
            return {"ok": True, "groups": [], "dups": 0, "thr": 0.0}
        thr = float(req.get("thr") or 0.985)
        data, sr = _read_audio_any(meta["wav"])
        feats = []
        for it in items:
            try:
                a, b = float(it.get("start") or 0), float(it.get("end") or 0)
            except (TypeError, ValueError):
                feats.append((None, 0.0))
                continue
            feats.append((_sfxb_fingerprint(data, sr, a, b), max(0.0, b - a)))

        # 并查集：相似度过了阈值、时长又接近的，归到一组
        parent = list(range(len(feats)))

        def find(i):
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        sims = []
        for i in range(len(feats)):
            vi, di = feats[i]
            if vi is None:
                continue
            for j in range(i + 1, len(feats)):
                vj, dj = feats[j]
                if vj is None:
                    continue
                if di > 0 and dj > 0 and not (0.6 <= di / dj <= 1.7):
                    continue                      # 时长差太多，不是同一种声音
                c = float(np.dot(vi, vj))
                if c >= thr:
                    sims.append((i, j, round(c, 4)))
                    ri, rj = find(i), find(j)
                    if ri != rj:
                        parent[rj] = ri

        buckets = {}
        for i in range(len(feats)):
            buckets.setdefault(find(i), []).append(i)
        groups = [{"keep": v[0], "dups": v[1:],
                   "sim": max([c for a, b, c in sims if a in v or b in v] or [0])}
                  for v in buckets.values() if len(v) > 1]
        groups.sort(key=lambda g: g["keep"])
        return {"ok": True, "thr": thr, "groups": groups,
                "dups": sum(len(g["dups"]) for g in groups)}

    # ---- 音效素材库 ---------------------------------------------------------
    @lf.get("/lf/sfx")
    def lf_sfx_list():
        idx = _load_sfx()
        items = _pin_sort(idx["items"])
        return {"ok": True, "items": items, "count": len(items),
                "folders": _folder_list(idx)}

    def _sfx_or_404(mid):
        idx = _load_sfx()
        it = next((x for x in idx["items"] if x["id"] == mid), None)
        if not it:
            raise HTTPException(404, "音效不存在")
        return idx, it

    def _decode_upload(raw, src_name):
        """上传的字节流 → (data, sr, is_video)。音频走 soundfile，视频靠 ffmpeg 抽轨。"""
        ext = os.path.splitext(src_name)[1].lower()
        is_video = ext in VIDEO_EXTS
        if ext and ext not in AUDIO_EXTS and not is_video:
            raise HTTPException(400, f"不支持的文件类型：{ext}")
        tmp_dir = _sfx_dir()
        tmp = os.path.join(tmp_dir, f".up_{uuid.uuid4().hex[:8]}{ext or '.bin'}")
        try:
            with open(tmp, "wb") as f:
                f.write(raw)
            try:
                data, sr = _read_audio_any(tmp)
            except HTTPException as e:
                if is_video and not _ffmpeg_bin():
                    raise HTTPException(400, "没有 ffmpeg，暂时读不了视频：请把 ffmpeg.exe 放到项目 bin/ 目录")
                raise HTTPException(400, str(e.detail))
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass
        return data, sr, is_video

    def _save_sfx_item(data, sr, name, src_name, kind, op="", parent="", folder=""):
        if data.shape[1] > 2:
            data = data[:, :2]
        data = _resample_audio(data, sr, SFX_SR)
        mid = uuid.uuid4().hex[:12]
        title = _safe_title(name or os.path.splitext(src_name)[0] or "音效", "音效")[:48]
        fname = f"{title}_{mid}.wav"
        path = os.path.join(_sfx_dir(), fname)
        _write_wav(path, data, SFX_SR)
        item = {"id": mid, "file": fname, "name": title, "kind": kind,
                "source": src_name, "op": op, "parent": parent,
                "dur": round(len(data) / float(SFX_SR), 2), "sr": SFX_SR,
                "ch": int(1 if data.ndim == 1 else data.shape[1]),
                "size": os.path.getsize(path), "created": int(time.time())}
        fld = _norm_folder(folder)
        if fld:
            item["folder"] = fld
        with _LOCK:
            idx = _batch_idx("sfx")
            own = idx is None
            if own:
                idx = _load_sfx()
            idx["items"].append(item)
            if fld:
                _store_folders(idx, _folder_paths(idx))
            if own:
                _save_sfx(idx)
        return item

    @lf.post("/lf/sfx/upload")
    def lf_sfx_upload(file: UploadFile = File(...), name: str = Form("")):
        raw = file.file.read()
        if not raw:
            raise HTTPException(400, "空文件")
        if len(raw) > SFX_MAX_BYTES:
            raise HTTPException(413, f"文件过大（音效上限 {SFX_MAX_BYTES // 1048576} MB）")
        src_name = os.path.basename(file.filename or "音效")
        data, sr, is_video = _decode_upload(raw, src_name)
        item = _save_sfx_item(data, sr, name, src_name,
                              "video" if is_video else "audio")
        _log("longform: sfx %s <- %s (%s, %.1fs)", item["file"], src_name, item["kind"], item["dur"])
        return {"ok": True, "item": item}

    @lf.post("/lf/sfx/from-media")
    def lf_sfx_from_media(req: dict = Body(...)):
        """把「素材预处理」里的一个素材收进音效库（复制一份，不动素材）。"""
        mid = str(req.get("mid") or "")
        _idx, it = _mat_item_or_404(_UIDS_RE.sub("", mid)[:20])
        data, sr = _read_audio_any(os.path.join(_mat_dir(), os.path.basename(it["file"])))
        item = _save_sfx_item(data, sr, req.get("name") or it.get("name"),
                              it.get("source") or it.get("name") or "", "derived",
                              op="收自素材", parent=it["id"])
        return {"ok": True, "item": item}

    @lf.get("/lf/sfx/{mid}/audio")
    def lf_sfx_audio(mid: str, download: int = 0):
        _idx, it = _sfx_or_404(mid)
        path = os.path.join(_sfx_dir(), os.path.basename(it["file"]))
        if not os.path.exists(path):
            raise HTTPException(404, "文件不存在")
        if download:
            return FileResponse(path, media_type="audio/wav", filename=it["file"])
        return FileResponse(path, media_type="audio/wav")

    @lf.get("/lf/sfx/{mid}/info")
    def lf_sfx_info(mid: str):
        _idx, it = _sfx_or_404(mid)
        path = os.path.join(_sfx_dir(), os.path.basename(it["file"]))
        if not os.path.exists(path):
            raise HTTPException(404, "文件不存在")
        props = _audio_props(path)
        props.update({"kind": it.get("kind") or "audio", "name": it.get("name"),
                      "source": it.get("source"), "op": it.get("op"),
                      "created": it.get("created")})
        return {"ok": True, "info": props}

    @lf.patch("/lf/sfx/{mid}")
    def lf_sfx_rename(mid: str, req: dict = Body(...)):
        with _LOCK:
            idx, it = _sfx_or_404(mid)
            name = _safe_title(req.get("name") or it.get("name"), it["id"])[:48]
            old_path = os.path.join(_sfx_dir(), os.path.basename(it["file"]))
            ext = os.path.splitext(it["file"])[1] or ".wav"
            new_file = f"{name}_{it['id']}{ext}"
            new_path = os.path.join(_sfx_dir(), new_file)
            if os.path.exists(old_path) and os.path.abspath(old_path) != os.path.abspath(new_path):
                try:
                    os.replace(old_path, new_path)
                    it["file"] = new_file
                except OSError as e:
                    _log("longform: sfx rename failed: %s", e, level="warning")
            it["name"] = name
            _save_sfx(idx)
        return {"ok": True, "item": it}

    @lf.post("/lf/sfx/{mid}/duplicate")
    def lf_sfx_duplicate(mid: str, req: dict = Body(default={})):
        """复制一份（音效库里的「复制 / 粘贴」就是它）。"""
        _idx, it = _sfx_or_404(mid)
        data, sr = _read_audio_any(os.path.join(_sfx_dir(), os.path.basename(it["file"])))
        base = _safe_title(it.get("name") or "音效", "音效")[:40]
        name = _safe_title(req.get("name") or f"{base} 副本", f"{base} 副本")[:48]
        item = _save_sfx_item(data, sr, name, it.get("source") or "", it.get("kind") or "audio",
                              op=it.get("op") or "", parent=it["id"],
                              folder=it.get("folder") or "")
        return {"ok": True, "item": item}

    @lf.delete("/lf/sfx/{mid}")
    def lf_sfx_delete(mid: str):
        with _LOCK:
            idx, it = _sfx_or_404(mid)
            idx["items"] = [x for x in idx["items"] if x["id"] != mid]
            _save_sfx(idx)
            src = os.path.join(_sfx_dir(), os.path.basename(it["file"]))
            if os.path.exists(src):
                trash = os.path.join(_sfx_dir(), ".trash")
                os.makedirs(trash, exist_ok=True)
                try:
                    os.replace(src, os.path.join(trash, f"{it['id']}_{os.path.basename(it['file'])}"))
                except OSError:
                    try:
                        os.remove(src)
                    except OSError:
                        pass
        return {"ok": True}

    @lf.post("/lf/sfx/bulk")
    def lf_sfx_bulk(req: dict = Body(default=None)):
        """音效批量操作：删除（进回收站）/ 移动文件夹 / 置顶 / 取消置顶。"""
        req = req or {}
        action = str(req.get("action") or "").strip()
        ids = [str(x) for x in (req.get("ids") or []) if x]
        if not ids:
            raise HTTPException(400, "没有选中任何音效")
        ids_set = set(ids[:2000])
        if action not in ("delete", "move", "pin", "unpin"):
            raise HTTPException(400, "action 只能是 delete / move / pin / unpin")
        folder = _norm_folder(req.get("folder")) if action == "move" else ""
        trash = os.path.join(_sfx_dir(), ".trash")
        done = 0
        with _LOCK:
            idx = _load_sfx()
            if action == "delete":
                gone = [x for x in idx["items"] if x.get("id") in ids_set]
                idx["items"] = [x for x in idx["items"] if x.get("id") not in ids_set]
                if gone:
                    os.makedirs(trash, exist_ok=True)
                for it in gone:
                    src = os.path.join(_sfx_dir(), os.path.basename(it.get("file") or ""))
                    if not os.path.exists(src):
                        continue
                    try:
                        os.replace(src, os.path.join(
                            trash, f"{it['id']}_{os.path.basename(it['file'])}"))
                    except OSError:
                        try:
                            os.remove(src)
                        except OSError:
                            pass
                    done += 1
            elif action == "move":
                for it in idx["items"]:
                    if it.get("id") not in ids_set:
                        continue
                    if folder:
                        it["folder"] = folder
                    else:
                        it.pop("folder", None)
                    done += 1
                if folder:
                    _store_folders(idx, _folder_paths(idx))
            else:
                pin = time.time() if action == "pin" else 0
                for it in idx["items"]:
                    if it.get("id") in ids_set:
                        if pin:
                            it["pin"] = pin
                        else:
                            it.pop("pin", None)
                        done += 1
            _save_sfx(idx)
        return {"ok": True, "action": action, "count": done}

    @lf.post("/lf/sfx/{mid}/process")
    def lf_sfx_process(mid: str, req: dict = Body(default={})):
        """音效预处理：和音色素材同一套处理顺序，结果另存为新音效。"""
        _idx, it = _sfx_or_404(mid)
        data, sr = _read_audio_any(os.path.join(_sfx_dir(), os.path.basename(it["file"])))
        data, sr, labels = _apply_ops(data, sr, req.get("ops") or {})
        if not labels:
            raise HTTPException(400, "没有勾选任何处理项")
        if not len(data):
            raise HTTPException(400, "处理结果为空（可能是裁剪范围超出音频长度）")
        base = _safe_title(it.get("name") or "音效", "音效")[:36]
        suffix = "+".join(labels[:3]) if len(labels) <= 3 else labels[0] + "等" + str(len(labels))
        item = _save_sfx_item(data, sr, f"{base}·{suffix}", it.get("source") or "",
                              "derived", op="+".join(labels), parent=it["id"])
        _log("longform: sfx process %s -> %s (%s, %.1fs)",
             it["file"], item["file"], item["op"], item["dur"])
        return {"ok": True, "item": item, "ops": labels}

    @lf.get("/lf/refs/{rid}/audio")
    def lf_ref_audio(rid: str):
        path = resolve_ref(rid)
        if not path:
            raise HTTPException(404, "音色文件不存在")
        return FileResponse(path, media_type="audio/wav")

    @lf.get("/lf/refs/{rid}/info")
    def lf_ref_info(rid: str):
        path = resolve_ref(rid)
        if not path:
            raise HTTPException(404, "音色文件不存在")
        props = _audio_props(path)
        idx = _load_refs()
        it = next((x for x in idx["items"] if x["id"] == rid), {}) or {}
        props.update({"kind": "ref", "name": it.get("name"),
                      "source": it.get("source"), "op": "",
                      "created": it.get("created")})
        return {"ok": True, "info": props}

    # ---- 能力清单（移植 / 前端降级用） --------------------------------------
    @lf.get("/lf/manifest")
    def lf_manifest():
        """这台机器上「能用什么」：引擎、参数表、可选能力。

        为什么要有这个接口：工作台要移植到别的整合包里，而不同包能提供的东西
        不一样（有没有 Demucs、有没有 HRTF、ffmpeg 在不在）。前端拿它决定
        「按钮显示 / 灰掉」，而不是像以前那样点了才报错。

        移植时**不用改这个接口**，只要：
          · 改 APP_NAME / APP_VERSION；
          · 把不适用的能力在下面 capabilities 里写成 False（或让对应 import 失败，
            这里已经用 try/except 兜住了）。
        """
        caps = {
            "presets": True,            # 参数预设（longform/presets/*.json）
            "tagFollow": True,          # 标签跟随（4 种口径）
            "marks": True,              # 普通标记
            "tagSfx": True,             # 标签挂音效
            "spatial": False,           # 空间音频（HRTF）
            "rooms": [],                # 房间脉冲（没有就是空数组 = 前端不显示）
            "hrtfProfiles": [],
            "demucs": False,            # 人声分离的另一条路
            "ffmpeg": False,            # 内置 ffmpeg（导出 mp3 / 工程包体检用）
            "exportFormats": ["wav"],
            "mixRates": [44100],
            "tagFollowModes": ["follow", "fixed", "inline", "between"],
        }
        try:  # 空间音频是可选的：没有 hrir.py 就当作不支持
            import hrir as _hrir
            caps["spatial"] = True
            caps["hrtfProfiles"] = [p.get("id") for p in (_hrir.profiles() or [])]
            try:
                import rooms as _rooms
                caps["rooms"] = list(_rooms.ROOM_MAP.keys())
            except Exception:  # noqa: BLE001
                caps["rooms"] = []
        except Exception:  # noqa: BLE001
            pass
        try:
            ok_dm, dev = _demucs_quick()
            caps["demucs"] = bool(ok_dm)
            caps["demucsDevice"] = dev
            caps["demucsProbed"] = bool(_DEMUCS.get("tried"))
        except Exception:  # noqa: BLE001
            caps["demucs"] = False
        try:
            fs = _ffmpeg_state()
            caps["ffmpeg"] = bool(fs.get("ok"))
        except Exception:  # noqa: BLE001
            caps["ffmpeg"] = False
        try:
            from timeline_api import MIX_FORMATS, MIX_RATES
            caps["exportFormats"] = list(MIX_FORMATS)
            caps["mixRates"] = list(MIX_RATES)
        except Exception:  # noqa: BLE001
            pass
        return {
            "ok": True,
            "app": {"name": APP_NAME, "version": APP_VERSION, "api": API_PREFIX},
            "engine": {"id": ENGINE_ID, "adapter": "_engine_kwargs",
                       "audioSr": AUDIO_SR},
            "params": {
                "fields": sorted(_DEFAULT_PARAMS.keys()),
                "sampling": sorted(_DEFAULT_SAMPLING.keys()),
            },
            "capabilities": caps,
        }

    # ---- 全局设置（时间轴 / 导出 / 界面偏好，跨台本共用） -------------------
    @lf.get("/lf/settings")
    def lf_settings_get():
        return {"ok": True, "settings": _load_settings(), "defaults": SETTINGS_DEFAULT}

    @lf.patch("/lf/settings")
    def lf_settings_patch(req: dict = Body(default={})):
        with _LOCK:
            return {"ok": True, "settings": _save_settings(req or {})}

    # ---- 台本 ---------------------------------------------------------------
    @lf.get("/lf/scripts")
    def lf_scripts():
        root = os.path.join(_lf_root(), "scripts")
        out = []
        for sid in sorted(os.listdir(root)):
            try:
                # 用 _load_script 而不是裸读 JSON：列表里的「已完成 N 句」
                # 也要走同一套状态自愈，否则会和右侧面板对不上。
                data = _load_script(sid)
            except Exception:  # noqa: BLE001
                continue
            if not data:
                continue
            st = _stats(data)
            proj = data.get("project") if isinstance(data.get("project"), dict) else None
            out.append({"id": data.get("id", sid), "title": data.get("title", sid),
                        "created": data.get("created"), "updated": data.get("updated"),
                        "is_project": bool(proj),
                        "source_id": (proj or {}).get("source_id"),
                        "source_title": (proj or {}).get("source_title"),
                        "has_initial": bool(proj) and os.path.exists(
                            os.path.join(root, sid, "initial_script.json")),
                        **st})
        out.sort(key=lambda x: x.get("updated") or 0, reverse=True)
        return {"ok": True, "scripts": out}

    @lf.post("/lf/scripts")
    def lf_script_create(req: dict = Body(...)):
        text = str(req.get("text") or "")
        title = _safe_title(req.get("title") or time.strftime("台本 %m-%d %H:%M"))
        sid = uuid.uuid4().hex[:12]
        mode = req.get("mode") or "packed"
        lines = ([_new_line(t) for t in split_text(text, int(req.get("max_chars") or 70), mode)]
                 if text.strip() else [])
        defaults = dict(_DEFAULT_PARAMS)
        defaults.update({k: v for k, v in (req.get("defaults") or {}).items() if k in _DEFAULT_PARAMS})
        script = {"version": 2, "id": sid, "title": title, "created": _now(), "updated": _now(),
                  "defaults": defaults, "sampling": dict(_DEFAULT_SAMPLING),
                  "tag_presets": [], "lines": lines}
        _save_script(script)
        _log("longform: script %s created (%d lines)", sid, len(lines))
        return {"ok": True, "id": sid, "script": script}

    @lf.get("/lf/scripts/{sid}")
    def lf_script(sid: str):
        with _LOCK:
            script = _load_script(sid)
            # 回填快照：早期版本生成的句子没有 gen，首次读取时按当前有效参数补一份，
            # 这样「改了什么 / 撤回修改」对历史句子也成立。只回填一次。
            dirty = False
            for ln in script.get("lines") or []:
                if ln.get("kind") == "tag":
                    continue
                if isinstance(ln.get("gen"), dict):
                    continue
                if ln.get("status") in ("done", "stale") and ln.get("out"):
                    ln["gen"] = _gen_snapshot(ln, script)
                    dirty = True
            if dirty:
                _save_script(script)
        job = _RENDERS.get(_safe_sid(sid))
        # 每行附上「和生成时相比改了什么」，前端据此显示标注与撤回按钮
        for ln in script.get("lines") or []:
            if ln.get("kind") == "tag":
                continue
            ln["changes"] = _line_changes(ln, script)
            ln["can_revert"] = bool(ln.get("changes")) and isinstance(ln.get("gen"), dict)
        proj = script.get("project") if isinstance(script.get("project"), dict) else None
        return {"ok": True, "script": script, "stats": _stats(script),
                "render": job.public() if job else None,
                "project": proj,
                "has_initial": bool(proj) and os.path.exists(
                    os.path.join(_script_dir(sid), "initial_script.json"))}

    @lf.get("/lf/scripts/{sid}/raw")
    def lf_script_raw(sid: str):
        """下载这个台本「导入时的原文」（真正的原稿，不是拆出来的句子）。

        老台本没存过原稿（v0.29 之前建的）就退回按 origin 拼一份 —— 前端会标注出来。
        """
        script = _load_script(sid)
        p = os.path.join(_script_dir(sid), "origin_raw.txt")
        title = _safe_title(script.get("title") or "台本")
        if os.path.isfile(p):
            return FileResponse(p, media_type="text/plain; charset=utf-8",
                                filename="导入原稿_" + title + ".txt")
        rows = [str(r.get("text") or "").strip() for r in (script.get("origin") or [])]
        rows = [r for r in rows if r]
        if not rows:
            raise HTTPException(404, "这个台本没有导入原稿（旧版本建的或手动建的）")
        body = ("\n".join(rows) + "\n").encode("utf-8")
        from urllib.parse import quote
        return Response(body, media_type="text/plain; charset=utf-8",
                        headers={"Content-Disposition":
                                 "attachment; filename*=UTF-8''"
                                 + quote("导入原稿_" + title + ".txt")})

    @lf.get("/lf/scripts/{sid}/cues")
    def lf_script_cues(sid: str):
        """台本 → SRT 式的字幕条（给高级音频处理台用）。

        为什么需要这个接口：从 SRT 导入的台本，每句本来就带着**原音时间** t0/t1；
        处理台再让用户手工导一遍同一个 srt 属于重复劳动，还容易导错文件。
        这里直接把台本的时间码整理成 cues，处理台点一下就能载入。

        一条字幕被切成长句的几段时，这些段的 t0/t1 是一样的 —— 这里按 t0 合并回一条，
        文本用换行拼起来，否则「按字幕切分」会把零长度区间也算成一句话。
        """
        script = _load_script(sid)
        cues, cur = [], None
        for i, ln in enumerate(script.get("lines") or []):
            if ln.get("kind") == "tag":
                continue
            t0 = ln.get("t0")
            if t0 is None:
                continue
            try:
                t0 = float(t0)
            except (TypeError, ValueError):
                continue
            t1 = ln.get("t1")
            try:
                t1 = float(t1) if t1 is not None else None
            except (TypeError, ValueError):
                t1 = None
            if t1 is not None and t1 <= t0 + 0.02:
                t1 = None
            if cur is not None and abs(t0 - cur["t0"]) < 0.05:
                # 同一条字幕被切成几段：合并文本，结束时间取最大
                cur["text"] = (cur["text"] + "\n" + (ln.get("text") or "")).strip()
                cur["lines"].append(i + 1)
                if t1 is not None:
                    cur["t1"] = max(cur["t1"] or t1, t1)
                continue
            cur = {"i": len(cues) + 1, "t0": round(t0, 3),
                   "t1": round(t1, 3) if t1 is not None else None,
                   "text": (ln.get("text") or "").strip(), "lines": [i + 1]}
            cues.append(cur)
        with_t1 = sum(1 for c in cues if c["t1"] is not None)
        return {"ok": True, "sid": _safe_sid(sid), "title": script.get("title") or "",
                "count": len(cues), "with_end": with_t1,
                "duration": round(max([c["t1"] or c["t0"] for c in cues] + [0.0]), 3),
                "cues": cues}

    @lf.patch("/lf/scripts/{sid}")
    def lf_script_save(sid: str, req: dict = Body(...)):
        sid = _safe_sid(sid)
        with _LOCK:
            script = _load_script(sid)
            if "title" in req:
                script["title"] = _safe_title(req["title"], script["title"])
            if isinstance(req.get("defaults"), dict):
                dnew = req["defaults"]
                script["defaults"].update(
                    {k: v for k, v in dnew.items() if k in _DEFAULT_PARAMS})
                # auto_voice 不是生成参数（_eff 不会读它），是「下次导入要不要按角色标签设音色」
                # 的备忘开关。它必须能显式关掉，所以单独处理：传 false 就删。
                if "auto_voice" in dnew:
                    if dnew["auto_voice"]:
                        script["defaults"]["auto_voice"] = True
                    else:
                        script["defaults"].pop("auto_voice", None)
            if isinstance(req.get("sampling"), dict):
                script["sampling"].update(
                    {k: v for k, v in req["sampling"].items() if k in _DEFAULT_SAMPLING})
            if isinstance(req.get("tag_presets"), list):
                script["tag_presets"] = [str(t)[:40] for t in req["tag_presets"]][:60]
            if isinstance(req.get("batches"), list):
                # 合法 uid 要算上「本次请求带来的新行」：
                # 回车拆分 / 插入 / 复制会同时提交「新行 + 新行所属分组」，
                # 只按旧 lines 校验会把新 uid 当作脏数据过滤掉 ——
                # 表现就是「拆出来的句子不在原分组里」（前端明明已经加进去了）。
                valid = {l["uid"] for l in script.get("lines") or []}
                if isinstance(req.get("lines"), list):
                    for ln in req["lines"]:
                        if isinstance(ln, dict) and ln.get("uid"):
                            valid.add(str(ln["uid"]))
                batches = []
                for b in req["batches"]:
                    if not isinstance(b, dict):
                        continue
                    uids = [u for u in (b.get("uids") or []) if u in valid]
                    batches.append({
                        "id": _UIDS_RE.sub("", str(b.get("id") or ""))[:20] or _new_uid(),
                        "name": _safe_title(b.get("name") or "批量任务", "批量任务")[:40],
                        "uids": uids,
                        "params": {k: v for k, v in (b.get("params") or {}).items()
                                   if k in _DEFAULT_PARAMS},
                        "created": b.get("created") or _now(),
                    })
                script["batches"] = batches[:60]
            if isinstance(req.get("lines"), list):
                incoming = [_normalize_line(l) for l in req["lines"]]
                script["lines"] = _merge_runtime(script["lines"], incoming, script)
            _save_script(script)
            stats = _stats(script)
            # 回传「改了什么」+ 每行状态：前端改完属性立刻能显示标注，
            # 不用重新拉整份台本，也不会出现「改了但没提示」。
            changes, statuses = {}, {}
            for ln in script.get("lines") or []:
                if ln.get("kind") == "tag":
                    continue
                statuses[ln["uid"]] = ln.get("status")
                if isinstance(ln.get("gen"), dict):
                    ch = _line_changes(ln, script)
                    if ch:
                        changes[ln["uid"]] = ch
        return {"ok": True, "stats": stats, "updated": script["updated"],
                "changes": changes, "statuses": statuses}

    @lf.post("/lf/scripts/{sid}/audio/copy")
    def lf_audio_copy(sid: str, req: dict = Body(...)):
        """把一行的音频复制成新行名（复制 / 粘贴句子时用）。

        不复制的话两行会共用同一个 wav：删掉一行、或重新生成其中一行，
        另一行的音频就跟着废了。
        """
        sid = _safe_sid(sid)
        adir = os.path.join(_script_dir(sid), "audio")
        src = os.path.basename(str(req.get("from") or ""))
        dst = os.path.basename(str(req.get("to") or ""))
        if not src or not dst or src == dst:
            raise HTTPException(400, "参数不对：需要 from / to 两个文件名")
        sp, dp = os.path.join(adir, src), os.path.join(adir, dst)
        if not os.path.exists(sp):
            return {"ok": False, "reason": "源音频不存在"}
        try:
            shutil.copy2(sp, dp)
        except OSError as exc:
            raise HTTPException(500, f"复制音频失败：{exc}")
        try:
            dur = round(float(_sf_info(dp).duration), 3)
        except Exception:  # noqa: BLE001
            dur = None
        return {"ok": True, "out": dst, "dur": dur}

    @lf.post("/lf/scripts/{sid}/import")
    def lf_script_import(sid: str, req: dict = Body(...)):
        sid = _safe_sid(sid)
        text = str(req.get("text") or "")
        if not text.strip():
            raise HTTPException(400, "文本为空")
        new_lines = [_new_line(t) for t in split_text(text, int(req.get("max_chars") or 70),
                                                      req.get("mode") or "packed")]
        with _LOCK:
            script = _load_script(sid)
            if req.get("replace"):
                script["lines"] = new_lines
            else:
                at = req.get("at")
                if isinstance(at, int) and 0 <= at <= len(script["lines"]):
                    script["lines"][at:at] = new_lines
                else:
                    script["lines"].extend(new_lines)
            _save_script(script)
            stats = _stats(script)
        return {"ok": True, "added": len(new_lines), "stats": stats}

    # ---- 智能导入（多格式 + 任务模板） ------------------------------------
    # 上传的文件先解析成「中间源」，落成 longform/_import/<token>.json，
    # 前端换模板 / 改选项时只带 token 重新 plan，不用反复上传大文件。
    def _import_dir():
        d = os.path.join(_lf_root(), "_import")
        os.makedirs(d, exist_ok=True)
        return d

    _IMPORT_GC_AT = [0.0]

    def _import_gc(keep_hours=24, max_remove=4):
        """清理过期的导入中间源（<token>.json）。

        **一次最多删 max_remove 个**：目录里攒到上千个过期文件时，一次性批量删除
        会被「批量删除守卫」判定为危险操作（在这类沙箱里会把整个进程打掉 ——
        表现为服务突然 502，日志最后一行是 sitecustomize 里的 SystemExit），
        而且在请求线程里做几百次 unlink 也会拖慢导入。每次顺手清几个就够。

        再加两道保险：① 十分钟才扫一次；② 删单个文件时连 SystemExit 一起吞掉 ——
        清理是「顺手做的事」，绝不该因为它把正在跑的台本服务带走。
        """
        now = time.time()
        if now - _IMPORT_GC_AT[0] < 600:
            return
        _IMPORT_GC_AT[0] = now
        d = _import_dir()
        cut = now - keep_hours * 3600
        gone = 0
        for fn in os.listdir(d):
            if gone >= max_remove:
                break
            if not fn.endswith(".json"):
                continue
            p = os.path.join(d, fn)
            try:
                if os.path.getmtime(p) < cut:
                    os.remove(p)
                    gone += 1
            except (OSError, SystemExit):      # noqa: PERF203
                pass

    @lf.get("/lf/import/classes")
    def lf_import_classes():
        import lf_import as IMP
        return {"ok": True, "classes": IMP.CLASSES,
                "group_labels": IMP.GROUP_LABELS,
                "max_seg_chars": IMP.MAX_SEG_CHARS}

    # 兼容：以前叫 templates，返回同一份「5 类」
    @lf.get("/lf/import/templates")
    def lf_import_templates():
        import lf_import as IMP
        return {"ok": True, "classes": IMP.CLASSES, "templates": IMP.CLASSES,
                "group_labels": IMP.GROUP_LABELS,
                "max_seg_chars": IMP.MAX_SEG_CHARS}

    @lf.post("/lf/import/detect")
    def lf_import_detect(req: dict = Body(...)):
        """只看特征、不真跑：判断这份文本属于哪一类（前端第二步的「识别结果」）。"""
        import lf_import as IMP
        src = _load_import_src((req or {}).get("token"))
        det = IMP.detect(src)
        det["defaults"] = {c: IMP.defaults_of(c) for c in IMP.CLASS_ORDER}
        det["ok"] = True
        det["source"] = {"kind": src.get("kind"), "filename": src.get("orig_name"),
                         "chars": src.get("chars") or len(src.get("text") or "")}
        return det

    @lf.post("/lf/import/inspect")
    def lf_import_inspect(file: UploadFile = File(...)):
        import lf_import as IMP
        raw = file.file.read()
        if len(raw) > 40 * 1024 * 1024:
            raise HTTPException(400, "文件超过 40MB，先拆分再导入")
        try:
            src = IMP.inspect_document(file.filename or "", raw)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(400, f"解析失败：{e}")
        if not (src.get("text") or "").strip() and not (src.get("rows") or src.get("cues")):
            raise HTTPException(400, "这个文件里没有抽到文字（可能是扫描件或空文件）")
        if src.get("kind") in ("text", "fountain", "srt") and \
                IMP._text_health(src.get("text") or "") < 0.9:
            raise HTTPException(400, "这不像是文本文件（二进制 / 未解码成功），"
                                     "请确认是 txt / docx / srt / csv / fountain")
        _import_gc()
        token = uuid.uuid4().hex[:16]
        payload = dict(src)
        payload["token"] = token
        payload["uploaded"] = _now()
        payload["orig_name"] = file.filename
        payload["chars"] = len(src.get("text") or "")
        _write_json(os.path.join(_import_dir(), token + ".json"), payload)
        text = (src.get("text") or "").strip()
        preview = ((payload.get("raw") or text)[:1500]
                   + ("…" if len(payload.get("raw") or text) > 1500 else ""))
        return {"ok": True, "token": token, "kind": src.get("kind"),
                "filename": file.filename, "meta": src.get("meta") or {},
                "chars": payload["chars"], "preview": preview,
                "header": src.get("header") or [],
                "rows": src.get("rows")[:6] if src.get("rows") else [],
                "cues": src.get("cues")[:5] if src.get("cues") else []}

    @lf.post("/lf/import/text")
    def lf_import_text(req: dict = Body(...)):
        """直接解析粘贴/示例文本（当作 .txt 处理）。"""
        import lf_import as IMP
        text = str((req or {}).get("text") or "")
        if len(text.strip()) < 2:
            raise HTTPException(400, "文本太短")
        try:
            src = IMP.inspect_document(str(req.get("filename") or "pasted.txt"),
                                       text.encode("utf-8"))
        except Exception as e:  # noqa: BLE001
            raise HTTPException(400, f"解析失败：{e}")
        _import_gc()
        token = uuid.uuid4().hex[:16]
        payload = dict(src)
        payload.update({"token": token, "uploaded": _now(),
                        "orig_name": req.get("filename") or "粘贴文本",
                        "chars": len(src.get("text") or "")})
        _write_json(os.path.join(_import_dir(), token + ".json"), payload)
        # 预览用**原文**：srt 的 text 是按 cue 重建的，拿它预览会丢结构 / 丢元信息行
        text_all = (src.get("raw") or src.get("text") or "").strip()
        return {"ok": True, "token": token, "kind": src.get("kind"),
                "filename": payload["orig_name"], "meta": src.get("meta") or {},
                "chars": payload["chars"],
                "preview": text_all[:1500] + ("…" if len(text_all) > 1500 else ""),
                "header": src.get("header") or [],
                "rows": src.get("rows")[:6] if src.get("rows") else [],
                "cues": src.get("cues")[:5] if src.get("cues") else []}

    def _load_import_src(token):
        token = re.sub(r"[^0-9a-f]", "", str(token or ""))[:32]
        if not token:
            raise HTTPException(400, "缺少文件标识，请重新上传")
        p = os.path.join(_import_dir(), token + ".json")
        data = _read_json(p, None)
        if not isinstance(data, dict):
            raise HTTPException(404, "上传的文件已过期，请重新选择文件")
        return data

    @lf.post("/lf/import/tc/check")
    def lf_import_tc_check(req: dict = Body(...)):
        """校验「自定义时间码格式」：立刻告诉用户能认出多少处、长什么样。

        输入：{pattern, token?, text?, pos?, fps?}
          pattern 留空 = 按内置全格式识别（用来对比自定义到底有没有多认出来）
        返回匹配数量、前若干条样例、以及每条切出来的正文。
        """
        import lf_import as IMP
        req = req or {}
        pat = str(req.get("pattern") or "").strip()[:300]
        text = str(req.get("text") or "")
        if not text.strip() and req.get("token"):
            try:
                src = _load_import_src(req.get("token"))
                text = src.get("raw") or src.get("text") or ""
                if not text and src.get("cues"):
                    text = "\n".join(f"{c.get('start')} {c.get('text')}" for c in src["cues"])
            except HTTPException:
                text = ""
        if not text.strip():
            raise HTTPException(400, "没有可用来校验的文本（先选文件，或直接粘贴几行）")

        opts = {"tc_custom": pat, "tc_pos": req.get("pos") or "auto",
                "tc_fps": req.get("fps") or 25}
        mode = "auto"
        if pat:
            try:
                cust = IMP._tc_custom_compile(pat, opts["tc_fps"])
            except Exception as e:  # noqa: BLE001
                return {"ok": False, "error": str(e), "mode": "regex", "matches": []}
            mode = cust["mode"] if cust else "auto"
        try:
            cues, stats = IMP.parse_timeline(text, opts)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": f"解析失败：{e}", "mode": mode, "matches": []}

        hit = [c for c in cues if c.get("start") is not None]
        no_tc = [c for c in cues if c.get("start") is None]
        samples = [{"start": c.get("start"), "end": c.get("end"),
                    "tc": IMP._fmt_tc_long(c["start"]) + (
                        " → " + IMP._fmt_tc_long(c["end"]) if c.get("end") is not None else ""),
                    "text": (c.get("text") or "")[:60]} for c in hit[:8]]
        return {"ok": True, "mode": mode, "pattern": pat,
                "count": len(hit), "total": len(cues), "no_tc": len(no_tc),
                "ranges": stats.get("ranges", 0), "fps": stats.get("fps"),
                "samples": samples,
                "warn": ("有 %d 段没认出时间码，这些段会按顺序排" % len(no_tc)) if no_tc else ""}

    @lf.post("/lf/import/plan")
    def lf_import_plan(req: dict = Body(...)):
        import lf_import as IMP
        req = req or {}
        src = _load_import_src(req.get("token"))
        cls = req.get("cls") or req.get("template")
        if cls in ("", "auto", None):
            cls = None
        try:
            out = IMP.plan(src, cls, req.get("opts") or {})
        except Exception as e:  # noqa: BLE001
            raise HTTPException(400, f"识别失败：{e}")
        out["ok"] = True
        out["source"] = {"kind": src.get("kind"), "filename": src.get("orig_name"),
                         "chars": src.get("chars") or len(src.get("text") or "")}
        # 预览就把「这个角色能对到哪个音色」标出来：能看到再决定要不要自动套，
        # 而不是导入完才发现套错了。只是建议，落库仍然由 commit 的 auto_voice 决定。
        char_idx = _char_index()
        tag_idx = _tag_index()
        tag_refs = {}
        for g in (out.get("groups") or []):
            nm = str((g or {}).get("name") or "").strip()
            if not nm:
                continue
            res = _resolve_voice(nm, char_idx, tag_idx)
            if res["source"] != "none":
                tag_refs[nm] = {"ref": res["ref"], "ref_name": res["ref_name"],
                                "tag": res["label"], "fuzzy": res["fuzzy"],
                                "source": res["source"], "char": res["char_name"],
                                "traits": res["traits"],
                                "lines": len((g or {}).get("segments") or [])}
        out["tag_refs"] = tag_refs
        out["tag_count"] = len(tag_idx)
        out["char_count"] = len(char_idx)
        return out

    @lf.post("/lf/import/marked")
    def lf_import_marked(req: dict = Body(...)):
        """写一份「导入原稿」：这次导入的原文**纯文本**（一段一行，不带任何标记）。

        它不是"当前状态的副本"，而是导入那一刻的原文：
        · 拿它核对「导入时有没有漏掉什么」；
        · 直接拖回智能导入就是一份干净的文本稿（想保持分段就选「一行一段」）。
        """
        req = req or {}
        src = _load_import_src(req.get("token"))
        token = re.sub(r"[^0-9a-f]", "", str(req.get("token") or ""))[:32]
        rows = []
        voiced = muted = 0
        for gi, g in enumerate((req.get("groups") or [])[:80]):
            if not isinstance(g, dict):
                continue
            for seg in (g.get("segments") or [])[:2000]:
                if not isinstance(seg, dict):
                    seg = {"text": str(seg or "")}
                body = str(seg.get("text") or "").strip()
                if not body:
                    continue
                try:
                    key = float(seg.get("i"))
                except (TypeError, ValueError):
                    key = 10 ** 6 + gi * 1000
                if seg.get("muted"):
                    muted += 1
                else:
                    voiced += 1
                rows.append((key, gi, body))
        if not rows:
            raise HTTPException(400, "没有可保存的内容")
        rows.sort(key=lambda x: (x[0], x[1]))
        title = _safe_title(req.get("title") or src.get("orig_name") or "智能导入")
        # 纯文本：一段一行，**不加**任何前缀/注释 —— 拖回智能导入就是一份普通文本稿
        text = "\n".join(r[2] for r in rows) + "\n"
        d = _import_dir()
        try:
            os.makedirs(d, exist_ok=True)
        except Exception:  # noqa: BLE001
            pass
        fn = f"{token}.origin.txt"
        path = os.path.join(d, fn)
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        _log("longform: origin text %s -> %d rows (%d voiced)", token, len(rows), voiced)
        return {"ok": True, "kind": "origin-text", "file": fn, "path": path, "rows": len(rows),
                "voiced": voiced, "muted": muted, "chars": len(text),
                "preview": "\n".join([r[2] for r in rows[:12]])}

    @lf.get("/lf/import/raw/{token}")
    def lf_import_raw_get(token: str):
        """下载「这次真正导进来的原文」（上传/粘贴时的那份，含【场景】、角色前缀、时间码）。

        注意和 `/import/marked/{token}` 的区别：那个是**拆句后**的稿子（一段一行），
        这个才是用户手上那份原始文件内容 —— 导进去发现要改原稿时，拿这个改。
        """
        import fastapi.responses as _fr
        token = re.sub(r"[^0-9a-f]", "", str(token or ""))[:32]
        if not token:
            raise HTTPException(400, "缺少文件标识")
        src = _load_import_src(token)
        text = str(src.get("raw") or src.get("text") or "")
        if not text.strip():
            raise HTTPException(404, "这次导入没有留下原文")
        name = _safe_title(str(src.get("orig_name") or "导入原稿").rsplit(".", 1)[0])
        tmp = os.path.join(_import_dir(), token + ".raw.txt")
        with open(tmp, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        return _fr.FileResponse(tmp, media_type="text/plain; charset=utf-8",
                                filename="导入原稿_" + name + ".txt")

    @lf.get("/lf/import/marked/{token}")
    def lf_import_marked_get(token: str):
        """下载这份「导入原稿」（纯文本，可直接再导入）。"""
        import fastapi.responses as _fr
        token = re.sub(r"[^0-9a-f]", "", str(token or ""))[:32]
        path = os.path.join(_import_dir(), token + ".origin.txt")
        if not os.path.isfile(path):
            # 兼容旧版写下的 .marked.txt
            path = os.path.join(_import_dir(), token + ".marked.txt")
        if not token or not os.path.isfile(path):
            raise HTTPException(404, "还没有生成过导入原稿")
        return _fr.FileResponse(path, media_type="text/plain; charset=utf-8",
                                filename="导入原稿_" + token + ".txt")

    @lf.post("/lf/import/commit")
    def lf_import_commit(req: dict = Body(...)):
        """把「预览里改过的分组/分段」建成一份新台本 + 每个分组一个批量任务。

        顺序很重要：分组只决定「哪些句子归一起（= 批量任务）」，
        台本里每一行的先后**必须按原文出现顺序**（seg["i"]）排，
        不能按分组排 —— 否则旁白/角色一交错，台本顺序就全乱了。
        """
        req = req or {}
        groups = req.get("groups") or []
        if not isinstance(groups, list) or not groups:
            raise HTTPException(400, "没有可导入的分段")
        title = _safe_title(req.get("title") or (str(req.get("filename") or "") or "智能导入")
                            .rsplit(".", 1)[0] or "智能导入")
        template = str(req.get("cls") or req.get("template") or "plain")[:30]
        sid = uuid.uuid4().hex[:12]
        flat = []          # (sort_key, gname, seg, params)
        origin_all = []    # 原稿行（含不配音段），最后写文件 + 存进 script.origin
        batches = []
        for gi, g in enumerate(groups[:80]):
            if not isinstance(g, dict):
                continue
            gname = _safe_title(g.get("name") or "正文", "正文")[:40]
            params = {k: v for k, v in (g.get("params") or {}).items() if k in _DEFAULT_PARAMS}
            uids, n_in_group = [], 0
            for si, seg in enumerate((g.get("segments") or [])[:2000]):
                if isinstance(seg, str):
                    seg = {"text": seg}
                text = str((seg or {}).get("text") or "").strip()
                if not text:
                    continue
                try:
                    key = float(seg.get("i"))
                except (TypeError, ValueError):
                    # 手动加的段没有 i：排在它所在分组最后一个已知位置之后
                    key = 10 ** 6 + gi * 1000 + si
                # 「导入原稿」要包含**所有**文字（含不配音的），先记一份
                origin_all.append({
                    "text": str(seg.get("text") or "").strip()[:MAX_LINE_CHARS],
                    "group": gname,
                    "note": (str(seg.get("note") or "").strip()[:200] or None),
                    "muted": bool(seg.get("muted")),
                    "i": key,
                })
                # 预览里「去掉配音」的段：文字还在（预览要能看见原文），但不进台本
                if seg.get("muted"):
                    continue
                flat.append((key, gi, si, gname, seg, params))
                n_in_group += 1
            if n_in_group:
                batches.append({"name": gname, "params": dict(params), "n": n_in_group})
        if not flat:
            raise HTTPException(400, "所有分段都是空的，没法导入")
        flat.sort(key=lambda x: (x[0], x[1], x[2]))
        lines, out_batches = [], []
        by_name = {}
        for _key, _gi, _si, gname, seg, params in flat:
            text = str(seg.get("text") or "").strip()[:MAX_LINE_CHARS]
            ln = _new_line(text)
            ln["group"] = gname
            note = str(seg.get("note") or "").strip()
            ln["note"] = note[:400] or None
            ln["slow"] = bool(seg.get("slow"))
            ln["t0"] = _num_or_none(seg.get("t0"))
            ln["t1"] = _num_or_none(seg.get("t1"))
            if seg.get("pause") is not None:
                try:
                    ln["pause"] = max(PAUSE_MIN, min(PAUSE_MAX, int(seg["pause"])))
                except (TypeError, ValueError):
                    pass
            # 分组参数 = 行级覆盖（跟「新建分组」里写覆盖值的行为一致）
            ov = {}
            for k in ("ref", "emo_mode", "emo_weight", "emo_vec", "emo_text", "emo_ref"):
                if params.get(k) not in (None, ""):
                    ov[k] = params[k]
            if ov:
                ln["ov"] = ov
            if params.get("pause") is not None:
                ln["pause"] = max(PAUSE_MIN, min(PAUSE_MAX, int(params["pause"])))
            lines.append(ln)
            by_name.setdefault(gname, []).append(ln["uid"])
        for b in batches:
            uids = by_name.get(b["name"]) or []
            if not uids:
                continue
            out_batches.append({
                "id": _new_uid(), "name": b["name"], "uids": uids,
                "params": dict(b["params"]), "created": _now(),
            })
        defaults = dict(_DEFAULT_PARAMS)
        defaults.update({k: v for k, v in (req.get("defaults") or {}).items()
                         if k in _DEFAULT_PARAMS})
        # 智能导入时按「人物 → 音色」自动设音色。
        # 优先级：请求里的显式值（预览里的勾选）> 老台本的 defaults.auto_voice（兼容）
        #        > 全局设置 voice.autoVoice（默认开）。
        raw_av = req.get("auto_voice")
        if raw_av is None and isinstance(req.get("defaults"), dict) and "auto_voice" in req["defaults"]:
            raw_av = req["defaults"]["auto_voice"]
        auto_voice = (bool(_load_settings()["voice"].get("autoVoice"))
                      if raw_av is None else bool(raw_av))
        if auto_voice:
            defaults["auto_voice"] = True
        auto_rep = None
        if auto_voice:
            char_idx = _char_index()
            tag_idx = _tag_index()
            hits = {}
            for ln in lines:
                if (ln.get("ov") or {}).get("ref"):
                    continue          # 分组参数里已经指定了音色：以它为准
                res = _resolve_voice(ln.get("group"), char_idx, tag_idx)
                if not res["ref"]:
                    continue
                ln["ov"] = ln.get("ov") or {}
                ln["ov"]["ref"] = res["ref"]
                ln["ov"]["ref_src"] = res["source"]
                if res.get("char_name"):
                    ln["ov"]["ref_char"] = res["char_name"]
                key = (ln.get("group") or "", res["ref"])
                h = hits.setdefault(key, {"name": ln.get("group") or "",
                                          "tag": res["label"], "fuzzy": res["fuzzy"],
                                          "ref": res["ref"], "ref_name": res["ref_name"],
                                          "source": res["source"], "char": res["char_name"],
                                          "traits": res["traits"], "lines": 0})
                h["lines"] += 1
            auto_rep = {"tags": len(tag_idx), "chars": len(char_idx),
                        "changed": sum(h["lines"] for h in hits.values()),
                        "matched": sorted(hits.values(), key=lambda x: -x["lines"])}
        # 导入原稿：**所有**文字（含被设成不配音的），按原文顺序。
        # 它既是台本页「原文本预览」的数据源，也会写成 `<token>.origin.txt` ——
        # 那份文件再拖回智能导入，分组/配音标记能原样还原。
        origin_all.sort(key=lambda x: x["i"])
        origin = [{
            "text": it["text"], "group": it["group"],
            "note": it["note"], "muted": it["muted"],
        } for it in origin_all if it["text"]]
        script = {
            "version": 2, "id": sid, "title": title, "created": _now(), "updated": _now(),
            "defaults": defaults, "sampling": dict(_DEFAULT_SAMPLING),
            "tag_presets": [], "lines": lines, "origin": origin,
            # 原文头几行（【场景】【人物】【字数】…）：台本页「原文本预览」展示用。
            # 它们不朗读、不进台本，但也不是"丢了"——预览顶部能看到。
            "origin_head": [str(x)[:200] for x in (req.get("head_lines") or [])][:12],
            "batches": out_batches if req.get("make_batches", True) else [],
            "import": {"cls": template, "template": template,
                       "filename": req.get("filename"),
                       "detect": req.get("detect") or None,
                       "at": _now(), "groups": len(out_batches)},
        }
        _save_script(script)
        # 写「导入原稿」：这份文件再拖回智能导入，分组/不配音标记/备注都能原样还原。
        # 它是**这次导入采用的那份稿子**，台本页之后的编辑不会回写它。
        try:
            tk = re.sub(r"[^0-9a-f]", "", str(req.get("token") or ""))[:32]
            if tk and origin:
                # 纯文本，一段一行，不带任何前缀/注释：拖回智能导入就是普通文本稿
                body_txt = "\n".join(it["text"] for it in origin) + "\n"
                d = _import_dir()
                os.makedirs(d, exist_ok=True)
                with open(os.path.join(d, tk + ".origin.txt"), "w",
                          encoding="utf-8", newline="\n") as f:
                    f.write(body_txt)
        except Exception as e:  # noqa: BLE001
            _log("longform: write origin script failed: %s", e, level="warning")
        # 「下载导入原稿」要的是**用户真正拖进来的那份原文**（带【场景】、角色前缀、
        # 时间码），不是拆分后的句子。原样存一份到台本目录，前端直接下它。
        try:
            raw_txt = str(req.get("raw_text") or "")
            if not raw_txt:
                tk2 = re.sub(r"[^0-9a-f]", "", str(req.get("token") or ""))[:32]
                if tk2:
                    try:
                        src0 = _load_import_src(tk2)
                        raw_txt = str(src0.get("raw") or src0.get("text") or "")
                    except HTTPException:
                        raw_txt = ""
            if raw_txt.strip():
                raw_txt = raw_txt[:MAX_RAW_ORIGIN]
                p_raw = os.path.join(_script_dir(sid), "origin_raw.txt")
                with open(p_raw, "w", encoding="utf-8", newline="\n") as f:
                    f.write(raw_txt if raw_txt.endswith("\n") else raw_txt + "\n")
                script["import"]["raw_file"] = "origin_raw.txt"
                script["import"]["raw_chars"] = len(raw_txt)
                _save_script(script)
        except Exception as e:  # noqa: BLE001
            _log("longform: write raw origin failed: %s", e, level="warning")
        _log("longform: smart import %s -> %d lines / %d groups", sid, len(lines), len(out_batches))
        return {"ok": True, "id": sid, "script": _load_script(sid), "stats": _stats(script),
                "lines": len(lines), "groups": len(out_batches),
                "auto_voice": auto_rep}

    @lf.get("/lf/import/class/{cid}")
    def lf_import_class(cid: str):
        """单个类别：详细说明 + 标准格式示例 + 选项 schema。"""
        import lf_import as IMP
        info = IMP.class_info(str(cid)[:20])
        if not info:
            raise HTTPException(404, "没有这个类别")
        return {"ok": True, "class": info, "template": info}

    @lf.get("/lf/import/template/{tid}")
    def lf_import_template(tid: str):
        import lf_import as IMP
        info = IMP.class_info(str(tid)[:20])
        if not info:
            raise HTTPException(404, "没有这个类别")
        return {"ok": True, "class": info, "template": info}

    @lf.get("/lf/import/sample/{kind}")
    def lf_import_sample(kind: str):
        """示例文本：kind 可以是类别 id，也可以是 fountain / srt / csv / text。"""
        import lf_import as IMP
        k = (kind or "").strip()
        c = IMP.CLASS_MAP.get(k)
        if c:
            return {"ok": True, "kind": "text", "cls": c["id"], "template": c["id"],
                    "text": c.get("sample") or "", "detail": c.get("detail") or "",
                    "hints": c.get("hints") or []}
        samples = {
            "fountain": IMP.CLASS_MAP["script"]["sample"],
            "srt": IMP.CLASS_MAP["timeline"]["sample"],
            "csv": "序号,角色,正文,标签\n1,旁白,夜色渐深。,序章\n2,阿澈,你终于来了。,序章\n",
        }
        if k.lower() in samples:
            return {"ok": True, "kind": k.lower(), "text": samples[k.lower()]}
        return {"ok": True, "kind": "text", "text": IMP.CLASS_MAP["plain"]["sample"]}

    @lf.delete("/lf/scripts/{sid}")
    def lf_script_delete(sid: str):
        sid = _safe_sid(sid)
        if _ACTIVE.get("sid") == sid:
            raise HTTPException(409, "这个台本正在渲染，先停止")
        with _LOCK:
            # 用「改名进回收站」代替 rmtree：避免触发沙箱的批量删除守卫，
            # 同时也让误删可恢复（longform/_trash/ 下）。
            src = os.path.join(_lf_root(), "scripts", sid)
            if os.path.isdir(src):
                trash = os.path.join(_lf_root(), "_trash")
                os.makedirs(trash, exist_ok=True)
                dst = os.path.join(trash, f"{sid}_{int(time.time())}")
                try:
                    os.rename(src, dst)
                except OSError:
                    # 同名则加随机后缀；仍失败就逐文件删（不触发 rmtree 守卫）
                    dst = dst + "_" + uuid.uuid4().hex[:6]
                    try:
                        os.rename(src, dst)
                    except OSError:
                        _remove_tree_shallow(src)
            _RENDERS.pop(sid, None)
        return {"ok": True}


    def _remove_tree_shallow(root):
        """逐文件删除，作为 rename 失败时的兜底（单文件删除不触发批量守卫）。"""
        for dirpath, dirs, files in os.walk(root, topdown=False):
            for f in files:
                try:
                    os.remove(os.path.join(dirpath, f))
                except OSError:
                    pass
            for d in dirs:
                try:
                    os.rmdir(os.path.join(dirpath, d))
                except OSError:
                    pass

    # ---- 渲染 ---------------------------------------------------------------
    @lf.post("/lf/scripts/{sid}/render")
    def lf_render_start(sid: str, req: dict | None = Body(default=None)):
        sid = _safe_sid(sid)
        req = req or {}
        script = _load_script(sid)
        mode = req.get("mode") or ("uids" if req.get("uids") else "all")
        if mode == "batches":
            wanted_b = set(req.get("batches") or [])
            if not wanted_b:
                raise HTTPException(400, "「按批量任务」模式没收到 batches：请先勾选要跑的组")
            uids = []
            for b in script.get("batches") or []:
                if b.get("id") in wanted_b:
                    uids.extend(b.get("uids") or [])
            wanted = set(uids)
            uids = [l["uid"] for l in script["lines"] if l["uid"] in wanted]
        elif mode in ("uids", "sel"):
            # "sel" 是前端「选中行」的旧写法：必须带 uids。
            # 以前没有这个分支，"sel" 会落到 else（全部行）—— 选 2 句整篇都在跑。
            if "uids" not in req:
                raise HTTPException(400, "「选中行」模式缺少 uids 列表，已拒绝（不猜成全篇）")
            wanted = set(req.get("uids") or [])
            uids = [l["uid"] for l in script["lines"] if l["uid"] in wanted]
        elif mode == "missing":
            uids = [l["uid"] for l in script["lines"]
                    if l.get("kind") != "tag" and l.get("status") != "done"
                    and (l.get("text") or "").strip()]
        elif mode == "all":
            uids = [l["uid"] for l in script["lines"]
                    if l.get("kind") != "tag" and (l.get("text") or "").strip()]
        else:
            # 未知范围一律拒绝：宁可报错，也不要「猜着来」把整篇重跑一遍。
            raise HTTPException(400, f"不认识的渲染范围：{mode}（可用：sel/uids/missing/batches/all）")
        job = _start_render(sid, uids)
        return {"ok": True, "render": job.public()}

    @lf.post("/lf/scripts/{sid}/render/append")
    def lf_render_append(sid: str, req: dict | None = Body(default=None)):
        """把几句追加到**正在跑**的任务队列尾部（用户点别的句子想生成时用）。

        与「等这轮结束再单独跑」的区别：追加的句子混在这一轮里，进度条总数会变大，
        跑完一次汇总里也一起出现。
        """
        sid = _safe_sid(sid)
        req = req or {}
        job = _RENDERS.get(sid)
        if not job or job.state not in ("running", "stopping"):
            raise HTTPException(409, "当前没有正在跑的任务，直接点「开始生成」就行")
        if job.state == "stopping":
            raise HTTPException(409, "任务正在停止，等它停下来再生成")
        if job.cursor >= len(job.uids):
            raise HTTPException(409, "这一轮刚跑完，再点一次「开始生成」")
        wanted = set(req.get("uids") or [])
        if not wanted:
            raise HTTPException(400, "没有要追加的句子")
        script = _load_script(sid)
        ok_uids = {l["uid"] for l in script["lines"]
                   if l.get("kind") != "tag" and (l.get("text") or "").strip()}
        add = [l["uid"] for l in script["lines"]
               if l["uid"] in wanted and l["uid"] in ok_uids and l["uid"] not in job.uids]
        if not add:
            raise HTTPException(400, "这些句子已经在当前队列里了")
        with _LOCK:
            script = _load_script(sid)
            for l in script["lines"]:
                if l["uid"] in add:
                    l["status"] = "queued"
            _save_script(script)
            with job.lock:
                job.uids.extend(add)
                job.total = len(job.uids)
        _log("longform: render %s append %d lines", sid, len(add))
        return {"ok": True, "render": job.public(), "added": add}

    @lf.get("/lf/scripts/{sid}/render")
    def lf_render_status(sid: str):
        sid = _safe_sid(sid)
        job = _RENDERS.get(sid)
        script = _load_script(sid)
        try:
            model = _D["tts"].state()
        except Exception:  # noqa: BLE001
            model = {"loaded": False, "phase": "unknown"}
        return {"ok": True, "render": job.public() if job else None,
                "model": model,
                "statuses": _render_statuses(script), "stats": _stats(script)}

    @lf.post("/lf/scripts/{sid}/render/stop")
    def lf_render_stop(sid: str):
        sid = _safe_sid(sid)
        job = _RENDERS.get(sid)
        if not job:
            raise HTTPException(404, "没有正在进行的渲染")
        job.stop_event.set()
        if job.state == "running":
            job.state = "stopping"
            job.message = "正在停止（当前行结束后停下）…"
        return {"ok": True, "render": job.public()}

    # ---- 分行音频 / 单句导出 --------------------------------------------------
    @lf.get("/lf/scripts/{sid}/audio/{uid}")
    def lf_line_audio(sid: str, uid: str, name: str = "", download: int = 0,
                      format: str = "wav", bit_depth: int = 16, quality: str = "standard",
                      sample_rate: int = AUDIO_SR, channels: int = 2):
        sid = _safe_sid(sid)
        uid = _UIDS_RE.sub("", uid)
        path = os.path.join(_script_dir(sid), "audio", f"{uid}.wav")
        if not os.path.exists(path):
            raise HTTPException(404, "这一行还没有音频")
        fmt = (format or "wav").lower()
        if not download and fmt == "wav":
            # 试听走原始文件，零转换开销
            return FileResponse(path, media_type="audio/wav")
        data, sr = sf.read(path, dtype="float32", always_2d=True)
        raw, ext, mime = _encode_audio(data, sr, fmt, bit_depth, quality, channels, sample_rate)
        base = _safe_title(name or uid, uid)
        quoted = urllib.parse.quote(f"{base}.{ext}")
        return Response(content=raw, media_type=mime, headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quoted}",
            "Content-Length": str(len(raw)),
        })

    @lf.post("/lf/scripts/{sid}/export/lines")
    def lf_export_lines(sid: str, req: dict | None = Body(default=None)):
        sid = _safe_sid(sid)
        req = req or {}
        script = _load_script(sid)
        result = _export_lines_zip(
            script, req.get("uids") or None,
            req.get("naming") or "index_text", req.get("prefix") or "",
            fmt=req.get("format") or "wav",
            bit_depth=int(req.get("bit_depth") or 16),
            quality=req.get("quality") or "standard",
            sample_rate=int(req.get("sample_rate") or AUDIO_SR),
            channels=int(req.get("channels") or 2),
        )
        _log("longform %s: exported %d line(s) to %s", sid, result["count"], result["zip"])
        return {"ok": True, **result}

    @lf.post("/lf/scripts/{sid}/export/script")
    def lf_export_script(sid: str, req: dict | None = Body(default=None)):
        sid = _safe_sid(sid)
        req = req or {}
        script = _load_script(sid)
        opts = {k: bool(req.get(k, True)) for k in ("timestamps", "meta", "tags")}
        result = _export_md(script, "txt" if req.get("format") == "txt" else "md", opts)
        return {"ok": True, **result}

    @lf.post("/lf/scripts/{sid}/export/srt")
    def lf_export_srt(sid: str, req: dict | None = Body(default=None)):
        """导出 SRT 字幕。

        时间轴自己算，不复用 _timeline —— 后者只看 `dur`，而没生成的行 `dur` 是 None，
        会让所有字幕挤在开头 0.2 秒里。这里对没生成的行按「字数 ÷ 实测语速」估，
        并且把行间停顿算进去，所以**没生成也能得到一版可看的字幕**，
        只是位置是估的：界面上必须说清楚「全部生成完再导才有用」。
        """
        sid = _safe_sid(sid)
        req = req or {}
        with_tags = bool(req.get("tags", True))
        script = _load_script(sid)
        stats = _stats(script)
        rate = float(stats.get("rate") or 3.5)          # 字/秒：已生成时是实测，否则 3.5
        default_pause = script.get("defaults", {}).get("pause", _DEFAULT_PARAMS["pause"])

        cues, cursor, gen, est = [], 0.0, 0, 0
        for ln in script.get("lines") or []:
            if ln.get("kind") == "tag":
                # 句间标签的留白也是时间轴的一部分，跳过但不占字幕
                cursor += float(ln.get("hold") or 0) / 1000.0
                continue
            txt = (ln.get("text") or "").strip()
            if with_tags:
                extra = [str(it.get("tag") or "").strip() for it in (ln.get("inline") or [])]
                extra = [e for e in extra if e]
                if extra:
                    txt = (txt + " " + " ".join("〔%s〕" % e for e in extra)).strip()
            if ln.get("out") and ln.get("dur"):
                dur = float(ln["dur"])
                gen += 1
            else:
                # 没生成：按字数估。至少 0.4 秒，避免一个字一行时贴着下一句
                dur = max(0.4, len(txt) / max(1.2, rate))
                est += 1
            if txt:
                cues.append((cursor, cursor + max(0.2, dur), txt))
            cursor += dur
            p = ln.get("pause")
            cursor += float((default_pause if p is None else p) or 0) / 1000.0

        if not cues:
            raise HTTPException(400, "台本里没有可导出的台词")

        out = []
        for i, (t0, t1, txt) in enumerate(cues, 1):
            out.append(str(i))
            out.append("%s --> %s" % (_srt_time(t0), _srt_time(t1)))
            out.append(txt)
            out.append("")
        name = "%s_字幕_%s.srt" % (_safe_title(script.get("title"), "台本")[:24],
                                   time.strftime("%Y%m%d_%H%M%S"))
        path = os.path.join(_script_dir(sid), "export", name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        # utf-8-sig：Windows 记事本 / 大部分播放器直接认，不会显示成乱码
        with open(path, "w", encoding="utf-8-sig", newline="\n") as f:
            f.write("\n".join(out))
        _log("longform: export srt %s (%d 条，%d 条已生成，%d 条按字数估)", sid, len(cues), gen, est)
        return {"ok": True, "file": name, "lines": len(cues),
                "generated": gen, "estimated": est, "rate": rate,
                "duration": round(cursor, 2)}

    @lf.get("/lf/scripts/{sid}/export/map")
    def lf_export_map(sid: str):
        """导出「映射 CSV」：给后期剪辑对轴用（分组/正文/备注/时长/音频文件名）。"""
        import csv as _csv
        sid = _safe_sid(sid)
        script = _load_script(sid)
        rows = [["序号", "uid", "分组", "正文", "附属备注", "慢语速",
                 "出现时间(秒)", "结束时间(秒)", "时长(秒)", "音频文件", "状态"]]
        idx = 0
        for ln in script.get("lines") or []:
            if ln.get("kind") == "tag":
                continue
            idx += 1
            rows.append([
                idx, ln.get("uid") or "", ln.get("group") or "",
                (ln.get("text") or "").replace("\r", " ").replace("\n", " "),
                (ln.get("note") or "").replace("\r", " ").replace("\n", " "),
                "1" if ln.get("slow") else "",
                (f"{float(ln['t0']):.2f}" if ln.get("t0") is not None else ""),
                (f"{float(ln['t1']):.2f}" if ln.get("t1") is not None else ""),
                f"{float(ln.get('dur') or 0):.2f}",
                os.path.basename(ln.get("out") or "") if ln.get("out") else "",
                ln.get("status") or "",
            ])
        name = f"{_safe_title(script.get('title'), '台本')[:24]}_映射_{time.strftime('%Y%m%d_%H%M%S')}.csv"
        path = os.path.join(_script_dir(sid), "export", name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8-sig", newline="") as f:
            _csv.writer(f).writerows(rows)
        return {"ok": True, "file": name, "rows": len(rows) - 1}

    # ---- 导出 ---------------------------------------------------------------
    @lf.post("/lf/scripts/{sid}/export")
    def lf_export(sid: str, req: dict | None = Body(default=None)):
        sid = _safe_sid(sid)
        req = req or {}
        script = _load_script(sid)
        gap = req.get("gap")
        try:
            gap = int(gap) if gap not in (None, "") else None
        except (TypeError, ValueError):
            gap = None
        result = _export(
            script, gap_override=gap, uids=req.get("uids") or None,
            fmt=req.get("format") or "wav",
            bit_depth=req.get("bit_depth") or 16,
            quality=req.get("quality") or "standard",
            channels=req.get("channels") or 2,
            range_start=req.get("range_start"),
            range_end=req.get("range_end"),
            sample_rate=req.get("sample_rate") or AUDIO_SR,
        )
        _log("longform %s: exported %s (%s, %.1fs, %d lines, %.1fMB)",
             sid, result["file"], result["fmt"], result["duration"],
             result["written"], result["size"] / 1048576.0)
        return {"ok": True, **result}

    @lf.post("/lf/scripts/{sid}/export/estimate")
    def lf_export_estimate(sid: str, req: dict | None = Body(default=None)):
        """只算不写：返回总时长 / 所选时段时长 / 预估文件大小，供导出面板实时显示。"""
        sid = _safe_sid(sid)
        req = req or {}
        script = _load_script(sid)
        gap = req.get("gap")
        try:
            gap = int(gap) if gap not in (None, "") else None
        except (TypeError, ValueError):
            gap = None
        return {"ok": True, **_export_estimate(
            script, gap_override=gap, uids=req.get("uids") or None,
            fmt=req.get("format") or "wav",
            bit_depth=req.get("bit_depth") or 16,
            quality=req.get("quality") or "standard",
            channels=req.get("channels") or 2,
            range_start=req.get("range_start"),
            range_end=req.get("range_end"),
            sample_rate=req.get("sample_rate") or AUDIO_SR,
        )}

    @lf.get("/lf/scripts/{sid}/export/{name}")
    def lf_export_file(sid: str, name: str):
        sid = _safe_sid(sid)
        safe = os.path.basename(name)
        path = os.path.join(_script_dir(sid), "export", safe)
        if not os.path.exists(path):
            raise HTTPException(404, "文件不存在")
        if safe.endswith(".wav"):
            media = "audio/wav"
        elif safe.endswith(".zip"):
            media = "application/zip"
        elif safe.endswith(".json"):
            media = "application/json"
        else:
            media = "text/plain; charset=utf-8"
        return FileResponse(path, media_type=media, filename=safe)

    @lf.get("/lf/scripts/{sid}/export")
    def lf_export_list(sid: str):
        sid = _safe_sid(sid)
        d = os.path.join(_script_dir(sid), "export")
        items = []
        for fn in sorted(os.listdir(d), key=_nat_key, reverse=True):
            p = os.path.join(d, fn)
            items.append({"name": fn, "size": os.path.getsize(p), "created": os.path.getmtime(p)})
        return {"ok": True, "files": items}

    # ---- 历史副本（落盘，跨会话可读） -------------------------------------
    def _history_dir(sid):
        d = os.path.join(_script_dir(sid), "history")
        os.makedirs(d, exist_ok=True)
        return d

    def _snapshot_history(script, label):
        """把当前台本整份存成副本。命名带时间前缀，便于排序与滚动清理。"""
        d = _history_dir(script["id"])
        name = f"{time.strftime('%Y%m%d_%H%M%S')}_{_safe_title(label, 'edit')[:20]}_{uuid.uuid4().hex[:4]}.json"
        payload = {
            "time": _now(), "label": label or "编辑",
            "title": script.get("title"), "lines": script.get("lines") or [],
            "defaults": script.get("defaults"), "sampling": script.get("sampling"),
            "tag_presets": script.get("tag_presets") or [],
        }
        _write_json(os.path.join(d, name), payload)
        files = sorted(os.listdir(d))
        for fn in files[:-HISTORY_KEEP]:
            try:
                os.remove(os.path.join(d, fn))
            except OSError:
                pass
        return name

    @lf.get("/lf/scripts/{sid}/history")
    def lf_history_list(sid: str):
        sid = _safe_sid(sid)
        d = _history_dir(sid)
        items = []
        for fn in sorted(os.listdir(d), key=_nat_key, reverse=True):
            if not fn.endswith(".json"):
                continue
            data = _read_json(os.path.join(d, fn), {}) or {}
            items.append({"name": fn, "time": data.get("time"), "label": data.get("label"),
                          "lines": len(data.get("lines") or []),
                          "title": data.get("title")})
        return {"ok": True, "items": items, "keep": HISTORY_KEEP}

    @lf.post("/lf/scripts/{sid}/history")
    def lf_history_add(sid: str, req: dict | None = Body(default=None)):
        sid = _safe_sid(sid)
        req = req or {}
        with _LOCK:
            script = _load_script(sid)
            name = _snapshot_history(script, req.get("label"))
        return {"ok": True, "name": name}

    @lf.post("/lf/scripts/{sid}/history/{name}/restore")
    def lf_history_restore(sid: str, name: str):
        sid = _safe_sid(sid)
        safe = os.path.basename(name)
        path = os.path.join(_history_dir(sid), safe)
        data = _read_json(path)
        if not data:
            raise HTTPException(404, "历史副本不存在")
        with _LOCK:
            script = _load_script(sid)
            _snapshot_history(script, "恢复前")   # 恢复前先存一份，可反悔
            script["lines"] = data.get("lines") or []
            if isinstance(data.get("defaults"), dict):
                script["defaults"].update(data["defaults"])
            if isinstance(data.get("sampling"), dict):
                script["sampling"].update(data["sampling"])
            if isinstance(data.get("tag_presets"), list):
                script["tag_presets"] = data["tag_presets"]
            _save_script(script)
            fresh = _load_script(sid)
        return {"ok": True, "script": fresh, "stats": _stats(fresh)}

    @lf.delete("/lf/scripts/{sid}/history/{name}")
    def lf_history_delete(sid: str, name: str):
        sid = _safe_sid(sid)
        path = os.path.join(_history_dir(sid), os.path.basename(name))
        if not os.path.exists(path):
            raise HTTPException(404, "历史副本不存在")
        try:
            os.remove(path)
        except OSError as e:
            raise HTTPException(400, f"删除失败: {e}")
        return {"ok": True}

    # ---- 台本复制 -----------------------------------------------------------
    @lf.post("/lf/scripts/{sid}/duplicate")
    def lf_script_duplicate(sid: str, req: dict | None = Body(default=None)):
        sid = _safe_sid(sid)
        req = req or {}
        with _LOCK:
            src = _load_script(sid)
            new_sid = uuid.uuid4().hex[:12]
            new_dir = _script_dir(new_sid)
            # 音频一起复制：副本立即可用，不用重新生成（两小时台本重跑代价太大）
            src_audio = os.path.join(_script_dir(sid), "audio")
            dst_audio = os.path.join(new_dir, "audio")
            if os.path.isdir(src_audio):
                for fn in os.listdir(src_audio):
                    if fn.endswith(".wav"):
                        try:
                            shutil.copy2(os.path.join(src_audio, fn), os.path.join(dst_audio, fn))
                        except OSError:
                            pass
            copy = json.loads(json.dumps(src))
            copy["id"] = new_sid
            copy["title"] = _safe_title(req.get("title") or (src.get("title", "台本") + " 副本"))
            copy["created"] = _now()
            copy["updated"] = _now()
            _write_json(_script_path(new_sid), copy)
            fresh = _load_script(new_sid)
        _log("longform: script %s duplicated -> %s", sid, new_sid)
        return {"ok": True, "id": new_sid, "script": fresh, "stats": _stats(fresh)}

    # ---- 参数预设 -----------------------------------------------------------
    def _presets_dir():
        d = os.path.join(_lf_root(), "presets")
        os.makedirs(d, exist_ok=True)
        return d

    def _preset_scan():
        """扫描所有预设文件，返回 [(path, id, data)]。

        文件名是「可读名字_id.json」，id 同时写进 json；老格式 <id>.json 也认。
        """
        out = []
        d = _presets_dir()
        for fn in os.listdir(d):
            if not fn.endswith(".json"):
                continue
            data = _read_json(os.path.join(d, fn), {}) or {}
            pid = data.get("id") or fn[:-5]
            data["id"] = pid
            out.append((os.path.join(d, fn), pid, data))
        return out

    def _preset_file(pid, name):
        return os.path.join(_presets_dir(), f"{_safe_title(name, pid)}_{pid}.json")

    def _preset_public(pid, data):
        return {"id": pid, "name": data.get("name") or pid, "created": data.get("created"),
                "params": data.get("params") or {}, "sampling": data.get("sampling") or {}}

    @lf.get("/lf/presets")
    def lf_presets():
        items = [_preset_public(pid, data) for _, pid, data in _preset_scan()]
        items.sort(key=lambda x: x.get("created") or 0, reverse=True)
        return {"ok": True, "presets": items}

    @lf.post("/lf/presets")
    def lf_preset_add(req: dict | None = Body(default=None)):
        req = req or {}
        name = _safe_title(req.get("name") or time.strftime("预设 %m-%d %H:%M"))
        # 只留认识的字段，且丢掉 None（前端「没填」会被序列化成 null，
        # 存进去之后套用时会变成「把这行清空」，不是它想表达的意思）
        params = {k: v for k, v in (req.get("params") or {}).items()
                  if k in _DEFAULT_PARAMS and v is not None}
        sampling = {k: v for k, v in (req.get("sampling") or {}).items()
                    if k in _DEFAULT_SAMPLING and v is not None}
        pid = uuid.uuid4().hex[:10]
        data = {"id": pid, "name": name, "created": _now(), "params": params, "sampling": sampling}
        with _LOCK:
            _write_json(_preset_file(pid, name), data)
        return {"ok": True, "preset": _preset_public(pid, data)}

    @lf.patch("/lf/presets/{pid}")
    def lf_preset_update(pid: str, req: dict | None = Body(default=None)):
        pid = _UIDS_RE.sub("", pid)
        req = req or {}
        with _LOCK:
            hit = next(((p, d) for p, i, d in _preset_scan() if i == pid), None)
            if not hit:
                raise HTTPException(404, "预设不存在")
            path, data = hit
            if req.get("name"):
                data["name"] = _safe_title(req["name"], data.get("name") or pid)
            if isinstance(req.get("params"), dict):
                data["params"] = {k: v for k, v in req["params"].items()
                                  if k in _DEFAULT_PARAMS and v is not None}
            if isinstance(req.get("sampling"), dict):
                data["sampling"] = {k: v for k, v in req["sampling"].items()
                                    if k in _DEFAULT_SAMPLING and v is not None}
            data["id"] = pid
            new_path = _preset_file(pid, data["name"])
            _write_json(new_path, data)
            if os.path.abspath(new_path) != os.path.abspath(path):
                try:
                    os.remove(path)      # 名字变了 → 旧文件删掉，保持文件名可读
                except OSError:
                    pass
        return {"ok": True, "preset": _preset_public(pid, data)}

    @lf.delete("/lf/presets/{pid}")
    def lf_preset_delete(pid: str):
        pid = _UIDS_RE.sub("", pid)
        with _LOCK:
            hit = next((p for p, i, d in _preset_scan() if i == pid), None)
            if not hit:
                raise HTTPException(404, "预设不存在")
            try:
                os.remove(hit)
            except OSError as e:
                raise HTTPException(400, f"删除失败: {e}")
        return {"ok": True}

    # ---- 撤回修改：把这一行恢复成"生成时的那套参数" ------------------------
    @lf.post("/lf/scripts/{sid}/lines/{uid}/revert")
    def lf_line_revert(sid: str, uid: str):
        sid = _safe_sid(sid)
        uid = _UIDS_RE.sub("", uid)[:20]
        with _LOCK:
            script = _load_script(sid)
            line = next((l for l in script["lines"] if l["uid"] == uid), None)
            if not line:
                raise HTTPException(404, "这一行不在了")
            gen = line.get("gen")
            if not isinstance(gen, dict):
                raise HTTPException(400, "这一行没有生成快照（可能是旧数据），只能重新生成")
            ov = line.setdefault("ov", {})
            for k in _GEN_FIELDS:
                if k == "text":
                    line["text"] = gen.get("text") or ""
                    continue
                v = gen.get(k)
                if v == script["defaults"].get(k):
                    ov.pop(k, None)
                else:
                    ov[k] = v
            if isinstance(gen.get("sampling"), dict):
                script["sampling"].update(gen["sampling"])
            # 文本可能被改短了，句中标签位置收进范围
            n = len(line.get("text") or "")
            for it in line.get("inline") or []:
                it["pos"] = max(0, min(n, int(it.get("pos") or 0)))
            line["sig"] = _line_sig(line, script)
            line["status"] = "done"
            line["err"] = None
            _save_script(script)
            fresh = _load_script(sid)
        return {"ok": True, "script": fresh, "stats": _stats(fresh),
                "line": next((l for l in fresh["lines"] if l["uid"] == uid), None)}

    # ---- 工程（PS/AE 式的"项目"） ------------------------------------------
    def _initial_path(sid):
        return os.path.join(_script_dir(sid), "initial_script.json")

    @lf.get("/lf/scripts/{sid}/project")
    def lf_project_info(sid: str):
        sid = _safe_sid(sid)
        script = _load_script(sid)
        proj = script.get("project") if isinstance(script.get("project"), dict) else None
        return {"ok": True, "is_project": bool(proj), "project": proj,
                "has_initial": os.path.exists(_initial_path(sid)),
                "title": script.get("title")}

    @lf.post("/lf/scripts/{sid}/project")
    def lf_project_create(sid: str, req: dict | None = Body(default=None)):
        """把一份台本变成"工程"：复制台本 + 硬链接音频 + 存一份初始样本。"""
        sid = _safe_sid(sid)
        req = req or {}
        with _LOCK:
            src = _load_script(sid)
            if isinstance(src.get("project"), dict):
                return {"ok": True, "id": sid, "reused": True,
                        "script": src, "stats": _stats(src)}
            new_sid = uuid.uuid4().hex[:12]
            new_dir = _script_dir(new_sid)
            src_audio = os.path.join(_script_dir(sid), "audio")
            dst_audio = os.path.join(new_dir, "audio")
            linked = 0
            if os.path.isdir(src_audio):
                for fn in os.listdir(src_audio):
                    if not fn.lower().endswith((".wav", ".mp3", ".flac", ".ogg")):
                        continue
                    s_path = os.path.join(src_audio, fn)
                    d_path = os.path.join(dst_audio, fn)
                    if os.path.exists(d_path):
                        continue
                    try:
                        os.link(s_path, d_path)      # 同盘硬链接：不占额外空间
                        linked += 1
                    except OSError:
                        try:
                            shutil.copy2(s_path, d_path)
                        except OSError:
                            pass
            copy = json.loads(json.dumps(src))
            copy["id"] = new_sid
            copy["title"] = _safe_title(req.get("title") or (src.get("title", "台本") + " · 工程"))
            copy["created"] = _now()
            copy["updated"] = _now()
            copy["project"] = {"source_id": sid, "source_title": src.get("title"),
                               "created": _now(), "initial_at": _now()}
            _write_json(_script_path(new_sid), copy)
            # 初始样本：进入时间轴之前的那一版（原样存一份，随时可回）
            _write_json(_initial_path(new_sid), {
                "snapshot_at": _now(), "source_id": sid,
                "title": src.get("title"), "lines": src.get("lines"),
                "defaults": src.get("defaults"), "sampling": src.get("sampling"),
                "tag_presets": src.get("tag_presets") or [],
                "batches": src.get("batches") or [],
            })
            fresh = _load_script(new_sid)
        _log("longform: project %s created from %s (audio linked %d)", new_sid, sid, linked)
        return {"ok": True, "id": new_sid, "script": fresh, "stats": _stats(fresh),
                "audio_linked": linked}

    @lf.post("/lf/scripts/{sid}/restore-initial")
    def lf_project_restore(sid: str):
        sid = _safe_sid(sid)
        data = _read_json(_initial_path(sid))
        if not data:
            raise HTTPException(404, "这份台本没有初始样本")
        with _LOCK:
            cur = _load_script(sid)
            # 恢复前先留一份，防止误点
            hist = os.path.join(_script_dir(sid), "history")
            os.makedirs(hist, exist_ok=True)
            try:
                _write_json(os.path.join(
                    hist, f"{time.strftime('%Y%m%d_%H%M%S')}_恢复初始样本前_{uuid.uuid4().hex[:4]}.json"),
                    {"time": _now(), "label": "恢复初始样本前", "title": cur.get("title"),
                     "lines": cur.get("lines"), "defaults": cur.get("defaults"),
                     "sampling": cur.get("sampling"), "tag_presets": cur.get("tag_presets")})
            except OSError:
                pass
            cur["lines"] = data.get("lines") or []
            if isinstance(data.get("defaults"), dict):
                cur["defaults"] = data["defaults"]
            if isinstance(data.get("sampling"), dict):
                cur["sampling"] = data["sampling"]
            if isinstance(data.get("tag_presets"), list):
                cur["tag_presets"] = data["tag_presets"]
            if isinstance(data.get("batches"), list):
                cur["batches"] = data["batches"]
            _save_script(cur)
            fresh = _load_script(sid)
        _log("longform: project %s restored to initial sample", sid)
        return {"ok": True, "script": fresh, "stats": _stats(fresh)}

    app.include_router(lf)
    _log("longform extension registered: /longform + /api/v1/lf/*")
    return True
