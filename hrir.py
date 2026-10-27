"""双耳 HRIR 渲染（SOFA 实测数据）

以前 `timeline_api._Binaural` 用的是球头近似：ITD + ILD + 低通，靠一条
「后方整体变闷」的规则凑前后感。它能听出左右和远近，但**没有耳廓**，
所以「绕到身后」「抬头/低头」只能靠猜。

这里换成实测 HRIR（默认打包 MIT KEMAR，710 个方向 / 44.1 kHz / 512 抽头）：

  1. 读 SOFA（h5py；SOFA 就是 HDF5）——支持任意 SimpleFreeFieldHRIR；
  2. **对齐**：每个方向每个耳把起始延迟剥掉，单独存成 `dly`。
     不对齐就直接插值/交叉淡化两个方向的 IR，会因为时间错位产生梳状滤波（金属声）；
  3. **插值**：按球面角距离取最近 3 个方向做反距离加权（KEMAR 的网格不规则，
     不能用规则网格的双线性）；
  4. **渲染**：先对信号做「时变分数延迟」（把 ITD 加回去），再用对齐后的 IR 卷积。
     时变延迟用线性重采样，方位在动时是连续的，不会咔哒。

没有 h5py 或没有数据文件时返回 None，调用方自动回退到球头模型 —— 保证离线可用。
"""
import glob
import math
import os

import numpy as np

ROOT = os.path.dirname(os.path.abspath(__file__))
SOFA_DIR = os.path.join(ROOT, "assets", "hrir")
VENDOR = os.path.join(ROOT, "_vendor")
if os.path.isdir(VENDOR) and VENDOR not in os.sys.path:
    os.sys.path.insert(0, VENDOR)

_CACHE = {}          # path -> HRTFSet（按 mtime 失效）
_FAILED = set()


def _angles(az_deg, el_deg):
    """方位角/仰角（度）→ 单位向量。az: 0 正前、90 正右、180 正后；el: 上正。"""
    a = math.radians(az_deg)
    e = math.radians(el_deg)
    return np.array([math.cos(e) * math.sin(a), math.sin(e), -math.cos(e) * math.cos(a)],
                    dtype="float64")


class HRTFSet:
    """一组按方向组织的 HRIR（已对齐、已重采样到目标采样率）。"""

    def __init__(self, name, sr, az, el, ir, dly, src_sr=None, dist=None):
        self.name = name
        self.sr = int(sr)
        self.src_sr = int(src_sr or sr)
        self.az = np.asarray(az, dtype="float32")
        self.el = np.asarray(el, dtype="float32")
        self.ir = np.asarray(ir, dtype="float32")     # (M, 2, K)
        self.dly = np.asarray(dly, dtype="float32")   # (M, 2)
        self.taps = int(self.ir.shape[2])
        # 距离维：SOFA 的 SourcePosition 第三列（米）。远场数据集只有一层（KEMAR 是 1.4m），
        # 近场数据集有 0.25/0.5/0.75/1/1.5 这种多层 —— 有分层才做距离插值。
        if dist is None:
            self.dist = np.ones(len(self.az), dtype="float32")
        else:
            self.dist = np.asarray(dist, dtype="float32").reshape(-1)
            if self.dist.size != len(self.az):
                self.dist = np.full(len(self.az), float(np.median(self.dist) or 1.0),
                                    dtype="float32")
        # 统一标定：按 **1 kHz 灵敏度** 对齐到 0.5（约 −6 dB）。
        #
        # 为什么不用「IR 总能量」：KEMAR 的 IR 有 512 taps（含长尾），能量分散在时间上，
        # 能量相同的情况下 1 kHz 的响应只有 KU100 的三分之一 —— 同一句话换数据集
        # 直接差 10 dB，用户只能靠调音量补偿；而 KU100 近场层偏大，近距离再乘
        # dist_gain 就顶进软限幅，低语/ASMR 听起来是「破音 / 劣质麦克风」。
        # 人声能量集中在 0.2~4 kHz，按 1 kHz 对齐最接近听感，也顺手抹平了
        # npz 打包集（以前完全没标定）与 SOFA 之间的口径差。
        try:
            _n = 1024
            _spec = np.abs(np.fft.rfft(self.ir.astype(np.float64), n=_n, axis=2))
            _fr = np.fft.rfftfreq(_n, 1.0 / self.sr)
            _k = int(np.argmin(np.abs(_fr - 1000.0)))
            _resp = float(np.median(_spec[:, :, max(0, _k - 1):_k + 2]))
            if _resp > 1e-9:
                self.ir = (self.ir * (0.5 / _resp)).astype(np.float32)
        except Exception:  # noqa: BLE001
            pass
        self.dist_layers = np.unique(np.round(self.dist, 3))
        self._layer_idx = {float(v): np.where(np.isclose(self.dist, v, atol=1e-3))[0]
                           for v in self.dist_layers}
        self.vec = np.stack([_angles(a, e) for a, e in zip(self.az, self.el)]) \
            if len(self.az) else np.zeros((0, 3))
        # 方向按向量缓存，查最近邻时只算一次点积
        self._norm = self.vec / np.maximum(1e-9, np.linalg.norm(self.vec, axis=1, keepdims=True))

    # ---- 构造 ---------------------------------------------------------------
    @classmethod
    def load(cls, path, target_sr=44100):
        if not os.path.exists(path):
            return None
        # 打包集（多个单距离 SOFA 合并成一个多距离层）：已经对齐、已标定，直接读
        if path.lower().endswith(".npz"):
            st = os.stat(path)
            key = (path, int(st.st_mtime), int(target_sr), "npz")
            if key in _CACHE:
                return _CACHE[key]
            try:
                z = np.load(path, allow_pickle=False)
                out = cls(str(z["name"]), int(z["sr"]), z["az"], z["el"],
                          z["ir"], z["dly"], src_sr=int(z["src_sr"]), dist=z["dist"])
            except Exception as e:  # noqa: BLE001
                _log_err(f"{os.path.basename(path)}: {e}")
                return None
            _CACHE[key] = out
            return out
        try:
            import h5py
        except Exception:  # noqa: BLE001
            return None
        st = os.stat(path)
        key = (path, int(st.st_mtime), int(target_sr))
        if key in _CACHE:
            return _CACHE[key]
        with h5py.File(path, "r") as f:
            ir = f["Data.IR"][:]                       # (M, 2, K)
            sr = float(np.asarray(f["Data.SamplingRate"]).reshape(-1)[0])
            pos = f["SourcePosition"][:]
            ptype = f["SourcePosition"].attrs.get("Type", b"spherical")
            if isinstance(ptype, bytes):
                ptype = ptype.decode()
            if str(ptype).lower().startswith("cart"):
                x, y, z = pos[:, 0], pos[:, 1], pos[:, 2]
                r = np.sqrt(x * x + y * y + z * z) + 1e-9
                az = np.degrees(np.arctan2(x, -z))
                el = np.degrees(np.arcsin(np.clip(y / r, -1, 1)))
            else:
                az, el = pos[:, 0], pos[:, 1]
                r = pos[:, 2] if pos.shape[1] > 2 else np.ones(len(az))
            name = os.path.splitext(os.path.basename(path))[0]
            try:
                if f.attrs.get("ListenerShortName"):
                    name = f.attrs["ListenerShortName"]
                    if isinstance(name, bytes):
                        name = name.decode()
            except Exception:  # noqa: BLE001
                pass

        ir = np.asarray(ir, dtype="float32")
        if abs(sr - target_sr) > 1:
            ir = _resample_ir(ir, sr, target_sr)
        # 半径是 0 / 缺失的都当远场 1.4m；非有限值同理
        r = np.asarray(r, dtype="float32").reshape(-1)
        r = np.where((r > 0.05) & np.isfinite(r), r, 1.4)
        # SOFA 的方位角是「从正前逆时针」(+90 = 左)，我们是「+90 = 右」，
        # 所以取反；不翻的话左右会整体镜像。
        az = -(((np.asarray(az, dtype="float32") + 180.0) % 360.0) - 180.0)
        el = np.asarray(el, dtype="float32")
        aligned, dly = _align_ir(ir)
        # 标定：让「一个平均方向」的宽带增益 = 1（等于干声）。
        # 不做这一步，换数据集就会整体响度变 2~3 dB —— A/B 比较时人会以为「换的那套更好听」。
        e = (aligned.astype("float64") ** 2).sum(axis=(1, 2))
        med = float(np.median(e)) if e.size else 0.0
        if med > 1e-9:
            aligned = (aligned * (1.0 / math.sqrt(med))).astype("float32")
        out = cls(name, target_sr, az, el, aligned, dly, src_sr=int(sr), dist=r)
        _CACHE[key] = out
        return out

    # ---- 查询 ---------------------------------------------------------------
    def _lookup_layer(self, az, el, k, idx_pool=None):
        q = _angles(float(az or 0), float(el or 0))
        qn = q / max(1e-9, float(np.linalg.norm(q)))
        pool = np.arange(len(self.az)) if idx_pool is None else idx_pool
        if pool.size == 0:
            pool = np.arange(len(self.az))
        cosd = np.clip(self._norm[pool] @ qn, -1.0, 1.0)
        ang = np.arccos(cosd)                        # 0..pi
        kk = min(k, pool.size)
        idx = np.argpartition(ang, kk - 1)[:kk]
        idx = idx[np.argsort(ang[idx])]
        if ang[idx[0]] < 1e-4 or kk == 1:
            return self.ir[pool[idx[0]]], self.dly[pool[idx[0]]]
        # 反距离权重（加一个小量避免除零；角距离越小权重越大）
        w = 1.0 / np.maximum(ang[idx], 1e-3) ** 2
        w = w / w.sum()
        ir = np.tensordot(w.astype("float32"), self.ir[pool[idx]], axes=(0, 0))
        dly = (w[:, None] * self.dly[pool[idx]]).sum(axis=0)
        return ir.astype("float32"), dly.astype("float32")

    def lookup(self, az, el, k=3, dist=None):
        """返回 (ir (2,K), delay (2,))。

        方向：最近 k 个方向反距离加权（网格不规则，不能用双线性）。
        距离：数据集有多层（近场集）时，先按 log 距离取上下两层，各自查一次再插值；
              只有一层（远场集）时忽略 —— 近场补偿交给 `NearField`。
        """
        layers = self.dist_layers
        if dist is None or layers.size <= 1:
            return self._lookup_layer(az, el, k)
        d = float(dist)
        d = min(max(d, float(layers[0]) * 0.6), float(layers[-1]) * 1.6)
        if d <= layers[0] or d >= layers[-1]:
            layer = float(layers[0] if d <= layers[0] else layers[-1])
            return self._lookup_layer(az, el, k, self._layer_idx[layer])
        hi = int(np.searchsorted(layers, d))
        lo = max(0, hi - 1)
        d0, d1 = float(layers[lo]), float(layers[hi])
        ir0, dy0 = self._lookup_layer(az, el, k, self._layer_idx[d0])
        ir1, dy1 = self._lookup_layer(az, el, k, self._layer_idx[d1])
        # 距离按对数插值（人对距离的分辨本来也是对数尺度）
        w = 0.0 if d1 <= d0 else (math.log(d) - math.log(d0)) / (math.log(d1) - math.log(d0))
        w = float(min(1.0, max(0.0, w)))
        return ((ir0 * (1.0 - w) + ir1 * w).astype("float32"),
                (dy0 * (1.0 - w) + dy1 * w).astype("float32"))

    def info(self):
        return {"name": self.name, "dirs": int(len(self.az)), "taps": self.taps,
                "sr": self.sr, "src_sr": self.src_sr,
                "dist": [float(self.dist_layers[0]), float(self.dist_layers[-1])],
                "dist_layers": int(self.dist_layers.size)}


def _resample_ir(ir, src_sr, dst_sr):
    """整组 IR 重采样（FFT，保持相位；KEMAR 是 44.1k，通常不会走到）。"""
    m, c, k = ir.shape
    n_out = int(round(k * dst_sr / src_sr))
    out = np.zeros((m, c, n_out), dtype="float32")
    for i in range(m):
        for e in range(c):
            spec = np.fft.rfft(ir[i, e])
            # 频率轴按比例缩放（截断或补零）
            if n_out <= spec.size:
                new = spec[:n_out]
            else:
                new = np.concatenate([spec, np.zeros(n_out - spec.size, dtype=spec.dtype)])
            out[i, e] = np.fft.irfft(new, n_out).astype("float32")
    return out


def _onset(h, thresh=0.12):
    """估计 IR 起始位置（分数采样）：先找过阈值处，再做抛物线细化。"""
    a = np.abs(h)
    peak = float(a.max())
    if peak <= 0:
        return 0.0
    idx = int(np.argmax(a >= peak * thresh))
    idx = max(0, idx - 1)
    if 0 < idx < len(a) - 1:
        y0, y1, y2 = a[idx - 1], a[idx], a[idx + 1]
        den = (y0 - 2 * y1 + y2)
        # 抛物线细化的偏移必须在 ±0.5 之内：平顶/近似线性时 den 可能小到 1e-6，
        # 0.5*(y0-y2)/den 会飞出几百个采样（KU100 就有这种 IR），
        # 一旦超过 IR 长度，_align_ir 会把整条 IR 切空 → 那个方向变成哑的。
        if abs(den) > 1e-9:
            off = 0.5 * (y0 - y2) / den
            idx = idx + max(-0.5, min(0.5, off))
    return float(min(max(0.0, idx), len(a) - 1))


def _align_ir(ir):
    """剥掉每个方向/耳的起始延迟，返回 (对齐后的 IR, 每个方向每只耳的延迟采样数)。

    对齐后各方向的 IR 在时间上基本重合，插值/交叉淡化才不会梳状滤波。
    """
    m, ch, k = ir.shape
    out = np.zeros_like(ir)
    dly = np.zeros((m, ch), dtype="float32")
    for i in range(m):
        for e in range(ch):
            d = _onset(ir[i, e])
            di = int(math.floor(d))
            if di >= k - 2:
                # 起点贴到末尾 = 这条 IR 基本是空的（或全零），别切，保持原样
                d, di = 0.0, 0
            dly[i, e] = d
            frac = float(d - di)
            h = ir[i, e]
            if di > 0:
                h = h[di:]
            if frac > 1e-3:
                # 去掉小数部分（线性相位近似）
                h0 = h
                h1 = np.concatenate([h[1:], np.zeros(1, dtype=h.dtype)])
                h = (1.0 - frac) * h0 + frac * h1
            out[i, e, :min(k, h.size)] = h[:k]
    return out, dly


# ============================ 渲染 ===========================================
class BinauralRenderer:
    """按块渲染双耳信号；跨块保留卷积尾巴与延迟历史。

    render(x, az, el, dist)：
      · az 标量 → 固定方向
      · az 数组 → 逐样本方位（关键帧自动化），按 256 样本一块取方向，
        块内延迟线性过渡（避免台阶），IR 与上一块做线性过渡（避免谱跳变）
    """

    CHUNK = 256
    BLOCK = 4096

    def __init__(self, hrtf, sr=44100):
        self.h = hrtf
        self.sr = int(sr)
        self.k = int(hrtf.taps)
        self.tail = np.zeros((2, self.k - 1), dtype="float32")
        self.hist = np.zeros(0, dtype="float32")
        self.prev_ir = None
        self.prev_d = None
        self.near = NearField(sr)

    # ---- 工具 ---------------------------------------------------------------
    def _delay2(self, x, d0, d1):
        """一次算两只耳的分数延迟（共用同一段历史，避免 hist 被推进两次）。"""
        need = int(math.ceil(max(abs(float(d0)), abs(float(d1))))) + 2
        if self.hist.size < need:
            self.hist = np.concatenate(
                [np.zeros(need - self.hist.size, dtype="float32"), self.hist])
        ext = np.concatenate([self.hist.astype("float64"), x.astype("float64")])
        self.hist = ext[-need:].astype("float32")
        base = ext.size - x.size
        outs = []
        for d in (float(d0), float(d1)):
            if abs(d) < 1e-6:
                outs.append(x.astype("float32", copy=False))
                continue
            idx = np.arange(x.size, dtype="float64") + base - d
            i0 = np.floor(idx).astype(int)
            fr = idx - i0
            i0 = np.clip(i0, 0, ext.size - 2)
            outs.append(((1.0 - fr) * ext[i0] + fr * ext[i0 + 1]).astype("float32"))
        return outs[0], outs[1]

    def _conv_add(self, xl, xr, irl, irr):
        """与两只耳的对齐 IR 卷积，返回 (2, n)；跨块尾巴存在 self.tail。"""
        n = xl.size
        out = np.zeros((2, n), dtype="float32")
        keep_n = self.tail.shape[1]
        # 1) 上一轮留下的尾巴先并进当前输出，剩下的前移
        add = min(n, keep_n)
        out[:, :add] += self.tail[:, :add]
        carry = np.concatenate([self.tail[:, add:],
                                np.zeros((2, add), dtype="float32")], axis=1)
        # 2) 当前块的卷积；超出 n 的部分进 carry
        for e, (sig, ir) in enumerate(((xl, irl), (xr, irr))):
            full = _fftconv(sig, ir)
            m = min(n, full.size)
            out[e, :m] += full[:m]
            if full.size > n:
                tail = full[n:n + keep_n]
                carry[e, :tail.size] += tail
        self.tail = carry
        return out

    def _dist_gain(self, dist):
        d = float(dist if dist is not None else 1.0)
        return 1.0 / (1.0 + 0.6 * max(0.0, d - 1.0))

    # ---- 主入口 -------------------------------------------------------------
    def render(self, x, az, el=0.0, dist=1.0):
        """分块渲染。块大小 4096（FFT 卷积跑得动，延迟插值的临时数组也不大）。

        az / el / dist 都允许传数组（关键帧自动化）或标量；每块取块中点，
        块之间靠延迟历史 + IR 过渡保持连续。
        """
        x = np.asarray(x, dtype="float32").reshape(-1)
        if x.size == 0:
            return np.zeros(0, dtype="float32"), np.zeros(0, dtype="float32")

        def series(v, n):
            if isinstance(v, (list, tuple, np.ndarray)):
                a = np.asarray(v, dtype="float32").reshape(-1)
                if a.size > 1:
                    return a
                return float(a[0]) if a.size else 0.0
            return float(v if v is not None else 0.0)

        azS, elS, dS = series(az, x.size), series(el, x.size), series(dist, x.size)
        multi = self.h.dist_layers.size > 1

        n = x.size
        out = np.zeros((2, n), dtype="float32")
        step = self.BLOCK
        for i in range(0, n, step):
            j = min(n, i + step)
            m = min(i + step // 2, n - 1)
            a = float(azS[m]) if isinstance(azS, np.ndarray) else float(azS)
            e = float(elS[m]) if isinstance(elS, np.ndarray) else float(elS)
            d = float(dS[m]) if isinstance(dS, np.ndarray) else float(dS)
            ir, dly = self.h.lookup(a, e, dist=(d if multi else None))
            if self.prev_ir is not None:
                # 方位/距离在动：IR 与延迟都跟上一块各取一半，避免块边界谱跳变
                ir = 0.5 * (ir + self.prev_ir)
                dly = 0.5 * (dly + self.prev_d)
            self.prev_ir, self.prev_d = ir, dly
            xl, xr = self._delay2(x[i:j], dly[0], dly[1])
            seg = self._conv_add(xl, xr, ir[0], ir[1])
            if self.near is not None:
                seg = self.near.process(seg, a, d)
            out[:, i:j] = seg
        # 距离增益：有自动化时必须**逐样本**乘。
        # 以前拿「这一段最后一个采样的距离」乘整段，距离一变，每个块边界
        # 都会跳一个台阶（听起来是每秒一声轻响）。
        if isinstance(dS, np.ndarray):
            dd = np.clip(dS.astype("float32"), 0.05, 30.0)
            if dd.size != out.shape[1]:
                dd = np.full(out.shape[1], float(dd[-1]) if dd.size else 1.0,
                             dtype="float32")
            g = np.minimum(1.25, 1.0 / (0.45 + 0.55 * dd)).astype("float32")
            return out[0] * g, out[1] * g
        g = float(dist_gain(dS))
        return out[0] * g, out[1] * g

    def flush(self, n):
        """片段已经结束：把卷积尾巴吐出来（HRIR 只有 ~11ms，主要是避免截断出咔哒）。"""
        out = np.zeros((2, max(0, n)), dtype="float32")
        if n <= 0 or self.tail.shape[1] == 0:
            return out[0], out[1]
        add = min(n, self.tail.shape[1])
        out[:, :add] = self.tail[:, :add]
        self.tail = np.concatenate([self.tail[:, add:],
                                    np.zeros((2, add), dtype="float32")], axis=1)
        return out[0], out[1]


def dist_gain(dist):
    """距离 → 增益（1m 处 = 1.0）。

    近场封顶 +1.9dB（1.25×）：近场 HRIR 本身已经含「离得近→更响」的能量，
    再按 1/d 叠加就会两头都算 —— 低语素材本身峰值高，一乘就进软限幅，
    听感是破音 / 像劣质麦克风。所以近处只做温和提升：
      0.2m/0.5m → +2.0dB（封顶）、1m → 0dB、2m → −3.8dB、3m → −6.4dB
    """
    d = float(dist if dist is not None else 1.0)
    d = max(0.05, min(30.0, d))
    return min(1.25, 1.0 / (0.45 + 0.55 * d))


class NearField:
    """远场 HRIR 补不出「贴耳」的两个线索，这里做近似补偿：

    · proximity（近讲效应）：低频抬升，越近越明显（0.2m 时 150Hz 以下约 +5dB）；
    · 远耳遮挡增强：距离越近、越偏侧，远耳 3kHz 以上越闷
      （真值是近场 HRTF 的 ILD 饱和，远场数据只有约 10dB，近场可到 20dB+）。

    这是近似，不是测量值；但「贴耳」最强的两个主观线索（低频堆积 + 远耳哑掉）
    都在里面，比只调音量像得多。
    """

    def __init__(self, sr=44100, shadow=True):
        self.sr = int(sr)
        # shadow=False 给球头模型用：它自己已经有远耳低通了，再补一次就过度发闷
        self.shadow = bool(shadow)
        self._lp = np.zeros(2, dtype="float64")     # proximity 低通状态（两只耳）
        self._hf = np.zeros(2, dtype="float64")     # 远耳高频低通状态

    def _a(self, fc):
        return 1.0 - math.exp(-2.0 * math.pi * float(fc) / self.sr)

    def process(self, seg, az, dist):
        d = max(0.05, min(30.0, float(dist if dist is not None else 1.0)))
        t = min(1.0, max(0.0, (1.0 - d) / 1.0))      # 1m→0，0.2m→0.8
        if t <= 1e-3:
            return seg
        l = seg[0].astype("float64")
        r = seg[1].astype("float64")
        # ① 低频抬升（一阶低通 + 加回去）
        a = self._a(180.0)
        # 0.9 → 0.55：+5.6dB 的低频堆积对低语（本身气声多）太过，
        # 峰值会被顶进限幅器；+3dB 已经能听出「贴耳」，又不会发闷
        k = 0.55 * t
        for ch, buf in ((0, l), (1, r)):
            out = np.empty_like(buf)
            st = self._lp[ch]
            for i in range(buf.size):
                st += a * (buf[i] - st)
                out[i] = buf[i] + k * st
            self._lp[ch] = st
            buf[:] = out
        # ② 远耳高频遮挡：越近越强，正前/正后时没有「远耳」所以不生效
        if not self.shadow:
            return np.stack([l, r]).astype("float32")
        lat = abs(math.sin(math.radians(max(-180.0, min(180.0, float(az or 0))))))
        g = 0.62 * t * lat
        if g > 1e-3:
            far = 0 if float(az or 0) > 0 else 1        # az>0（右）时左耳是远耳
            buf = l if far == 0 else r
            a2 = self._a(3000.0)
            st = self._hf[far]
            out = np.empty_like(buf)
            for i in range(buf.size):
                st += a2 * (buf[i] - st)
                out[i] = buf[i] * (1.0 - g) + st * g
            self._hf[far] = st
            buf[:] = out
        return np.stack([l, r]).astype("float32")


def _fftconv(a, b):
    """长块用 FFT 卷积（44100×512 的直卷太慢）。"""
    try:
        from scipy.signal import fftconvolve
        return fftconvolve(a, b).astype("float32")
    except Exception:  # noqa: BLE001
        return np.convolve(a, b).astype("float32")


def _shift_frac(x, d):
    """把整段信号再延迟 d（分数）个采样（用边缘填充，不维护历史）。"""
    if abs(d) < 1e-6 or x.size == 0:
        return x
    k = int(math.ceil(abs(d))) + 1
    pad = np.concatenate([np.zeros(k, dtype=x.dtype), x, np.zeros(k, dtype=x.dtype)])
    idx = np.arange(x.size, dtype="float64") + k - d
    i0 = np.floor(idx).astype(int)
    fr = idx - i0
    i0 = np.clip(i0, 0, pad.size - 2)
    return ((1.0 - fr) * pad[i0] + fr * pad[i0 + 1]).astype("float32")


# ============================ 单例 ===========================================
_DEFAULT = {"set": None, "tried": False, "error": ""}


def pack(items, out_path, name=None, target_sr=44100):
    """把多个「单距离」SOFA 合并成一份多距离层的打包集（.npz）。

    为什么要这一步：KU100 近场那套是「每个距离一个 .sofa」，而我们的查表需要
    「一套数据里带距离维」才能做 0.25→0.5→1.0 的连续插值。

    `items` = [(sofa 路径, 这个文件的距离米), ...]；距离按文件里的半径优先。
    每个文件进来时都会走一遍 HRTFSet.load（含**按层标定**）：所以各层响度被拉到同一把尺子，
    距离造成的音量差由渲染器的 dist_gain 负责，不会两头都算一遍。
    """
    az_l, el_l, dist_l, ir_l, dly_l = [], [], [], [], []
    src_sr = int(target_sr)
    for a, b in items:
        # 允许 (path, dist) 或 (dist, path) 两种写法（dict.items() 给的是后者）
        path, dist_hint = (a, b) if isinstance(a, (str, os.PathLike)) else (b, a)
        st = HRTFSet.load(path, target_sr)
        if st is None:
            raise RuntimeError(f"读不了 {path}")
        m = len(st.az)
        d = float(np.median(st.dist))
        if not np.isfinite(d) or d <= 0.05:
            d = float(dist_hint)
        # 每层再按「正前」对齐一次：近场数据本身方向性极强（正前弱、侧向强），
        # 只按全向中位数归一的话，正前方的声音会「越近越轻」—— 方向反了。
        # 按正前归一到 1 之后，距离造成的响度交给 dist_gain，
        # 「近处侧向更强」这个真实方向性仍然保留。
        ir0, _ = st.lookup(0.0, 0.0)
        fe = float((ir0.astype("float64") ** 2).sum())
        k = 1.0 / math.sqrt(fe) if fe > 1e-9 else 1.0
        az_l.append(st.az)
        el_l.append(st.el)
        dist_l.append(np.full(m, d, dtype="float32"))
        ir_l.append((st.ir * k).astype("float32"))
        dly_l.append(st.dly)
        src_sr = st.src_sr
    az = np.concatenate(az_l)
    el = np.concatenate(el_l)
    dist = np.concatenate(dist_l)
    ir = np.concatenate(ir_l).astype("float32")
    dly = np.concatenate(dly_l).astype("float32")
    order = np.lexsort((el, az, dist))
    rid = str(name or os.path.splitext(os.path.basename(out_path))[0])
    np.savez_compressed(
        out_path, name=np.array(rid), sr=np.array(int(target_sr)),
        src_sr=np.array(int(src_sr)), az=az[order], el=el[order],
        dist=dist[order], ir=ir[order], dly=dly[order],
    )
    layers = np.unique(np.round(dist, 3))
    print(f"packed {rid}: {len(az)} dirs, {len(layers)} layers "
          f"({layers.min():.2f}~{layers.max():.2f}m), taps={ir.shape[2]}, "
          f"{os.path.getsize(out_path)/1048576:.1f}MB")
    return out_path


def _pretty(pid):
    """文件名 → 展示名：MIT_KEMAR_normal_pinna → MIT KEMAR normal pinna"""
    return pid.replace("_", " ").strip()


def profiles():
    """可用数据集清单（不加载数据，只扫目录；sphere 是永远存在的兜底）。"""
    out = []
    files = sorted(glob.glob(os.path.join(SOFA_DIR, "*.sofa"))) + \
        sorted(glob.glob(os.path.join(SOFA_DIR, "*.npz")))
    for path in files:
        pid = os.path.splitext(os.path.basename(path))[0]
        meta = _profile_meta(path)
        # 注意：_profile_meta 的结果是缓存的，不能 pop（第二次调用就丢了）
        lab = meta.get("label") or _pretty(pid)
        rest = {k2: v2 for k2, v2 in meta.items() if k2 != "label"}
        out.append({"id": pid, "label": lab,
                    "kind": "packed" if path.endswith(".npz") else "sofa",
                    "path": os.path.basename(path), **rest})
    out.append({"id": "sphere", "label": "球头近似（无数据也能用）", "kind": "analytic",
                "taps": 0, "dirs": 0, "dist": [], "src_sr": 0})
    return out


_META = {}


def _profile_meta(path):
    """只读 SOFA 的头（形状/采样率/距离层），不读 Data.IR —— 近场集几百 MB，扫一遍太贵。"""
    key = (path, int(os.path.getmtime(path)) if os.path.exists(path) else 0)
    if key in _META:
        return _META[key]
    meta = {"taps": 0, "dirs": 0, "dist": [], "src_sr": 0}
    if path.endswith(".npz"):
        try:
            z = np.load(path, allow_pickle=False)
            meta["dirs"] = int(z["ir"].shape[0])
            meta["taps"] = int(z["ir"].shape[2])
            meta["src_sr"] = int(z["src_sr"])
            layers = np.unique(np.round(z["dist"], 3))
            meta["dist"] = [float(layers.min()), float(layers.max()), int(layers.size)]
            meta["size_mb"] = round(os.path.getsize(path) / 1048576.0, 1)
            try:
                meta["label"] = str(z["name"])
            except Exception:  # noqa: BLE001
                pass
        except Exception as e:  # noqa: BLE001
            meta["error"] = str(e)
        _META[key] = meta
        return meta
    try:
        import h5py
        with h5py.File(path, "r") as f:
            ir = f["Data.IR"]
            meta["dirs"] = int(ir.shape[0])
            meta["taps"] = int(ir.shape[2])
            meta["src_sr"] = int(float(np.asarray(f["Data.SamplingRate"]).reshape(-1)[0]))
            pos = f["SourcePosition"][:]
            if pos.shape[1] > 2:
                r = np.round(np.asarray(pos[:, 2], dtype="float32"), 2)
                r = r[(r > 0.05) & np.isfinite(r)]
                if r.size:
                    layers = np.unique(r)
                    meta["dist"] = [float(layers.min()), float(layers.max()), int(layers.size)]
            meta["size_mb"] = round(os.path.getsize(path) / 1048576.0, 1)
    except Exception as e:  # noqa: BLE001
        meta["error"] = str(e)
    _META[key] = meta
    return meta


def default_name():
    cand = os.environ.get("INDEXTTS_HRIR") or ""
    if cand and os.path.exists(cand):
        return os.path.splitext(os.path.basename(cand))[0]
    files = sorted(glob.glob(os.path.join(SOFA_DIR, "*.sofa"))) + \
        sorted(glob.glob(os.path.join(SOFA_DIR, "*.npz")))
    for path in files:
        return os.path.splitext(os.path.basename(path))[0]
    return "sphere"


def get_set(name=None):
    """按名字取一套 HRIR。

    名字可以是：
      · None / ""            → 默认（环境变量 → assets 里第一个）
      · "sphere"/"analytic"  → None（调用方用球头模型）
      · 文件名（不含 .sofa）  → 对应数据集，失败也返回 None（回退球头）
    结果按 (路径, mtime) 缓存在 _CACHE，重复调用不重新加载。
    """
    name = (name or "").strip()
    if name.lower() in ("sphere", "analytic", "model"):
        return None
    if name:
        base = os.path.join(SOFA_DIR, name)
        cands = [name] if name.endswith((".sofa", ".npz")) else [name + ".sofa", name + ".npz"]
        path = ""
        for c in cands:
            p = os.path.join(SOFA_DIR, c)
            if os.path.exists(p):
                path = p
                break
    else:
        path = os.environ.get("INDEXTTS_HRIR") or ""
        if not (path and os.path.exists(path)):
            found = sorted(glob.glob(os.path.join(SOFA_DIR, "*.sofa"))) + \
                sorted(glob.glob(os.path.join(SOFA_DIR, "*.npz")))
            path = found[0] if found else ""
    if not path:
        return None
    try:
        return HRTFSet.load(path)
    except Exception as e:  # noqa: BLE001
        _log_err(f"{os.path.basename(path)}: {e}")
        return None


def _log_err(msg):
    _DEFAULT["error"] = msg
    try:
        print("[hrir]", msg, flush=True)
    except Exception:  # noqa: BLE001
        pass


def default_hrtf(path=None):
    """兼容旧调用：等价于 get_set()（或显式路径）。"""
    if path:
        return HRTFSet.load(path)
    return get_set(None)


def status():
    st = get_set(None)
    base = {"profiles": profiles(), "default": default_name()}
    if st is None:
        return {"available": False, "reason": _DEFAULT["error"] or "未加载", **base}
    return {"available": True, **st.info(), **base}


def space_of(st):
    """给前端/接口用的摘要：方向数、距离层。"""
    if st is None:
        return {"dist": [], "layers": 0}
    return {"dist": [float(st.dist_layers[0]), float(st.dist_layers[-1])],
            "layers": int(st.dist_layers.size)}
