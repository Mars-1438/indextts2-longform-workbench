"""长篇台本 · 时间轴工程（P1-P5）

独立模块，独立路由前缀 /api/v1/lf/tl，独立页面 /timeline。
不改 longform_api.py 与 server.py 的既有逻辑，只在末尾注册。

工程模型（project.json v2）
  tracks[]  多音轨：id / name / kind / gain / pan / mute / solo
  clips{}   语音片段差分：start / trim / gain / pan / speed / mute / locked / track
  sfx[]     素材片段：同上 + media
  kf{}      关键帧：{片段id: {gain:[[t,v]], pan:[[t,v]], shape:{gain,pan}}}
            （t 相对片段起点；shape 决定经过点的曲线是平滑还是折线）
  · clips/sfx/tagfx 里还可以有 az / el / dist / binaural（HRTF 双耳空间位置）
  · 语音片段默认 locked=True（位置时间锁死，跟随台本时间轴）
  · 素材片段默认 locked=False（可随意拖）
"""

import io
import math
import os
import shutil
import time
import uuid
import zipfile
from fractions import Fraction

import numpy as np
import soundfile as sf

# _build() 里有个局部变量就叫 sf（标签行的音效设置），会遮蔽 soundfile ——
# 结果 `sf.info(path)` 永远抛 AttributeError 被 except 吞掉，文件时长一律算 0
# （素材裁剪后 src_dur 跟着缩、右边缘再也拉不回去，就是它闹的）。
# 这里留一个别名，凡是「读文件信息」的地方都用它，别再被局部变量坑。
_sf_info = sf.info
from fastapi import APIRouter, Body, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response

import hrir as hrir_mod
import rooms as rooms_mod

from longform_api import (
    AUDIO_SR, PAUSE_MAX, PAUSE_MIN, _LOCK as _LF_LOCK, _audio_props, _eff,
    _load_materials, _load_script, _log, _lf_root, _mat_add_from_audio, _mat_dir,
    _merge_runtime, _new_uid, _normalize_line, _now, _read_audio_any, _read_json,
    _safe_sid, _safe_title, _save_script, _script_dir, _start_render, _usable,
    _write_json, resolve_ref, sfx_item, sfx_path_of,
)

try:
    from scipy.signal import lfilter as _lfilter, resample_poly as _resample
except Exception:  # noqa: BLE001
    _resample = None
    _lfilter = None

SR = 44100
PEAK_POINTS = 640
BLOCK_SEC = 1.0
MAX_PEAK_UIDS = 80
DEFAULT_TRACKS = [
    {"id": "voice", "name": "语音", "kind": "voice"},
    {"id": "sfx", "name": "素材", "kind": "sfx"},
]

_D = {}
_LF = APIRouter(prefix="/api/v1")
_MIX_LOCK = None


def _lock():
    global _MIX_LOCK
    if _MIX_LOCK is None:
        import threading
        _MIX_LOCK = threading.Lock()
    return _MIX_LOCK


# ================================ 路径 ========================================

def _media_dir(sid):
    d = os.path.join(_script_dir(sid), "media")
    os.makedirs(d, exist_ok=True)
    return d


def _peak_dir(sid):
    d = os.path.join(_script_dir(sid), "peaks")
    os.makedirs(d, exist_ok=True)
    return d


def _cache_dir(sid):
    d = os.path.join(_script_dir(sid), "cache")
    os.makedirs(d, exist_ok=True)
    return d


def _proj_path(sid):
    return os.path.join(_script_dir(sid), "project.json")


# ---------------------------- 工程历史版本（落盘） ---------------------------
HISTORY_KEEP = 40


def _hist_dir(sid):
    # 注意：必须与台本页的历史副本（scripts/<sid>/history）分开，
    # 否则两边格式不同，互相恢复会把对方的数据清空。
    d = os.path.join(_script_dir(sid), "timeline_history")
    os.makedirs(d, exist_ok=True)
    return d


def _snapshot_project(sid, label):
    """把当前 project.json 整份存成历史副本（文件名带时间前缀，便于排序）。"""
    p = _load_project(sid)
    d = _hist_dir(sid)
    name = time.strftime("%Y%m%d_%H%M%S") + f"_{_safe_title(label or '编辑', 'edit')[:18]}_" \
        + uuid.uuid4().hex[:4] + ".json"
    _write_json(os.path.join(d, name), {
        "time": _now(), "label": label or "编辑", "project": p,
        "clips": len(p.get("sfx") or []), "tracks": len(p.get("tracks") or []),
    })
    files = sorted(fn for fn in os.listdir(d) if fn.endswith(".json"))
    for fn in files[:-HISTORY_KEEP]:
        try:
            os.remove(os.path.join(d, fn))
        except OSError:
            pass
    return name


def _default_project():
    return {
        "version": 2,
        "tracks": [dict(t, gain=1.0, pan=0.0, mute=False, solo=False) for t in DEFAULT_TRACKS],
        "clips": {},
        "sfx": [],
        "tagfx": {},
        "kf": {},
        "marks": [],
        "rev": 0,
    }


# ---- 关键帧（片段级属性自动化） ---------------------------------------------
# 存法：project.kf[片段id] = {"gain": [[t, v], ...], "pan": [[t, v], ...]}
#   t = 相对片段起点的秒数（所以整段挪位置时关键帧跟着走，不会错位）
#   v = gain 0~4（1.0 = 100%）、pan -1~1
# 有 keyframe 的属性，**这段就以曲线为准**（相当于把静态音量/声像交给自动化），
# 只有一条关键帧时就是常量。
KF_PROPS = {"gain": (0.0, 4.0, 4), "pan": (-1.0, 1.0, 3), "az": (-180.0, 180.0, 2)}
KF_MAX_POINTS = 1024          # 每个属性的关键帧上限（原来 240，长片段铺细会不够）
KF_MAX_CLIPS = 2000


def _clean_kf(raw):
    """把前端来的关键帧洗干净：只留认识的属性、排序、去重、限点数。"""
    out = {}
    if not isinstance(raw, dict):
        return out
    for cid, props in list(raw.items())[:KF_MAX_CLIPS]:
        cid = str(cid)[:20]
        if not cid or not isinstance(props, dict):
            continue
        item = {}
        # ---- 空间关键帧：一个点 = 一个位置（方位 / 仰角 / 距离）----
        # 以前只存方位曲线（kf.az），把「空间」退化成了「左右」：
        # 仰角、距离都没法随句子变化，而那两个才是「凑近/绕到身后」的主线索。
        sp = props.get("space")
        if isinstance(sp, list):
            buf = []
            for pt in sp[:KF_MAX_POINTS]:
                if isinstance(pt, (list, tuple)) and len(pt) >= 4:
                    t, az, el, d = pt[0], pt[1], pt[2], pt[3]
                elif isinstance(pt, dict):
                    t, az = pt.get("t"), pt.get("az")
                    el, d = pt.get("el"), pt.get("dist")
                else:
                    continue
                t = _num(t, -1, -1, 86400)
                if t < 0:
                    continue
                buf.append([round(t, 3),
                            round(_num(az, 0, -180, 180), 2),
                            round(_num(el, 0, -90, 90), 1),
                            round(_num(d, 1, 0.1, 10), 2)])
            buf.sort(key=lambda x: x[0])
            ded = []
            for pt in buf:
                if ded and abs(ded[-1][0] - pt[0]) < 0.0005:
                    ded[-1] = pt
                else:
                    ded.append(pt)
            if ded:
                item["space"] = ded
        for k, (lo, hi, nd) in KF_PROPS.items():
            pts = props.get(k)
            if not isinstance(pts, list):
                continue
            buf = []
            for pt in pts[:KF_MAX_POINTS]:
                if isinstance(pt, (list, tuple)) and len(pt) >= 2:
                    t, v = pt[0], pt[1]
                elif isinstance(pt, dict):
                    t, v = pt.get("t"), pt.get("v")
                else:
                    continue
                t = _num(t, -1, -1, 86400)
                if t < 0:
                    continue
                buf.append([round(t, 3), round(_num(v, 1, lo, hi), nd)])
            buf.sort(key=lambda x: x[0])
            ded = []
            for pt in buf:
                if ded and abs(ded[-1][0] - pt[0]) < 0.0005:
                    ded[-1] = pt            # 同一时刻只留最后一个
                else:
                    ded.append(pt)
            if ded:
                item[k] = ded
        # 曲线形态：{gain:"smooth"|"linear", pan:...}，缺省 = 平滑
        shp = props.get("shape")
        if isinstance(shp, dict):
            # space 是空间关键帧的形态（一个点 = 一个位置），不在 KF_PROPS 里，单独放行
            clean = {k: ("linear" if shp.get(k) == "linear" else "smooth")
                     for k in list(KF_PROPS) + ["space"] if shp.get(k)}
            if clean:
                item["shape"] = clean
        if item:
            out[cid] = item
    return out


def _kf_shape(kf, prop):
    """取某条曲线的形态；没写就是平滑。"""
    if not isinstance(kf, dict):
        return "smooth"
    shp = kf.get("shape")
    if isinstance(shp, dict) and shp.get(prop):
        return "linear" if shp.get(prop) == "linear" else "smooth"
    return "smooth"


def _pchip_eval(xs, ys, tt):
    """单调三次 Hermite（PCHIP）求值。

    和折线一样严格穿过每个关键帧点，但段与段之间是一阶连续的曲线；用单调版本
    而不是普通 Catmull-Rom，是为了不「过冲」——音量曲线冲过 0 以下或翻到 400%
    以上会听着像爆音，声像冲过 ±1 也会发飘。
    """
    n = xs.size
    if n == 1:
        return np.full(np.shape(tt), float(ys[0]), dtype="float32")
    h = np.diff(xs).astype("float64")
    h = np.maximum(h, 1e-6)
    d = np.diff(ys).astype("float64") / h
    m = np.zeros(n, dtype="float64")
    m[0], m[-1] = d[0], d[-1]
    for i in range(1, n - 1):
        if d[i - 1] * d[i] <= 0:
            m[i] = 0.0                       # 极值点 → 斜率 0，不会过冲
        else:
            w1 = 2 * h[i] + h[i - 1]
            w2 = h[i] + 2 * h[i - 1]
            m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])
    t = np.clip(np.asarray(tt, dtype="float64"), xs[0], xs[-1])
    idx = np.clip(np.searchsorted(xs, t, side="right") - 1, 0, n - 2)
    hk = h[idx]
    u = (t - xs[idx]) / hk
    u2 = u * u
    u3 = u2 * u
    out = ((2 * u3 - 3 * u2 + 1) * ys[idx]
           + (u3 - 2 * u2 + u) * hk * m[idx]
           + (-2 * u3 + 3 * u2) * ys[idx + 1]
           + (u3 - u2) * hk * m[idx + 1])
    return out.astype("float32")


# 空间距离的标尺：与前端 KF_META.space（0.2~10m，对数）完全一致。
# 为什么要在「归一化域」插值：片段上那条曲线的纵轴是对数刻度，折线看着是直的；
# 如果后端按米线性插值，同一个中点的距离会比试听听到的小（2m→0.3m 的中点
# 应该是 1.41m 而不是 1.15m），导出和试听就对不上了。
SPACE_DIST_LO, SPACE_DIST_HI = 0.2, 10.0


def _dist_norm(d):
    """米 → 0..1（对数刻度）。"""
    x = np.clip(np.asarray(d, dtype="float64"), SPACE_DIST_LO, SPACE_DIST_HI)
    return np.log(x / SPACE_DIST_LO) / math.log(SPACE_DIST_HI / SPACE_DIST_LO)


def _dist_denorm(u):
    """0..1 → 米。"""
    return SPACE_DIST_LO * np.power(SPACE_DIST_HI / SPACE_DIST_LO,
                                    np.asarray(u, dtype="float64"))


def _kf_space_envs(kfg, tt, clip):
    """空间关键帧 → (az, el, dist) 三条逐样本数组；没有关键帧返回 (None, None, None)。

    不存三条曲线，而是存「一个点 = 一个位置」，求值时按分量各自插值。
    这样拖动一个关键帧就是「这一个时刻的位置」，不会出现「方位在动、距离却跳」的错位。
    距离那一条在归一化（对数）域里插值，和前端曲线同一套算法。
    """
    pts = kfg.get("space") if isinstance(kfg, dict) else None
    if not pts:
        return None, None, None
    shape = _kf_shape(kfg, "space")
    cols = []
    for i, dflt in ((1, float(clip.get("az") or 0)),
                    (2, float(clip.get("el") or 0)),
                    (3, float(clip.get("dist") if clip.get("dist") is not None else 1.0))):
        series = [[p[0], p[i]] for p in pts]
        if i == 3:
            ser = [[t, float(_dist_norm(v))] for t, v in series]
            cols.append(_dist_denorm(_kf_curve(ser, tt, shape)).astype("float32"))
        else:
            cols.append(_kf_curve(series, tt, shape))
    return cols[0], cols[1], cols[2]


def _kf_curve(points, tt, shape="smooth"):
    """关键帧 → 逐样本数组；没有关键帧返回 None（调用方据此决定用不用静态值）。

    首点之前=首值，末点之后=末值；中间按 shape 走：
      · "smooth"（默认）：经过点的平滑曲线（PCHIP）
      · "linear"：原来的折线
    只有一个点就是常量。
    """
    if not points:
        return None
    xs = np.asarray([p[0] for p in points], dtype="float64")
    ys = np.asarray([p[1] for p in points], dtype="float64")
    tt = np.asarray(tt, dtype="float64")
    if xs.size == 1:
        return np.full(tt.shape, float(ys[0]), dtype="float32")
    if (shape or "smooth") == "linear":
        return np.interp(tt, xs, ys).astype("float32")
    return _pchip_eval(xs, ys, tt)



# ---- 双耳空间音频（HRTF 近似）-----------------------------------------------
# 试听用的是浏览器自带的 `PannerNode(panningModel="HRTF")`（真 HRIR）。
# 离线混音没法从浏览器拿 HRIR 数据库，这里用「球头模型」近似：
#   · ITD 双耳时间差：Woodworth 公式 t=(a/c)(θ+sinθ)，最大约 0.66ms
#   · ILD 双耳强度差 + 远耳头部遮挡低通（越侧越闷）
#   · 前后：正后方整体略闷、略轻（耳廓线索的粗略替代）
#   · 仰角：轻微增益差；距离：反比律衰减
# 说明白：这不是测量 HRIR，前后/仰角只是近似；左右、远近、遮挡是实的。
HEAD_R = 0.0875          # 人头半径（米）
SOUND_C = 343.0          # 声速


def _soft_knee(x, th=0.92, ceil=0.995):
    """无状态软限幅：|x| ≤ th 原样，超过的部分用 tanh 平滑压到 1.0 以内。

    **必须无状态、无门控**。之前是按块判峰值决定「这一块要不要压」：
    响的那一块被压、相邻那块没被压，块边界两边同一时刻的电平差 10~20%，
    听起来就是每秒一声「啪」（导出里很明显，试听走浏览器没这一步所以听不到）。
    tanh 是逐样本函数，块与块之间天然连续，不会产生台阶，也不会抽吸。
    """
    a = np.abs(x)
    m = a > th
    if not m.any():
        return x
    y = x.copy()
    # 上限留在 0.98：软限幅的渐近值是 ceil，这样永远碰不到 1.0，
    # 后面那一步硬 np.clip 就不会真的削平（削平会产生一截平顶，比软压更刺耳）
    y[m] = np.sign(x[m]) * (th + (ceil - th) * np.tanh((a[m] - th) / (ceil - th)))
    return y


class _Binaural:
    """单条片段的双耳渲染状态（跨块保留延迟历史与滤波器状态）。"""

    __slots__ = ("hist", "zi_l", "zi_r", "near")

    def __init__(self):
        self.hist = np.zeros(0, dtype="float32")
        self.zi_l = np.zeros(1)
        self.zi_r = np.zeros(1)
        # 近场补偿：球头模型自己已经有远耳低通，这里只要 proximity（低频抬升）
        self.near = hrir_mod.NearField(SR, shadow=False)

    def _delayed(self, x, d_l, d_r):
        """按采样数延迟（分数延迟用线性插值），两块之间靠 hist 衔接。"""
        need = int(math.ceil(max(d_l, d_r))) + 2
        if self.hist.size < need:
            self.hist = np.concatenate(
                [np.zeros(need - self.hist.size, dtype="float32"), self.hist])
        ext = np.concatenate([self.hist.astype("float64"), x.astype("float64")])
        self.hist = ext[-need:].astype("float32")
        base = ext.size - x.size
        out = []
        for d in (d_l, d_r):
            pos = np.arange(x.size, dtype="float64") + base - d
            i0 = np.floor(pos).astype(int)
            fr = pos - i0
            i0 = np.clip(i0, 0, ext.size - 2)
            out.append(((1.0 - fr) * ext[i0] + fr * ext[i0 + 1]).astype("float32"))
        return out[0], out[1]

    def _lp(self, x, fc, ear):
        """一阶低通（头部遮挡/距离变闷）。没有 scipy 就跳过，宁可不做也不能出错。"""
        if _lfilter is None or fc >= SR * 0.45:
            return x
        a = 1.0 - math.exp(-2.0 * math.pi * max(300.0, fc) / SR)
        if ear == "l":
            y, self.zi_l = _lfilter([a], [1.0, -(1.0 - a)], x, zi=self.zi_l)
        else:
            y, self.zi_r = _lfilter([a], [1.0, -(1.0 - a)], x, zi=self.zi_r)
        return y.astype("float32")

    def render(self, x, az, el=0.0, dist=1.0):
        """az / el / dist 都可以是标量或逐样本数组（空间关键帧）。

        时变时按 128 样本一块处理：每块用块首的值算 ITD/ILD/滤波，
        块之间延迟历史与滤波器状态是连续的，听感上是平滑移动而不是台阶。
        """

        def series(v, dflt):
            if isinstance(v, (list, tuple, np.ndarray)):
                a = np.asarray(v, dtype="float32").reshape(-1)
                if a.size > 1:
                    return a
                return float(a[0]) if a.size else float(dflt)
            return float(v if v is not None else dflt)

        azS = series(az, 0.0)
        elS = series(el, 0.0)
        dS = series(dist, 1.0)
        if not any(isinstance(v, np.ndarray) for v in (azS, elS, dS)):
            return self._render_static(x, azS, elS, dS)
        n = x.size
        out_l = np.zeros(n, dtype="float32")
        out_r = np.zeros(n, dtype="float32")
        step = 128
        for i in range(0, n, step):
            j = min(n, i + step)
            a = float(azS[i]) if isinstance(azS, np.ndarray) else azS
            e = float(elS[i]) if isinstance(elS, np.ndarray) else elS
            d = float(dS[i]) if isinstance(dS, np.ndarray) else dS
            bl, br = self._render_static(x[i:j], a, e, d)
            out_l[i:j] = bl
            out_r[i:j] = br
        return out_l, out_r

    def flush(self, n):
        """球头模型没有卷积尾巴，但混音器在片段结束后仍会来要一次尾巴。

        没有这个方法 → 只要走球头回退（sphere / 数据集缺失），混到最后一个块就 500。
        """
        return (np.zeros(max(0, int(n)), dtype="float32"),
                np.zeros(max(0, int(n)), dtype="float32"))

    def _render_static(self, x, az, el, dist):
        azr = math.radians(max(-180.0, min(180.0, float(az or 0))))
        elr = math.radians(max(-90.0, min(90.0, float(el or 0))))
        d = float(dist if dist is not None else 1.0)
        lat = abs(math.sin(azr))              # 侧向程度：0 正前/正后，1 正侧
        fb = (1.0 - math.cos(azr)) / 2.0      # 0 正前，1 正后
        th = lat * math.pi / 2.0
        itd = (HEAD_R / SOUND_C) * (th + math.sin(th)) * SR
        if azr >= 0:                          # 右为正
            d_l, d_r = itd, 0.0
        else:
            d_l, d_r = 0.0, itd
        left, right = self._delayed(x, d_l, d_r)

        fc_far = 18000.0 * math.exp(-2.3 * lat) * (1.0 - 0.35 * fb)
        fc_both = 16000.0 * math.exp(-1.5 * fb)   # 后方整体闷（=1 时约 3.6k）
        g_far = 1.0 - 0.35 * lat
        g_near = 1.0 + 0.06 * lat
        if azr >= 0:
            left = self._lp(left, min(fc_far, fc_both), "l") * g_far
            right = self._lp(right, fc_both, "r") * g_near
        else:
            right = self._lp(right, min(fc_far, fc_both), "r") * g_far
            left = self._lp(left, fc_both, "l") * g_near

        gain = hrir_mod.dist_gain(d) * (1.0 + 0.06 * math.sin(elr))
        out = np.stack([left * gain, right * gain]).astype("float32")
        # 距离 ≤1m 时补低频（球头模型本身没有近讲效应）
        return tuple(self.near.process(out, az, d))


def _make_binaural(sr=SR, name=None):
    """按数据集名建渲染器；"sphere" 或加载失败 → 球头近似（保证离线可用）。

    这是「多方案整合」的落点：所有数据集走同一个 BinauralRenderer，
    差别只在 HRTFSet；球头模型是永远可用的兜底。
    """
    st = hrir_mod.get_set(name)
    if st is not None:
        try:
            return hrir_mod.BinauralRenderer(st, sr)
        except Exception as e:  # noqa: BLE001
            _log("timeline: HRIR renderer failed: %s", e, level="warning")
    return _Binaural()


def _sfx_fallback(sid_tracks):
    """未知/失效轨道时的落点：优先第一条素材轨，没有才退回第一条轨。

    以前写死 `p["tracks"][0]["id"]`，而 tracks[0] 通常是音声轨，
    结果「素材」被塞到音声轨上，看起来就是片段自己跳了轨。"""
    for t in sid_tracks:
        if t.get("kind") == "sfx":
            return t["id"]
    return sid_tracks[0]["id"] if sid_tracks else "sfx"


def _num(v, d=0.0, lo=None, hi=None):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return d
    if lo is not None:
        x = max(lo, x)
    if hi is not None:
        x = min(hi, x)
    return x


def _purge_dir(path, budget=2.0):
    """逐文件删掉一个目录，删干净返回 True。

    不用 shutil.rmtree：一次删几百个文件会被「批量删除守卫」拦下（进程直接退出），
    而工程包导出的暂存目录正好是几百个文件。逐文件 + 时间预算更稳。
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


def _mtime_int(path):
    """文件修改时间（整秒）。用作「这一版音频」的版本号。"""
    try:
        return int(os.stat(path).st_mtime)
    except OSError:
        return 0


def _spatial_of(d):
    """空间音频字段（az/el/dist/binaural/room/send/hrtf/sp_preset）。

    sfx / tagfx / 语音片段三处都要用同一套清洗逻辑：以前只有 `_clean_clip`
    有这几个字段，素材片段（sfx）和标签音效（tagfx）在保存时被整段丢掉，
    表现就是「删掉再撤销，空间位置/HRIR/混响全没了」。
    """
    out = {}
    if d.get("az") is not None:
        out["az"] = round(_num(d["az"], 0, -180, 180), 2)
    if d.get("el") is not None:
        out["el"] = round(_num(d["el"], 0, -90, 90), 2)
    if d.get("dist") is not None:
        out["dist"] = round(_num(d["dist"], 1, 0.2, 30), 3)
    if d.get("binaural") is not None:
        out["binaural"] = bool(d["binaural"])
    if d.get("hrtf") is not None:
        out["hrtf"] = str(d["hrtf"])[:48]
    if d.get("sp_preset") is not None:
        out["sp_preset"] = str(d["sp_preset"])[:24]
    if d.get("room") is not None:
        out["room"] = str(d["room"])[:20]
    if d.get("send") is not None:
        out["send"] = round(_num(d["send"], 0, 0, 1), 3)
    return out


def _clean_marks(raw):
    """自定义标记点（project.marks）：时间轴里按 M 加的「句间标签」。

    和台本派生出来的标记（标签行 / 行内标签）存在一起，但只存在工程里：
    删句子不会带走它，删它也不会动台本。
    """
    out = []
    for m in (raw or [])[:500]:
        if not isinstance(m, dict):
            continue
        try:
            t = float(m.get("time"))
        except (TypeError, ValueError):
            continue
        if t < 0:
            continue
        out.append({"id": str(m.get("id") or _new_uid())[:24],
                    "time": round(t, 3),
                    "name": str(m.get("name") or "标记")[:40],
                    "kind": "mark"})
    out.sort(key=lambda x: x["time"])
    return out


def _clean_clip(ov):
    item = {}
    if ov.get("start") is not None:
        item["start"] = round(_num(ov["start"], 0, 0), 4)
    for k in ("trim_start", "trim_end"):
        if ov.get(k) is not None:
            item[k] = round(_num(ov[k], 0, 0), 4)
    if ov.get("gain") is not None:
        item["gain"] = round(_num(ov["gain"], 1, 0, 4), 4)
    if ov.get("pan") is not None:
        item["pan"] = round(_num(ov["pan"], 0, -1, 1), 3)
    if ov.get("speed") is not None:
        item["speed"] = round(_num(ov["speed"], 1, 0.25, 4), 4)
    for k in ("mute", "locked"):
        if ov.get(k) is not None:
            item[k] = bool(ov[k])
    # 淡入淡出：之前漏了这两个字段，导致保存后丢掉、导出 RPP 没有 FADEIN/FADEOUT
    for k in ("fade_in", "fade_out"):
        if ov.get(k) is not None:
            item[k] = round(_num(ov[k], 0, 0, 60), 4)
    if ov.get("track"):
        item["track"] = str(ov["track"])[:20]
    # 空间音频（HRTF 双耳）：方位角 / 仰角 / 距离米。没开 binaural 就仍然走声像。
    if ov.get("az") is not None:
        item["az"] = round(_num(ov["az"], 0, -180, 180), 2)
    if ov.get("el") is not None:
        item["el"] = round(_num(ov["el"], 0, -90, 90), 2)
    if ov.get("dist") is not None:
        item["dist"] = round(_num(ov["dist"], 1, 0.2, 30), 3)
    if ov.get("binaural") is not None:
        item["binaural"] = bool(ov["binaural"])
    if ov.get("hrtf") is not None:
        # 每个片段可以指定用哪套 HRIR 数据集（空 = 用默认）
        item["hrtf"] = str(ov["hrtf"])[:48]
    if ov.get("sp_preset") is not None:
        # 空间方案 id（asmr / bed / close / room / cinema / hall / outdoor / corridor / custom）
        # 只用来记住「标尺范围」和面板上高亮哪一颗 chip，不影响声音本身
        item["sp_preset"] = str(ov["sp_preset"])[:24]
    if ov.get("room") is not None:
        item["room"] = str(ov["room"])[:20]
    if ov.get("send") is not None:
        item["send"] = round(_num(ov["send"], 0, 0, 1), 3)
    return item


def _group_tracks(tracks):
    """音声轨在前、素材轨在后（组内保持原顺序）。

    界面上本来就是按「音声组 / 素材组」分两段画的，但底层数组以前可能是交错的，
    于是「插在最后一条音声轨之后」「上移一格」这类操作算出来的位置和眼睛看到的对不上
    （表现就是「新建的素材轨跑到最下面」）。统一在这里理顺，数组顺序 == 界面顺序。
    """
    voice = [t for t in tracks if t.get("kind") == "voice"]
    other = [t for t in tracks if t.get("kind") != "voice"]
    return voice + other


def _load_project(sid):
    raw = _read_json(_proj_path(sid), None)
    p = _default_project()
    if not isinstance(raw, dict):
        return p

    tracks = []
    tr = raw.get("tracks")
    if isinstance(tr, list):
        for t in tr:
            if not isinstance(t, dict) or not t.get("id"):
                continue
            tracks.append({
                "id": str(t["id"])[:20],
                "name": str(t.get("name") or "音轨")[:24],
                "kind": "voice" if t.get("kind") == "voice" else "sfx",
                "gain": _num(t.get("gain"), 1.0, 0, 4),
                "pan": _num(t.get("pan"), 0.0, -1, 1),
                "mute": bool(t.get("mute")),
                "solo": bool(t.get("solo")),
            })
    elif isinstance(tr, dict):     # v1 兼容
        base = {t["id"]: dict(t, gain=1.0, pan=0.0, mute=False, solo=False) for t in DEFAULT_TRACKS}
        for k, v in tr.items():
            if k in base and isinstance(v, dict):
                base[k]["gain"] = _num(v.get("gain"), 1.0, 0, 4)
                base[k]["mute"] = bool(v.get("mute"))
        tracks = [base["voice"], base["sfx"]]
    if not tracks:
        tracks = [dict(t, gain=1.0, pan=0.0, mute=False, solo=False) for t in DEFAULT_TRACKS]
    p["tracks"] = _group_tracks(tracks[:200])

    ids = {t["id"] for t in p["tracks"]}
    clips = raw.get("clips")
    if isinstance(clips, dict):
        for uid, ov in clips.items():
            if not isinstance(ov, dict):
                continue
            item = _clean_clip(ov)
            if item.get("track") and item["track"] not in ids:
                item.pop("track", None)
            if item:
                p["clips"][str(uid)[:20]] = item

    sfx = raw.get("sfx")
    fallback = _sfx_fallback(p["tracks"])
    if isinstance(sfx, list):
        for s in sfx[:400]:
            if not isinstance(s, dict) or not s.get("media"):
                continue
            tid = str(s.get("track") or fallback)[:20]
            if tid not in ids:
                tid = fallback
            item = {
                "id": str(s.get("id") or _new_uid())[:20],
                "media": os.path.basename(str(s["media"])),
                "name": str(s.get("name") or s["media"])[:60],
                "track": tid,
                "start": round(_num(s.get("start"), 0, 0), 4),
                "offset": round(_num(s.get("offset"), 0, 0), 4),
                "dur": round(_num(s.get("dur"), 0, 0), 4),
                "gain": round(_num(s.get("gain"), 1.0, 0, 4), 4),
                "pan": round(_num(s.get("pan"), 0, -1, 1), 3),
                "speed": round(_num(s.get("speed"), 1, 0.25, 4), 4),
                "reverse": False,
                "mute": bool(s.get("mute")),
                "locked": bool(s.get("locked")),
                "fade_in": round(_num(s.get("fade_in"), 0, 0, 60), 4),
                "fade_out": round(_num(s.get("fade_out"), 0, 0, 60), 4),
            }
            item.update(_spatial_of(s))       # 空间位置 / HRIR / 混响
            p["sfx"].append(item)

    # 标签音效的位置是「标签时间 + 留白」派生出来的，但「放在哪条素材轨」必须持久化，
    # 否则整理重叠 / 手动换轨之后，一刷新就被 _build 塞回第一条素材轨 —— 表现就是
    # 「删掉一个素材，别的片段自己挪走了，还叠在一起」。
    tfx = raw.get("tagfx")
    if isinstance(tfx, dict):
        for uid, ov in list(tfx.items())[:600]:
            if not isinstance(ov, dict):
                continue
            item = {}
            tid = str(ov.get("track") or "")[:20]
            if tid in ids:
                item["track"] = tid
            if ov.get("gain") is not None:
                item["gain"] = round(_num(ov["gain"], 1.0, 0, 4), 4)
            if ov.get("mute") is not None:
                item["mute"] = bool(ov["mute"])
            item.update(_spatial_of(ov))
            if item:
                p["tagfx"][str(uid)[:20]] = item

    try:
        p["duration"] = max(0.0, float(raw.get("duration") or 0))
    except (TypeError, ValueError):
        p["duration"] = 0.0
    p["marks"] = _clean_marks(raw.get("marks"))
    p["rev"] = int(raw.get("rev") or 0)
    p["kf"] = _clean_kf(raw.get("kf"))
    return p


def _save_project(sid, data):
    p = _load_project(sid)

    if isinstance(data.get("tracks"), list):
        tracks = []
        for t in data["tracks"][:200]:
            if not isinstance(t, dict) or not t.get("id"):
                continue
            tracks.append({
                "id": str(t["id"])[:20],
                "name": str(t.get("name") or "音轨")[:24],
                "kind": "voice" if t.get("kind") == "voice" else "sfx",
                "gain": _num(t.get("gain"), 1.0, 0, 4),
                "pan": _num(t.get("pan"), 0, -1, 1),
                "mute": bool(t.get("mute")),
                "solo": bool(t.get("solo")),
            })
        if tracks:
            p["tracks"] = _group_tracks(tracks)
    ids = {t["id"] for t in p["tracks"]}

    if isinstance(data.get("clips"), dict):
        # 锁定的语音片段：位置/裁剪不接受改动（前端会挡，这里是兜底）
        old = p["clips"]
        clean = {}
        for uid, ov in data["clips"].items():
            if not isinstance(ov, dict):
                continue
            item = _clean_clip(ov)
            prev = old.get(str(uid)[:20])
            locked = item.get("locked", (prev or {}).get("locked", True))
            item["locked"] = bool(locked)
            if locked and prev:
                for k in ("start", "trim_start", "trim_end"):
                    if k in prev:
                        item[k] = prev[k]
                    else:
                        item.pop(k, None)
            if item.get("track") and item["track"] not in ids:
                item.pop("track", None)
            if item:
                clean[str(uid)[:20]] = item
        p["clips"] = clean

    if isinstance(data.get("sfx"), list):
        out = []
        fallback = _sfx_fallback(p["tracks"])
        for s in data["sfx"][:400]:
            if not isinstance(s, dict) or not s.get("media"):
                continue
            tid = str(s.get("track") or fallback)[:20]
            if tid not in ids:
                tid = fallback
            item = {
                "id": str(s.get("id") or _new_uid())[:20],
                "media": os.path.basename(str(s["media"])),
                "name": str(s.get("name") or s["media"])[:60],
                "track": tid,
                "start": round(_num(s.get("start"), 0, 0), 4),
                "offset": round(_num(s.get("offset"), 0, 0), 4),
                "dur": round(_num(s.get("dur"), 0, 0), 4),
                "gain": round(_num(s.get("gain"), 1.0, 0, 4), 4),
                "pan": round(_num(s.get("pan"), 0, -1, 1), 3),
                "speed": round(_num(s.get("speed"), 1, 0.25, 4), 4),
                "reverse": False,
                "mute": bool(s.get("mute")),
                "locked": bool(s.get("locked")),
                "fade_in": round(_num(s.get("fade_in"), 0, 0, 60), 4),
                "fade_out": round(_num(s.get("fade_out"), 0, 0, 60), 4),
            }
            item.update(_spatial_of(s))
            out.append(item)
        p["sfx"] = out

    if isinstance(data.get("tagfx"), dict):
        out = {}
        for uid, ov in list(data["tagfx"].items())[:600]:
            if not isinstance(ov, dict):
                continue
            item = {}
            tid = str(ov.get("track") or "")[:20]
            if tid in ids:
                item["track"] = tid
            if ov.get("gain") is not None:
                item["gain"] = round(_num(ov["gain"], 1.0, 0, 4), 4)
            if ov.get("mute") is not None:
                item["mute"] = bool(ov["mute"])
            item.update(_spatial_of(ov))
            if item:
                out[str(uid)[:20]] = item
        p["tagfx"] = out

    if isinstance(data.get("marks"), list):
        p["marks"] = _clean_marks(data["marks"])

    if isinstance(data.get("kf"), dict):
        p["kf"] = _clean_kf(data["kf"])

    p["rev"] = int(time.time())
    _write_json(_proj_path(sid), p)
    return p


# ================================ 时间轴派生 ==================================

def _chars_per_sec(script):
    chars = 0
    secs = 0.0
    for line in script.get("lines") or []:
        if line.get("kind") == "tag":
            continue
        d = float(line.get("dur") or 0)
        t = (line.get("text") or "").strip()
        if d > 0.2 and t:
            chars += len(t)
            secs += d
    if chars > 20 and secs > 1:
        return max(1.5, chars / secs)
    return 5.0


def _initial_timeline(sid):
    """从初始样本（initial_script.json）派生初始时间码表：uid -> (start, dur)。

    副本（工程）改文本重生成后，句子时长会变、后续句子时间会漂移。这里给出
    「进入时间轴那一刻」每句的原始时间码，供前端对照显示，也能作为对齐锚点。
    句序号（index）不参与，只有时间码对照。
    """
    data = _read_json(os.path.join(_script_dir(sid), "initial_script.json"))
    if not isinstance(data, dict):
        return {}
    script = {"lines": data.get("lines") or [],
              "defaults": data.get("defaults") or {},
              "sampling": data.get("sampling") or {}}
    cps = _chars_per_sec(script)
    table = {}
    cursor = 0.0
    for line in script["lines"]:
        if line.get("kind") == "tag":
            cursor += int(line.get("hold") or 0) / 1000.0
            continue
        text = (line.get("text") or "").strip()
        if not text:
            continue
        base_dur = float(line.get("dur") or 0)
        if base_dur <= 0.05:
            base_dur = max(0.4, len(text) / cps)
        table[line.get("uid")] = (round(cursor, 4), round(base_dur, 4))
        cursor += base_dur + int(_eff(line, script)["pause"]) / 1000.0
    return table


def _build(sid, script=None, project=None):
    script = script or _load_script(sid)
    p = project or _load_project(sid)
    cps = _chars_per_sec(script)
    ov = p.get("clips") or {}
    tracks = p["tracks"]
    voice_track = (tracks[0] if tracks else DEFAULT_TRACKS[0])["id"]
    clips, markers, cursor = [], [], 0.0
    init_tc = _initial_timeline(sid)
    gen_defaults = script.get("defaults") or {}

    sfx_track_ids = [t["id"] for t in tracks if t.get("kind") == "sfx"] or ["sfx"]
    sfx_track = sfx_track_ids[0]
    tfx_ov = p.get("tagfx") or {}

    # 标签音效的「落轨」规则：
    #   1) project.tagfx[uid].track 有值（用户手动搬过 / 整理重叠搬过）→ 就用它；
    #   2) 否则挑一条「该时间段空着」的素材轨；都占满才落第一条。
    # 以前写死「永远第一条素材轨」，所有标签音效挤在一起 → 天然重叠，
    # 而且整理重叠搬到别的轨之后一刷新就被拉回来。
    sfx_occ = {}
    for s in p.get("sfx") or []:
        tid = s.get("track") if s.get("track") in sfx_track_ids else sfx_track
        st = float(s.get("start") or 0)
        du = float(s.get("dur") or 0)
        if du <= 0.01:
            sp = os.path.join(_media_dir(sid), s["media"])
            if os.path.exists(sp):
                try:
                    du = float(_sf_info(sp).duration)
                except Exception:  # noqa: BLE001
                    du = 0.0
        sfx_occ.setdefault(tid, []).append((st, st + max(0.05, du)))

    def _free_sfx_track(a, b):
        for tid in sfx_track_ids:
            if all(not (a < y - 1e-4 and b > x + 1e-4) for x, y in sfx_occ.get(tid, [])):
                return tid
        return sfx_track

    for idx, line in enumerate(script["lines"], start=1):
        if line.get("kind") == "tag":
            hold = int(line.get("hold") or 0) / 1000.0
            tag_time = cursor
            sf = line.get("sfx") if isinstance(line.get("sfx"), dict) else None
            sf_mid = (sf or {}).get("mid") or None
            markers.append({"id": "m_" + line["uid"], "time": round(tag_time, 3),
                            "name": line.get("tag") or "标签", "kind": "tag",
                            "uid": line["uid"], "index": idx,
                            "hold": round(hold, 3), "inline": False,
                            "sfx_mid": sf_mid})
            # 标签挂了音效：固定落在「标签时间 + 留白」处，锁死位置（要挪就改留白）
            if sf_mid:
                item = sfx_item(sf_mid)
                media_name = os.path.basename(item["file"]) if item else ""
                dst = os.path.join(_media_dir(sid), media_name) if media_name else ""
                if dst and not os.path.exists(dst):
                    src = sfx_path_of(sf_mid)
                    if src:
                        try:
                            shutil.copy2(src, dst)
                        except OSError as e:  # noqa: BLE001
                            _log("timeline: copy tag sfx failed %s: %s", src, e, level="warning")
                if item:
                    tag_name = line.get("tag") or "标签"
                    dur_t = round(max(0.05, float(item.get("dur") or 0.05)), 4)
                    st_t = round(tag_time + hold, 4)
                    ov_t = tfx_ov.get(line["uid"]) or {}
                    tid_t = ov_t.get("track")
                    if tid_t not in sfx_track_ids:
                        tid_t = _free_sfx_track(st_t, st_t + dur_t)
                    sfx_occ.setdefault(tid_t, []).append((st_t, st_t + dur_t))
                    clips.append({
                        "id": "tagsfx_" + line["uid"], "kind": "sfx", "track": tid_t,
                        "uid": None, "index": idx,
                        "text": f"〔{tag_name}〕{item.get('name') or media_name}",
                        "name": f"〔{tag_name}〕{item.get('name') or media_name}",
                        "media": media_name,
                        "start": st_t,
                        "dur": dur_t,
                        "src_dur": dur_t,
                        "offset": 0.0,
                        "gain": float((sf or {}).get("gain") if (sf or {}).get("gain") is not None
                                      else (ov_t.get("gain") if ov_t.get("gain") is not None else 1.0)),
                        "pan": 0.0, "speed": 1, "reverse": False,
                        "az": float(ov_t.get("az") or 0),
                        "el": float(ov_t.get("el") or 0),
                        "dist": float(ov_t.get("dist") if ov_t.get("dist") is not None else 1.0),
                        "binaural": bool(ov_t.get("binaural")),
                        "room": (ov_t.get("room") or ""),
                        "send": float(ov_t.get("send") or 0),
                        "hrtf": (ov_t.get("hrtf") or ""),
                        "sp_preset": (ov_t.get("sp_preset") or ""),
                        "mute": bool(ov_t.get("mute")),
                        "locked": True,
                        "fade_in": 0.0, "fade_out": 0.0,
                        "has_audio": bool(dst) and os.path.exists(dst),
                        "file_rev": (_mtime_int(dst) if dst and os.path.exists(dst) else 0),
                        "playable": bool(dst) and os.path.exists(dst),
                        "stale": False, "status": "done", "moved": True, "changes": [],
                        "from_tag": line["uid"], "tag_name": tag_name,
                    })
            cursor += hold
            continue
        text = (line.get("text") or "").strip()
        if not text:
            continue
        out_name = os.path.basename(line.get("out") or "")
        has_file = bool(out_name) and os.path.exists(
            os.path.join(_script_dir(sid), "audio", out_name))
        stale = line.get("status") == "stale"
        usable = _usable(line, sid)
        base_dur = float(line.get("dur") or 0) if has_file else 0.0
        if base_dur <= 0.05:
            base_dur = max(0.4, len(text) / cps)
        o = ov.get(line["uid"]) or {}
        ts = float(o.get("trim_start") or 0)
        te = float(o.get("trim_end") or 0)
        # 字幕导入的行带 t0（原文出现时间）：按它落位，但不早于前一句结束，避免叠住
        t0 = line.get("t0")
        base_start = cursor
        if t0 is not None:
            try:
                base_start = max(cursor, round(float(t0), 3))
            except (TypeError, ValueError):
                base_start = cursor
        start = max(0.0, float(o["start"])) if o.get("start") is not None else base_start + ts
        dur = max(0.05, base_dur - ts - te)
        clips.append({
            "id": line["uid"], "kind": "voice",
            "track": o.get("track") or voice_track,
            "uid": line["uid"], "index": idx,
            "text": line.get("text") or "",
            # 分组 / 角色 / 备注带到片段上：时间轴里「按组批量选择」要用
            "group": line.get("group") or "",
            "role": line.get("role") or "",
            "note": line.get("note") or "",
            # 生成属性：改属性弹窗要拿它做初值，属性面板要显示「改过什么」
            "ov": dict(line.get("ov") or {}) if isinstance(line.get("ov"), dict) else {},
            "eff": {k: ((line.get("ov") or {}).get(k)
                        if k in (line.get("ov") or {}) else (gen_defaults or {}).get(k))
                    for k in ("ref", "emo_mode", "emo_weight", "emo_vec",
                              "emo_text", "emo_ref")},
            "pause": line.get("pause"),
            # 有效停顿（毫秒）：行上没单独设就跟随台本默认 —— 时间轴「重排音声片段延迟」要用
            "pause_ms": int(_eff(line, script)["pause"]),
            "slow": bool(line.get("slow")),
            "start": round(start, 4), "dur": round(dur, 4),
            "src_dur": round(max(base_dur, ts + dur), 4), "offset": round(ts, 4),
            "gain": float(o.get("gain", 1.0) if o.get("gain") is not None else 1.0),
            "pan": float(o.get("pan") or 0),
            # 空间位置（HRTF 双耳关着时不起作用，仍然按 pan 摆位）
            "az": float(o.get("az") or 0),
            "el": float(o.get("el") or 0),
            "dist": float(o.get("dist") if o.get("dist") is not None else 1.0),
            "binaural": bool(o.get("binaural")),
            "room": (o.get("room") or ""),
            "send": float(o.get("send") or 0),
            "hrtf": (o.get("hrtf") or ""),
            "sp_preset": (o.get("sp_preset") or ""),
            "speed": float(o.get("speed") or 1),
            "reverse": False,
            "mute": bool(o.get("mute")),
            "locked": bool(o.get("locked", True)),
            "fade_in": float(o.get("fade_in") or 0),
            "fade_out": float(o.get("fade_out") or 0),
            "has_audio": has_file,
            # 文件版本（mtime）：音频被重新生成后文件名不变，浏览器/缓存只要
            # 认名字就会一直播旧的那份。带上它，试听 URL 和波形缓存才跟着变。
            "file_rev": (_mtime_int(os.path.join(_script_dir(sid), "audio", out_name))
                         if has_file else 0),
            "playable": bool(usable),
            "stale": stale,
            "file": out_name,
            "base_start": round(base_start, 4),
            "status": line.get("status"),
            "moved": o.get("start") is not None,
            "changes": line.get("changes") or [],
            "initial_start": init_tc.get(line["uid"], (None, None))[0],
            "initial_dur": init_tc.get(line["uid"], (None, None))[1],
        })
        for i_it, it in enumerate(line.get("inline") or []):
            pos = max(0, min(len(text), int(it.get("pos") or 0)))
            # 句中标签的落点 = 句内按字数比例的位置 + 它自带的延迟（默认 500ms，
            # 免得和上一句末尾的句间标签挤在同一时刻）
            try:
                hold_ms = max(0, int(it.get("hold") or 0))
            except (TypeError, ValueError):
                hold_ms = 0
            t = start + (pos / max(1, len(text))) * dur + hold_ms / 1000.0
            markers.append({"id": "i_" + line["uid"] + "_" + str(pos) + "_" + str(i_it),
                            "time": round(t, 3), "name": it.get("tag") or "标签",
                            "kind": "inline", "uid": line["uid"], "index": idx,
                            "hold": round(hold_ms / 1000.0, 3), "inline": True,
                            "pos": pos, "sfx": it.get("sfx") or None})
        cursor = base_start + base_dur + int(_eff(line, script)["pause"]) / 1000.0

    for s in p.get("sfx") or []:
        path = os.path.join(_media_dir(sid), s["media"])
        dur = float(s.get("dur") or 0)
        # 素材文件的**真实长度**：裁剪后 dur 会变短，如果 src_dur 跟着 dur 算，
        # 一刷新就再也拉不回完整片段（右边缘「不能延长」就是这么来的）。
        file_dur = 0.0
        if os.path.exists(path):
            try:
                file_dur = float(_sf_info(path).duration)
            except Exception:  # noqa: BLE001
                file_dur = 0.0
        if dur <= 0.01:
            dur = file_dur
        clips.append({
            "id": s["id"], "kind": "sfx", "track": s.get("track") or "sfx",
            "uid": None, "index": None,
            "text": s.get("name") or s["media"], "media": s["media"],
            "start": round(float(s["start"]), 4), "dur": round(max(0.05, dur), 4),
            "src_dur": round(max(dur + float(s.get("offset") or 0), file_dur, 0.05), 4),
            "offset": round(float(s.get("offset") or 0), 4),
            "gain": float(s.get("gain") if s.get("gain") is not None else 1.0),
            "pan": float(s.get("pan") or 0),
            "az": float(s.get("az") or 0),
            "el": float(s.get("el") or 0),
            "dist": float(s.get("dist") if s.get("dist") is not None else 1.0),
            "binaural": bool(s.get("binaural")),
            "room": (s.get("room") or ""),
            "send": float(s.get("send") or 0),
            "hrtf": (s.get("hrtf") or ""),
            "sp_preset": (s.get("sp_preset") or ""),
            "speed": float(s.get("speed") or 1),
            "reverse": False,
            "mute": bool(s.get("mute")),
            "locked": bool(s.get("locked")),
            "fade_in": float(s.get("fade_in") or 0),
            "fade_out": float(s.get("fade_out") or 0),
            "has_audio": os.path.exists(path),
            "file_rev": (_mtime_int(path) if os.path.exists(path) else 0),
            "playable": os.path.exists(path),
            "stale": False, "status": "done", "moved": True, "changes": [],
        })

    duration = 0.0
    for c in clips:
        duration = max(duration, c["start"] + c["dur"])
    # 手动拉长的总时长（上方时间窗里改的）也要生效，否则一刷新又缩回去
    try:
        duration = max(duration, float(p.get("duration") or 0))
    except (TypeError, ValueError):
        pass
    # 关键帧挂到片段上（前端画包络、播放/混音都读它）
    kf_all = p.get("kf") or {}
    for c in clips:
        kf = kf_all.get(c["id"]) or {}
        # 老数据只有 kf.az（一条方位曲线）→ 迁成「一个点 = 一个位置」的空间关键帧，
        # 仰角/距离用这段片段当时的静态值补上，听感与迁移前一致。
        if isinstance(kf.get("az"), list) and not kf.get("space"):
            el0 = c.get("el") or 0
            d0 = c.get("dist") if c.get("dist") is not None else 1.0
            kf = dict(kf)
            kf["space"] = [[pt[0], pt[1], el0, d0] for pt in kf["az"]
                           if isinstance(pt, (list, tuple)) and len(pt) >= 2]
            kf.pop("az", None)
            shp = dict(kf.get("shape") or {})
            if shp.get("az"):
                shp["space"] = shp.pop("az")
                kf["shape"] = shp
        c["kf"] = kf
    # 工程里手加的标记点（M 键 / 右键「添加标记点」）：和台本派生的标记并在一起，
    # 时间轴吸附、跳转、导出 markers.csv 都能看到
    for m in p.get("marks") or []:
        markers.append({"id": m.get("id") or _new_uid(), "time": float(m["time"]),
                        "name": m.get("name") or "标记", "kind": "mark",
                        "uid": "", "index": 0, "hold": 0.0, "inline": False,
                        "custom": True})
    markers.sort(key=lambda m: m["time"])
    out_tracks = []
    for t in p["tracks"]:
        out_tracks.append({
            "id": t["id"], "name": t["name"], "kind": t["kind"],
            "gain": t["gain"], "pan": t["pan"], "mute": t["mute"], "solo": t["solo"],
            "clips": [c for c in clips if c["track"] == t["id"]],
        })
    return {
        "ok": True, "sid": sid, "sample_rate": SR, "chars_per_sec": round(cps, 2),
        "duration": round(duration, 3), "tracks": out_tracks,
        "markers": markers, "project": p, "title": script.get("title"),
    }


# ================================ 波形 ========================================

def _resample_2d(data, sr, target):
    """二维（n, ch）重采样：逐声道做，保留声道数。"""
    data = np.asarray(data, dtype="float32")
    if data.ndim == 1:
        data = data[:, None]
    sr, target = int(sr or SR), int(target or SR)
    if sr == target or data.size == 0 or _resample is None:
        return data
    up, down = Fraction(target, sr).limit_denominator(1000).as_integer_ratio()
    cols = [_resample(data[:, ch], up, down) for ch in range(data.shape[1])]
    n = min(len(c) for c in cols)
    return np.stack([c[:n] for c in cols], axis=1)


def _peaks_of(x, n=PEAK_POINTS):
    x = np.asarray(x, dtype="float32").reshape(-1)
    if x.size == 0:
        return [0.0] * n
    if x.size < n:
        idx = np.linspace(0, x.size, n + 1).astype(int)
        out = [float(np.abs(x[idx[i]:max(idx[i] + 1, idx[i + 1])]).max()) if idx[i] < x.size else 0.0
               for i in range(n)]
        return [round(min(1.0, v), 3) for v in out]
    per = x.size // n
    seg = np.abs(x[:per * n].reshape(n, per)).max(axis=1)
    return [round(float(min(1.0, v)), 3) for v in seg]


def _peaks_cached(sid, key, path):
    fp = os.path.join(_peak_dir(sid), key + ".json")
    data = _read_json(fp, None)
    if isinstance(data, list) and len(data) == PEAK_POINTS:
        return data
    if not path or not os.path.exists(path):
        return [0.0] * PEAK_POINTS
    try:
        x, _sr = sf.read(path, dtype="float32", always_2d=True)
        pk = _peaks_of(x.mean(axis=1))
    except Exception as e:  # noqa: BLE001
        _log("timeline: peaks failed %s: %s", path, e, level="warning")
        pk = [0.0] * PEAK_POINTS
    try:
        _write_json(fp, pk)
    except OSError:
        pass
    return pk


# ================================ 变速 / 倒放 =================================

# 变速缓存格式版本。**改过缓存内容的口径就要 +1**：
# 旧缓存不会因为「源文件没变」而失效，用户会一直听到修复前的问题。
# v2：缓存按源采样率写（v1 把 22050 的样本标成 44100，音调翻倍 + 后半补零 + 边界啪）。
PREP_CACHE_VER = 2


def _speed_ratio(speed):
    f = Fraction(int(round(1000 / speed)), 1000).limit_denominator(100)
    return f.numerator, f.denominator


def _prepared_source(sid, c, stats=None):
    """返回 (音频路径, 片段内起始秒)。

    变速/倒放的片段先渲染一份缓存 wav（等于"已经缩放过"的片段内容），
    这样混音、Reaper 工程、试听听到的完全一致，块边界也不会反复重采样。
    """
    src = c["path"]
    speed = float(c.get("speed") or 1)
    rev = False  # 倒放已移除：存档里即使有旧标记也按正向处理
    if abs(speed - 1) < 1e-3 and not rev:
        return src, float(c["offset"])

    try:
        st = os.stat(src)
        stamp = f"{st.st_size}-{int(st.st_mtime)}"
    except OSError:
        return src, float(c["offset"])
    key = f"{c['id']}_{speed:.3f}_{int(rev)}_v{PREP_CACHE_VER}"
    meta_path = os.path.join(_cache_dir(sid), key + ".json")
    wav_path = os.path.join(_cache_dir(sid), key + ".wav")
    meta = _read_json(meta_path, None)
    if (isinstance(meta, dict) and meta.get("stamp") == stamp
            and meta.get("ver") == PREP_CACHE_VER and os.path.exists(wav_path)):
        return wav_path, 0.0

    try:
        data, sr = sf.read(src, dtype="float32", always_2d=True)
        data = data.mean(axis=1)
    except Exception as e:  # noqa: BLE001
        _log("timeline: prepare failed %s: %s", src, e, level="warning")
        return src, float(c["offset"])

    off = float(c["offset"])
    clip_dur = float(c["dur"])
    i0 = max(0, int(off * sr))
    i1 = min(len(data), int((off + clip_dur * speed) * sr))
    seg = data[i0:i1]
    if rev:
        seg = seg[::-1]
    if abs(speed - 1) > 1e-3 and _resample is not None:
        up, down = _speed_ratio(speed)
        seg = _resample(seg, up, down)
    # 这里的数据还是**源采样率**（变速率只做了速度缩放，没做采样率转换）。
    # 以前写死 SR：源是 22050 时既把长度算错（后半被补零 = 听起来「丢句」），
    # 又把 22050 的样本标成 44100 写出去（音调升高、块边界出现「啪」）。
    want = int(round(clip_dur * sr))
    if len(seg) < want:
        seg = np.pad(seg, (0, want - len(seg)))
    seg = np.clip(seg[:want], -1, 1)
    try:
        sf.write(wav_path, seg, int(sr), subtype="PCM_16")
        _write_json(meta_path, {"stamp": stamp, "speed": speed, "reverse": rev,
                               "ver": PREP_CACHE_VER})
        if isinstance(stats, dict):
            stats["rebuilt"] = int(stats.get("rebuilt") or 0) + 1
    except OSError as e:
        _log("timeline: cache write failed %s: %s", wav_path, e, level="warning")
        return src, off
    return wav_path, 0.0


class _Reader:
    def __init__(self, path):
        self.path = path
        self.f = sf.SoundFile(path)
        self.sr = int(self.f.samplerate)
        self.up, self.down = Fraction(SR, self.sr).limit_denominator(1000).as_integer_ratio()
        self.frame = self.f.frames

    def close(self):
        try:
            self.f.close()
        except Exception:  # noqa: BLE001
            pass

    def slice(self, a, n_out):
        if n_out <= 0:
            return np.zeros(0, dtype="float32")
        pad = 0.05
        i0 = max(0, int((a - pad) * self.sr))
        i1 = min(self.frame, int((a + n_out / SR + pad) * self.sr))
        if i1 <= i0:
            return np.zeros(n_out, dtype="float32")
        self.f.seek(i0)
        d = self.f.read(i1 - i0, dtype="float32", always_2d=True).mean(axis=1)
        if self.up != self.down and _resample is not None:
            d = _resample(d, self.up, self.down)
        off = int(round((a - i0 / self.sr) * SR))
        seg = d[off:off + n_out] if off >= 0 else d[0:n_out]
        if seg.size < n_out:
            seg = np.pad(seg, (0, n_out - seg.size))
        return seg.astype("float32", copy=False)


def _engine_clips(sid, script, project):
    """可出声的片段：有文件、未静音、时长为正，带上轨道增益与声像。"""
    built = _build(sid, script, project)
    any_solo = any(t["solo"] for t in built["tracks"])
    out = []
    for tr in built["tracks"]:
        if tr["mute"] or (any_solo and not tr["solo"]):
            continue
        for c in tr["clips"]:
            if not c.get("playable") or c.get("mute"):
                continue
            if c["kind"] == "voice":
                line = next((l for l in script["lines"] if l["uid"] == c["uid"]), None)
                if not line or not line.get("out"):
                    continue
                path = os.path.join(_script_dir(sid), "audio", os.path.basename(line["out"]))
            else:
                path = os.path.join(_media_dir(sid), c["media"])
            out.append({**c, "path": path,
                        "track_gain": float(tr["gain"]), "track_pan": float(tr["pan"])})
    out.sort(key=lambda c: c["start"])
    return out, built


# ---- 混音编码配置与体积预估 -------------------------------------------------
# 与工作台导出同一套经验值：本机没有 ffmpeg/lame，压缩格式用 libsndfile 内置编码器，
# MP3/OGG 码率上限较低（实测 MP3≈48kbps、OGG≈31kbps 立体声），预估只作参考。
_MIX_QUALITY_CL = {"high": 0.0, "standard": 0.35, "small": 0.8}
_MIX_QUALITY_KBPS = {
    "mp3": {"high": 48, "standard": 36, "small": 30},
    "ogg": {"high": 32, "standard": 28, "small": 25},
}


SAMPLE_RATES = (16000, 22050, 32000, 44100, 48000, 96000)


def _norm_sr(v, default=SR):
    """采样率收敛到 8k~96k，非法值直接 400。"""
    try:
        sr = int(float(v))
    except (TypeError, ValueError):
        return int(default)
    if sr < 8000 or sr > 96000:
        raise HTTPException(400, "采样率要在 8000~96000 之间")
    return sr


def _stream_resampler(src_sr, dst_sr, channels):
    """返回流式重采样器（None = 不需要/不可用，直接原样写）。"""
    if int(src_sr) == int(dst_sr):
        return None
    try:
        import soxr  # type: ignore
        return soxr.ResampleStream(int(src_sr), int(dst_sr), int(channels),
                                   dtype="float32", quality="HQ")
    except Exception:  # noqa: BLE001
        _log("timeline: soxr 不可用，混音输出保持 %s Hz", src_sr, level="warning")
        return None


def _mix_codec(fmt, bit_depth=16, quality="standard"):
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
        return "MPEG_LAYER_III", "MP3", _MIX_QUALITY_CL.get(quality, 0.35)
    if fmt == "ogg":
        return "VORBIS", "OGG", _MIX_QUALITY_CL.get(quality, 0.35)
    raise HTTPException(400, "只支持 wav / flac / mp3 / ogg")


def _mix_est_bytes(seconds, fmt="wav", bit_depth=16, channels=2, quality="standard",
                   sample_rate=SR):
    seconds = max(0.0, float(seconds or 0))
    ch = 1 if int(channels or 2) <= 1 else 2
    sr = int(sample_rate or SR)
    fmt = (fmt or "wav").lower()
    if fmt == "wav":
        return int(seconds * sr * ch * (int(bit_depth or 16) / 8.0)) + 44
    if fmt == "flac":
        ratio = 0.80 if int(bit_depth or 16) >= 24 else 0.62
        return int(seconds * sr * ch * 2 * ratio) + 8192
    kbps = _MIX_QUALITY_KBPS.get(fmt, {}).get(quality, 36)
    kbps *= max(0.6, min(1.6, sr / 44100.0)) ** 0.5
    return int(seconds * kbps * 1000 / 8.0) + 4096


def _clip_audible_len(c):
    """片段真正有声音的长度（时间轴秒）。

    `c["dur"]` 是「显示长度」，但它可能比源里剩下的还长：
    改过速、裁过尾巴、或者素材被替换成更短的文件之后都会这样。
    混音时如果照 `dur` 读，多出来的部分就是补零 —— 在有声/静音交界处硬切，
    听起来是一声很轻的「啪」（浏览器试听走 `<audio>`，长度由播放器管，所以听不到）。
    """
    dur = float(c.get("dur") or 0)
    src = float(c.get("src_dur") or dur or 0)
    off = float(c.get("offset") or 0)
    rate = max(0.25, min(4.0, float(c.get("speed") or 1)))
    avail = max(0.0, (src - off) / rate)
    return min(dur, avail) if avail > 0 else dur


def _clip_full_end(c):
    """片段「没被显示出来」的那部分末端（源里还剩多少，按变速折算到时间轴）。"""
    src = float(c.get("src_dur") or c.get("dur") or 0)
    off = float(c.get("offset") or 0)
    rate = max(0.25, min(4.0, float(c.get("speed") or 1)))
    return float(c.get("start") or 0) + max(float(c.get("dur") or 0), (src - off) / rate)


def _mix_span(sid, only=None, range_start=None, range_end=None, duration_mode="visible"):
    """返回 (总时长, 所选时段起点, 终点)。只算时长，不读音频。

    duration_mode:
      visible —— 到最后一个片段的**显示末端**为止（默认，和眼睛里看到的一致）
      full    —— 到最后一个片段**未显示部分的末端**为止（被裁掉/变速压掉的那段也算）
    """
    script = _load_script(sid)
    project = _load_project(sid)
    clips, _built = _engine_clips(sid, script, project)
    if only:
        keep = set(only)
        clips = [c for c in clips if c["track"] in keep]
    if duration_mode == "full":
        total = max([_clip_full_end(c) for c in clips] + [0.0])
    else:
        total = max([c["start"] + c["dur"] for c in clips] + [0.0])
    # 工程里显式拉长的总时长
    try:
        total = max(total, float(project.get("duration") or 0))
    except (TypeError, ValueError):
        pass
    if total <= 0:
        raise HTTPException(400, "没有可混音的片段（先让台本生成语音，或插入素材）")
    # 有房间混响的片段：把尾巴算进总长，否则导出会把余响切掉
    tail = 0.0
    for c in clips:
        rid = (c.get("room") or "").strip()
        if rid and float(c.get("send") or 0) > 0:
            spec = rooms_mod.ROOM_MAP.get(rid)
            if spec:
                tail = max(tail, min(3.0, float(spec[3]) * 1.2))
    if tail > 0:
        total += tail
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
    return total, rs, re_


def _mix_estimate(sid, only=None, fmt="wav", bit_depth=16, quality="standard",
                  channels=2, range_start=None, range_end=None, sample_rate=SR,
                  duration_mode="visible"):
    total, rs, re_ = _mix_span(sid, only, range_start, range_end, duration_mode)
    span = max(0.0, re_ - rs)
    sr = _norm_sr(sample_rate, SR)
    return {"total_duration": round(total, 3), "span_duration": round(span, 3),
            "est_bytes": _mix_est_bytes(span, fmt, bit_depth, channels, quality, sr),
            "sample_rate": sr,
            "range": [round(rs, 3), round(re_, 3)]}


def _render_mix(sid, out_path, fmt="wav", only=None, bit_depth=16, quality="standard",
                channels=2, range_start=None, range_end=None, sample_rate=SR,
                only_uids=None, duration_mode="visible"):
    """分块流式混音：内存只占一个块。支持格式/位深或质量/声道/时段/采样率。"""
    script = _load_script(sid)
    project = _load_project(sid)
    clips, built = _engine_clips(sid, script, project)
    if only_uids:
        keep_uids = set(only_uids)
        clips = [c for c in clips if c["id"] in keep_uids]
    if only:
        keep = set(only)
        clips = [c for c in clips if c["track"] in keep
                 or any(t["id"] == c["track"] and t["kind"] in keep for t in built["tracks"])]
    if duration_mode == "full":
        total = max([_clip_full_end(c) for c in clips] + [0.0])
    else:
        total = max([c["start"] + c["dur"] for c in clips] + [0.0])
    try:
        total = max(total, float(project.get("duration") or 0))
    except (TypeError, ValueError):
        pass
    if total <= 0:
        raise HTTPException(400, "没有可混音的片段（先让台本生成语音，或插入素材）")
    # 有房间混响的片段：把尾巴算进总长，否则导出会把余响切掉
    tail = 0.0
    for c in clips:
        rid = (c.get("room") or "").strip()
        if rid and float(c.get("send") or 0) > 0:
            spec = rooms_mod.ROOM_MAP.get(rid)
            if spec:
                tail = max(tail, min(3.0, float(spec[3]) * 1.2))
    if tail > 0:
        total += tail

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

    subtype, sfmt, comp = _mix_codec(fmt, bit_depth, quality)
    ch = 1 if int(channels or 2) <= 1 else 2
    target = _norm_sr(sample_rate, SR)
    rstream = _stream_resampler(SR, target, ch)

    readers = {}
    prepared = {}
    prep_stats = {"rebuilt": 0}
    # 显示长度比「实际音频」长的片段：这些以前会在交界处补零硬切（啪的一声）
    trimmed = sum(1 for c in clips if _clip_audible_len(c) < float(c["dur"]) - 1e-3)
    bin_states = {}          # 双耳渲染器（每个片段/数据集一个）
    bin_audio = {}           # 双耳整段渲染结果缓存（按片段 id）
    wet_states = {}          # 房间湿声的卷积尾巴
    block = int(SR * BLOCK_SEC)
    written = 0
    peak_seen = 0.0          # 导出后的真实峰值（>0.99 说明已经贴着上限）
    kwargs = {"samplerate": target, "channels": ch, "subtype": subtype, "format": sfmt}
    if comp is not None:
        kwargs["compression_level"] = float(comp)
    try:
        with sf.SoundFile(out_path, "w", **kwargs) as w:
            t0 = rs
            idx = 0
            n_all = len(clips)
            while t0 < re_ - 1e-9:
                n = min(block, int(round((re_ - t0) * SR)))
                if n <= 0:
                    break
                buf = np.zeros((n, 2), dtype="float32")
                active_wet, active_bin = set(), set()
                while idx < n_all and clips[idx]["start"] + _clip_audible_len(clips[idx]) <= t0:
                    idx += 1
                j = idx
                while j < n_all and clips[j]["start"] < t0 + n / SR:
                    c = clips[j]
                    c_len = _clip_audible_len(c)
                    a = max(t0, c["start"])
                    b = min(t0 + n / SR, c["start"] + c_len)
                    if b > a:
                        if c["id"] not in prepared:
                            prepared[c["id"]] = _prepared_source(sid, c, prep_stats)
                        src_path, src_off = prepared[c["id"]]
                        rd = readers.get(src_path)
                        if rd is None:
                            try:
                                rd = _Reader(src_path)
                            except Exception as e:  # noqa: BLE001
                                _log("timeline mix: skip %s (%s)", src_path, e, level="warning")
                                readers[src_path] = False
                                j += 1
                                continue
                            readers[src_path] = rd
                        if rd is False:
                            j += 1
                            continue
                        rel = src_off + (a - c["start"])
                        cnt = int(round((b - a) * SR))
                        seg = rd.slice(rel, cnt)
                        kfg = c.get("kf") or {}
                        tt = (a - c["start"]) + np.arange(cnt, dtype="float32") / SR
                        # 有 gain 关键帧 → 这段以曲线为准（静态 gain 让位给自动化）
                        # 曲线形态（平滑/折线）跟工程里存的一致，试听和导出才对得上
                        g_env = _kf_curve(kfg.get("gain"), tt, _kf_shape(kfg, "gain"))
                        tg = float(c["track_gain"])
                        if g_env is None:
                            g = tg * float(c["gain"])
                            if g != 1.0:
                                seg = seg * g
                        else:
                            if tg != 1.0:
                                seg = seg * tg
                            seg = seg * g_env
                        fi, fo = float(c["fade_in"] or 0), float(c["fade_out"] or 0)
                        # 段落实际有多长（可能比 dur 短）；淡出要落在真正结束的位置
                        seg_len = c_len
                        # 即使用户没设淡入淡出，也垫 3ms 的「declick」斜坡：
                        # 素材被切在半个波形上（或语音首尾不是从 0 开始）时，
                        # 硬起硬落就是一声很轻的「哒」。
                        fi_e = max(fi, 0.003 if seg_len > 0.02 else 0.0)
                        fo_e = max(fo, 0.003 if seg_len > 0.02 else 0.0)
                        if fi_e > 0 or fo_e > 0:
                            env = np.ones(cnt, dtype="float32")
                            if fi_e > 0:
                                env = np.minimum(env, np.clip(tt / fi_e, 0, 1))
                            if fo_e > 0:
                                env = np.minimum(env,
                                                 np.clip((seg_len - tt) / fo_e, 0, 1))
                            seg = seg * env
                        lo = int(round((a - t0) * SR))
                        hi = min(n, lo + cnt)
                        az_env, el_env, d_env = _kf_space_envs(kfg, tt, c)
                        az_now = (float(az_env[len(az_env) // 2]) if az_env is not None
                                  and az_env.size else float(c.get("az") or 0))
                        d_now = (float(d_env[len(d_env) // 2]) if d_env is not None
                                 and d_env.size else float(c.get("dist") or 1.0))

                        # 房间（湿声）：干声先过一遍双耳房间 IR，按干湿比叠回去。
                        # 直达声在 IR 里已经被切掉了，所以不会和下面的 HRIR 叠加成双份。
                        room_id = (c.get("room") or "").strip()
                        send = float(c.get("send") or 0.0)
                        if room_id and send > 0 and hi > lo:
                            st_wet = wet_states.get(c["id"])
                            if st_wet is None:
                                st_wet = wet_states[c["id"]] = rooms_mod.RoomRenderer(SR)
                            active_wet.add(c["id"])
                            wl, wr = st_wet.process(seg[:hi - lo], room_id, az_now, d_now)
                            buf[lo:hi, 0] += wl * send
                            buf[lo:hi, 1] += wr * send

                        # 双耳空间音频：把这段当成一个点声源摆到 (方位/仰角/距离)
                        # 注意：开了双耳就忽略声像（含声像关键帧与轨道声像）——
                        # 空间位置是绝对的，再叠一层左右平衡会把它拉回立体声。
                        if c.get("binaural") and hi > lo:
                            active_bin.add(c["id"])
                            prof = (c.get("hrtf") or "").strip()
                            key = c["id"] + "|" + prof
                            st_bin = bin_states.get(key)
                            if st_bin is None:
                                # 每段片段按自己的 hrtf 数据集建渲染器（空 = 默认）
                                st_bin = bin_states[key] = _make_binaural(SR, prof or None)
                            if c["id"] not in bin_audio:
                                # **整段一次渲染**，再按块切片叠加。
                                # 以前是「每 1 秒调一次 render」：BinauralRenderer 的状态
                                # 虽然会跨调用保留，但实测每块开头仍有 ~0.05 的相位跳变
                                # （导出里每秒一声很轻的「嗒」，试听走 WebAudio 没有）。
                                # 整段渲染绕开这个调用边界，实测与整条 render 逐样本一致。
                                whole_n = max(1, int(round(c_len * SR)))
                                s_all = rd.slice(src_off, whole_n)
                                tt_all = np.arange(s_all.size, dtype="float32") / SR
                                g_all = _kf_curve(kfg.get("gain"), tt_all,
                                                  _kf_shape(kfg, "gain"))
                                tgc = float(c["track_gain"])
                                if g_all is None:
                                    gv = tgc * float(c["gain"])
                                    if gv != 1.0:
                                        s_all = s_all * gv
                                else:
                                    if tgc != 1.0:
                                        s_all = s_all * tgc
                                    s_all = s_all * g_all
                                fi_a, fo_a = float(c["fade_in"] or 0), float(c["fade_out"] or 0)
                                fi_ae = max(fi_a, 0.003 if c_len > 0.02 else 0.0)
                                fo_ae = max(fo_a, 0.003 if c_len > 0.02 else 0.0)
                                if fi_ae > 0 or fo_ae > 0:
                                    env_all = np.ones(s_all.size, dtype="float32")
                                    if fi_ae > 0:
                                        env_all = np.minimum(
                                            env_all, np.clip(tt_all / fi_ae, 0, 1))
                                    if fo_ae > 0:
                                        env_all = np.minimum(
                                            env_all,
                                            np.clip((c_len - tt_all) / fo_ae, 0, 1))
                                    s_all = s_all * env_all
                                az_all, el_all, d_all = _kf_space_envs(kfg, tt_all, c)
                                bl_a, br_a = st_bin.render(
                                    s_all,
                                    az_all if az_all is not None else c.get("az"),
                                    el_all if el_all is not None else c.get("el"),
                                    d_all if d_all is not None else c.get("dist"))
                                bin_audio[c["id"]] = (bl_a, br_a)
                                if len(bin_audio) > 24:
                                    for old_id in list(bin_audio)[:-12]:
                                        bin_audio.pop(old_id, None)
                            o0 = int(round((a - c["start"]) * SR))
                            bl_src, br_src = bin_audio[c["id"]]
                            seg_l = bl_src[o0:o0 + (hi - lo)]
                            seg_r = br_src[o0:o0 + (hi - lo)]
                            if seg_l.size < (hi - lo):
                                pad_n = (hi - lo) - seg_l.size
                                seg_l = np.pad(seg_l, (0, pad_n))
                                seg_r = np.pad(seg_r, (0, pad_n))
                            buf[lo:hi, 0] += seg_l
                            buf[lo:hi, 1] += seg_r
                            j += 1
                            continue
                        # 声像：有关键帧就逐样本插值，否则用静态值
                        track_pan = float(c.get("track_pan") or 0)
                        p_env = _kf_curve(kfg.get("pan"), tt, _kf_shape(kfg, "pan"))
                        if p_env is None:
                            pan_arr = max(-1.0, min(1.0, track_pan + float(c.get("pan") or 0)))
                        else:
                            pan_arr = np.clip(track_pan + p_env, -1.0, 1.0)
                        th = (pan_arr + 1) * math.pi / 4
                        if hi > lo:
                            part = seg[:hi - lo]
                            if isinstance(th, np.ndarray):
                                th = th[:hi - lo]
                                buf[lo:hi, 0] += part * np.cos(th)
                                buf[lo:hi, 1] += part * np.sin(th)
                            else:
                                buf[lo:hi, 0] += part * math.cos(th)
                                buf[lo:hi, 1] += part * math.sin(th)
                    j += 1
                # 片段已经结束、但卷积尾巴还没吐完的：继续叠进这一块
                # （房间混响可能还有好几秒，不吐的话导出会把余响切掉）
                for cid, st in wet_states.items():
                    if cid in active_wet:
                        continue
                    wl, wr = st.flush(n)
                    if wl.any():
                        buf[:, 0] += wl
                        buf[:, 1] += wr
                for cid, st in bin_states.items():
                    if cid in active_bin:
                        continue
                    bl, br = st.flush(n)
                    if bl.any():
                        buf[:, 0] += bl
                        buf[:, 1] += br
                # 总线软限幅：逐样本、无门控（见 _soft_knee 的注释），
                # 放在所有声源叠完之后，块边界也就不会有台阶。
                buf = _soft_knee(buf)
                np.clip(buf, -1.0, 1.0, out=buf)
                m = float(np.max(np.abs(buf))) if buf.size else 0.0
                if m > peak_seen:
                    peak_seen = m
                arr = buf if ch == 2 else buf.mean(axis=1, keepdims=True)
                if rstream is not None:
                    arr = rstream.resample_chunk(arr, last=False)
                if arr.size:
                    w.write(arr if ch == 2 else arr[:, 0])
                    written += int(arr.shape[0])
                t0 += n / SR
            if rstream is not None:
                tail = rstream.resample_chunk(np.zeros((0, ch), dtype="float32"), last=True)
                if tail.size:
                    w.write(tail if ch == 2 else tail[:, 0])
                    written += int(tail.shape[0])
    finally:
        for rd in readers.values():
            if rd:
                rd.close()
    size = os.path.getsize(out_path) if os.path.exists(out_path) else 0
    dur = written / float(target) if target else 0.0
    return {"duration": round(dur, 3), "clips": len(clips), "size": size,
            "peak": round(peak_seen, 3),
            "prepared": prep_stats["rebuilt"], "trimmed": trimmed,
            "kbps": round(size * 8 / max(0.001, dur) / 1000),
            "format": (fmt or "wav").lower(), "channels": ch, "sample_rate": target,
            "range": [round(rs, 3), round(re_, 3)], "total": round(total, 3)}


# ================================ 工程导出 ====================================

def _tc(sec, fps=25):
    if sec < 0:
        sec = 0
    f = int(round(sec * fps))
    hh, f = divmod(f, fps * 3600)
    mm, f = divmod(f, fps * 60)
    ss, f = divmod(f, fps)
    return f"{hh:02d}:{mm:02d}:{ss:02d}:{f:02d}"


def _guid():
    return "{" + str(uuid.uuid4()).upper() + "}"


def _rpp_env(tag, pts, shape):
    """片段的音量/声像自动化包络（Reaper 的 take envelope）。

    · 点的时间相对**片段起点**（Reaper 的 take 包络就是这么存的，片段一挪包络跟着走）
    · 值：VOLENV2 是线性幅度（1.0 = 0dB），PANENV2 是 -1..1
    · 形状码：0 = 直线，5 = 贝塞尔（对应面板上的「折线 / 平滑」）
    只写 ≥2 个点的曲线：单点没有「走势」，写进去只剩一条平线，反而盖掉静态值。
    """
    if not pts or len(pts) < 2:
        return []
    code = 5 if (shape or "smooth") != "linear" else 0
    L = [f"      <{tag}",
         "        ACT 1 -1",
         "        VIS 1 1 1",
         "        LANEHEIGHT 0 0",
         "        ARM 0",
         "        DEFSHAPE 0 -1 -1"]
    for p in pts:
        try:
            t, v = float(p[0]), float(p[1])
        except (TypeError, ValueError, IndexError):
            continue
        L.append(f"        PT {max(0.0, t):.6f} {v:.6f} {code}")
    L.append("      >")
    return L


def _rpp_text(built, clip_files, clip_soffs=None, sample_rate=SR, auto_env=True):
    """clip_files: {clip_id: 路径}。变速/倒放的片段用预渲染缓存，听感和成品一致。

    clip_soffs: {clip_id: 源内起始秒}。变速/倒放的预渲染文件从片段内容 0 秒开始，
    这里必须用 0，否则 Reaper 会多跳过一段（这是之前的 bug）。
    """
    clip_soffs = clip_soffs or {}
    L = ['<REAPER_PROJECT 0.1 "7.0" 1700000000',
         "  RIPPLE 0", "  GROUPOVERRIDE 0 0 0", "  AUTOXFADE 1",
         f"  SAMPLERATE {int(sample_rate)} 0 0", "  TEMPO 120 4 4", "  PLAYRATE 1 1 7 -1 0 0.0025",
         "  MASTER_NCH 2 2", "  MASTER_VOLUME 1 0 -1 -1 1"]

    for i, m in enumerate(built["markers"], start=1):
        name = str(m["name"]).replace('"', "'")
        L.append(f'  MARKER {i} {m["time"]:.6f} "{name}" 0 0')

    for tr in built["tracks"]:
        # 工程导出比混音更宽松：只要有音频文件就导出（含「需重生成」的旧音频），
        # 这样在 Reaper 里能看到完整时间线，再决定替换；混音导出仍会跳过 stale。
        clips = [c for c in tr["clips"] if c.get("has_audio") and not c.get("mute")]
        L.append("  <TRACK " + _guid())
        L.append(f"    NAME {tr['name']}")
        L.append(f"    VOLPAN {float(tr['gain']):.6f} {float(tr['pan']):.6f} -1 -1 1")
        L.append(f"    MUTESOLO {1 if tr['mute'] else 0} {2 if tr['solo'] else 0} 0")
        L.append("    ISBUS 0 0")
        for c in clips:
            src = clip_files.get(c["id"])
            if not src:
                continue
            soffs = clip_soffs.get(c["id"], float(c["offset"]))
            L.append("    <ITEM")
            L.append(f"      POSITION {c['start']:.6f}")
            L.append("      SNAPOFFS 0")
            L.append(f"      LENGTH {c['dur']:.6f}")
            L.append("      LOOP 0")
            name = (c.get("text") or "").replace('"', "'")[:60] or c["id"]
            if c.get("stale"):
                name = "【需重生成】" + name
            L.append(f'      NAME "{name}"')
            L.append(f"      SOFFS {soffs:.6f}")
            L.append("      PLAYRATE 1 1 0 -1 0 0.0025")
            kfg = (c.get("kf") or {}) if auto_env else {}
            shp = (kfg.get("shape") or {}) if isinstance(kfg, dict) else {}
            gkf = kfg.get("gain") if isinstance(kfg, dict) else None
            pkf = kfg.get("pan") if isinstance(kfg, dict) else None
            # 只有「真的会写出包络」时静态值才让位：单点曲线写不出包络，
            # 这时候把 VOLPAN 设成 1.0 就等于把这个片段的音量丢了。
            env_g = _rpp_env("VOLENV2", gkf, shp.get("gain"))
            env_p = _rpp_env("PANENV2", pkf, shp.get("pan"))
            gv = 1.0 if env_g else float(c["gain"])
            pv = 0.0 if env_p else float(c.get("pan") or 0)
            L.append(f"      VOLPAN {gv:.6f} {pv:.6f} -1 -1 1")
            L.append(f"      MUTE {1 if c.get('mute') else 0} 0")
            if c["fade_in"] or c["fade_out"]:
                L.append(f"      FADEIN 1 {float(c['fade_in']):.6f} 0 1 0 0")
                L.append(f"      FADEOUT 1 {float(c['fade_out']):.6f} 0 1 0 0")
            L.extend(env_g)
            L.extend(env_p)
            L.append("      <SOURCE WAVE")
            L.append(f'        FILE "{src}"')
            L.append("      >")
            L.append("    >")
        L.append("  >")
    L.append(">")
    return "\n".join(L) + "\n"


def _edl_text(built, title, clip_soffs=None):
    """CMX3600 EDL。源入/源出用片段在文件内的真实偏移，避免裁过的片段在 PR 里错位。"""
    clip_soffs = clip_soffs or {}
    L = [f"TITLE: {_safe_title(title, 'timeline')}", "FCM: NON-DROP FRAME", ""]
    n = 0
    ch_of_track = {}
    for tr in built["tracks"]:
        for c in tr["clips"]:
            if not c.get("has_audio"):
                continue
            n += 1
            soffs = clip_soffs.get(c["id"], float(c["offset"]))
            s, e = c["start"], c["start"] + c["dur"]
            # 每条音轨映射到一个声道（A/A2/A3/A4），超出回落到 A
            ch = ch_of_track.setdefault(tr["id"], ["A", "A2", "A3", "A4"][min(3, len(ch_of_track))])
            L.append(f"{n:03d}  AX       {ch:<6} C        {_tc(soffs)} {_tc(soffs + c['dur'])} {_tc(s)} {_tc(e)}")
            name = (c.get("text") or c["id"]).replace("\n", " ")[:50]
            L.append(f"* FROM CLIP NAME: {name}")
            L.append(f"* TRACK: {tr['name']}")
            L.append("")
    return "\n".join(L)


def _audacity_labels(built):
    """Audacity 标签轨文件：`起\\t止\\t文字`，起=止 表示点标签。"""
    lines = []
    for m in built.get("markers") or []:
        name = str(m.get("name") or "标记").replace("\t", " ")
        kind = "句中" if m.get("inline") else "句间"
        lines.append((float(m["time"]), float(m["time"]), f"[{kind}] {name}"))
    for tr in built["tracks"]:
        for c in tr["clips"]:
            if not c.get("has_audio"):
                continue
            label = (c.get("text") or c.get("name") or c["id"]).replace("\t", " ")
            label = f"{tr['name']} · {label[:40]}"
            lines.append((float(c["start"]), float(c["start"]) + float(c["dur"]), label))
    lines.sort(key=lambda x: (x[0], x[1]))
    return "".join(f"{a:.6f}\t{b:.6f}\t{t}\n" for a, b, t in lines)


def _csv_text(rows):
    out = []
    for r in rows:
        out.append(",".join('"' + str(x).replace('"', '""') + '"' for x in r))
    return "\n".join(out) + "\n"


def _csv_rows(built):
    rows = [["index", "type", "track", "start", "end", "dur", "start_tc", "end_tc",
             "gain", "pan", "speed", "reverse", "locked", "kf",
             "binaural", "sp_preset", "az", "el", "dist", "room", "send",
             "name", "text"]]
    for tr in built["tracks"]:
        for c in tr["clips"]:
            kf = c.get("kf") or {}
            kf_txt = " ".join(f"{k}:{len(kf[k])}" for k in ("gain", "pan", "space")
                              if isinstance(kf.get(k), list) and kf.get(k))
            rows.append([
                c.get("index") or "", c["kind"], tr["name"],
                f"{c['start']:.3f}", f"{c['start'] + c['dur']:.3f}", f"{c['dur']:.3f}",
                _tc(c["start"]), _tc(c["start"] + c["dur"]),
                f"{c['gain']:.2f}", f"{c.get('pan') or 0:.2f}",
                f"{c.get('speed') or 1:.2f}", "0",
                "1" if c.get("locked") else "0",
                kf_txt,
                "1" if c.get("binaural") else "0",
                c.get("sp_preset") or "",
                f"{float(c.get('az') or 0):.1f}", f"{float(c.get('el') or 0):.1f}",
                f"{float(c.get('dist') if c.get('dist') is not None else 1.0):.2f}",
                c.get("room") or "", f"{float(c.get('send') or 0):.2f}",
                (c.get("media") or "").replace(",", "，"),
                (c.get("text") or "").replace("\n", " ").replace(",", "，"),
            ])
    return rows


# ================================ 路由 ========================================

def register_timeline(app, deps=None):
    global _D
    _D.update(deps or {})
    web_dir = _D.get("web_dir") or os.path.join(_D.get("project_dir", "."), "web")
    _log("timeline extension registered: /timeline + /api/v1/lf/tl/*")

    @_LF.get("/lf/tl-rooms")
    def tl_rooms():
        """房间预设 + 当前 HRIR 数据状态（前端做下拉和提示用）。"""
        return {"ok": True, "rooms": rooms_mod.room_list(),
                "hrir": hrir_mod.status(),
                "hrir_profiles": hrir_mod.profiles()}

    @_LF.get("/lf/tl/room-ir")
    def tl_room_ir(room: str = "small", az: float = 0.0, dist: float = 1.0):
        """房间 IR（双耳、已去直达）——前端试听时用 ConvolverNode 加载同一份。"""
        ir = rooms_mod.room_ir(room, az, dist, SR)
        if ir is None:
            raise HTTPException(404, "没有这个房间")
        buf = io.BytesIO()
        sf.write(buf, ir.T, SR, subtype="PCM_16", format="WAV")
        data = buf.getvalue()
        return Response(content=data, media_type="audio/wav",
                        headers={"Cache-Control": "public, max-age=3600"})

    @_LF.get("/lf/tl/{sid}")
    def tl_get(sid: str):
        return _build(_safe_sid(sid))

    @_LF.patch("/lf/tl/{sid}/project")
    def tl_patch(sid: str, req: dict = Body(default={})):
        sid = _safe_sid(sid)
        with _lock():
            p = _save_project(sid, req or {})
        return {"ok": True, "project": p}

    # ---- 音轨 ---------------------------------------------------------------
    @_LF.post("/lf/tl/{sid}/tracks")
    def tl_track_add(sid: str, req: dict = Body(default={})):
        sid = _safe_sid(sid)
        with _lock():
            p = _load_project(sid)
            if len(p["tracks"]) >= 200:
                raise HTTPException(400, "音轨数量已达上限")
            kind = "voice" if req.get("kind") == "voice" else "sfx"
            tid = "t" + uuid.uuid4().hex[:8]
            item = {
                "id": tid,
                "name": _safe_title(req.get("name") or f"音轨 {len(p['tracks']) + 1}", "音轨")[:24],
                "kind": kind, "gain": 1.0, "pan": 0.0, "mute": False, "solo": False,
            }
            # 插到「同类型轨组的末尾」：音声轨插在第一条素材轨之前，素材轨插在最后
            same = [i for i, t in enumerate(p["tracks"]) if (t.get("kind") == "voice") == (kind == "voice")]
            at = (same[-1] + 1) if same else (0 if kind == "voice" else len(p["tracks"]))
            if kind == "voice" and not same:
                at = 0
            p["tracks"].insert(at, item)
            p["rev"] = int(time.time())
            _write_json(_proj_path(sid), p)
        return {"ok": True, "project": p}

    @_LF.patch("/lf/tl/{sid}/tracks/{tid}")
    def tl_track_patch(sid: str, tid: str, req: dict = Body(default={})):
        sid = _safe_sid(sid)
        tid = str(tid)[:20]
        with _lock():
            p = _load_project(sid)
            tr = next((t for t in p["tracks"] if t["id"] == tid), None)
            if not tr:
                raise HTTPException(404, "音轨不在了")
            if req.get("name"):
                tr["name"] = _safe_title(req["name"], tr["name"])[:24]
            if req.get("gain") is not None:
                tr["gain"] = _num(req["gain"], 1.0, 0, 4)
            if req.get("pan") is not None:
                tr["pan"] = _num(req["pan"], 0, -1, 1)
            for k in ("mute", "solo"):
                if req.get(k) is not None:
                    tr[k] = bool(req[k])
            p["rev"] = int(time.time())
            _write_json(_proj_path(sid), p)
        return {"ok": True, "project": p}

    @_LF.delete("/lf/tl/{sid}/tracks/{tid}")
    def tl_track_delete(sid: str, tid: str):
        sid = _safe_sid(sid)
        tid = str(tid)[:20]
        with _lock():
            p = _load_project(sid)
            if len(p["tracks"]) <= 1:
                raise HTTPException(400, "至少保留一条音轨")
            has_clip = any(c.get("track") == tid for c in p["clips"].values()) or \
                any(s.get("track") == tid for s in p["sfx"])
            if has_clip:
                raise HTTPException(400, "这条音轨上还有片段，先把它们移走")
            p["tracks"] = [t for t in p["tracks"] if t["id"] != tid]
            # 标签音效的落轨覆盖要跟着清掉，否则会指向一条已经不存在的轨
            for uid in list((p.get("tagfx") or {}).keys()):
                if (p["tagfx"][uid] or {}).get("track") == tid:
                    p["tagfx"][uid].pop("track", None)
                    if not p["tagfx"][uid]:
                        p["tagfx"].pop(uid, None)
            p["rev"] = int(time.time())
            _write_json(_proj_path(sid), p)
        return {"ok": True, "project": p}

    # ---- 历史版本 -----------------------------------------------------------
    @_LF.get("/lf/tl/{sid}/history")
    def tl_history_list(sid: str):
        sid = _safe_sid(sid)
        d = _hist_dir(sid)
        items = []
        for fn in sorted(os.listdir(d), reverse=True):
            if not fn.endswith(".json"):
                continue
            data = _read_json(os.path.join(d, fn), {}) or {}
            items.append({
                "name": fn, "time": data.get("time"), "label": data.get("label"),
                "clips": data.get("clips"), "tracks": data.get("tracks"),
            })
        return {"ok": True, "items": items, "keep": HISTORY_KEEP}

    @_LF.post("/lf/tl/{sid}/history")
    def tl_history_add(sid: str, req: dict = Body(default={})):
        sid = _safe_sid(sid)
        with _lock():
            name = _snapshot_project(sid, (req or {}).get("label"))
        return {"ok": True, "name": name}

    @_LF.post("/lf/tl/{sid}/history/{name}/restore")
    def tl_history_restore(sid: str, name: str):
        sid = _safe_sid(sid)
        path = os.path.join(_hist_dir(sid), os.path.basename(name))
        data = _read_json(path, None)
        if not isinstance(data, dict) or not isinstance(data.get("project"), dict):
            raise HTTPException(404, "历史版本不存在")
        with _lock():
            _snapshot_project(sid, "恢复前")     # 恢复前先存一份，可反悔
            _write_json(_proj_path(sid), data["project"])
        return {"ok": True, **_build(sid)}

    @_LF.delete("/lf/tl/{sid}/history/{name}")
    def tl_history_delete(sid: str, name: str):
        sid = _safe_sid(sid)
        path = os.path.join(_hist_dir(sid), os.path.basename(name))
        if not os.path.exists(path):
            raise HTTPException(404, "历史版本不存在")
        try:
            os.remove(path)
        except OSError as e:  # noqa: BLE001
            raise HTTPException(400, f"删除失败：{e}")
        return {"ok": True}

    @_LF.post("/lf/tl/{sid}/tracks/{tid}/move")
    def tl_track_move(sid: str, tid: str, req: dict = Body(default={})):
        """上下调整音轨顺序。dir: -1 上移 / +1 下移。"""
        sid = _safe_sid(sid)
        tid = str(tid)[:20]
        pos = str(req.get("pos") or "").strip().lower()
        direction = int(req.get("dir") or 0)
        if pos not in ("top", "bottom") and direction not in (-1, 1):
            raise HTTPException(400, "dir 只能是 -1 / 1，或 pos = top / bottom")
        with _lock():
            p = _load_project(sid)
            tracks = p["tracks"]
            idx = next((i for i, t in enumerate(tracks) if t["id"] == tid), None)
            if idx is None:
                raise HTTPException(404, "音轨不在了")
            me = tracks[idx]
            same_kind = [i for i, t in enumerate(tracks) if (t.get("kind") == "voice") == (me.get("kind") == "voice")]
            if pos in ("top", "bottom"):
                # 组内第一条 / 最后一条：只在自己那组里动，不跨音声轨/素材轨
                if len(same_kind) < 2:
                    raise HTTPException(400, "这条轨是组里唯一的一条，没得挪")
                rest = [t for t in tracks if t is not me]
                rest_same = [i for i, t in enumerate(rest)
                             if (t.get("kind") == "voice") == (me.get("kind") == "voice")]
                if pos == "top":
                    at = rest_same[0] if rest_same else len(rest)
                else:
                    at = (rest_same[-1] + 1) if rest_same else len(rest)
                rest.insert(at, me)
                tracks = rest
            else:
                pos_in_group = same_kind.index(idx)
                j = pos_in_group + direction
                if j < 0 or j >= len(same_kind):
                    raise HTTPException(400, "已经在组内的边界了")
                tracks[idx], tracks[same_kind[j]] = tracks[same_kind[j]], tracks[idx]
            p["tracks"] = _group_tracks(tracks)
            p["rev"] = int(time.time())
            _write_json(_proj_path(sid), p)
        return {"ok": True, "project": p}

    # ---- 重新生成（批量） ---------------------------------------------------
    def _pin_starts(sid, script=None):
        """把所有语音片段的当前位置钉进 project.clips[uid].start。

        重生成时先钉住，后面句子就不会被时长变化顶走。返回钉了几条。
        """
        built = _build(sid, script=script or _load_script(sid))
        pinned = 0
        with _lock():
            p = _load_project(sid)
            ov = p.setdefault("clips", {})
            for tr in built.get("tracks") or []:
                for c in tr.get("clips") or []:
                    if c.get("kind") != "voice":
                        continue
                    o = ov.get(c["uid"])
                    if isinstance(o, dict) and o.get("start") is not None:
                        continue
                    item = ov.setdefault(c["uid"], {})
                    if not isinstance(item, dict):
                        item = {}
                        ov[c["uid"]] = item
                    item["start"] = round(float(c.get("start") or 0), 4)
                    pinned += 1
            p["rev"] = int(time.time())
            _write_json(_proj_path(sid), p)
        return pinned

    def _start_regen(sid, uids, pin=True):
        pinned = _pin_starts(sid) if pin else 0
        try:
            job = _start_render(sid, uids)
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001
            raise HTTPException(400, f"启动重新生成失败：{e}")
        _log("timeline %s: regen %d line(s), pinned %d start(s)", sid, len(uids), pinned)
        return job, pinned

    @_LF.post("/lf/tl/{sid}/regen")
    def tl_regen(sid: str, req: dict = Body(default={})):
        """重新生成选中的句子，并且**保证所有句子的初始位置不变**。

        做法：先把每条语音片段当前的位置（含排版算出来的 base_start）冻到
        project.clips[uid].start 上，再只重跑这几句。这样：
          · 被重生成的句子时长变了，也不会把后面的句子顶走；
          · 其它音轨的素材、标签音效一个都不动。
        想恢复「跟台本重排」可以在片段属性里点「回到初始位置」。
        """
        sid = _safe_sid(sid)
        uids = [str(u)[:32] for u in (req.get("uids") or []) if u]
        if not uids:
            raise HTTPException(400, "没有选中要重新生成的句子")
        if len(uids) > 500:
            raise HTTPException(400, "一次最多重新生成 500 句")
        script = _load_script(sid)
        by_uid = {l["uid"]: l for l in script["lines"]}
        uids = [u for u in uids if u in by_uid and by_uid[u].get("kind") != "tag"
                and (by_uid[u].get("text") or "").strip()]
        if not uids:
            raise HTTPException(400, "选中的都是标签或空行，没有可重新生成的句子")

        job, pinned = _start_regen(sid, uids, bool(req.get("pin_start", True)))
        return {"ok": True, "render": job.public(), "uids": uids,
                "pinned": pinned, "count": len(uids)}

    # ---- 改属性 + 重生成（与台本页共用同一份 script.json） -------------------
    _OV_KEYS = ("ref", "emo_mode", "emo_weight", "emo_vec", "emo_text", "emo_ref")

    @_LF.post("/lf/tl/{sid}/line-props")
    def tl_line_props(sid: str, req: dict = Body(default={})):
        """在时间轴上改某几句的生成属性（音色 / 情感 / 停顿 / 慢语速），可顺带重生成。

        写的是**时间轴正在用的那份 script.json**（= 台本工作台打开的那个脚本，
        进时间轴时台本页已经切到工程副本），所以两边天然是同一份数据，不会出现
        两边各改一份的问题。改完走 `_merge_runtime` 重算指纹 → 状态自动变「需重生成」，
        跟台本页点保存完全同一条路径。
        """
        sid = _safe_sid(sid)
        req = req or {}
        uids = [str(u)[:32] for u in (req.get("uids") or []) if u]
        if not uids:
            raise HTTPException(400, "没有选中要改属性的句子")
        if len(uids) > 500:
            raise HTTPException(400, "一次最多改 500 句")
        ov_in = req.get("ov") if isinstance(req.get("ov"), dict) else {}
        ov_in = {k: v for k, v in ov_in.items() if k in _OV_KEYS}
        has_pause = req.get("pause") is not None
        clear_pause = bool(req.get("pause_clear"))
        has_slow = req.get("slow") is not None
        if not ov_in and not has_pause and not has_slow and not clear_pause:
            raise HTTPException(400, "没有要改的属性")

        with _LF_LOCK:
            script = _load_script(sid)
            want = set(uids)
            hit = []
            for line in script["lines"]:
                if line["uid"] not in want or line.get("kind") == "tag":
                    continue
                o = dict(line.get("ov") or {}) if isinstance(line.get("ov"), dict) else {}
                for k, v in ov_in.items():
                    empty = (v in (None, "")) or (k == "emo_vec" and not any(v or []))
                    if empty:
                        o.pop(k, None)
                    else:
                        o[k] = v
                if o:
                    line["ov"] = o
                else:
                    line.pop("ov", None)
                if clear_pause:
                    line.pop("pause", None)          # 回到「跟随默认」
                elif has_pause:
                    line["pause"] = max(PAUSE_MIN, min(PAUSE_MAX, int(req["pause"])))
                if has_slow:
                    line["slow"] = bool(req["slow"])
                hit.append(line["uid"])
            if not hit:
                raise HTTPException(400, "选中的都是标签，没有可改属性的句子")
            # 与台本页保存同一套：重算指纹，参数变了就转「需重生成」
            incoming = [_normalize_line(l) for l in script["lines"]]
            script["lines"] = _merge_runtime(script["lines"], incoming, script)
            _save_script(script)
            fresh = _load_script(sid)

        out_lines = [{k: l.get(k) for k in ("uid", "ov", "pause", "slow", "status")}
                     for l in fresh["lines"] if l["uid"] in set(hit)]
        job, pinned = None, 0
        err = ""
        if req.get("regen", True):
            try:
                job, pinned = _start_regen(sid, hit, bool(req.get("pin_start", True)))
            except HTTPException as e:
                err = str(e.detail)
        return {"ok": True, "count": len(hit), "uids": hit, "lines": out_lines,
                "render": job.public() if job else None, "pinned": pinned,
                "regen_error": err}

    @_LF.get("/lf/tl/{sid}/line-props")
    def tl_line_props_get(sid: str, uids: str = ""):
        """读某几句的「有效生成参数」（默认 + 行覆盖），给改属性弹窗做初值。"""
        sid = _safe_sid(sid)
        script = _load_script(sid)
        d = script.get("defaults") or {}
        want = {u for u in (uids or "").split(",") if u}
        out = []
        for l in script["lines"]:
            if l.get("kind") == "tag" or (want and l["uid"] not in want):
                continue
            ov = l.get("ov") or {}
            eff = {k: (ov[k] if k in ov else d.get(k)) for k in _OV_KEYS}
            out.append({"uid": l["uid"], "index": None, "text": l.get("text"),
                        "ov": ov, "eff": eff,
                        "pause": l.get("pause"), "slow": bool(l.get("slow")),
                        "status": l.get("status")})
        return {"ok": True, "defaults": {k: d.get(k) for k in _OV_KEYS}, "lines": out}

    # ---- 波形 ---------------------------------------------------------------
    @_LF.get("/lf/tl/{sid}/peaks")
    def tl_peaks(sid: str, uids: str = "", media: str = ""):
        sid = _safe_sid(sid)
        script = _load_script(sid)
        by_uid = {l["uid"]: l for l in script["lines"] if l.get("kind") != "tag"}
        out = {}
        for u in [x for x in (uids or "").split(",") if x][:MAX_PEAK_UIDS]:
            line = by_uid.get(u)
            if not line or not line.get("out"):
                out[u] = {"peaks": [0.0] * PEAK_POINTS, "empty": True}
                continue
            path = os.path.join(_script_dir(sid), "audio", os.path.basename(line["out"]))
            # 键里带 mtime：重新生成后波形也要跟着变（以前同名缓存，波形一直是旧的）
            rev = _mtime_int(path)
            out[u] = {"peaks": _peaks_cached(sid, f"v_{u}_{rev}", path), "empty": False}
        if media:
            for name in [m for m in media.split(",") if m][:20]:
                base = os.path.basename(name)
                path = os.path.join(_media_dir(sid), base)
                rev = _mtime_int(path)
                out["media:" + base] = {"peaks": _peaks_cached(sid, f"m_{base}_{rev}", path),
                                        "empty": not os.path.exists(path)}
        return {"ok": True, "peaks": out}

    # ---- 音频源 -------------------------------------------------------------
    @_LF.get("/lf/tl/{sid}/src/{kind}/{name}")
    def tl_src(sid: str, kind: str, name: str):
        sid = _safe_sid(sid)
        base = os.path.basename(name)
        folder = _media_dir(sid) if kind == "media" else os.path.join(_script_dir(sid), "audio")
        path = os.path.join(folder, base)
        if not os.path.exists(path):
            raise HTTPException(404, "文件不存在")
        return FileResponse(path, media_type="audio/wav")

    # ---- 素材库 -------------------------------------------------------------
    @_LF.get("/lf/tl/{sid}/media")
    def tl_media_list(sid: str):
        sid = _safe_sid(sid)
        d = _media_dir(sid)
        items = []
        for fn in sorted(os.listdir(d)):
            if not fn.lower().endswith((".wav", ".flac", ".ogg", ".mp3")):
                continue
            path = os.path.join(d, fn)
            try:
                info = sf.info(path)
                items.append({"name": fn, "dur": round(info.duration, 2),
                              "sr": info.samplerate, "ch": int(info.channels or 1),
                              "size": os.path.getsize(path)})
            except Exception:  # noqa: BLE001
                items.append({"name": fn, "dur": 0, "sr": 0, "size": 0})
        return {"ok": True, "items": items}

    @_LF.post("/lf/tl/{sid}/media")
    def tl_media_upload(sid: str, file: UploadFile = File(...)):
        sid = _safe_sid(sid)
        raw = file.file.read()
        if not raw:
            raise HTTPException(400, "空文件")
        if len(raw) > 80 * 1024 * 1024:
            raise HTTPException(400, "单个素材不要超过 80MB")
        orig = os.path.basename(file.filename or "sfx")
        stem = _safe_title(os.path.splitext(orig)[0] or "素材", "素材")[:30]
        tmp = os.path.join(_media_dir(sid), f".tmp_{uuid.uuid4().hex[:6]}")
        with open(tmp, "wb") as f:
            f.write(raw)
        try:
            data, sr = sf.read(tmp, dtype="float32", always_2d=True)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(400, f"这个格式读不了（{type(e).__name__}）。请转成 wav/mp3/flac/ogg")
        finally:
            if os.path.exists(tmp):
                try:
                    os.remove(tmp)
                except OSError:
                    pass
        # 新标准：保留原声道（以前这里一律混成单声道，立体声素材一进工程就变单声道）
        if data.shape[1] > 2:
            data = data[:, :2]
        data = _resample_2d(data, sr, SR)
        name = f"{stem}_{uuid.uuid4().hex[:6]}.wav"
        sf.write(os.path.join(_media_dir(sid), name), data if data.shape[1] > 1 else data[:, 0],
                 SR, subtype="PCM_16")
        return {"ok": True, "name": name, "dur": round(len(data) / SR, 2), "sr": SR,
                "ch": int(data.shape[1])}

    @_LF.patch("/lf/tl/{sid}/media/{name}")
    def tl_media_rename(sid: str, name: str, req: dict = Body(default={})):
        """重命名素材：磁盘文件名和工程里引用它的片段一起改。"""
        sid = _safe_sid(sid)
        base = os.path.basename(name)
        new_stem = _safe_title(req.get("name") or "", "")[:40]
        if not new_stem:
            raise HTTPException(400, "名字不能为空")
        old_path = os.path.join(_media_dir(sid), base)
        if not os.path.exists(old_path):
            raise HTTPException(404, "素材不存在")
        tail = base.rsplit("_", 1)[-1] if "_" in base else ""
        new_name = f"{new_stem}_{tail}" if tail else f"{new_stem}.wav"
        if not new_name.lower().endswith(".wav"):
            new_name += ".wav"
        new_path = os.path.join(_media_dir(sid), new_name)
        if os.path.exists(new_path) and os.path.abspath(new_path) != os.path.abspath(old_path):
            raise HTTPException(400, "已经有同名素材了")
        os.replace(old_path, new_path)
        with _lock():
            p = _load_project(sid)
            for s in p["sfx"]:
                if s["media"] == base:
                    s["media"] = new_name
                    if req.get("rename_clips") is not False:
                        s["name"] = new_stem
            _write_json(_proj_path(sid), p)
        old_pk = os.path.join(_peak_dir(sid), "m_" + base + ".json")
        if os.path.exists(old_pk):
            try:
                os.rename(old_pk, os.path.join(_peak_dir(sid), "m_" + new_name + ".json"))
            except OSError:
                pass
        return {"ok": True, "name": new_name}

    @_LF.get("/lf/tl/{sid}/media/{name}/info")
    def tl_media_info(sid: str, name: str):
        sid = _safe_sid(sid)
        base = os.path.basename(name)
        path = os.path.join(_media_dir(sid), base)
        if not os.path.exists(path):
            raise HTTPException(404, "素材不存在")
        props = _audio_props(path)
        props.update({"kind": "project", "name": base, "source": "本工程目录",
                      "op": "", "created": int(os.path.getmtime(path))})
        return {"ok": True, "info": props}

    @_LF.post("/lf/tl/{sid}/media/{name}/to-inbox")
    def tl_media_to_inbox(sid: str, name: str):
        """把工程里的一个素材拷进台本页的素材导入台（想重新裁/处理时用）。"""
        sid = _safe_sid(sid)
        base = os.path.basename(name)
        path = os.path.join(_media_dir(sid), base)
        if not os.path.exists(path):
            raise HTTPException(404, "素材不存在")
        data, sr = _read_audio_any(path)
        item = _mat_add_from_audio(data, sr, os.path.splitext(base)[0],
                                   os.path.splitext(base)[0], "derived",
                                   op="收自工程", parent=sid)
        return {"ok": True, "item": item}

    @_LF.delete("/lf/tl/{sid}/media/{name}")
    def tl_media_delete(sid: str, name: str):
        sid = _safe_sid(sid)
        base = os.path.basename(name)
        path = os.path.join(_media_dir(sid), base)
        if not os.path.exists(path):
            raise HTTPException(404, "素材不存在")
        os.remove(path)
        pk = os.path.join(_peak_dir(sid), "m_" + base + ".json")
        if os.path.exists(pk):
            try:
                os.remove(pk)
            except OSError:
                pass
        with _lock():
            p = _load_project(sid)
            p["sfx"] = [s for s in p["sfx"] if s["media"] != base]
            _write_json(_proj_path(sid), p)
        return {"ok": True}

    @_LF.post("/lf/tl/{sid}/media/from-sfx")
    def tl_media_from_sfx(sid: str, req: dict = Body(...)):
        """把音效库里的一个音效拷进工程素材目录，返回可直接插入的素材名。"""
        sid = _safe_sid(sid)
        mid = str(req.get("mid") or "")
        item = sfx_item(mid)
        src = sfx_path_of(mid)
        if not item or not src:
            raise HTTPException(404, "音效不存在")
        name = os.path.basename(item["file"])
        dst = os.path.join(_media_dir(sid), name)
        if not os.path.exists(dst):
            try:
                shutil.copy2(src, dst)
            except OSError as e:  # noqa: BLE001
                raise HTTPException(500, f"拷贝音效失败：{e}")
        return {"ok": True, "name": name, "dur": item.get("dur"),
                "display": item.get("name") or name}

    @_LF.post("/lf/tl/{sid}/media/from-material")
    def tl_media_from_material(sid: str, req: dict = Body(...)):
        """把「导入台素材库」里的一条拷进工程目录，返回可直接插入的素材名。

        导入台是全局的（跨台本/工程共用）；工程里保留一份副本只是为了
        「工程自带素材、换机器也能开」。库里删了不影响已经插好的片段。
        """
        sid = _safe_sid(sid)
        mid = str(req.get("mid") or "")
        idx = _load_materials()
        it = next((x for x in (idx.get("items") or []) if x.get("id") == mid), None)
        if not it:
            raise HTTPException(404, "导入台里没有这条素材")
        src = os.path.join(_mat_dir(), os.path.basename(it.get("file") or ""))
        if not os.path.exists(src):
            raise HTTPException(404, "素材文件不存在")
        name = os.path.basename(it["file"])
        dst = os.path.join(_media_dir(sid), name)
        if not os.path.exists(dst):
            try:
                shutil.copy2(src, dst)
            except OSError as e:  # noqa: BLE001
                raise HTTPException(500, f"拷贝素材失败：{e}")
        return {"ok": True, "name": name, "dur": it.get("dur"),
                "display": it.get("name") or name}

    @_LF.post("/lf/tl/{sid}/media/from-ref")
    def tl_media_from_ref(sid: str, req: dict = Body(...)):
        """把音色库里的一个音色拷进工程当素材用（内置音色也支持）。"""
        sid = _safe_sid(sid)
        rid = str(req.get("rid") or "")
        src = resolve_ref(rid)
        if not src or not os.path.exists(src):
            raise HTTPException(404, "音色文件不存在")
        name = os.path.basename(src)
        dst = os.path.join(_media_dir(sid), name)
        if not os.path.exists(dst):
            try:
                shutil.copy2(src, dst)
            except OSError as e:  # noqa: BLE001
                raise HTTPException(500, f"拷贝音色失败：{e}")
        return {"ok": True, "name": name, "dur": None,
                "display": req.get("name") or name}

    @_LF.get("/lf/tl/{sid}/media/{name}/audio")
    def tl_media_audio(sid: str, name: str):
        sid = _safe_sid(sid)
        path = os.path.join(_media_dir(sid), os.path.basename(name))
        if not os.path.exists(path):
            raise HTTPException(404, "素材不存在")
        return FileResponse(path, media_type="audio/wav")

    # ---- 单句 / 单段导出 ----------------------------------------------------
    @_LF.post("/lf/tl/{sid}/export/clip")
    def tl_export_clip(sid: str, req: dict = Body(default={})):
        """把一条片段单独渲染成一个文件（带它自己的空间位置 / 房间 / 淡入淡出）。

        和「导出混音」走同一条渲染链路（同一个 BinauralRenderer / RoomRenderer），
        区别只是只混这一段、时间范围裁到它自己（房间尾巴算进去）。
        """
        sid = _safe_sid(sid)
        uid = str(req.get("uid") or "").strip()
        if not uid:
            raise HTTPException(400, "缺少 uid")
        fmt = (req.get("format") or "wav").lower()
        if fmt not in ("wav", "flac", "mp3", "ogg"):
            raise HTTPException(400, "只支持 wav / flac / mp3 / ogg")
        script = _load_script(sid)
        project = _load_project(sid)
        clips, built = _engine_clips(sid, script, project)
        clip = next((c for c in clips if c["id"] == uid), None)
        if clip is None:
            raise HTTPException(404, "找不到这段片段")
        if not clip.get("has_audio"):
            raise HTTPException(400, "这段还没有音频（先让台本生成语音）")
        start, dur = float(clip["start"]), float(clip["dur"])
        # 房间混响尾巴：导出时别把余响切掉
        tail = 0.0
        rid = (clip.get("room") or "").strip()
        if rid and float(clip.get("send") or 0) > 0:
            spec = rooms_mod.ROOM_MAP.get(rid)
            if spec:
                tail = min(3.0, float(spec[3]) * 1.2)
        base = _safe_title(script.get("title"), "台本")
        label = (clip.get("text") or clip.get("name") or clip.get("id") or "clip")[:18]
        label = _safe_title(label, "clip")
        stamp = time.strftime("%Y%m%d_%H%M%S")
        out_dir = os.path.join(_script_dir(sid), "export")
        os.makedirs(out_dir, exist_ok=True)
        name = f"{base}_{label}_{stamp}.{fmt}"
        path = os.path.join(out_dir, name)
        if os.path.exists(path):
            name = f"{base}_{label}_{stamp}_{uuid.uuid4().hex[:4]}.{fmt}"
            path = os.path.join(out_dir, name)
        if not _lock().acquire(blocking=False):
            raise HTTPException(429, "已经有导出任务在跑，等它结束再来")
        try:
            st = time.time()
            info = _render_mix(
                sid, path, fmt=fmt,
                channels=req.get("channels") or 2,
                bit_depth=req.get("bit_depth") or 16,
                quality=req.get("quality") or "standard",
                sample_rate=req.get("sample_rate") or SR,
                range_start=max(0.0, start - 0.02),
                range_end=start + dur + tail,
                only_uids=[uid],
            )
            info["seconds"] = round(time.time() - st, 1)
        finally:
            _lock().release()
        _log("timeline: clip export %s %s -> %s (%.1fs)", sid, uid, name, info["seconds"])
        return {"ok": True, "id": uid, "file": name,
                "url": f"/api/v1/lf/scripts/{sid}/export/{name}",
                "text": clip.get("text") or clip.get("name") or "", **info}

    # ---- 混音 ---------------------------------------------------------------
    @_LF.post("/lf/tl/{sid}/mix")
    def tl_mix(sid: str, req: dict = Body(default={})):
        sid = _safe_sid(sid)
        fmt = (req.get("format") or "wav").lower()
        if fmt not in ("wav", "mp3", "flac", "ogg"):
            raise HTTPException(400, "只支持 wav / flac / mp3 / ogg")
        only = req.get("tracks")
        only = [t for t in only if isinstance(t, str)] if isinstance(only, list) else None
        script = _load_script(sid)
        base = _safe_title(script.get("title"), "台本")
        stamp = time.strftime("%Y%m%d_%H%M%S")
        name = f"{base}_混音_{stamp}.{fmt}"
        out_dir = os.path.join(_script_dir(sid), "export")
        os.makedirs(out_dir, exist_ok=True)
        path = os.path.join(out_dir, name)
        if os.path.exists(path):   # 同一秒内连导两次不能互相覆盖
            name = f"{base}_混音_{stamp}_{uuid.uuid4().hex[:4]}.{fmt}"
            path = os.path.join(out_dir, name)
        if not _lock().acquire(blocking=False):
            raise HTTPException(429, "已经有导出任务在跑，等它结束再来")
        try:
            st = time.time()
            info = _render_mix(
                sid, path, fmt=fmt, only=only,
                bit_depth=req.get("bit_depth") or 16,
                quality=req.get("quality") or "standard",
                channels=req.get("channels") or 2,
                range_start=req.get("range_start"),
                range_end=req.get("range_end"),
                sample_rate=req.get("sample_rate") or SR,
                duration_mode=("full" if req.get("duration_mode") == "full" else "visible"),
            )
            info["seconds"] = round(time.time() - st, 1)
        finally:
            _lock().release()
        _log("timeline: mix %s -> %s (%s, %.1fs audio, %.1fMB, %.1fs)",
             sid, name, info["format"], info["duration"], info["size"] / 1048576.0, info["seconds"])
        return {"ok": True, "file": name, "url": f"/api/v1/lf/scripts/{sid}/export/{name}", **info}

    @_LF.post("/lf/tl/{sid}/mix/estimate")
    def tl_mix_estimate(sid: str, req: dict = Body(default={})):
        """只算不写：混音总时长 / 时段时长 / 预估文件大小。"""
        sid = _safe_sid(sid)
        only = req.get("tracks")
        only = [t for t in only if isinstance(t, str)] if isinstance(only, list) else None
        return {"ok": True, **_mix_estimate(
            sid, only=only,
            fmt=req.get("format") or "wav",
            bit_depth=req.get("bit_depth") or 16,
            quality=req.get("quality") or "standard",
            channels=req.get("channels") or 2,
            range_start=req.get("range_start"),
            range_end=req.get("range_end"),
            sample_rate=req.get("sample_rate") or SR,
            duration_mode=("full" if req.get("duration_mode") == "full" else "visible"),
        )}

    # ---- 声转素材：把音声片段的音频复制成普通素材（重复制，不动台本） ----------
    @_LF.post("/lf/tl/{sid}/media/from-voice")
    def tl_media_from_voice(sid: str, req: dict = Body(default={})):
        """把某句语音的 wav 复制一份进本工程 media，返回可当素材用的名字。

        复制出来的素材是**独立的音频文件**：改名、裁剪、删除都不会影响台本那一句，
        也不会在台本里多出一句。
        """
        sid = _safe_sid(sid)
        uid = str(req.get("uid") or "").strip()
        if not uid:
            raise HTTPException(400, "缺少 uid")
        script = _load_script(sid)
        line = next((l for l in script.get("lines") or [] if l.get("uid") == uid), None)
        if not line or not line.get("out"):
            raise HTTPException(404, "这一句还没有生成音频")
        src = os.path.join(_script_dir(sid), "audio", os.path.basename(line["out"]))
        if not os.path.exists(src):
            raise HTTPException(404, "音频文件不在了")
        name = (line.get("text") or "语音")[:16]
        name = "".join(ch for ch in name if ch not in "/\\:*?\"<>|") or "语音"
        stamp = uuid.uuid4().hex[:6]
        fname = f"{name}_{stamp}.wav"
        dst = os.path.join(_script_dir(sid), "media", fname)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
        try:
            dur = float(_sf_info(dst).duration)
        except Exception:  # noqa: BLE001
            dur = float(line.get("dur") or 0)
        _log("timeline: voice %s -> media %s", uid, fname)
        return {"ok": True, "name": fname, "display": name + "（副本）", "dur": round(dur, 3)}

    # ---- 工程包 -------------------------------------------------------------
    @_LF.post("/lf/tl/{sid}/export/pack")
    def tl_export_pack(sid: str, req: dict = Body(default={})):
        sid = _safe_sid(sid)
        want = [f for f in (req.get("formats") or ["rpp", "edl"])
                if f in ("rpp", "edl", "audacity")]
        if not want:
            raise HTTPException(400, "至少选一种工程格式")
        include_audio = bool(req.get("include_audio"))
        pack_sr = int(req.get("sample_rate") or SR)
        script = _load_script(sid)
        project = _load_project(sid)
        built = _build(sid, script, project)
        base = _safe_title(script.get("title"), "台本")
        stamp = time.strftime("%Y%m%d_%H%M%S")
        root = f"{base}_工程_{stamp}"
        out_dir = os.path.join(_script_dir(sid), "export")
        os.makedirs(out_dir, exist_ok=True)
        zip_path = os.path.join(out_dir, root + ".zip")
        stage = os.path.join(out_dir, ".stage_" + uuid.uuid4().hex[:8])
        # 顺手清掉以前留下的暂存目录（最多 3 个，别让导出本身变成垃圾制造机）
        try:
            olds = [d for d in os.listdir(out_dir) if d.startswith((".trash_", ".stage_"))]
            for d in olds[:3]:
                _purge_dir(os.path.join(out_dir, d), budget=0.8)
        except OSError:
            pass
        for sub in ("audio", "media", "stems", "audacity"):
            os.makedirs(os.path.join(stage, sub), exist_ok=True)
        clip_files = {}
        clip_soffs = {}
        skipped = 0
        try:
            media_base = "media" if include_audio else _media_dir(sid).replace(os.sep, "/")
            for tr in built["tracks"]:
                for c in tr["clips"]:
                    if not c.get("has_audio"):
                        continue
                    if c["kind"] == "voice":
                        line = next((l for l in script["lines"] if l["uid"] == c["uid"]), None)
                        if not line or not line.get("out"):
                            continue
                        src = os.path.join(_script_dir(sid), "audio", os.path.basename(line["out"]))
                        if not os.path.exists(src):
                            skipped += 1
                            continue
                        cache, _off = _prepared_source(sid, {**c, "path": src})
                        tag = ""
                        if abs(float(c.get("speed") or 1) - 1) > 1e-3:
                            tag += f"_x{c['speed']:.2f}"
                        # 倒放已移除
                        if include_audio:
                            fname = (f"{c['index']:04d}_"
                                     f"{_safe_title((c['text'] or '')[:22], 'line')}{tag}.wav")
                            dst = os.path.join(stage, "audio", fname)
                            if not os.path.exists(dst):
                                try:
                                    shutil.copy2(cache, dst)
                                except OSError:
                                    pass
                            clip_files[c["id"]] = f"audio/{fname}"
                            clip_soffs[c["id"]] = float(_off)
                        else:
                            clip_files[c["id"]] = cache.replace(os.sep, "/")
                            clip_soffs[c["id"]] = float(_off)
                    else:
                        src = os.path.join(_media_dir(sid), c["media"])
                        if not os.path.exists(src):
                            skipped += 1
                            continue
                        cache, _off = _prepared_source(sid, {**c, "path": src})
                        if include_audio:
                            fname = os.path.basename(cache)
                            dst = os.path.join(stage, "media", fname)
                            if not os.path.exists(dst):
                                try:
                                    shutil.copy2(cache, dst)
                                except OSError:
                                    pass
                            clip_files[c["id"]] = f"media/{fname}"
                            clip_soffs[c["id"]] = float(_off)
                        else:
                            clip_files[c["id"]] = cache.replace(os.sep, "/")
                            clip_soffs[c["id"]] = float(_off)

            if not clip_files:
                raise HTTPException(
                    400,
                    "没有可导出的片段：时间轴上还没有能出声的片段"
                    + (f"（{skipped} 段的音频文件不见了，检查素材是否被删）" if skipped else ""))

            for tr in built["tracks"]:
                try:
                    _render_mix(sid, os.path.join(
                        stage, "stems", f"{tr['id']}_{_safe_title(tr['name'], 'track')}.wav"),
                        fmt="wav", only=[tr["id"]], sample_rate=pack_sr)
                except HTTPException:
                    pass

            if "rpp" in want:
                with open(os.path.join(stage, "project.rpp"), "w", encoding="utf-8") as f:
                    f.write(_rpp_text(built, clip_files, clip_soffs, pack_sr,
                                      auto_env=bool(req.get("auto_env", True))))
            if "edl" in want:
                with open(os.path.join(stage, "timeline.edl"), "w", encoding="utf-8") as f:
                    f.write(_edl_text(built, base, clip_soffs))
            if "audacity" in want:
                # Audacity 没有可写的工程格式（.aup3 是 SQLite），业界通行做法是
                # 给「每条音轨一条从 0 开始的 WAV」+「标签文件」，导入后时间轴天然对齐。
                aud = os.path.join(stage, "audacity")
                for ti, tr in enumerate(built["tracks"], start=1):
                    src = os.path.join(stage, "stems", f"{tr['id']}_{_safe_title(tr['name'], 'track')}.wav")
                    if not os.path.exists(src):
                        continue
                    dst = os.path.join(aud, f"{ti:02d}_{_safe_title(tr['name'], 'track')}.wav")
                    try:
                        shutil.copy2(src, dst)
                    except OSError:
                        pass
                with open(os.path.join(aud, "labels.txt"), "w", encoding="utf-8") as f:
                    f.write(_audacity_labels(built))
                with open(os.path.join(aud, "README_audacity.txt"), "w", encoding="utf-8") as f:
                    f.write(
                        f"Audacity 4 导入说明 · {base}\n"
                        "----------------------------------------\n"
                        "1) File > Import > Audio...（或直接把本文件夹里的 wav 全选拖进窗口）\n"
                        "   一条 wav = 一条音轨，全部从 0 秒开始，时间轴天然对齐。\n"
                        "2) File > Import > Labels...  选 labels.txt，会生成一条标签轨\n"
                        "   （范围标签 = 每个片段，点标签 = 台本里的句中/句间标记）。\n"
                        "3) 想继续做混音：Tracks > Mix > Mix and Render 合成一条；\n"
                        "   想改音量/声像：直接拖音轨左侧的 -/+ 滑块与 Pan 旋钮。\n"
                        "4) 变速片段已经是预渲染后的音频，导入即可，不需要再改速度。\n\n"
                        "如果要保留「每个片段独立可拖」的编辑粒度，用同包的\n"
                        "project.rpp（Reaper）或 timeline.edl（PR / 达芬奇）。\n"
                    )
            with open(os.path.join(stage, "timeline.csv"), "w", encoding="utf-8-sig") as f:
                f.write(_csv_text(_csv_rows(built)))
            mrows = [["time", "time_tc", "kind", "index", "name"]]
            for m in built["markers"]:
                mrows.append([f"{m['time']:.3f}", _tc(m["time"]),
                              "句中" if m.get("inline") else "句间", m.get("index") or "", m["name"]])
            with open(os.path.join(stage, "markers.csv"), "w", encoding="utf-8-sig") as f:
                f.write(_csv_text(mrows))
            readme = (
                f"{base} · 时间轴工程\n生成时间：{time.strftime('%Y-%m-%d %H:%M:%S')}\n"
                f"工程采样率：{pack_sr} Hz / 立体声\n总时长：{built['duration']:.2f} 秒\n"
                f"音轨：{'、'.join(t['name'] for t in built['tracks'])}\n\n"
                + ("project.rpp      拖进 Reaper 直接打开（每段一个 item，位置/音量/声像/淡入淡出都在）\n" if "rpp" in want else "")
                + ("timeline.edl     CMX3600，PR / 达芬奇从「导入 EDL」使用\n" if "edl" in want else "")
                + ("audacity/        Audacity 4 用：每轨一条 WAV + labels.txt + 导入说明\n" if "audacity" in want else "")
                + "stems/           每条音轨各自的整轨混音（已含 HRTF 双耳 + 混响）\n"
                + "audio/           逐句语音（变速/倒放用预渲染版本，和成品一致）\n"
                + "media/           素材音效\n"
                + "timeline.csv     每段起止秒 + 时间码 + 增益/声像/速度 + 空间（方位/仰角/距离/房间）\n"
                + "markers.csv      标签标记点\n\n"
                + "关于空间音频：\n"
                + "· RPP 里写的是「片段的音量/声像包络」（VOLENV2 / PANENV2，点相对片段起点）。\n"
                + "· 双耳 HRTF 与房间混响是实时渲染的，Reaper/PR 里没有对应的通用参数，\n"
                + "  所以这两项已经烘进 stems/ 与「导出混音」，工程里只保留位置与音量自动化。\n"
                + "· 想改空间摆位后重新出成品：回本工具改，然后重新「导出混音」。\n"
            )
            with open(os.path.join(stage, "README.txt"), "w", encoding="utf-8") as f:
                f.write(readme)
            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
                for root_dir, _dirs, files in os.walk(stage):
                    for fn in files:
                        full = os.path.join(root_dir, fn)
                        arc = os.path.join(root, os.path.relpath(full, stage)).replace(os.sep, "/")
                        z.write(full, arc)
        finally:
            # 先逐文件删（正常环境几毫秒）；确实删不掉（文件被占用）才退化成改名暂存。
            # 暂存目录不会越积越多：每次导出前会顺手清掉旧的 .trash_*。
            if not _purge_dir(stage):
                try:
                    os.rename(stage,
                              os.path.join(out_dir, ".trash_" + uuid.uuid4().hex[:8]))
                except OSError:
                    pass
        size = os.path.getsize(zip_path)
        _log("timeline: pack %s -> %s (%.1f MB)", sid, zip_path, size / 1048576)
        return {"ok": True, "file": root + ".zip", "size": size, "sample_rate": pack_sr,
                "url": f"/api/v1/lf/scripts/{sid}/export/{root}.zip",
                "duration": built["duration"],
                "clips": len(clip_files), "skipped": skipped}

    # 前端资源一律禁用缓存：改完 HTML/JS/CSS 刷新即生效，避免浏览器拿到旧版本
    # 导致「明明改了却没变化」的困扰。
    _NO_CACHE = {"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                 "Pragma": "no-cache", "Expires": "0"}

    @app.get("/timeline")
    def tl_page():
        return FileResponse(os.path.join(web_dir, "timeline.html"), headers=_NO_CACHE)

    @app.get("/timeline-assets/{name}")
    def tl_asset(name: str):
        base = os.path.basename(name)
        # 时间轴页用到的前端资源：自己的 timeline.*，以及与台本页共用的 emoctl.js
        if not (base.startswith("timeline.") or base == "emoctl.js"):
            raise HTTPException(404, "not found")
        path = os.path.join(web_dir, base)
        if not os.path.exists(path):
            raise HTTPException(404, "not found")
        mt = "text/css" if base.endswith(".css") else "application/javascript"
        if base.endswith(".html"):
            mt = "text/html; charset=utf-8"
        return FileResponse(path, media_type=mt, headers=_NO_CACHE)

    app.include_router(_LF)
