"""房间混响：镜像源法生成「双耳 RIR」（纯 numpy，无额外依赖）

为什么要自己写，而不是直接上 pyroomacoustics：
  · 运行时是打包好的嵌入式 Python，没有 pip；多一个重依赖（它还要 matplotlib）
    就多一份装不上的风险；
  · 我们只需要「长方体房间 + 均匀吸声」这一种情况，镜像源法 80 行就够，
    公式可查、结果可测（RT60 能对得上）；
  · 结果完全确定，回归测试可以卡数值。

做法：
  1. 由 RT60 用 Sabine 反推平均吸声系数 α（A = 0.161V / (RT60·S)）；
  2. 房间六个面做镜像，枚举 (nx, ny, nz) 得到一串镜像源；
  3. 每只耳朵（听者左右各 9cm）各自累加脉冲：幅度 = 1/(4πr) × (1−α)^反射次数；
  4. **切掉直达声**：直达已经由 HRIR 渲染过了，这里只留反射与混响尾巴；
  5. 时间上做「越来越闷」的低通（空气吸收 + 高频先衰减），再归一到单位能量。

听者朝向固定为 +y（正前），声源按方位角/距离摆在房间里 —— 方位/距离变化时
反射的到达时间与左右差都会跟着变，所以「走动」是有意义的，不是一句静态混响。
"""
import math
import os
import threading

import numpy as np

SR = 44100
C_AIR = 343.0
EAR_HALF = 0.09          # 两耳间距的一半（米）

# id / 名称 / 房间尺寸(米) / RT60(秒) / 说明
ROOMS = [
    # 录音棚/播客间：ASMR、贴耳耳语要的是「几乎没有房间」，只剩一点点早期反射
    ("booth", "录音棚", (2.4, 2.0, 2.4), 0.12, "几乎无反射，贴耳/耳语"),
    ("small", "小卧室", (3.4, 2.8, 2.5), 0.35, "近讲、干爽，适合独白"),
    ("living", "客厅", (5.6, 4.4, 2.7), 0.60, "常见室内，轻微空间感"),
    ("corridor", "走廊", (9.0, 1.9, 2.6), 0.95, "长条反射，有一点金属味"),
    ("hall", "大厅", (16.0, 11.0, 7.0), 1.90, "明显混响，适合大场面"),
    ("outdoor", "室外", (60.0, 60.0, 20.0), 0.10, "几乎无反射，只有空气衰减"),
]
ROOM_MAP = {r[0]: r for r in ROOMS}

AZ_BUCKET = 45           # 方位分档（度）
DIST_EDGES = (2.0, 6.0)  # 距离分档边界（米）：近 / 中 / 远

_CACHE = {}
_LOCK = threading.Lock()
_MAX_CACHE = 48


def room_list():
    return [{"id": r[0], "name": r[1], "rt60": r[3],
             "size": list(r[2]), "desc": r[4]} for r in ROOMS]


def _sabine_alpha(vol, surf, rt60):
    """Sabine：A = 0.161 V / (RT60 S)，A 是总吸声量（m²），α = A / S。"""
    if rt60 <= 0.02 or surf <= 0:
        return 0.95
    a = 0.161 * vol / (rt60 * surf)
    return float(min(0.95, max(0.03, a)))


def _mirror(pos, length, n):
    """一维镜像位置：n 为镜像序号（正负表示反射方向），返回坐标与反射次数。"""
    if n == 0:
        return pos, 0
    # 2kL ± p
    if n % 2 == 1:
        k = (n + 1) // 2
        return 2 * k * length - pos, abs(n)
    k = n // 2
    return 2 * k * length + pos, abs(n)


def _bucket(az, dist):
    """方位 45° 一档、距离三档。必须和前端的 roomIrKey() 完全一致，
    否则「试听」和「导出」会取到不同的 IR。"""
    # 用 floor(x+0.5) 而不是 round()：Python 的 round 是银行家舍入（0.5→0），
    # JS 的 Math.round 是 0.5→1，同一个方位会差一档。
    a = int(math.floor((((float(az or 0) + 180.0) % 360.0) / AZ_BUCKET) + 0.5)) \
        * AZ_BUCKET - 180
    d = float(dist if dist is not None else 1.0)
    idx = 0
    for i, edge in enumerate(DIST_EDGES):
        if d > edge:
            idx = i + 1
    return a, idx


def room_ir(room_id, az=0.0, dist=1.0, sr=SR):
    """返回 (2, N) 的双耳房间 RIR（已去直达、归一化）。"""
    if room_id not in ROOM_MAP:
        return None
    azb, db = _bucket(az, dist)
    key = (room_id, azb, db, int(sr))
    with _LOCK:
        hit = _CACHE.get(key)
    if hit is not None:
        return hit
    ir = _build(room_id, azb, db, int(sr))
    if ir is None:
        return None
    with _LOCK:
        if len(_CACHE) >= _MAX_CACHE:
            _CACHE.pop(next(iter(_CACHE)))
        _CACHE[key] = ir
    return ir


WET_REF = 0.5           # send=1 时，湿声约为干声的 0.5（-6 dB），各房间同一把尺子
E_FLOOR = 0.02          # 归一化分母下限：反射太少的房间不许被拉满
_CALIB = {}


def _measure_rt60(ir, sr):
    """Schroeder 反向积分，取 -5 ~ -25 dB 斜率。"""
    e = (ir.astype("float64") ** 2).sum(axis=0)
    if e.sum() <= 0:
        return 0.0
    edc = np.cumsum(e[::-1])[::-1]
    db = 10.0 * np.log10(edc / edc[0] + 1e-30)
    def at(level):
        idx = int(np.argmax(db <= level))
        return idx / float(sr), bool(db[-1] <= level)
    t5, ok5 = at(-5.0)
    t25, ok25 = at(-25.0)
    if ok5 and ok25 and t25 > t5:
        return (t25 - t5) * 3.0
    # 尾巴没衰减到 -25 dB（短房间 / 截断）：退回 -5~-15 外推
    t15, ok15 = at(-15.0)
    if ok5 and ok15 and t15 > t5:
        return (t15 - t5) * 6.0
    return 0.0


def _build(room_id, azb, db, sr, alpha=None):
    _, name, (lx, ly, lz), rt60 = ROOM_MAP[room_id][:4]
    vol = lx * ly * lz
    surf = 2 * (lx * ly + ly * lz + lx * lz)
    if alpha is None:
        alpha = _sabine_alpha(vol, surf, rt60)
    # 长度：RT60 的 1.25 倍 + 一点余量（Schroeder 能走到 -25 dB）
    n_taps = int(min(5.0, max(0.30, rt60 * 1.25 + 0.10)) * sr)

    # 距离取档位中点；方位用档位中心
    dist = {0: 1.0, 1: 3.5, 2: 9.0}.get(db, 1.0)
    a = math.radians(azb)
    lx0, ly0 = lx / 2.0, ly / 2.0
    lz0 = min(1.55, lz / 2.0)
    # 声源：听者前方 +y，右方 +x。距离先按房间几何截断到「沿这个方向还能走多远」，
    # 而不是统一截到某个半径 —— 否则窄房间里不同距离档会算出同一份 IR。
    dx, dy = math.sin(a), math.cos(a)
    lim = []
    if abs(dx) > 1e-6:
        lim.append(((lx - 0.25) / 2.0) / abs(dx))
    if abs(dy) > 1e-6:
        lim.append(((ly - 0.25) / 2.0) / abs(dy))
    max_d = min(lim) if lim else 1.0
    dist = max(0.4, min(dist, max_d * 0.85))
    sx = lx0 + dist * dx
    sy = ly0 + dist * dy
    sz = lz0
    sx = float(np.clip(sx, 0.2, lx - 0.2))
    sy = float(np.clip(sy, 0.2, ly - 0.2))

    rir = np.zeros((2, n_taps), dtype="float32")
    direct_samp = (dist / C_AIR) * sr

    # 早期反射：镜像源用 8 阶（再多也就是给晚期尾巴做重复劳动，还慢）
    order = 8
    for nx in range(-order, order + 1):
        px, rx = _mirror(sx, lx, nx)
        for ny in range(-order, order + 1):
            py, ry = _mirror(sy, ly, ny)
            for nz in range(-order, order + 1):
                pz, rz = _mirror(sz, lz, nz)
                nref = rx + ry + rz
                amp = (1.0 - alpha) ** nref
                if amp < 0.002:
                    continue
                for e, ex in enumerate((-EAR_HALF, EAR_HALF)):
                    dx = px - (lx0 + ex)
                    dy = py - ly0
                    dz = pz - lz0
                    r = math.sqrt(dx * dx + dy * dy + dz * dz)
                    if r < 0.05:
                        continue
                    idx = (r / C_AIR) * sr
                    if idx >= n_taps - 2:
                        continue
                    if idx <= direct_samp + 0.0015 * sr:
                        # 直达（含极早期）：交给 HRIR，别再叠一遍
                        continue
                    g = amp / (4.0 * math.pi * r)
                    i0 = int(idx)
                    fr = idx - i0
                    rir[e, i0] += g * (1.0 - fr)
                    rir[e, i0 + 1] += g * fr

    # 晚期混响：指数衰减的去相关噪声尾巴，从「早期反射基本结束」处接上。
    # 纯镜像源做不到长 RT60（阶数要几十阶、镜像数爆炸），工业做法都是这样拼。
    if rt60 > 0.12:
        t_start = float(min(0.06, max(0.02, rt60 * 0.15)))
        i_start = int(t_start * sr)
        if i_start < n_taps:
            rng = np.random.default_rng(20261025)
            m = n_taps - i_start
            t = np.arange(m, dtype="float64") / sr
            env = np.exp(-6.9078 * t / rt60)
            common = rng.standard_normal(m) * 0.55
            nz = np.stack([common + rng.standard_normal(m) * 0.83,
                           common + rng.standard_normal(m) * 0.83]) * env
            # 30ms 淡入，避免尾巴起点出现「噗」的一声
            fade = int(min(m, 0.03 * sr))
            if fade > 1:
                nz[:, :fade] *= np.linspace(0.0, 1.0, fade)[None, :]
            # 电平对齐：让尾巴刚出现时的 RMS 和早期反射同一量级
            w = slice(i_start, min(n_taps, i_start + int(0.05 * sr)))
            e_early = float(np.sqrt((rir[:, w].astype("float64") ** 2).mean() + 1e-20))
            e_tail = float(np.sqrt((nz[:, :w.stop - w.start].astype("float64") ** 2).mean() + 1e-20))
            if e_tail > 1e-12:
                nz *= (1.4 * e_early / e_tail)
            rir[:, i_start:] += nz.astype("float32")

    # 越往后越闷：分段一阶低通（fc 从 16k 降到 ~1.5k）
    rir = _damp(rir, sr, rt60)

    # 归一化到固定的湿声电平：这样「干湿比」滑杆在各房间含义一致。
    # 先算能量；几乎没反射的房间（室外）直接当没有混响，避免把零星反射放大成回声。
    e = float(np.sqrt((rir.astype("float64") ** 2).sum()))
    if e < 1e-6:
        return np.zeros_like(rir)
    # 归一化到固定湿声电平；但给分母加个下限 —— 否则「室外」这种几乎没反射的房间
    # 会被放大成「零星回声」，比没有混响还难听。
    rir *= (WET_REF / max(e, E_FLOOR))
    return rir


def _damp(rir, sr, rt60):
    """分段低通：模拟高频先衰减（简单但听感有效）。"""
    try:
        from scipy.signal import lfilter
    except Exception:  # noqa: BLE001
        return rir
    out = np.zeros_like(rir)
    n = rir.shape[1]
    blk = 512
    fc_start = 16000.0
    fc_end = 1500.0
    for e in range(2):
        zi = np.zeros(1)
        for i in range(0, n, blk):
            j = min(n, i + blk)
            k = i / max(1, n - 1)
            fc = fc_start * (fc_end / fc_start) ** k
            fc = max(600.0, min(fc, sr * 0.45))
            a = 1.0 - math.exp(-2.0 * math.pi * fc / sr)
            y, zi = lfilter([a], [1.0, -(1.0 - a)], rir[e, i:j], zi=zi)
            out[e, i:j] = y
    return out


class RoomRenderer:
    """按块把干声卷积成「湿声」，跨块保留尾巴（IR 比块长得多）。"""

    def __init__(self, sr=SR):
        self.sr = int(sr)
        self.tail = np.zeros((2, 0), dtype="float32")

    def process(self, x, room_id, az=0.0, dist=1.0):
        x = np.asarray(x, dtype="float32").reshape(-1)
        n = x.size
        if n == 0:
            return np.zeros(0, dtype="float32"), np.zeros(0, dtype="float32")
        ir = room_ir(room_id, az, dist, self.sr)
        if ir is None:
            return np.zeros(n, dtype="float32"), np.zeros(n, dtype="float32")
        k = ir.shape[1]
        if self.tail.shape[1] != k - 1:
            # IR 长度变了（换房间 / 换距离档）：保留还挂着的那段尾巴，
            # 截断或补零到新长度就行。以前是直接清零——尾巴被瞬间掐断，
            # 换房间的那一刻就是一声「咔」。
            old = self.tail
            new = np.zeros((2, k - 1), dtype="float32")
            m = min(k - 1, old.shape[1])
            if m > 0:
                new[:, :m] = old[:, :m]
            self.tail = new
        out = np.zeros((2, n), dtype="float32")
        add = min(n, k - 1)
        out[:, :add] += self.tail[:, :add]
        carry = np.concatenate([self.tail[:, add:],
                                np.zeros((2, add), dtype="float32")], axis=1)
        try:
            from scipy.signal import fftconvolve
            conv = fftconvolve
        except Exception:  # noqa: BLE001
            conv = np.convolve
        for e in range(2):
            full = conv(x, ir[e]).astype("float32")
            m = min(n, full.size)
            out[e, :m] += full[:m]
            if full.size > n:
                t = full[n:n + carry.shape[1]]
                carry[e, :t.size] += t
        self.tail = carry
        return out[0], out[1]

    def flush(self, n):
        """片段已经结束了：把还挂在尾巴里的混响吐出来（否则导出会把余响切掉）。"""
        out = np.zeros((2, n), dtype="float32")
        if self.tail.shape[1] == 0 or n <= 0:
            return out[0], out[1]
        add = min(n, self.tail.shape[1])
        out[:, :add] = self.tail[:, :add]
        self.tail = np.concatenate([self.tail[:, add:],
                                    np.zeros((2, add), dtype="float32")], axis=1)
        return out[0], out[1]


def clear_cache():
    with _LOCK:
        _CACHE.clear()
