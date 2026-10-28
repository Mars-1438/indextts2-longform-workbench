/* 全能音声工作台 · 时间轴（多轨 / 剪辑 / 导航 / 素材）
   canvas 自绘 + Web Audio 调度。所有编辑都写进 project.json 的差分。 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pad2 = (n) => String(n).padStart(2, "0");
  const uid = () => Math.random().toString(36).slice(2, 10);
  const mono = () => getComputedStyle(document.body).getPropertyValue("--mono");
  const sans = () => getComputedStyle(document.body).getPropertyValue("--sans");

  function fmt(t) {
    t = Math.max(0, t || 0);
    const m = Math.floor(t / 60), s = Math.floor(t % 60), c = Math.floor((t * 100) % 100);
    return `${m}:${pad2(s)}.${pad2(c)}`;
  }
  function fmtShort(t) {
    t = Math.max(0, t || 0);
    const m = Math.floor(t / 60), s = Math.round(t % 60);
    return `${m}:${pad2(s)}`;
  }
  function toast(msg, isErr) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "toast show" + (isErr ? " err" : "");
    clearTimeout(t._h);
    t._h = setTimeout(() => (t.className = "toast"), isErr ? 4200 : 2000);
  }

  const SID = (new URLSearchParams(location.search).get("sid") || "").replace(/[^0-9a-f]/g, "")
    || (localStorage.getItem("lf.last") || "").replace(/[^0-9a-f]/g, "");
  const API = `/api/v1/lf/tl/${SID}`;
  const LFAPI = "/api/v1/lf";        // 音效素材库等全局接口

  const RULER_H = 26;
  const TRACK_H = 64;
  const GAP = 4;

  const S = {
    data: null,
    pps: 60,
    scrollX: 0,
    sel: null,
    multi: new Set(),      // 多选（批量操作）
    anchor: null,          // Shift 连选的起点
    marquee: null,         // 框选矩形 {x0,y0,x1,y1}
    bulkOpen: false,       // 批量条是否被手动打开（片段右键菜单里可以打开）
    peaks: new Map(),
    waveN: {},             // 每段片段上一次绘制用的竖线数（排查「长音频竖线被拉开」）
    peakAsk: new Set(),
    playing: false,
    pos: 0,
    t0: 0,
    audioAlive: false,
    timer: null,
    drag: null,
    dirty: false,
    saveTimer: null,
    clipboard: null,
    navDrag: null,
    hoverIns: null,
    ovDrag: false,
    snap: true,
    loop: false,
    rate: 1,               // 预览倍速（只影响试听）
  };

  /* ------------------------------ 画布 ------------------------------ */
  const cv = $("cv");
  const ctx = cv.getContext("2d");
  const nav = $("nav");
  const nctx = nav.getContext("2d");
  let W = 800, H = 400, DPR = 1, NW = 800, NH = 74;

  const tracks = () => (S.data ? S.data.tracks : []);
  const allClips = () => tracks().reduce((a, t) => a.concat(t.clips), []);
  const clipById = (id) => allClips().find((c) => c.id === id) || null;
  const trackOfClip = (c) => tracks().find((t) => t.clips.includes(c)) || null;
  // 轨道按类型分组排序：音声轨在前，素材轨在后（保持组内原有相对顺序）
  const VOICE_COPY_TRACK = "音声副本音轨";   // 复制语音片段时的专属素材轨名
  const BTN_ROW_H = 26;      // 新建轨按钮行高度
  const GROUP_GAP = 14;      // 音声轨组与素材轨组之间的分隔空隙
  const voiceTracks = () => tracks().filter((t) => t.kind === "voice");
  const sfxTracks = () => tracks().filter((t) => t.kind === "sfx");
  const orderedTracks = () => voiceTracks().concat(sfxTracks());

  /* ============================== 关键帧 ==============================
     每条片段都能挂「音量 / 声像」的自动化曲线：
       c.kf = { gain: [[相对秒, 值], ...], pan: [...] }   （时间相对片段起点）
     有曲线的属性，这段就以曲线为准（静态 gain/pan 让位给自动化）。
     画布上：曲线画在片段里，点是小方块；拖动改时间+数值，Alt+点击加点，双击点删除。 */
  const KF_META = {
    gain: { label: "音量", lo: 0, hi: 2, def: 1, step: 0.02,
            fmt: (v) => Math.round(v * 100) + "%", unit: "%", scale: 100 },
    pan: { label: "声像", lo: -1, hi: 1, def: 0, step: 0.05,
           fmt: (v) => (Math.abs(v) < 0.02 ? "居中"
             : (v < 0 ? "左 " : "右 ") + Math.round(Math.abs(v) * 100) + "%"),
           unit: "%", scale: 100 },
    /* 空间关键帧：一个点 = 一个位置（方位 / 仰角 / 距离）。
       片段上那条曲线的纵轴是**距离**（对数刻度：0.2m 在底、10m 在顶），
       所以「把插入点往上拖 = 声音离你更远」，往下拖 = 越贴耳；
       方位和仰角在右侧的图形面板里改（罗盘或三视图），因为一根纵轴画不了三个量。 */
    space: { label: "空间距离", lo: 0.2, hi: 10, def: 1, step: 0.05, log: true,
             fmt: (v) => (v < 1 ? v.toFixed(2) : v.toFixed(1)) + "m",
             unit: "m", scale: 1 },
  };
  const SPACE_AZ = 1, SPACE_EL = 2, SPACE_DIST = 3;
  const KF = { prop: "gain", drag: null, snapPx: 7, sel: null, selFor: null,
               insert: false, view: "xz", hidden: false, rec: null };
  try {
    // 上次用的平面：xz / yz / xy（老版本存的 top/tri 迁到 xz）
    const v = localStorage.getItem("tl.spview");
    KF.view = ["xz", "yz", "xy"].includes(v) ? v : "xz";
  } catch (e) { /* 忽略 */ }

  const kfPts = (c, prop) => ((c && c.kf && Array.isArray(c.kf[prop])) ? c.kf[prop] : []);
  const r3 = (v) => Math.round(v * 1000) / 1000;

  /* 空间点存的是 [时间, 方位, 仰角, 距离]（顺序与后端一致），
     但片段上的曲线画的是「距离」：取值时单独把第 4 个分量挑出来当纵轴。 */
  const kfYVal = (prop, pt) => (prop === "space"
    ? (pt[SPACE_DIST] == null ? 1 : Number(pt[SPACE_DIST])) : pt[1]);
  /* 曲线取值用的序列（只有空间需要换纵轴）。按内容指纹缓存，
     否则每帧都会新建一个数组，PCHIP 的 WeakMap 缓存永远命中不了。
     空间序列存的是**归一化后的距离**（0..1，对数刻度）：
     这样「折线」在图上是直线、听感上也是匀速（每段等比例变化），
     曲线形态和实际声音严格一致。 */
  const SPSER = new WeakMap();
  function kfSeries(pts, prop) {
    if (prop !== "space" || !pts) return pts;
    const sig = kfSig(pts, SPACE_DIST, 1);
    const hit = SPSER.get(pts);
    if (hit && hit.sig === sig) return hit.arr;
    const arr = pts.map((q) => [q[0], kfNorm("space",
      q[SPACE_DIST] == null ? 1 : Number(q[SPACE_DIST]))]);
    SPSER.set(pts, { sig, arr });
    return arr;
  }
  /* 值 ↔ 归一化（0..1）映射：空间的纵轴用对数刻度，
     否则 10m 的行程会把 0.2~1m 这段贴耳区间挤成一条缝。 */
  function kfNorm(prop, v) {
    const m = KF_META[prop];
    if (m.log) {
      return clamp(Math.log(clamp(Number(v) || m.def, m.lo, m.hi) / m.lo)
        / Math.log(m.hi / m.lo), 0, 1);
    }
    return clamp((Number(v) - m.lo) / (m.hi - m.lo), 0, 1);
  }
  function kfDenorm(prop, k) {
    const m = KF_META[prop];
    const u = clamp(k, 0, 1);
    return m.log ? m.lo * Math.pow(m.hi / m.lo, u) : m.lo + u * (m.hi - m.lo);
  }

  /* 平滑曲线：单调三次 Hermite（PCHIP）。
     关键帧的位置和数值**一个都不动**，只是把「点与点之间拉直线」换成「经过每个点、
     段与段一阶连续的曲线」。用单调版本而不是普通 Catmull-Rom，是因为它不会过冲：
     音量节点之间不会冲到 0 以下或 400% 以上（那是爆音），声像也不会甩出 ±1。
     点还是原来的点，拖点、双击删点、Alt 加点的手感完全不变。 */
  const PCHIP = new WeakMap();
  /* 指纹：拖动关键帧是「就地 splice 同一个数组」，WeakMap 的键不变，
     只按对象身份缓存会一直拿到拖之前的斜率 —— 表现就是「折线跟着动、曲线不动」。
     这里再比一次内容指纹，点一变就重算。 */
  function kfSig(pts, idx, round) {
    const mul = round === 1 ? 10000 : 1000;
    let h = 2166136261;
    for (let i = 0; i < pts.length; i++) {
      h = ((h ^ Math.round(pts[i][0] * 1000)) * 16777619) | 0;
      h = ((h ^ Math.round((pts[i][idx == null ? 1 : idx] || 0) * mul)) * 16777619) | 0;
    }
    return pts.length + ":" + (h >>> 0);
  }

  function pchipOf(pts) {
    const sig = kfSig(pts);
    let c = PCHIP.get(pts);
    if (c && c.sig === sig) return c;
    const n = pts.length;
    const xs = new Array(n), ys = new Array(n);
    const h = new Array(Math.max(1, n - 1)), d = new Array(Math.max(1, n - 1));
    for (let i = 0; i < n; i++) { xs[i] = pts[i][0]; ys[i] = pts[i][1]; }
    for (let i = 0; i < n - 1; i++) {
      h[i] = Math.max(1e-6, xs[i + 1] - xs[i]);
      d[i] = (ys[i + 1] - ys[i]) / h[i];
    }
    const m = new Array(n).fill(0);
    if (n >= 2) {
      m[0] = d[0];
      m[n - 1] = d[n - 2];
      for (let i = 1; i < n - 1; i++) {
        if (d[i - 1] * d[i] <= 0) { m[i] = 0; }
        else {
          const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
          m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
        }
      }
    }
    c = { xs, ys, h, m, sig };
    PCHIP.set(pts, c);
    return c;
  }

  function pchipAt(pts, t) {
    const n = pts.length;
    if (n === 1) return pts[0][1];
    if (t <= pts[0][0]) return pts[0][1];
    if (t >= pts[n - 1][0]) return pts[n - 1][1];
    const { xs, ys, h, m } = pchipOf(pts);
    let i = 0;
    while (i < n - 2 && t > xs[i + 1]) i++;
    const hh = h[i];
    const u = (t - xs[i]) / hh;
    const u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * ys[i]
      + (u3 - 2 * u2 + u) * hh * m[i]
      + (-2 * u3 + 3 * u2) * ys[i + 1]
      + (u3 - u2) * hh * m[i + 1];
  }

  // 曲线形态：smooth（默认，经过点的平滑曲线） / linear（折线）
  function kfShape(c, prop) {
    const shp = c && c.kf && c.kf.shape;
    if (shp && shp[prop]) return shp[prop] === "linear" ? "linear" : "smooth";
    return "smooth";
  }

  function kfAt(pts, t, dflt, shape) {
    if (!pts || !pts.length) return dflt;
    if ((shape || "smooth") === "linear") {
      if (t <= pts[0][0]) return pts[0][1];
      const last = pts[pts.length - 1];
      if (t >= last[0]) return last[1];
      for (let i = 1; i < pts.length; i++) {
        if (t <= pts[i][0]) {
          const a = pts[i - 1], b = pts[i];
          const span = b[0] - a[0];
          const k = span < 1e-9 ? 0 : (t - a[0]) / span;
          return a[1] + (b[1] - a[1]) * k;
        }
      }
      return last[1];
    }
    return pchipAt(pts, t);
  }

  // 静态值（没有曲线时用哪个数）
  function kfStatic(c, prop) {
    if (prop === "pan") return c.pan || 0;
    if (prop === "space") return c.dist == null ? 1 : Number(c.dist);
    return c.gain == null ? 1 : c.gain;
  }

  // 某属性在片段内 local 秒处的值（没有关键帧就退回静态值）
  function kfValue(c, prop, local) {
    const pts = kfPts(c, prop);
    const stat = kfStatic(c, prop);
    if (!pts.length) return stat;
    if (prop !== "space") return kfAt(pts, local, stat, kfShape(c, prop));
    return kfDenorm(prop, kfAt(kfSeries(pts, prop), local, kfNorm(prop, stat),
      kfShape(c, prop)));
  }

  // 这条片段可以画几条曲线（方位只在开了双耳时才有意义）
  const kfPropsOf = (c) => (c && c.binaural ? ["gain", "pan", "space"] : ["gain", "pan"]);

  /* 空间关键帧的读取：一个是整点（含仰角/距离），一个是「某一时刻的位置」。 */
  const kfSpace = (c) => ((c && c.kf && Array.isArray(c.kf.space)) ? c.kf.space : []);
  const kfSpaceStatic = (c) => ({
    az: Number(c.az || 0),
    el: Number(c.el || 0),
    dist: c.dist == null ? 1 : Number(c.dist),
  });
  function kfSpaceAt(c, local) {
    const pts = kfSpace(c);
    const st = kfSpaceStatic(c);
    if (!pts.length) return st;
    const shp = kfShape(c, "space");
    const comp = (i, dflt) => kfAt(pts.map((q) => [q[0], q[i] == null ? dflt : q[i]]),
      local, dflt, shp);
    // 距离走归一化（对数）插值，与片段上那条曲线完全一致
    const dist = kfDenorm("space", kfAt(kfSeries(pts, "space"), local,
      kfNorm("space", st.dist), shp));
    return { az: comp(SPACE_AZ, st.az), el: comp(SPACE_EL, st.el), dist };
  }
  function kfSpaceWrite(c, pts, label) {
    c.kf = c.kf || {};
    const arr = (pts || []).slice().sort((a, b) => a[0] - b[0]);
    if (arr.length) c.kf.space = arr; else delete c.kf.space;
    if (!Object.keys(c.kf).length) delete c.kf;
    kfCommit(c, "space", label);
  }

  /* 「当前在编辑哪个空间关键帧」—— 图形面板（罗盘/三视图/XYZ）改的是它，
     没有选中任何点时才退回片段的静态位置。 */
  function kfSelIdx(c) {
    if (!c) return null;
    const pts = kfSpace(c);
    if (KF.sel == null || KF.selFor !== c.id) return null;
    return pts[KF.sel] ? KF.sel : null;
  }
  function kfSelSet(c, i) {
    KF.sel = (i == null ? null : i);
    KF.selFor = c ? c.id : null;
    if (i != null) KF.prop = "space";
  }
  /* 图形面板读取的位置：选中了关键帧就读那个点，否则读静态值 */
  function kfPosOf(c) {
    const i = kfSelIdx(c);
    if (i != null) {
      const p = kfSpace(c)[i];
      return { az: Number(p[SPACE_AZ] || 0), el: Number(p[SPACE_EL] || 0),
               dist: p[SPACE_DIST] == null ? 1 : Number(p[SPACE_DIST]), kf: i };
    }
    return { az: Number(c.az || 0), el: Number(c.el || 0),
             dist: c.dist == null ? 1 : Number(c.dist), kf: null };
  }
  /* 写回：选中了关键帧就只改那一个点（其它点不动），否则改静态值 */
  function kfPosWrite(c, patch, label) {
    const i = kfSelIdx(c);
    if (i != null) {
      const pts = kfSpace(c).map((q, k) => {
        if (k !== i) return q;
        return [q[0],
                patch.az == null ? (q[SPACE_AZ] || 0) : r3(patch.az),
                patch.el == null ? (q[SPACE_EL] || 0) : r3(patch.el),
                patch.dist == null ? (q[SPACE_DIST] == null ? 1 : q[SPACE_DIST])
                  : r3(clamp(patch.dist, KF_META.space.lo, KF_META.space.hi))];
      });
      kfSpaceWrite(c, pts, label || "调整空间关键帧");
      return;
    }
    if (patch.az != null) c.az = patch.az;
    if (patch.el != null) c.el = patch.el;
    if (patch.dist != null) c.dist = clamp(patch.dist, 0.2, 10);
    commitClip(c, label || "空间位置");
  }

  /* 在片段内 local 秒处插一个关键帧（Alt+点击 / 插入模式 / 播放头加点都走这里）。
     空间点：纵向位置给「距离」；方位/仰角继承当前选中的点，没选就取该时刻的位置。 */
  function addKfAt(c, localT, y, mode) {
    const prop = KF.prop;
    const ti = orderedTracks().indexOf(trackOfClip(c));
    if (ti < 0) return null;
    const top = trackTop(ti) + 4, bh = TRACK_H - 8;
    const local = r3(clamp(localT, 0, c.dur));
    const val = kfV(c, prop, y, top, bh);
    const pts = kfPts(c, prop).slice();
    const dup = pts.findIndex((q) => Math.abs(q[0] - local) < 0.002);
    let pt;
    if (prop === "space") {
      const base = (kfSelIdx(c) != null) ? kfPosOf(c) : kfSpaceAt(c, local);
      pt = [local, r3(base.az), r3(base.el), r3(clamp(val, 0.2, 10))];
    } else {
      pt = [local, val];
    }
    if (dup >= 0) pts[dup] = pt; else pts.push(pt);
    pts.sort((a, b) => a[0] - b[0]);
    c.kf = c.kf || {};
    c.kf[prop] = pts;
    const idx = Math.max(0, pts.findIndex((q) => Math.abs(q[0] - local) < 0.002));
    S.sel = c.id; S.anchor = c.id;
    if (prop === "space") kfSelSet(c, idx);
    S.drag = { type: "kf", c, prop, idx, moved: true, fresh: true };
    drawInspector(); draw();
    if (mode === "click") {
      toast(`已在 ${local.toFixed(2)}s 插入插入点：上下拖 = 改距离，方位/仰角在右侧面板摆`);
    }
    return idx;
  }

  function kfY(c, prop, v, top, bh) {
    return top + bh - kfNorm(prop, v) * bh;
  }
  function kfV(c, prop, y, top, bh) {
    return r3(kfDenorm(prop, 1 - (y - top) / bh));
  }
  const kfX = (c, t) => xOf(c.start + clamp(t, 0, c.dur));

  /* 曲线在画布上的纵坐标。空间曲线的纵轴是归一化（对数）距离，
     直接按 0..1 映射到像素，和音频侧的插值严格同一条。 */
  function kfPixY(prop, pts, t, shape, dfltV, top, bh) {
    if (prop === "space") {
      const u = kfAt(kfSeries(pts, prop), t, kfNorm(prop, dfltV), shape);
      return top + bh - clamp(u, 0, 1) * bh;
    }
    return kfY(null, prop, kfAt(pts, t, dfltV, shape), top, bh);
  }

  // 写盘：c.kf → project.kf，并保存
  function kfCommit(c, prop, label) {
    writeClipOverride(c);
    markDirty(label || "调整关键帧");
    drawInspector();
    draw();
  }

  function kfSet(c, prop, pts, label) {
    c.kf = c.kf || {};
    const arr = (pts || []).slice().sort((a, b) => a[0] - b[0]);
    if (arr.length) c.kf[prop] = arr;
    else delete c.kf[prop];
    if (!Object.keys(c.kf).length) delete c.kf;
    kfCommit(c, prop, label);
  }

  /* ---------------- 曲线形态 ----------------
     注意语义：这里的「平滑」**不改任何关键帧**——点的位置和数值原样保留，
     只是把点与点之间的连线从折线换成经过点的平滑曲线（PCHIP）。
     想压缩点数的老「抹平」逻辑拿掉了：那会偷偷改数值，和「平滑曲线」不是一回事。 */
  const KF_SHAPES = {
    smooth: { name: "平滑（经过点的曲线）" },
    linear: { name: "折线（点对点直线）" },
  };

  function setShapeOn(c, shape, onlyProp) {
    c.kf = c.kf || {};
    const shp = Object.assign({}, c.kf.shape || {});
    (onlyProp ? [onlyProp] : kfPropsOf(c)).forEach((p) => { shp[p] = shape; });
    c.kf.shape = shp;
  }

  function shapeCurrent(shape) {
    const c = S.sel ? clipById(S.sel) : null;
    if (!c) { toast("先点一个片段", true); return; }
    if (!kfPts(c, KF.prop).length) { toast("这条曲线还没有关键帧", true); return; }
    setShapeOn(c, shape, KF.prop);
    kfCommit(c, KF.prop, "曲线形态");
    toast(`${KF_META[KF.prop].label}曲线已切成${KF_SHAPES[shape].name}`);
  }

  function shapeWholeClip(shape) {
    const c = S.sel ? clipById(S.sel) : null;
    if (!c) { toast("先点一个片段", true); return; }
    const n = kfPropsOf(c).filter((p) => kfPts(c, p).length).length;
    if (!n) { toast("这条片段还没有关键帧曲线", true); return; }
    setShapeOn(c, shape, null);
    kfCommit(c, KF.prop, "曲线形态");
    toast(`这条片段的 ${n} 条曲线已切成${KF_SHAPES[shape].name}`);
  }

  function shapeSelected(shape) {
    const cs = selClips().filter((c) => kfPropsOf(c).some((p) => kfPts(c, p).length));
    if (!cs.length) { toast("选中的片段没有关键帧曲线", true); return; }
    cs.forEach((c) => setShapeOn(c, shape, null));
    bulkCommit(cs, "曲线形态");
    toast(`${cs.length} 段片段已切成${KF_SHAPES[shape].name}`);
  }

  function openShapeMenu(btn, scope) {
    const cur = S.sel ? clipById(S.sel) : null;
    const now = cur ? kfShape(cur, KF.prop) : "smooth";
    const items = (fn, withProp) => Object.keys(KF_SHAPES).map((k) => ({
      label: (k === now ? "✓ " : "　") + KF_SHAPES[k].name,
      fn: () => fn(k),
    }));
    const entries = [];
    if (scope === "batch") {
      entries.push({ head: "把选中片段的曲线都切成（点与数值不变）" });
      entries.push(...items(shapeSelected));
    } else {
      entries.push({ head: `当前这条（${KF_META[KF.prop].label}）：${KF_SHAPES[now].name}` });
      entries.push(...items(shapeCurrent));
      entries.push("-");
      entries.push({ head: "这条片段的所有曲线（音量 + 声像 + 空间距离）" });
      entries.push(...items(shapeWholeClip));
    }
    entries.push("-");
    entries.push({ head: "两种都经过每个关键帧，只是连法不同" });
    dropMenuBelow(btn, entries);
  }

  function kfHit(c, x, y) {
    if (KF.hidden) return null;      // 曲线面板藏起来时，关键帧点也一起失效
    if (!c || S.sel !== c.id) return null;
    const prop = KF.prop;
    const pts = kfPts(c, prop);
    if (!pts.length) return null;
    const ti = orderedTracks().indexOf(trackOfClip(c));
    if (ti < 0) return null;
    const top = trackTop(ti) + 4, bh = TRACK_H - 8;
    for (let i = 0; i < pts.length; i++) {
      if (Math.abs(kfX(c, pts[i][0]) - x) <= KF.snapPx
        && Math.abs(kfY(c, prop, kfYVal(prop, pts[i]), top, bh) - y) <= KF.snapPx) return i;
    }
    return null;
  }


  /* ================================ 多选 ================================
     单选（S.sel）是「看属性」，多选（S.multi）是「批量操作」。
     · 点空白拖框 = 框选；Shift 点 = 连选；Ctrl/⌘ 点 = 加/减选
     · 选完底部浮出批量条：锁定（一个键两态）/ 静音（一个键两态）/ 音量 / 移轨 / 复制 / 删除 / 重新生成
     · 「按组」直接按台本里的分组整组选上（组名从片段上带过来）
     · 框选完要把 S.sel 落到其中一段上（锚点），否则只认 S.multi 的入口（L 键、属性面板）会找不到当前片段 */
  const selClips = () => Array.from(S.multi).map((id) => clipById(id)).filter(Boolean);
  const inMulti = (id) => S.multi.has(id);

  function pruneMulti() {
    const alive = new Set(allClips().map((c) => c.id));
    for (const id of Array.from(S.multi)) if (!alive.has(id)) S.multi.delete(id);
    if (S.sel && !alive.has(S.sel)) S.sel = null;
    if (S.anchor && !alive.has(S.anchor)) S.anchor = null;
    updateBulkBar();
  }

  function setMulti(ids, keep) {
    if (!keep) S.multi.clear();
    (ids || []).forEach((id) => S.multi.add(id));
    updateBulkBar();
    draw();
  }

  function clearMulti() {
    S.bulkOpen = false;
    const hadMulti = S.multi.size, hadSel = !!S.sel;
    S.multi.clear();
    /* 取消选择要连锚点一起清：只清集合而留着 S.sel，按 L / V 还会偷偷作用到
       「上一次点过的那段」，看起来像随机改了一个没选中的片段。 */
    S.sel = null;
    S.anchor = null;
    updateBulkBar();
    if (!hadMulti && !hadSel) return;
    drawInspector();
    draw();
  }

  function toggleMulti(id) {
    if (S.multi.has(id)) S.multi.delete(id);
    else { S.multi.add(id); S.anchor = id; }
    S.sel = id;
    updateBulkBar();
    drawInspector();
    draw();
  }

  // 同一轨道上按时间顺序连选（Shift 点）
  function rangeSelect(c) {
    const tr = trackOfClip(c);
    const from = S.anchor && clipById(S.anchor);
    if (!tr || !from) { setMulti([c.id]); S.anchor = c.id; return; }
    const list = tr.clips.slice().sort((a, b) => a.start - b.start);
    const i = list.indexOf(from), j = list.indexOf(c);
    if (i < 0 || j < 0) { setMulti([c.id]); S.anchor = c.id; return; }
    const [a, b] = i < j ? [i, j] : [j, i];
    setMulti(list.slice(a, b + 1).map((x) => x.id));
  }

  function marqueeHits(x0, y0, x1, y1) {
    const lx = Math.min(x0, x1), rx = Math.max(x0, x1);
    const ly = Math.min(y0, y1), ry = Math.max(y0, y1);
    const out = [];
    orderedTracks().forEach((tr, i) => {
      const top = trackTop(i) + 4, bot = top + TRACK_H - 8;
      if (bot < ly || top > ry) return;
      for (const c of tr.clips) {
        const cx0 = xOf(c.start), cx1 = cx0 + Math.max(2, c.dur * S.pps);
        if (cx1 < lx || cx0 > rx) continue;
        out.push(c.id);
      }
    });
    return out;
  }

  function groupNames() {
    const seen = new Map();
    allClips().forEach((c) => {
      if (c.kind !== "voice") return;
      const g = (c.group || "").trim() || "（未分组）";
      seen.set(g, (seen.get(g) || 0) + 1);
    });
    return Array.from(seen.entries()).sort((a, b) => b[1] - a[1]);
  }

  function updateBulkBar() {
    const bar = $("bulkBar");
    if (!bar) return;
    const n = S.multi.size;
    bar.hidden = n < 2 && !S.bulkOpen;
    /* 注意：这里**不要**顺手清掉 S.marquee —— 框选过程中选中数会从 0 慢慢涨上来，
       以前在这里 `if (n<2) S.marquee=null`，结果一拖就把框选矩形删了，
       表现出来就是「框选没反应」（只有恰好一次框到 2 段以上才活）。 */
    if (bar.hidden) return;
    const cs = selClips();
    const nv = cs.filter((c) => c.kind === "voice").length;
    const groups = new Set(cs.map((c) => (c.group || "").trim() || "（未分组）"));
    let label = n ? `已选 ${n} 段` : "未选片段";
    if (n && groups.size === 1 && cs.every((c) => c.kind === "voice")) label += ` · ${[...groups][0]}`;
    else if (nv && nv < n) label += ` · 语音 ${nv} / 素材 ${n - nv}`;
    $("bkCount").textContent = label;
    const en = (id, on) => { const b = $(id); if (b) b.disabled = !on; };
    const haveSfx = cs.some((c) => c.kind === "sfx" && !c.from_tag);
    en("bkDup", haveSfx);
    en("bkDel", haveSfx);
    en("bkRegen", nv > 0);
    en("bkMove", cs.length > 0);
    en("bkGain", cs.length > 0);
    /* 锁定 / 静音各只留一个按钮，文案跟着选中片的实际状态走：
       全部已锁 → 显示「🔓 解锁」，否则显示「🔒 锁定」（混合状态按「全锁」算，和 L 键一致）；
       全部已静音 → 显示「🔊 取消静音」，否则显示「🔇 静音」。 */
    const allLocked = cs.length > 0 && cs.every((c) => c.locked);
    const allMuted = cs.length > 0 && cs.every((c) => c.mute);
    const bl = $("bkLock");
    if (bl) {
      bl.textContent = allLocked ? "🔓 解锁" : "🔒 锁定";
      bl.classList.toggle("on", allLocked);
      bl.title = allLocked
        ? "全部已锁定：点一下解锁（快捷键 L）"
        : "锁住位置和时间（混合状态也是全部锁定，快捷键 L）";
      bl.disabled = cs.length === 0;
    }
    const bm = $("bkMute");
    if (bm) {
      bm.textContent = allMuted ? "🔊 取消静音" : "🔇 静音";
      bm.classList.toggle("on", allMuted);
      bm.title = allMuted ? "全部已静音：点一下取消（快捷键 V）" : "静音选中片段（快捷键 V）";
      bm.disabled = cs.length === 0;
    }
    en("bkCopyProps", cs.length > 0);
    en("bkPasteProps", cs.length > 0 && !!PROP_CLIP);
  }

  // 找一段从 t 开始、长度 dur 的空位（避开 occ 里的区间）
  function findFree(occ, t, dur) {
    let at = Math.max(0, t), guard = 0;
    while (guard++ < 800) {
      const hit = occ.find((o) => at < o.end - 1e-3 && o.start < at + dur - 1e-3);
      if (!hit) return at;
      at = hit.end + 0.002;
    }
    return at;
  }

  // 把选中的片段放到目标音轨：keep=保持原时间（可能重叠）；pack=依次排开（不重叠）
  function moveSelectedTo(tid, mode) {
    const target = tracks().find((t) => t.id === tid);
    if (!target) { toast("这条音轨不在了", true); return; }
    const cs = selClips();
    if (!cs.length) return;
    const wantVoice = cs[0].kind === "voice";
    if (cs.some((c) => (c.kind === "voice") !== wantVoice)) {
      toast("语音片段和素材片段不能混在同一条轨上，请分开选", true);
      return;
    }
    if ((target.kind === "voice") !== wantVoice) {
      toast(wantVoice ? "语音只能放到音声轨" : "素材只能放到素材轨", true);
      return;
    }
    undoMark("批量移轨");
    // 先从原轨摘掉
    tracks().forEach((t) => { t.clips = t.clips.filter((c) => !S.multi.has(c.id)); });
    if (mode === "pack") {
      const occ = target.clips.map((c) => ({ start: c.start, end: c.start + c.dur }));
      let cursor = Math.min(...cs.map((c) => c.start));
      cs.slice().sort((a, b) => a.start - b.start).forEach((c) => {
        const at = findFree(occ, cursor, c.dur);
        c.start = Math.round(at * 1000) / 1000;
        cursor = c.start + c.dur;
        occ.push({ start: c.start, end: c.start + c.dur });
      });
    }
    cs.forEach((c) => { c.track = target.id; target.clips.push(c); });
    target.clips.sort((a, b) => a.start - b.start);
    bulkCommit(cs, "批量移轨");
    toast(`已移到「${target.name}」${mode === "pack" ? "（顺序排开）" : "（保持时间）"}`);
  }

  function bulkCommit(cs, label) {
    cs.forEach((c) => writeClipOverride(c));
    markDirty(label || "批量编辑");
    drawInspector();
    draw();
    updateBulkBar();
  }


  function trackTop(i) {
    // 计算第 i 条轨（orderedTracks 顺序）的 y 坐标，含中间按钮行和分隔空隙
    let y = RULER_H + 4;
    const nv = voiceTracks().length;
    for (let k = 0; k < i; k++) {
      if (k === nv - 1) {
        // 音声轨组末尾 → 加"新建音声轨"按钮行 + 分隔空隙
        y += TRACK_H + GAP + BTN_ROW_H + GROUP_GAP;
      } else if (k < nv) {
        y += TRACK_H + GAP;
      } else {
        y += TRACK_H + GAP;
      }
    }
    return y;
  }

  function totalContentH() {
    const nv = voiceTracks().length, ns = sfxTracks().length;
    let h = nv * (TRACK_H + GAP) + (nv > 0 ? BTN_ROW_H + GROUP_GAP : 0);
    h += ns * (TRACK_H + GAP) + (ns > 0 ? BTN_ROW_H : 0);
    return h;
  }

  const xOf = (t) => (t * S.pps - S.scrollX) + 0.5;
  const tOf = (x) => (x + S.scrollX) / S.pps;
  /* 右侧多留 5 秒 + 半个视口的余量：否则片段拖到「当前总时长」就到头了，
     没法把时间轴拖长（用户反馈的「往右拖不动、总时长不涨」就是这个）。 */
  const maxScroll = () => {
    const dur = (S.data ? S.data.duration : 0) + 5 + (W / Math.max(1, S.pps)) * 0.5;
    return Math.max(0, dur * S.pps - W + 90);
  };

  function trackIndexAtY(y) {
    for (let i = 0; i < orderedTracks().length; i++) {
      const top = trackTop(i);
      if (y >= top && y < top + TRACK_H) return i;
    }
    return -1;
  }

  function clipAt(track, x) {
    const t = tOf(x);
    for (const c of track.clips) {
      if (t >= c.start && t <= c.start + c.dur) return c;
    }
    return null;
  }

  /* 顶部粘性标尺：和主画布同一套坐标，滚动时永远贴在视口顶部。
     顺带把它当作「播放头把手」——滚到页面下方也能看到/拖动播放头。 */
  const cvRuler = $("cvRuler");
  const rctx = cvRuler ? cvRuler.getContext("2d") : null;

  function drawRulerOverlay() {
    if (!rctx || !cvRuler) return;
    const w = Math.round(W), h = RULER_H;
    if (cvRuler.width !== Math.floor(w * DPR) || cvRuler.height !== Math.floor(h * DPR)) {
      cvRuler.width = Math.floor(w * DPR);
      cvRuler.height = Math.floor(h * DPR);
      cvRuler.style.width = w + "px";
      cvRuler.style.height = h + "px";
    }
    rctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    rctx.clearRect(0, 0, w, h);
    rctx.fillStyle = COL.ruler;
    rctx.fillRect(0, 0, w, h);
    rctx.strokeStyle = COL.line;
    rctx.beginPath(); rctx.moveTo(0, h - 0.5); rctx.lineTo(w, h - 0.5); rctx.stroke();

    const t0 = S.scrollX / S.pps, t1 = (S.scrollX + w) / S.pps;
    const step = stepOf();
    const sub = step * S.pps >= 90 ? 5 : (step * S.pps >= 40 ? 2 : 1);
    rctx.font = "10px " + mono();
    rctx.textBaseline = "middle";
    for (let t = Math.floor(t0 / step) * step; t <= t1 + step; t += step) {
      if (t < 0) continue;
      const x = xOf(t);
      if (x < -60 || x > w + 60) continue;
      rctx.strokeStyle = COL.tick;
      rctx.beginPath(); rctx.moveTo(x, h - 9); rctx.lineTo(x, h - 1); rctx.stroke();
      rctx.fillStyle = COL.tickText;
      rctx.fillText(step >= 1 ? fmtShort(t) : t.toFixed(1) + "s", x + 3, h / 2 - 2);
      for (let k = 1; k < sub; k++) {
        const xs = xOf(t + (step / sub) * k);
        if (xs < 0 || xs > w) continue;
        rctx.strokeStyle = "rgba(160,154,144,.5)";
        rctx.beginPath(); rctx.moveTo(xs, h - 5); rctx.lineTo(xs, h - 1); rctx.stroke();
      }
    }
    // 播放头把手：三角 + 竖线，永远看得见
    if (S.data) {
      const px = xOf(S.pos);
      if (px >= -8 && px <= w + 8) {
        rctx.strokeStyle = COL.sel;
        rctx.lineWidth = 1;
        rctx.beginPath(); rctx.moveTo(px, 0); rctx.lineTo(px, h); rctx.stroke();
        rctx.fillStyle = COL.sel;
        rctx.beginPath();
        rctx.moveTo(px - 5, 0); rctx.lineTo(px + 5, 0); rctx.lineTo(px, 8);
        rctx.closePath(); rctx.fill();
      }
    }
  }

  function resize() {
    DPR = window.devicePixelRatio || 1;
    const box = $("scroll").getBoundingClientRect();
    W = Math.max(200, Math.floor(box.width));
    const viewH = Math.max(160, Math.floor(box.height));
    // 画布高度 = max(视口高, 轨道总内容高度)，超出部分通过纵向滚动查看
    const contentH = (S.data ? totalContentH() : 0) + RULER_H + 8;
    H = Math.max(viewH, contentH);
    cv.width = Math.floor(W * DPR); cv.height = Math.floor(H * DPR);
    cv.style.width = W + "px"; cv.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    // 用父卡片（.tl-nav）的尺寸算：canvas 的高度是由这里写死的，量它自己会锁死
    const nb = (nav.parentElement || nav).getBoundingClientRect();
    NW = Math.max(120, Math.floor(nb.width));
    NH = Math.max(20, Math.floor(nb.height));
    nav.width = Math.floor(NW * DPR); nav.height = Math.floor(NH * DPR);
    nav.style.width = NW + "px"; nav.style.height = NH + "px";
    nctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    draw(); drawNav(); drawRulerOverlay();
  }

  /* ------------------------------ 绘制 ------------------------------ */
  const COL_LIGHT = {
    ruler: "#ffffff", line: "#e3e0da", tick: "#a09a90", tickText: "#8b857c",
    trackA: "#faf9f6", trackB: "#f2f1ee",
    voice: "#dfe9fb", voice2: "#cfdcf6", voiceEdge: "#93aede", voiceText: "#1f3560",
    sfx: "#d9f1e7", sfx2: "#c7e9db", sfxEdge: "#7cc3a6", sfxText: "#1c4d3c",
    pend: "#eeedea", pendEdge: "#cfcbc2", pendText: "#9a948a",
    stale: "#fdf2e0", stale2: "#f9e6c8", staleEdge: "#d8a95a", staleText: "#7a5a2a",
    sel: "#d2372e", marker: "#6b4fa8", wave: "rgba(31,53,96,.32)", waveSfx: "rgba(28,77,60,.32)",
    waveFill: "rgba(31,53,96,.27)", waveFillSfx: "rgba(28,77,60,.24)",
    kfGain: "rgba(196,124,10,.95)", kfPan: "rgba(31,95,224,.9)", kfAz: "rgba(14,140,128,.95)",
    staleWave: "rgba(122,90,42,.3)", dim: "rgba(27,26,24,.06)",
  };
  const COL_DARK = {
    ruler: "#1c1b19", line: "#2e2c29", tick: "#55524d", tickText: "#8b857c",
    trackA: "#1a1917", trackB: "#161513",
    voice: "#2d4668", voice2: "#27405e", voiceEdge: "#4a7ab5", voiceText: "#cfe0f5",
    sfx: "#2c5a45", sfx2: "#26513d", sfxEdge: "#4aa880", sfxText: "#cfe8dc",
    pend: "#2a2927", pendEdge: "#3a3834", pendText: "#8a857c",
    stale: "#4a3d24", stale2: "#42371e", staleEdge: "#c08a3d", staleText: "#f2dfb8",
    sel: "#e5503f", marker: "#a98bd8", wave: "rgba(207,224,245,.5)", waveSfx: "rgba(207,232,220,.5)",
    waveFill: "rgba(206,224,248,.32)", waveFillSfx: "rgba(198,232,218,.29)",
    kfGain: "rgba(255,186,84,.95)", kfPan: "rgba(140,180,255,.95)", kfAz: "rgba(92,226,208,.95)",
    staleWave: "rgba(242,223,184,.5)", dim: "rgba(0,0,0,.32)",
  };
  // 当前配色对象：随主题切换被 applyCol() 整体覆盖
  const COL = Object.assign({}, COL_LIGHT);
  function applyCol() {
    const src = document.documentElement.dataset.theme === "dark" ? COL_DARK : COL_LIGHT;
    Object.assign(COL, src);
  }
  applyCol();
  // 主题切换（storage 事件从 timeline.html 转发）时重绘 canvas
  window.addEventListener("tl-theme-change", () => {
    applyCol();
    draw();
    drawNav();
  });

  function cutText(text, maxW) {
    if (maxW <= 6) return "";
    if (ctx.measureText(text).width <= maxW) return text;
    let s = text;
    while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
    return s + "…";
  }

  function roundRect(c, x, y, w, h, r) {
    r = Math.min(r, h / 2, w / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function stepOf() {
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    let step = steps[0];
    for (const s of steps) { step = s; if (s * S.pps >= 64) break; }
    return step;
  }

  function draw() {
    if (!S.data) return;
    ctx.clearRect(0, 0, W, H);
    const t0 = tOf(0), t1 = tOf(W);
    orderedTracks().forEach((tr, i) => {
      const y = trackTop(i);
      ctx.fillStyle = i % 2 ? COL.trackB : COL.trackA;
      ctx.fillRect(0, y, W, TRACK_H);
      ctx.strokeStyle = COL.line;
      ctx.beginPath(); ctx.moveTo(0, y + TRACK_H + 0.5); ctx.lineTo(W, y + TRACK_H + 0.5); ctx.stroke();
    });

    ctx.fillStyle = COL.ruler;
    ctx.fillRect(0, 0, W, RULER_H);
    ctx.strokeStyle = COL.line;
    ctx.beginPath(); ctx.moveTo(0, RULER_H - 0.5); ctx.lineTo(W, RULER_H - 0.5); ctx.stroke();
    const step = stepOf();
    const sub = step * S.pps >= 90 ? 5 : (step * S.pps >= 40 ? 2 : 1);
    ctx.font = "10px " + mono();
    ctx.textBaseline = "middle";
    for (let t = Math.floor(t0 / step) * step; t <= t1 + step; t += step) {
      if (t < 0) continue;
      const x = xOf(t);
      if (x < -60 || x > W + 60) continue;
      ctx.strokeStyle = COL.tick;
      ctx.beginPath(); ctx.moveTo(x, RULER_H - 9); ctx.lineTo(x, RULER_H - 1); ctx.stroke();
      ctx.fillStyle = COL.tickText;
      ctx.fillText(step >= 1 ? fmtShort(t) : t.toFixed(1) + "s", x + 3, RULER_H / 2 - 2);
      for (let k = 1; k < sub; k++) {
        const xs = xOf(t + (step / sub) * k);
        if (xs < 0 || xs > W) continue;
        ctx.strokeStyle = "rgba(160,154,144,.5)";
        ctx.beginPath(); ctx.moveTo(xs, RULER_H - 5); ctx.lineTo(xs, RULER_H - 1); ctx.stroke();
      }
    }

    orderedTracks().forEach((tr, i) => drawTrackClips(tr, i, t0, t1));
    drawGrid(t0, t1);
    drawMarkers(t0, t1);
    drawMarquee();
    drawPlayheadDom();
    drawRulerOverlay();
    ensurePeaks();
    refreshSpatial();
  }

  /* 空间位置面板（罗盘 / 三视图）跟着播放头刷新。
     注意：播放时 tick() 只重画播放头（不整帧 draw()），所以这里必须由 tick
     也调一次 —— 否则「用脚本加了关键帧，播放时圆点和读数纹丝不动」。 */
  function refreshSpatial() {
    const sp = document.querySelector("#inspector .sp-pad-wrap");
    if (!sp) return;
    if (sp.__paint) sp.__paint();
    // DOM 更新（距离/仰角/XYZ 数字框）比画布贵，限到 ~12fps
    if ((S.playing || KF.rec) && SPUI && SPUI.sync
        && performance.now() - spSyncAt > 80) {
      spSyncAt = performance.now();
      SPUI.sync();
    }
  }

  // 框选矩形（拖到一半也要看得见）
  function drawMarquee() {
    const m = S.marquee;
    if (!m) return;
    const x = Math.min(m.x0, m.x1), y = Math.min(m.y0, m.y1);
    const w = Math.abs(m.x1 - m.x0), h = Math.abs(m.y1 - m.y0);
    if (w < 2 && h < 2) return;
    ctx.save();
    ctx.fillStyle = "rgba(107,79,168,.12)";
    ctx.strokeStyle = COL.marker;
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 3]);
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    ctx.restore();
  }

  function drawGrid(t0, t1) {
    const step = stepOf();
    ctx.strokeStyle = COL.line;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let t = Math.floor(t0 / step) * step; t <= t1 + step; t += step) {
      if (t < 0) continue;
      const x = xOf(t);
      ctx.moveTo(x, RULER_H); ctx.lineTo(x, H);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawTrackClips(tr, i, t0, t1) {
    const y = trackTop(i);
    const top = y + 4, bh = TRACK_H - 8;
    const anySolo = tracks().some((x) => x.solo);
    const silent = tr.mute || (anySolo && !tr.solo);

    // 先画「原始长度」的半透明幽灵块（被裁剪掉的部分），表示素材原本有多长
    for (const c of tr.clips) {
      const off = Math.max(0, c.offset || 0);
      const srcDur = c.src_dur || c.dur + off;
      const rightCut = Math.max(0, srcDur - off - c.dur);
      if (off < 0.005 && rightCut < 0.005) continue;
      const ox0 = xOf(c.start - off);
      const ow = Math.max(1, (srcDur) * S.pps);
      if (ox0 > W + 20 || ox0 + ow < -20) continue;
      ctx.save();
      ctx.globalAlpha = 0.22;
      roundRect(ctx, ox0, top + 2, ow, bh - 4, 6);
      ctx.fillStyle = c.kind === "voice" ? COL.voice2 : COL.sfx2;
      ctx.fill();
      ctx.globalAlpha = 0.5;
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = c.kind === "voice" ? COL.voiceEdge : COL.sfxEdge;
      ctx.stroke();
      ctx.restore();
    }

    for (const c of tr.clips) {
      if (c.start > t1 + 1 || c.start + c.dur < t0 - 1) continue;
      const x = xOf(c.start);
      const w = Math.max(2, c.dur * S.pps);
      /* 单选 = 只有红框；多选（集合里 ≥2 段）才加紫圈 + 勾标。
         以前「点一下就进集合」，于是单选也同时画红框和紫圈，看着像蓝红双框。 */
      const multiSel = S.multi.size > 1;
      const multi = multiSel && inMulti(c.id);
      const isSel = S.sel === c.id || multi;
      const isVoice = c.kind === "voice";
      const pend = !c.has_audio;
      const stale = !!c.stale && c.has_audio;
      const dim = silent || c.mute;

      ctx.save();
      roundRect(ctx, x, top, w, bh, 6);
      const g = ctx.createLinearGradient(0, top, 0, top + bh);
      if (pend) { g.addColorStop(0, COL.pend); g.addColorStop(1, COL.pend); }
      else if (stale) { g.addColorStop(0, COL.stale); g.addColorStop(1, COL.stale2); }
      else if (isVoice) { g.addColorStop(0, COL.voice); g.addColorStop(1, COL.voice2); }
      else { g.addColorStop(0, COL.sfx); g.addColorStop(1, COL.sfx2); }
      ctx.fillStyle = g;
      ctx.fill();
      ctx.lineWidth = isSel ? 2 : 1;
      ctx.strokeStyle = isSel ? COL.sel
        : (pend ? COL.pendEdge : (stale ? COL.staleEdge : (isVoice ? COL.voiceEdge : COL.sfxEdge)));
      if (pend) ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.clip();

      if (!pend && w > 6) {
        const pk = S.peaks.get(peakKey(c));
        if (pk) {
          /* 波形改画「填充包络」而不是一根根竖线：
             按像素列取该列的峰值，画成上/下对称的一条闭合曲线再填色。
             好处：缩放、长短片段看起来都是同一条连续的波形，
             不会出现「竖线忽疏忽密、像栅栏」或「线太细看不见」的问题。 */
          const vw = Math.max(320, cv.clientWidth || 1200);
          const px = clamp(Math.round(vw / 780), 2, 4);       // 采样步长（屏幕上多少 px 一个样本）
          const srcDur = Math.max(0.05, c.src_dur || (c.dur + (c.offset || 0)));
          const off = Math.max(0, c.offset || 0);
          /* 变速后时间轴上的 1 秒 = 源里的 speed 秒。
             以前这里直接拿「时间轴上的秒」当「源里的秒」用，所以变速只改了片段宽度、
             波形还是原来那一段的形状 —— 看起来就是「波形没跟着变」。 */
          const rate = clamp(c.speed || 1, 0.25, 4);
          let step = px / Math.max(1, S.pps);
          let n = Math.max(2, Math.ceil(c.dur / step));
          if (n > 3000) { n = 3000; step = c.dur / n; }        // 变态长片段兜底
          S.waveN[c.id] = { n, w: Math.round(w), step, pps: Math.round(S.pps), px,
            speed: rate, srcSpan: Math.round(c.dur * rate * 1000) / 1000,
            off: Math.round(off * 1000) / 1000, srcDur: Math.round(srcDur * 1000) / 1000 };

          /* 波形占中间偏下的一条带：上面留给句子名、下面留给时长/倍速字样，
             所以上下各留一点空隙（mid/amp 一起收一点）。 */
          const mid = top + bh * 0.585;
          const amp = bh * 0.27;
          const vals = new Array(n + 1);
          for (let k = 0; k <= n; k++) {
            const ta = Math.min(c.dur, k * step);
            const tb = Math.min(c.dur, ta + step);
            const a0 = clamp((off + ta * rate) / srcDur, 0, 1);
            const a1 = clamp((off + tb * rate) / srcDur, a0, 1);
            const j0 = Math.floor(a0 * pk.length);
            const j1 = Math.max(j0 + 1, Math.min(pk.length, Math.ceil(a1 * pk.length)));
            let v = 0;
            for (let j = j0; j < j1; j++) v = Math.max(v, pk[j] || 0);
            vals[k] = v;
          }
          // 两端点对齐到片段左右边缘，避免首尾有空隙
          vals[0] = vals[0] || vals[1] || 0;
          vals[n] = vals[n] || vals[n - 1] || 0;

          const waveCol = stale ? COL.staleWave
            : (isVoice ? (COL.waveFill || COL.wave) : (COL.waveFillSfx || COL.waveSfx));
          ctx.save();
          ctx.fillStyle = waveCol;
          ctx.globalAlpha = 1;
          ctx.beginPath();
          for (let k = 0; k <= n; k++) {
            const xx = x + (k / n) * w;
            const hh = Math.max(0.6, vals[k] * amp);
            if (k === 0) ctx.moveTo(xx, mid - hh);
            else ctx.lineTo(xx, mid - hh);
          }
          for (let k = n; k >= 0; k--) {
            const xx = x + (k / n) * w;
            const hh = Math.max(0.6, vals[k] * amp);
            ctx.lineTo(xx, mid + hh);
          }
          ctx.closePath();
          ctx.fill();
          /* 上包络再描一条很淡的线：填充本身压得很轻（不抢关键帧曲线），
             但纯填充在浅色主题上容易糊成一片，加这道线才看得出「形状」。 */
          ctx.globalAlpha = 0.34;
          ctx.strokeStyle = waveCol;
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (let k = 0; k <= n; k++) {
            const xx = x + (k / n) * w;
            const hh = Math.max(0.6, vals[k] * amp);
            if (k === 0) ctx.moveTo(xx, mid - hh);
            else ctx.lineTo(xx, mid - hh);
          }
          ctx.stroke();
          // 中线（0 轴），让静音段也能看出「这是一条波形」
          ctx.globalAlpha = 0.5;
          ctx.strokeStyle = waveCol;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, mid + 0.5); ctx.lineTo(x + w, mid + 0.5);
          ctx.stroke();
          ctx.restore();
        }
      }
      if (w > 44) {
        ctx.font = "11px " + sans();
        ctx.textBaseline = "top";
        ctx.fillStyle = pend ? COL.pendText : (stale ? COL.staleText : (isVoice ? COL.voiceText : COL.sfxText));
        const label = (isVoice ? (c.index ? c.index + ". " : "") : "♪ ") + (c.text || "");
        ctx.fillText(cutText(label, w - 10), x + 5, top + 4);
        if (w > 96) {
          ctx.font = "10px " + mono();
          ctx.fillStyle = "rgba(27,26,24,.42)";
          const bits = [c.dur.toFixed(2) + "s"];
          if (c.speed && Math.abs(c.speed - 1) > 0.01) bits.push("×" + c.speed.toFixed(2));
          if (pend) bits.push("未生成");
          else if (stale) bits.push("需重生成");
          if (c.locked) bits.push("锁");
          ctx.fillText(cutText(bits.join(" · "), w - 10), x + 5, top + bh - 13);
        }
      }

      // 关键帧包络：画在片段内部（外面已经 clip 过），有曲线的属性都画
      // Alt+K 隐藏后整条曲线都不画（自然也点不到、拖不动）
      const kfProps = KF.hidden ? [] : kfPropsOf(c);
      const kfAll = kfProps.map((p) => kfPts(c, p));
      if (kfAll.some((x) => x.length)) {
        const focus = S.sel === c.id;
        const dur = Math.max(0.001, c.dur);
        kfProps.forEach((prop, pi) => {
          const pts = kfAll[pi];
          if (!pts.length) return;
          const active = focus && KF.prop === prop;
          ctx.save();
          ctx.strokeStyle = prop === "gain" ? COL.kfGain
            : (prop === "space" ? COL.kfAz : COL.kfPan);
          ctx.lineWidth = active ? 1.8 : 1.1;
          ctx.globalAlpha = active ? 1 : 0.6;
          const dfltV = kfStatic(c, prop);
          const shape = kfShape(c, prop);
          // 空间曲线的纵轴是距离，取值在归一化域里算
          const spts = kfSeries(pts, prop);
          ctx.beginPath();
          if (shape === "linear") {
            // 折线：点 + 两端（曲线在片段起止处的值）
            [[0, kfPixY(prop, pts, 0, "linear", dfltV, top, bh)]]
              .concat(pts.filter((q) => q[0] > 0.0005 && q[0] < c.dur - 0.0005)
                .map((q) => [q[0], kfY(c, prop, kfYVal(prop, q), top, bh)]))
              .concat([[c.dur, kfPixY(prop, pts, c.dur, "linear", dfltV, top, bh)]])
              .forEach((q, k) => {
                const px = x + (clamp(q[0], 0, c.dur) / dur) * w;
                const py = q[1];
                if (k) ctx.lineTo(px, py); else ctx.moveTo(px, py);
              });
          } else {
            // 平滑曲线：按像素采样 PCHIP（点还是原来的点，只是点之间画成曲线）
            const steps = clamp(Math.round(w / 2), 8, 420);
            for (let k = 0; k <= steps; k++) {
              const tt = (k / steps) * c.dur;
              const px = x + (k / steps) * w;
              const py = kfPixY(prop, pts, tt, "smooth", dfltV, top, bh);
              if (k) ctx.lineTo(px, py); else ctx.moveTo(px, py);
            }
          }
          ctx.stroke();
          if (active) {
            pts.forEach((q) => {
              const px = x + (clamp(q[0], 0, c.dur) / dur) * w;
              const py = kfY(c, prop, kfYVal(prop, q), top, bh);
              ctx.beginPath();
              ctx.rect(px - 3, py - 3, 6, 6);
              ctx.fillStyle = "#fff";
              ctx.fill();
              ctx.lineWidth = 1.4;
              ctx.stroke();
            });
          }
          ctx.restore();
        });
      }

      ctx.restore();

      if (dim) {
        ctx.fillStyle = COL.dim;
        roundRect(ctx, x, top, w, bh, 6);
        ctx.fill();
      }
      if (isSel && !c.locked && !multiSel && w > 14) {
        // 左右裁剪手柄（剪映风格：两条竖向握把 + 三道纹）；多选时不画，免得误导
        const hw = 6, hh = Math.min(bh - 10, 34), hy = top + (bh - hh) / 2;
        ctx.fillStyle = COL.sel;
        roundRect(ctx, x, hy, hw, hh, 3); ctx.fill();
        roundRect(ctx, x + w - hw, hy, hw, hh, 3); ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,.85)";
        ctx.lineWidth = 1;
        for (const hx of [x + hw / 2, x + w - hw / 2]) {
          for (let k = -1; k <= 1; k++) {
            ctx.beginPath();
            ctx.moveTo(hx, hy + hh / 2 + k * 5 - 2);
            ctx.lineTo(hx, hy + hh / 2 + k * 5 + 2);
            ctx.stroke();
          }
        }
      }
      if (multi) {
        // 多选：外侧加一圈紫色描边 + 角上打勾，和单选的红框区分开
        ctx.strokeStyle = COL.marker;
        ctx.lineWidth = 2;
        roundRect(ctx, x - 1.5, top - 1.5, w + 3, bh + 3, 7);
        ctx.stroke();
        // 勾标放右上角，别压住片段的文字
        const bxx = w >= 30 ? x + w - 10 : x + 8;
        ctx.fillStyle = COL.marker;
        ctx.beginPath();
        ctx.arc(bxx, top + 9, 6.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(bxx - 3.2, top + 9);
        ctx.lineTo(bxx - 1, top + 11.3);
        ctx.lineTo(bxx + 3.2, top + 6.6);
        ctx.stroke();
      }
      if (c.locked && w > 30) {
        ctx.fillStyle = "rgba(27,26,24,.35)";
        ctx.font = "10px " + sans();
        ctx.textBaseline = "top";
        ctx.fillText("🔒", x + w - 15, top + 3);
      }
    }
  }

  function drawMarkers(t0, t1) {
    let lastRight = -999;
    ctx.font = "10px " + sans();
    for (const m of S.data.markers) {
      if (m.time < t0 - 2 || m.time > t1 + 2) continue;
      const x = xOf(m.time);
      ctx.strokeStyle = COL.marker;
      ctx.globalAlpha = 0.45;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, trackTop(orderedTracks().length - 1) + TRACK_H);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      const label = m.name || "标签";
      const tw = Math.min(110, ctx.measureText(label).width + 10);
      const fits = x > lastRight + 4 && x + tw < W;
      ctx.fillStyle = m.inline ? COL.marker : COL.marker;
      if (fits && tw > 26) {
        roundRect(ctx, x, 2, tw, 14, 4);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.textBaseline = "middle";
        ctx.fillText(cutText(label, tw - 8), x + 5, 9);
        lastRight = x + tw;
      } else {
        ctx.beginPath();
        ctx.moveTo(x, 2); ctx.lineTo(x + 5, 2); ctx.lineTo(x, 9);
        ctx.closePath(); ctx.fill();
        lastRight = x + 6;
      }
      ctx.textBaseline = "middle";
    }
  }

  function drawPlayheadDom() {
    const ph = $("playhead");
    const x = xOf(S.pos);
    if (x < -2 || x > W + 2) { ph.style.display = "none"; }
    else { ph.style.display = "block"; ph.style.left = Math.round(x) + "px"; }
    $("timeCur").textContent = fmt(S.pos);
    drawNav();
  }

  /* ------------------------------ 导航窗 ------------------------------ */
  function drawNav() {
    if (!S.data) return;
    nctx.clearRect(0, 0, NW, NH);
    const dur = Math.max(0.1, S.data.duration);
    const k = NW / dur;

    // 背景渐变
    const bg = nctx.createLinearGradient(0, 0, 0, NH);
    bg.addColorStop(0, COL.trackA);
    bg.addColorStop(1, COL.trackB);
    nctx.fillStyle = bg;
    nctx.fillRect(0, 0, NW, NH);

    // 轨道泳道 + 片段（圆角小条）；底部留 14px 给说明文字
    const HINT_H = 14;
    const laneH = NH - HINT_H;
    const trs = orderedTracks();
    const rows = Math.max(1, trs.length);
    const pad = 4;
    const rh = Math.max(5, (laneH - pad) / rows);
    trs.forEach((tr, i) => {
      const y = pad + i * rh;
      nctx.fillStyle = i % 2 ? "rgba(0,0,0,.035)" : "rgba(0,0,0,.015)";
      nctx.fillRect(0, y, NW, rh - 1);
      for (const c of tr.clips) {
        if (!c.has_audio && c.kind === "voice") continue;
        nctx.fillStyle = c.kind === "voice"
          ? (c.stale ? COL.staleEdge : COL.voiceEdge)
          : COL.sfxEdge;
        const w = Math.max(1.5, c.dur * k);
        roundRect(nctx, c.start * k, y + 1, w, Math.max(2, rh - 3), Math.min(2, (rh - 3) / 2));
        nctx.fill();
      }
    });
    // 标记：细竖线 + 顶部小三角（原来在「整体预览」里，现在合并到这里）
    nctx.globalAlpha = 0.55;
    nctx.strokeStyle = COL.marker;
    nctx.lineWidth = 1;
    nctx.beginPath();
    for (const m of S.data.markers) {
      const mx = Math.round(m.time * k) + 0.5;
      nctx.moveTo(mx, 1); nctx.lineTo(mx, laneH - 1);
    }
    nctx.stroke();
    nctx.globalAlpha = 1;

    // 视口框（圆角 + 左右握把）
    const vx = (S.scrollX / S.pps) * k;
    const vw = Math.max(8, (W / S.pps) * k);
    nctx.fillStyle = "rgba(210,55,46,.09)";
    roundRect(nctx, vx, 1, vw, laneH - 2, 4); nctx.fill();
    nctx.strokeStyle = "rgba(210,55,46,.62)";
    nctx.lineWidth = 1;
    roundRect(nctx, vx + 0.5, 1.5, Math.max(2, vw - 1), laneH - 3, 4); nctx.stroke();
    nctx.fillStyle = "rgba(210,55,46,.5)";
    nctx.fillRect(vx + 2, laneH / 2 - 5, 1.5, 10);
    nctx.fillRect(vx + vw - 3.5, laneH / 2 - 5, 1.5, 10);

    // 播放头
    const px = S.pos * k;
    nctx.strokeStyle = COL.sel;
    nctx.lineWidth = 1.5;
    nctx.beginPath(); nctx.moveTo(px, 0); nctx.lineTo(px, laneH); nctx.stroke();
    nctx.fillStyle = COL.sel;
    nctx.beginPath();
    nctx.moveTo(px - 3, 0); nctx.lineTo(px + 3, 0); nctx.lineTo(px, 5);
    nctx.closePath(); nctx.fill();
  }

  nav.addEventListener("mousedown", (e) => {
    if (!S.data) return;
    const r = nav.getBoundingClientRect();
    const k = NW / Math.max(0.1, S.data.duration);
    const t = (e.clientX - r.left) / k;
    const vx = S.scrollX / S.pps, vw = W / S.pps;
    nav.classList.add("dragging");
    if (t >= vx && t <= vx + vw) {
      S.navDrag = { mode: "move", t0: t, sx: S.scrollX };
    } else {
      // 点视口外：定位播放头并把视图移过去
      S.navDrag = { mode: "jump" };
      S.scrollX = clamp(t * S.pps - W / 2, 0, maxScroll());
      seek(clamp(t, 0, S.data.duration), S.playing);
      draw();
    }
    e.preventDefault();
  });
  nav.addEventListener("dblclick", () => { $("btnFit").click(); });
  window.addEventListener("mousemove", (e) => {
    if (!S.navDrag || !S.data) return;
    const r = nav.getBoundingClientRect();
    const k = NW / Math.max(0.1, S.data.duration);
    const t = (e.clientX - r.left) / k;
    if (S.navDrag.mode === "move") {
      S.scrollX = clamp(S.navDrag.sx + (t - S.navDrag.t0) * S.pps, 0, maxScroll());
    } else {
      S.scrollX = clamp(t * S.pps - W / 2, 0, maxScroll());
    }
    draw();
  });
  window.addEventListener("mouseup", () => {
    if (S.navDrag) { S.navDrag = null; nav.classList.remove("dragging"); }
  });
  nav.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoom(e.deltaY < 0 ? 1.2 : 1 / 1.25);
  }, { passive: false });

  /* ---------------------------- 播放监视（电平表） ---------------------------- */
  // 电平不用 Web Audio 接管输出（避免影响播放），而是按「当前播放位置命中哪些片段」+
  // 各片段缓存的波形峰值 + 增益/声像/淡入淡出，实时推算左右声道电平。
  const meter = { l: 0, r: 0, holdL: 0, holdR: 0, holdAt: 0, lastLabel: "" };

  /* 监视对象：默认「跟随音声片段」——只看音声轨上正在响的那一段；
     也能切成「整体混音」，或指定某一条轨单独看。 */
  const METER = {
    mode: localStorage.getItem("tl.meterMode") || "auto",
    track: localStorage.getItem("tl.meterTrack") || "",
  };

  function meterSrcTracks() {
    const ts = tracks();
    if (METER.mode === "track") {
      const t = ts.find((x) => x.id === METER.track);
      return t ? [t] : ts;
    }
    if (METER.mode === "all") return ts;
    // auto：音声轨优先（没有音声轨才退回全部）
    const v = ts.filter((t) => t.kind === "voice");
    return v.length ? v : ts;
  }

  function clipPlayingAt(pos, srcTracks) {
    const list0 = srcTracks || tracks();
    const anySolo = tracks().some((t) => t.solo);
    const out = [];
    for (const tr of list0) {
      if (tr.mute || (anySolo && !tr.solo)) continue;
      for (const c of tr.clips) {
        if (!c.has_audio || c.mute) continue;
        if (pos < c.start - 0.001 || pos > c.start + c.dur + 0.001) continue;
        out.push({ c, tr });
      }
    }
    return out;
  }

  function clipPeakAt(c, pos) {
    const pk = S.peaks.get(peakKey(c));
    if (!pk || !pk.length) return 0.22;   // 峰值还没加载：给个保守值，表至少会动
    const srcDur = Math.max(0.05, c.src_dur || (c.dur + (c.offset || 0)));
    const p = ((c.offset || 0) + Math.max(0, pos - c.start)) / srcDur;
    const i = Math.min(pk.length - 1, Math.max(0, Math.floor(p * pk.length)));
    return Math.min(1, Number(pk[i]) || 0);
  }

  function meterTargets() {
    const list = clipPlayingAt(S.pos, meterSrcTracks());
    if (!list.length) return { l: 0, r: 0, clip: null, n: 0 };
    let l = 0, r = 0, best = null, bestAmp = -1;
    for (const { c, tr } of list) {
      let amp = clipPeakAt(c, S.pos) * Math.max(0, c.gain || 0) * Math.max(0, tr.gain || 0);
      const t = Math.max(0, S.pos - c.start);
      const fi = c.fade_in || 0, fo = c.fade_out || 0, d = c.dur || 0;
      if (fi > 0 && t < fi) amp *= t / fi;
      if (fo > 0 && t > d - fo) amp *= Math.max(0, (d - t) / fo);
      const pan = Math.max(-1, Math.min(1, (c.pan || 0) + (tr.pan || 0)));
      const th = (pan + 1) * Math.PI / 4;
      l += amp * Math.cos(th);
      r += amp * Math.sin(th);
      if (amp > bestAmp) { bestAmp = amp; best = c; }
    }
    return { l: Math.min(1, l), r: Math.min(1, r), clip: best, n: list.length };
  }

  function clipLabel(c) {
    if (!c) return "";
    if (c.kind === "sfx") return (c.from_tag ? "🔔 " : "♪ ") + (c.name || c.media || "素材");
    const t = (c.text || "").trim().replace(/\s+/g, " ");
    return `第 ${c.index || "?"} 行 · ${t.slice(0, 16)}${t.length > 16 ? "…" : ""}`;
  }

  function drawMeter() {
    if (!S.data) return;
    const tgt = S.playing ? meterTargets() : { l: 0, r: 0, clip: null, n: 0 };
    // 快速起、慢速落（更接近硬件表的手感）；暂停/停止时落得更快
    const fall = S.playing ? 0.84 : 0.66;
    meter.l = tgt.l > meter.l ? meter.l + (tgt.l - meter.l) * 0.7 : meter.l * fall;
    meter.r = tgt.r > meter.r ? meter.r + (tgt.r - meter.r) * 0.7 : meter.r * fall;
    if (meter.l < 0.002) meter.l = 0;
    if (meter.r < 0.002) meter.r = 0;

    const now = performance.now();
    if (meter.l >= meter.holdL || now - meter.holdAt > 700) { meter.holdL = meter.l; }
    if (meter.r >= meter.holdR || now - meter.holdAt > 700) { meter.holdR = meter.r; }
    if (meter.l > 0.01 || meter.r > 0.01) meter.holdAt = now;

    const pct = (v) => (Math.pow(Math.min(1, v), 0.6) * 100).toFixed(1) + "%";
    const bL = $("mtL"), bR = $("mtR");
    if (bL) bL.style.width = pct(meter.l);
    if (bR) bR.style.width = pct(meter.r);
    const hl = $("mtLp"), hr = $("mtRp");
    if (hl) { hl.style.left = pct(meter.holdL); hl.style.opacity = meter.holdL > 0.01 ? "0.9" : "0"; }
    if (hr) { hr.style.left = pct(meter.holdR); hr.style.opacity = meter.holdR > 0.01 ? "0.9" : "0"; }

    const peak = Math.max(meter.l, meter.r);
    const db = peak > 0.0008 ? 20 * Math.log10(peak) : -Infinity;
    const dbEl = $("mtDb");
    if (dbEl) dbEl.textContent = db === -Infinity ? "-∞" : (db > -0.05 ? "0.0" : db.toFixed(1));

    const dot = $("mtDot"), st = $("mtState"), file = $("mtFile");
    if (dot) dot.classList.toggle("on", !!S.playing);
    if (st) st.textContent = S.playing ? "播放中" : (S.pos > 0.01 ? "已暂停" : "未播放");
    let label;
    if (S.playing && tgt.clip) {
      if (METER.mode === "all") {
        label = tgt.n > 1 ? `整体混音 · ${tgt.n} 段同时` : clipLabel(tgt.clip);
      } else if (METER.mode === "track") {
        const tr = tracks().find((x) => x.id === METER.track);
        label = (tr ? tr.name + " · " : "") + clipLabel(tgt.clip);
      } else {
        label = clipLabel(tgt.clip) + (tgt.n > 1 ? `（同轨 ${tgt.n} 段）` : "");
      }
    } else if (S.playing) {
      label = METER.mode === "auto" ? "这一时刻没有音声片段" : "这一时刻没有片段";
    } else {
      label = S.pos > 0.01 && meter.lastLabel ? "⏸ " + meter.lastLabel : "点播放或双击片段开始";
    }
    if (label !== meter.lastShown) {
      meter.lastShown = label;
      if (file) file.textContent = label;
      if (label.indexOf("⏸") !== 0) meter.lastLabel = label === "点播放或双击片段开始" ? "" : label;
    }
  }
  setInterval(drawMeter, 60);

  function refreshMeterModes() {
    const sel = $("mtMode");
    if (!sel) return;
    const cur = METER.mode === "track" ? "track:" + METER.track : METER.mode;
    const ts = tracks();
    sel.innerHTML = "";
    const add = (v, t) => {
      const o = document.createElement("option");
      o.value = v; o.textContent = t;
      sel.appendChild(o);
    };
    add("auto", "跟随音声片段");
    add("all", "整体混音");
    if (ts.length) {
      const g = document.createElement("optgroup");
      g.label = "单独看某条轨";
      ts.forEach((t) => {
        const o = document.createElement("option");
        o.value = "track:" + t.id;
        o.textContent = (t.kind === "voice" ? "🎙 " : "♪ ") + t.name;
        g.appendChild(o);
      });
      sel.appendChild(g);
    }
    let hit = Array.from(sel.options).some((o) => o.value === cur);
    if (!hit && METER.mode === "track") {
      METER.mode = "auto";
      try { localStorage.setItem("tl.meterMode", "auto"); } catch (e) { /* 忽略 */ }
      hit = true;
    }
    sel.value = METER.mode === "track" ? "track:" + METER.track : METER.mode;
    if (!hit) sel.value = "auto";
  }

  function initMeterMode() {
    const sel = $("mtMode");
    if (!sel) return;
    sel.onchange = () => {
      const v = sel.value;
      if (v.indexOf("track:") === 0) {
        METER.mode = "track";
        METER.track = v.slice(6);
        try { localStorage.setItem("tl.meterTrack", METER.track); } catch (e) { /* 忽略 */ }
      } else {
        METER.mode = v === "all" ? "all" : "auto";
      }
      try { localStorage.setItem("tl.meterMode", METER.mode); } catch (e) { /* 忽略 */ }
      meter.lastLabel = "";
      drawMeter();
    };
    refreshMeterModes();
  }

  /* 底部预览窗格：高度固定，可拖动分隔条调整（双击复位），记在本地 */
  function initBottomSplit() {
    const rz = $("bottomRz");
    const box = $("tlBottom");
    if (!rz || !box) return;
    const MIN = 72;
    const maxH = () => Math.max(MIN + 60, Math.round(window.innerHeight * 0.62));
    const setH = (h) => {
      const v = Math.round(clamp(h, MIN, maxH()));
      document.documentElement.style.setProperty("--bottom-h", v + "px");
      return v;
    };
    const saved = parseInt(localStorage.getItem("tl.bottomH") || "", 10);
    if (saved > 0) setH(saved);
    rz.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const y0 = e.clientY;
      const h0 = box.getBoundingClientRect().height;
      document.body.classList.add("hsplit");
      rz.classList.add("on");
      const move = (ev) => { setH(h0 - (ev.clientY - y0)); resize(); };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        document.body.classList.remove("hsplit");
        rz.classList.remove("on");
        try {
          localStorage.setItem("tl.bottomH",
            String(Math.round(box.getBoundingClientRect().height)));
        } catch (e2) { /* 忽略 */ }
        resize();
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
    rz.addEventListener("dblclick", () => {
      document.documentElement.style.removeProperty("--bottom-h");
      try { localStorage.removeItem("tl.bottomH"); } catch (e) { /* 忽略 */ }
      resize();
    });
    window.addEventListener("resize", () => setH(box.getBoundingClientRect().height));
  }

  /* ------------------------------ 峰值 ------------------------------ */
  /* 波形缓存的键 = 片段 + 文件版本。重生成后 rev 变了，旧键自然失效，
     前端会重新拉一次峰值（后端缓存键也带 mtime，见 tl_peaks）。 */
  function peakKey(c) {
    const rev = c.file_rev || 0;
    return (c.kind === "sfx" ? "media:" + c.media : c.uid) + "@" + rev;
  }
  /* 后端返回的 key 是「uid」或「media:文件名」，这里补上 rev 存进 S.peaks */
  function absorbPeaks(map, keyBase) {
    const owner = allClips().find((z) => (z.kind === "sfx" ? "media:" + z.media : z.uid) === keyBase);
    S.peaks.set(owner ? peakKey(owner) : keyBase, map);
  }
  /* 只留当前片段用得到的键，免得换了十几次版本后内存里堆一堆旧数组 */
  function prunePeaks() {
    const alive = new Set(allClips().filter((c) => c.has_audio).map((c) => peakKey(c)));
    for (const k of Array.from(S.peaks.keys())) {
      if (!alive.has(k)) S.peaks.delete(k);
    }
  }

  let peakTimer = null;
  function ensurePeaks() {
    if (peakTimer) return;
    peakTimer = setTimeout(async () => {
      peakTimer = null;
      if (!S.data) return;
      const uids = [], media = [];
      for (const c of allClips()) {
        if (!c.has_audio) continue;
        const k = peakKey(c);
        if (S.peaks.has(k) || S.peakAsk.has(k)) continue;
        S.peakAsk.add(k);
        if (c.kind === "sfx") media.push(c.media); else uids.push(c.uid);
        if (uids.length + media.length >= 60) break;
      }
      if (!uids.length && !media.length) return;
      try {
        const q = new URLSearchParams();
        if (uids.length) q.set("uids", uids.join(","));
        if (media.length) q.set("media", media.join(","));
        const r = await fetch(`${API}/peaks?` + q.toString());
        const d = await r.json();
        Object.keys(d.peaks || {}).forEach((k) => absorbPeaks(d.peaks[k].peaks, k));
      } catch (err) { S.peakAsk.clear(); return; }
      draw();
    }, 120);
  }

  /* ------------------------------ 播放（HTML5 Audio 引擎） -------------------
     为什么不用 Web Audio：部分浏览器/环境下 AudioContext 被自动播放策略挂起、
     或解码后不出声，排查成本高。这里改用原生 <audio> 元素，每个片段一个，
     由 tick 统一按时间轴驱动（播放/暂停/跳转/音量/淡入淡出）。稳定可靠。 */
  /* 片段音频的 URL。带 file_rev（后端给的 mtime）：
     重新生成后文件名往往不变，只认名字的话浏览器会一直播旧的那份缓存 ——
     这也是「重生成完试听没变、但导出是对的」的原因。 */
  function srcUrl(c) {
    const rev = c.file_rev || 0;
    if (c.kind === "sfx") {
      return `${API}/src/media/${encodeURIComponent(c.media)}?r=${rev}`;
    }
    return `${API}/src/audio/${encodeURIComponent(c.file || "")}?r=${rev}`;
  }

  function audible() {
    const anySolo = tracks().some((t) => t.solo);
    const out = [];
    for (const tr of tracks()) {
      if (tr.mute || (anySolo && !tr.solo)) continue;
      for (const c of tr.clips) {
        // 试听/播放只看有没有音频文件（stale 需重生成的句子也有旧音频可听）
        if (c.has_audio && !c.mute) out.push({ c, tr });
      }
    }
    return out;
  }

  // 音频元素池：clipId -> HTMLAudioElement（挂到隐藏容器，保证各浏览器都能播）
  const audioPool = new Map();
  function audioSink() {
    let s = document.getElementById("audioSink");
    if (!s) {
      s = document.createElement("div");
      s.id = "audioSink";
      s.style.cssText = "position:fixed;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none;left:-9999px;";
      document.body.appendChild(s);
    }
    return s;
  }
  function audioEl(c) {
    let a = audioPool.get(c.id);
    const url = srcUrl(c);
    if (!a) {
      a = document.createElement("audio");
      a.preload = "auto";
      a.src = url;
      a._url = url;
      audioSink().appendChild(a);
      audioPool.set(c.id, a);
    } else if (a._url !== url) {
      a.src = url; a._url = url;
    }
    return a;
  }
  function pauseAllAudio() {
    for (const a of audioPool.values()) {
      try { a.pause(); } catch (e) { /* noop */ }
    }
  }
  function resetPool() {
    pauseAllAudio();
    for (const a of audioPool.values()) { try { a.removeAttribute("src"); a.load(); } catch (e) {} }
    audioPool.clear();
    for (const n of AG.nodes.values()) {
      try { if (n && n.src) n.src.disconnect(); } catch (e) { /* 忽略 */ }
      try { if (n && n.conv) n.conv.disconnect(); } catch (e) { /* 忽略 */ }
    }
    AG.nodes.clear();
    ROOM_IR.clear();
  }
  if (typeof window !== "undefined" && !window.__tlAudioUnloadBound) {
    window.__tlAudioUnloadBound = true;
    window.addEventListener("beforeunload", (e) => {
      resetPool();
      if (!S.dirty || !S.data) return;
      /* 改完 700ms 内就关页面 / 刷新时，防抖保存还没跑，改动会静默丢失。
         这里先用 keepalive 抢发一次（页面卸载后请求仍会继续），再弹确认。 */
      try {
        fetch(`${API}/project`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(S.data.project), keepalive: true,
        });
      } catch (_) { /* 忽略：至少还有确认框兜底 */ }
      e.preventDefault();
      e.returnValue = "";
    });
  }

  // 片段在给定时间点的音量包络（含淡入淡出）
  function clipVolumeAt(c, tr, pos) {
    const local = pos - c.start;
    const g = kfValue(c, "gain", local);
    let v = Math.max(0, g) * Math.max(0, tr.gain == null ? 1 : tr.gain);
    const fi = c.fade_in || 0, fo = c.fade_out || 0;
    if (fi > 0 && local < fi) v *= Math.max(0, local / fi);
    if (fo > 0 && local > c.dur - fo) v *= Math.max(0, (c.dur - local) / fo);
    return clamp(v, 0, 4);
  }

  /* WebAudio 只做「element.volume 做不到」的两件事：>100% 的增益、声像。
     没有自动化也没有声像的片段继续走原来的 volume 路子，不改它的行为。
     任何一步失败就返回 null，调用方退回 element.volume。 */
  const AG = { ctx: null, nodes: new Map(), dead: false };

  /* 房间 IR：与后端同一套分档（方位 45°、距离 3 档），所以试听和导出用的是同一份。
     前端只是多接一个 ConvolverNode，声音不走服务端。 */
  const ROOM_IR = new Map();
  function roomIrKey(c) {
    const az = Number(c.az) || 0;
    const azb = Math.round(((((az + 180) % 360) + 360) % 360) / 45) * 45 - 180;
    const d = Number(c.dist) || 1;
    const db = d > 6 ? 2 : (d > 2 ? 1 : 0);
    return { key: `${c.room}|${azb}|${db}`, azb, db };
  }
  function loadRoomIR(c) {
    const { key, azb, db } = roomIrKey(c);
    if (ROOM_IR.has(key)) return ROOM_IR.get(key);
    const p = (async () => {
      try {
        if (!AG.ctx) return null;
        const dist = db === 0 ? 1.0 : (db === 1 ? 3.5 : 9.0);
        const url = `${LFAPI}/tl/room-ir?room=${encodeURIComponent(c.room)}`
          + `&az=${azb}&dist=${dist}`;
        const r = await fetch(url);
        if (!r.ok) return null;
        const buf = await r.arrayBuffer();
        return await AG.ctx.decodeAudioData(buf);
      } catch (e) { return null; }
    })();
    ROOM_IR.set(key, p);
    return p;
  }

  function kfGraph(c, a) {
    if (AG.dead) return null;
    try {
      if (!AG.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { AG.dead = true; return null; }
        AG.ctx = new AC();
      }
      let n = AG.nodes.get(c.id);
      if (!n) {
        // 上下文还没 running 就先退回 element 音量：接上 MediaElementSource 之后
        // 声音只走图，图要是挂起的，这段就成了哑的
        if (AG.ctx.state !== "running") {
          const pr = AG.ctx.resume();
          if (pr && pr.catch) pr.catch(() => {});
          return null;
        }
        const src = AG.ctx.createMediaElementSource(a);
        const gain = AG.ctx.createGain();
        // 近场补偿（proximity）：越近低频越厚。浏览器没有近场 HRTF，
        // 但这一级能把「贴耳」最明显的低频堆积补出来，和导出侧的做法对齐。
        const low = AG.ctx.createBiquadFilter();
        try {
          low.type = "lowshelf";
          low.frequency.value = 180;
          low.gain.value = 0;
        } catch (e) { /* 老浏览器 */ }
        src.connect(gain);
        gain.connect(low);
        // 输出级按需创建（声像 / 双耳），切换时只换后半段：
        // MediaElementSource 一个元素只能建一次，不能整条重建
        n = { src, gain, low, out: null, outKind: "", dead: false,
              wetGain: null, conv: null, convKey: "" };
        AG.nodes.set(c.id, n);
      }
      if (n.dead) return null;
      // 房间湿声：从 gain 再分一路到 Convolver（干声那一路不受影响）
      if (c.room && Number(c.send) > 0) {
        if (!n.wetGain) {
          try {
            n.wetGain = AG.ctx.createGain();
            n.conv = AG.ctx.createConvolver();
            n.wetGain.gain.value = 0;
            n.low.connect(n.wetGain);
            n.wetGain.connect(n.conv);
            n.conv.connect(AG.ctx.destination);
          } catch (e) { n.wetGain = null; n.conv = null; }
        }
        if (n.conv) {
          const { key } = roomIrKey(c);
          if (n.convKey !== key) {
            n.convKey = key;
            loadRoomIR(c).then((b) => {
              if (b && n.conv && !n.dead) {
                try { n.conv.buffer = b; } catch (e) { /* noop */ }
              }
            });
          }
        }
      }
      // 双耳：PannerNode + panningModel="HRTF"（浏览器内置 HRIR，真双耳）
      const want = c.binaural ? "hrtf" : "pan";
      if (n.outKind !== want) {
        if (n.out) {
          try { n.low.disconnect(n.out); } catch (e) { /* noop */ }
          try { n.out.disconnect(); } catch (e) { /* noop */ }
        }
        let out = null;
        if (want === "hrtf" && AG.ctx.createPanner) {
          out = AG.ctx.createPanner();
          try {
            out.panningModel = "HRTF";
            out.distanceModel = "inverse";
            out.refDistance = 1;
            out.maxDistance = 40;
            // 距离衰减由我们自己算（和后端同一条曲线）；这里关掉，
            // 否则 1m 以内 PannerNode 恒为 1、1m 以外又和自定义增益叠一次
            out.rolloffFactor = 0;
          } catch (e) { /* 老浏览器 */ }
          placePanner(out, c.az, c.el, c.dist);
        } else if (AG.ctx.createStereoPanner) {
          try { out = AG.ctx.createStereoPanner(); } catch (e) { out = null; }
        }
        if (out) { n.low.connect(out); out.connect(AG.ctx.destination); }
        else { n.low.connect(AG.ctx.destination); }
        n.out = out;
        n.outKind = out ? want : "direct";
      }
      if (AG.ctx.state !== "running") { const p = AG.ctx.resume(); if (p && p.catch) p.catch(() => {}); }
      return n;
    } catch (e) {
      AG.nodes.set(c.id, { dead: true });
      return null;
    }
  }
  /* 方位角(度) / 仰角(度) / 距离(米) → WebAudio 坐标。正前方是 -Z。 */
  function placePanner(p, az, el, dist) {
    const a = (Number(az) || 0) * Math.PI / 180;
    const e = (Number(el) || 0) * Math.PI / 180;
    const d = clamp(Number(dist) || 1, 0.2, 40);
    const x = d * Math.cos(e) * Math.sin(a);
    const y = d * Math.sin(e);
    const z = -d * Math.cos(e) * Math.cos(a);
    try {
      if (p.positionX) { p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z; }
      else if (p.setPosition) p.setPosition(x, y, z);
    } catch (err) { /* noop */ }
  }

  const needGraph = (c) => (!!c.room && Number(c.send) > 0) || !!c.binaural
    || kfPts(c, "pan").length > 0 || kfPts(c, "gain").length > 0
    || Math.abs(c.pan || 0) > 0.001 || (c.gain || 1) > 1.001;

  // 按当前播放位置驱动所有音频元素
  function syncAudio() {
    const anySolo = tracks().some((t) => t.solo);
    const live = new Set();
    for (const { c, tr } of audible()) {
      live.add(c.id);
      const a = audioEl(c);
      const rate = clamp(c.speed || 1, 0.25, 4);       // 时间映射用片段自己的变速
      const inRange = S.pos >= c.start - 0.02 && S.pos < c.start + c.dur;
      if (!inRange) {
        if (!a.paused) a.pause();
        continue;
      }
      const want = Math.max(0, c.offset + (S.pos - c.start) * rate);
      // 变速由 playbackRate 表达，倒放已移除
      if (Math.abs((a.currentTime || 0) - want) > 0.25) {
        try { a.currentTime = want; } catch (e) { /* 尚未加载完成 */ }
      }
      // 实际播放速率 = 片段变速 × 预览倍速（浏览器上限 4×，超出就夹住）
      const pr = clamp(rate * (S.rate || 1), 0.25, 4);
      if (Math.abs((a.playbackRate || 1) - pr) > 0.001) a.playbackRate = pr;
      const vol = clipVolumeAt(c, tr, S.pos);
      const n = (AG.nodes.has(c.id) || needGraph(c)) ? kfGraph(c, a) : null;
      if (n) {
        a.volume = 1;
        try {
          // 距离律与后端 hrir.dist_gain 完全同一条：
          // min(1.25, 1/(0.45+0.55d)) —— 近场封顶 +1.9dB。
          // 以前是 1/(0.4+0.6d)、0.2m 就有 +5.7dB，再叠 +6dB 低频补偿，
          // 低语/ASMR 在试听里就削顶了（导出反而没这么响，两边不一致）。
          const sp0 = kfSpaceAt(c, clamp(S.pos - c.start, 0, c.dur));
          const dNow = sp0.dist || 1;
          const dg = Math.min(1.25, 1 / (0.45 + 0.55 * clamp(dNow, 0.05, 30)));
          n.gain.gain.value = vol * (c.binaural ? dg : 1);
          if (n.low) {
            const t = clamp((1 - dNow) / 1.0, 0, 1);
            n.low.gain.value = c.binaural ? 3 * t : 0;
          }
          if (n.wetGain) {
            n.wetGain.gain.value = (c.room && Number(c.send) > 0)
              ? clamp(Number(c.send), 0, 1) : 0;
          }
          if (n.outKind === "hrtf" && n.out) {
            // 方位也可以有自动化：有曲线就按曲线走
            const sp = kfSpaceAt(c, clamp(S.pos - c.start, 0, c.dur));
            placePanner(n.out, sp.az, sp.el, sp.dist);
          } else if (n.out && n.out.pan) {
            n.out.pan.value = clamp(kfValue(c, "pan", S.pos - c.start), -1, 1);
          }
        } catch (e) { /* 节点掉了就退回 element 音量 */ a.volume = Math.min(1, vol); }
      } else {
        a.volume = Math.min(1, vol);
      }
      if (a.paused) {
        const p = a.play();
        if (p && p.catch) p.catch(() => {});
      }
    }
    // 不在范围内的暂停
    for (const [id, a] of audioPool) {
      if (!live.has(id) && !a.paused) a.pause();
    }
    // 通知 UI：当前是否有片段在响
    const anyPlaying = [...audioPool.values()].some((a) => !a.paused);
    S.audioAlive = anyPlaying;
  }

  // 播放前先把 AudioContext 唤醒：在用户手势里 resume 才有效，
  // 否则自动化（>100% 增益 / 声像）会因为上下文挂起而没声音
  function warmAudio() {
    if (AG.dead) return;
    try {
      if (!AG.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { AG.dead = true; return; }
        AG.ctx = new AC();
      }
      if (AG.ctx.state !== "running") {
        const p = AG.ctx.resume();
        if (p && p.catch) p.catch(() => {});
      }
    } catch (e) { AG.dead = true; }
  }

  /* 倍速播放：S.pos 是「时间轴上的秒数」，人耳听到的进度 = 它 × 倍速。
     所以 t0 要按 rate 反推，tick 里按 rate 正推；音频元素再用 playbackRate 跟上。 */
  const t0For = (pos) => performance.now() - pos * 1000 / Math.max(0.05, S.rate);
  const posAt = (now) => (now - S.t0) / 1000 * Math.max(0.05, S.rate);

  async function play() {
    warmAudio();
    if (!S.data) return;
    if (S.playing) return pause();
    if (S.pos >= S.data.duration - 0.05) S.pos = 0;
    S.playing = true;
    S.t0 = t0For(S.pos);
    $("btnPlay").textContent = "❚❚ 暂停";
    S.timer = setInterval(tick, 60);
    tick();
    // 首次播放若没有任何片段进入可播状态，给个提示（多半是该位置没有音频）
    setTimeout(() => {
      if (S.playing && !S.audioAlive) {
        toast("当前位置附近没有可播放的音频（片段可能未生成或为空）");
      }
    }, 600);
  }

  function pause() {
    S.playing = false;
    clearInterval(S.timer);
    pauseAllAudio();
    $("btnPlay").textContent = "▶ 播放";
    draw();
  }

  function seek(t, keep) {
    S.pos = clamp(t, 0, Math.max(0, S.data.duration));
    if (S.playing) S.t0 = t0For(S.pos);
    pauseAllAudio();          // 跳转时先停，tick 会按新位置续播
    drawPlayheadDom();
    draw();
    if (keep && !S.playing) play();
  }

  function tick() {
    if (!S.playing) return;
    const t = posAt(performance.now());
    S.pos = t;
    syncAudio();
    refreshSpatial();     // 播放中面板也要跟着走（不只是播放头）
    const x = xOf(t);
    if (x > W - 60) {
      S.scrollX = clamp(S.scrollX + (x - (W - 60)), 0, maxScroll());
      draw();
    } else {
      drawPlayheadDom();
    }
    if (t >= S.data.duration) {
      if (S.loop) { S.pos = 0; S.t0 = t0For(0); pauseAllAudio(); draw(); return; }
      pause(); S.pos = S.data.duration; draw();
    }
  }

  /* ------------------------------ 编辑 ------------------------------ */
  // 重叠分流：优先放到「同类别的空白音轨」，没有才新建一条。
  // 新建时按拖拽方向放在当前轨的上方(dir=-1)或下方(dir=+1)。
  /* 锁定 / 解锁：多选时作用于整组；选中的片段锁定状态不一致时，**优先全部锁定**。
     （单段维持原来的「点一下切换」手感）
     c 可以省略：框选之后 S.sel 可能是空的，这时直接按多选集合处理 ——
     以前 L 键写成 `if (key === "l" && c)`，框选完按 L 一点反应都没有就是这个原因。 */
  function lockSelection(c) {
    const base = c || (S.sel ? clipById(S.sel) : null);
    let list;
    if (S.multi.size > 1) list = selClips();
    else if (base) list = [base];
    else list = selClips();
    list = list.filter(Boolean);
    if (!list.length) { toast("先选一段（或多段）再锁定", true); return; }
    const allLocked = list.every((x) => x.locked);
    const to = !allLocked;
    list.forEach((x) => {
      x.locked = to;
      commitClip(x, to ? "锁定片段" : "解锁片段");
    });
    drawInspector(); draw();
    updateBulkBar();
    toast(to ? `已锁定 ${list.length} 段` : `已解锁 ${list.length} 段`);
  }

  function clipsForBatch(c) {
    return (S.multi.size > 1 && S.multi.has(c.id)) ? selClips() : [c].filter(Boolean);
  }

  /* 把片段挪到另一条轨（只是搬家，不改时间）。语音/素材类型不匹配时直接拒绝。 */
  function moveClipToTrack(c, target) {
    if (!c || !target || target.id === c.track) return false;
    if ((target.kind === "voice") !== (c.kind === "voice")) return false;
    const from = tracks().find((z) => z.id === c.track);
    if (from) from.clips = from.clips.filter((z) => z !== c);
    c.track = target.id;
    target.clips = target.clips || [];
    if (!target.clips.includes(c)) target.clips.push(c);
    target.clips.sort((a, b) => a.start - b.start);
    return true;
  }

  function moveToNewTrack(c, wantVoice, dir) {
    const kind = wantVoice ? "voice" : "sfx";
    const sameKind = S.data.tracks.filter((t) => t.kind === kind && t.id !== c.track);
    // 1) 先找空白轨（无片段），优先离当前轨最近的下方，再上方
    const curIdx = S.data.tracks.findIndex((t) => t.id === c.track);
    const empties = sameKind.filter((t) => !t.clips || t.clips.length === 0);
    let target = null;
    if (empties.length) {
      // 按与当前轨的数组距离排序，距离近的优先
      empties.sort((a, b) => {
        const ia = S.data.tracks.indexOf(a), ib = S.data.tracks.indexOf(b);
        return Math.abs(ia - curIdx) - Math.abs(ib - curIdx);
      });
      target = empties[0];
    }
    if (target) {
      // 复用空白轨
      const from = S.data.tracks.find((t) => t.id === c.track);
      if (from) from.clips = from.clips.filter((z) => z !== c);
      c.track = target.id;
      target.clips = target.clips || [];
      target.clips.push(c);
      markDirty();
      buildHeads();
      drawInspector();
      resize();
      toast(`已移到空白音轨「${target.name}」`);
      return;
    }
    // 2) 没有空白轨 → 新建
    const n = tracks().filter((t) => t.kind === kind).length + 1;
    const newTr = {
      id: "t" + uid(),
      name: (wantVoice ? "音声轨 " : "素材轨 ") + n,
      kind, gain: 1, pan: 0, mute: false, solo: false, clips: [],
    };
    // 插入到当前轨的上/下（数组内相邻，orderedTracks 按 kind 过滤后仍是相邻）
    const insertAt = curIdx < 0 ? S.data.tracks.length
      : (dir < 0 ? curIdx : curIdx + 1);
    S.data.tracks.splice(insertAt, 0, newTr);
    if (Array.isArray(S.data.project.tracks)) {
      const pIdx = S.data.project.tracks.findIndex((t) => t.id === c.track);
      const pAt = pIdx < 0 ? S.data.project.tracks.length : (dir < 0 ? pIdx : pIdx + 1);
      S.data.project.tracks.splice(pAt, 0, {
        id: newTr.id, name: newTr.name, kind, gain: 1, pan: 0, mute: false, solo: false,
      });
    }
    c.track = newTr.id;
    newTr.clips.push(c);
    markDirty();
    buildHeads();
    drawInspector();
    resize();
    toast(`重叠已分流：新建「${newTr.name}」（${dir < 0 ? "上方" : "下方"}）`);
  }

  /**
   * 改「源内起点」时保持片段在时间轴上的右边界与幽灵块左边界不动。
   * 即：offset ↑ 时 start 同步右移、dur 同步收缩（等价于从头部裁掉一段）。
   */
  function setClipOffset(c, newOff) {
    const off0 = Math.max(0, c.offset || 0);
    const srcDur = Math.max(c.dur + off0, c.src_dur || 0);
    let off1 = clamp(newOff, 0, Math.max(0, srcDur - 0.05));
    let delta = off1 - off0;
    if (c.start + delta < 0) { delta = -c.start; off1 = off0 + delta; }
    if (c.dur - delta < 0.05) { delta = c.dur - 0.05; off1 = off0 + delta; }
    c.start = Math.max(0, Math.round((c.start + delta) * 1000) / 1000);
    c.dur = Math.max(0.05, Math.round((c.dur - delta) * 1000) / 1000);
    c.offset = Math.max(0, Math.round(off1 * 1000) / 1000);
    if (c.kind === "voice") c.trim_start = c.offset;
    commitClip(c, "调整源内起点");
    drawInspector();
    draw();
  }

  function writeClipOverride(c) {
    const p = S.data.project;
    // 关键帧（音量/声像自动化）：片段上没曲线了就把它从工程里删掉，别留垃圾
    p.kf = p.kf || {};
    if (c.kf && Object.keys(c.kf).length) p.kf[c.id] = c.kf;
    else delete p.kf[c.id];
    if (c.kind === "voice") {
      p.clips[c.uid] = p.clips[c.uid] || {};
      const o = p.clips[c.uid];
      o.start = Math.max(0, c.start);
      o.trim_start = Math.max(0, c.offset);
      o.trim_end = Math.max(0, (c.src_dur || c.dur + c.offset) - c.offset - c.dur);
      o.gain = c.gain;
      o.pan = c.pan;
      o.speed = c.speed;
      o.mute = !!c.mute;
      o.locked = !!c.locked;
      o.track = c.track;
      o.fade_in = c.fade_in;
      o.fade_out = c.fade_out;
      o.az = c.az || 0;
      o.el = c.el || 0;
      o.dist = c.dist == null ? 1 : c.dist;
      o.binaural = !!c.binaural;
      o.room = c.room || "";
      o.send = Number(c.send) || 0;
      o.hrtf = c.hrtf || "";
      o.sp_preset = c.sp_preset || "";
    } else if (c.from_tag) {
      /* 标签音效片段是「派生」出来的：它不在 project.sfx 里（位置由标签时间+留白决定），
         但它被搬到哪条轨必须写进 project.tagfx，否则一刷新就被 _build 拉回原来那条轨，
         表现出来就是「别的片段自己挪了位置、还叠上去了」。 */
      p.tagfx = p.tagfx || {};
      /* tfx = 这条派生音效的覆写键：句间标签就是标签行 uid，
         句中标签是「uid#k」—— 同一句可能挂好几个句中音效，不能共用一个键。 */
      const tkey = c.tfx || c.from_tag;
      const o = p.tagfx[tkey] || {};
      o.track = c.track;
      o.gain = c.gain;
      o.mute = !!c.mute;
      o.az = c.az || 0;
      o.el = c.el || 0;
      o.dist = c.dist == null ? 1 : c.dist;
      o.binaural = !!c.binaural;
      o.room = c.room || "";
      o.send = Number(c.send) || 0;
      o.hrtf = c.hrtf || "";
      o.sp_preset = c.sp_preset || "";
      p.tagfx[tkey] = o;
    } else {
      const item = (p.sfx || []).find((s) => s.id === c.id);
      if (item) {
        item.start = Math.max(0, c.start);
        item.dur = c.dur;
        item.offset = Math.max(0, c.offset);
        item.gain = c.gain;
        item.pan = c.pan;
        item.speed = c.speed;
        item.mute = !!c.mute;
        item.locked = !!c.locked;
        item.track = c.track;
        item.fade_in = c.fade_in;
        item.fade_out = c.fade_out;
        item.az = c.az || 0;
        item.el = c.el || 0;
        item.dist = c.dist == null ? 1 : c.dist;
        item.binaural = !!c.binaural;
        item.room = c.room || "";
        item.send = Number(c.send) || 0;
        item.hrtf = c.hrtf || "";
        item.sp_preset = c.sp_preset || "";
      }
    }
  }

  function commitClip(c, why) {
    writeClipOverride(c);
    markDirty(why);
    draw();
  }

  function removeClip(c) {
    if (c.kind === "voice") {
      toast("语音片段跟台本走，删句子请回台本页", true);
      return;
    }
    if (c.from_tag) {
      toast("这是标签挂的音效：位置由标签决定，请回台本页把标签的音效取消挂载", true);
      return;
    }
    undoMark("删除片段");
    S.data.project.sfx = (S.data.project.sfx || []).filter((s) => s.id !== c.id);
    if (S.data.project.kf) delete S.data.project.kf[c.id];
    S.sel = null;
    persist("删除片段");
  }

  /* 插入一条素材片段。dur / display 可以直接给（从三个库插入时由后端返回），
     不给就按导入台里的同名条目查。 */
  function addSfx(media, at, trackId, dur, display) {
    const m = MEDIA.find((x) => x.name === media);
    const d0 = dur != null ? Number(dur) : (m && m.dur) || 0;
    const item = {
      id: uid(), media,
      name: String(display || (m && m.name) || media).replace(/\.wav$/, ""),
      track: trackId || (sfxTracks()[0] || tracks()[0]).id,
      start: Math.max(0, Math.round(at * 1000) / 1000), offset: 0,
      dur: Math.max(0.1, d0 || 1), gain: 1, pan: 0, speed: 1,
      mute: false, locked: false, fade_in: 0, fade_out: 0,
    };
    S.data.project.sfx = (S.data.project.sfx || []).concat([item]);
    return item;
  }

  /* ---------------- 复制 / 粘贴（支持多段） ----------------
     剪贴板统一存成 { items:[{c, dt, track}] }：
       dt    = 相对第一段的起始偏移（粘贴时整块保持相对位置）
       track = 原轨 id（粘贴时优先回原轨，轨没了就落到目标轨）
     旧格式（单个片段对象）也认，避免刚复制完就升级到新代码时剪贴板失效。 */
  function clipItems(clip) {
    if (!clip) return [];
    if (Array.isArray(clip.items)) return clip.items;
    return [{ c: clip, dt: 0, track: clip.track }];
  }

  function pasteClip(clip, at, trackId, withKf) {
    const item = {
      id: uid(), media: clip.media,
      // 素材片段的显示名在 text 里（服务端 payload 没有 name 字段），两处都兜住
      name: clip.name || clip.text || clip.media,
      track: trackId, start: at, offset: clip.offset, dur: clip.dur,
      gain: clip.gain, pan: clip.pan, speed: clip.speed,
      mute: clip.mute, locked: false, fade_in: clip.fade_in, fade_out: clip.fade_out,
      az: clip.az || 0, el: clip.el || 0,
      dist: clip.dist == null ? 1 : clip.dist, binaural: !!clip.binaural,
      // 空间方案 / 混响 / HRIR 也一起复制，不然「粘贴一份」听起来和原件不是一回事
      room: clip.room || "", send: Number(clip.send) || 0,
      hrtf: clip.hrtf || "", sp_preset: clip.sp_preset || "",
    };
    S.data.project.sfx = (S.data.project.sfx || []).concat([item]);
    // 复制过来的片段连关键帧一起带过去（不然自动化就白做了）
    if (withKf !== false && clip.kf && Object.keys(clip.kf).length) {
      S.data.project.kf = S.data.project.kf || {};
      S.data.project.kf[item.id] = JSON.parse(JSON.stringify(clip.kf));
    }
    return item;
  }

  /* 把「选中的片段」放进剪贴板：支持多段，保持相对时间 */
  function copySelection(cut, ids) {
    const cs = ids ? ids.map((x) => clipById(x)).filter(Boolean)
      : (S.multi.size > 1 ? selClips() : [clipById(S.sel)].filter(Boolean));
    /* 语音片段也能复制了：粘贴时会把它复制成一条**独立的素材片段**（新 wav 文件），
       不会在台本里多一句，删掉也不影响原句。标签音效（from_tag）仍不复制。 */
    const usable = cs.filter((c) => !c.from_tag && (c.kind === "sfx" || c.kind === "voice"));
    if (!usable.length) {
      toast(cs.length ? "标签挂的音效跟标签走，不能复制" : "先选中要复制的片段", true);
      return false;
    }
    if (usable.length < cs.length) {
      toast(`只复制了 ${usable.length} 段（标签音效不能复制）`);
    }
    const base = Math.min(...usable.map((c) => c.start));
    S.clipboard = {
      items: usable.map((c) => ({
        c: JSON.parse(JSON.stringify(c)), dt: c.start - base, track: c.track,
      })),
      n: usable.length,
    };
    const nv = usable.filter((c) => c.kind === "voice").length;
    if (!cut) {
      toast(`已复制 ${usable.length} 段`
        + (nv ? `（其中 ${nv} 段语音会复制成独立素材，不改台本）` : ""));
    }
    return true;
  }

  /* 复制语音到「音声副本音轨」：台本那一句完全不受影响。
     副本落在一条专属素材轨上，位置固定在所有音声轨下方、其它素材轨上方。 */
  /* 副本轨：没有就建一条。位置固定在「素材组第一条」——即所有音声轨下方、其它素材轨上方。 */
  function ensureVoiceCopyTrack() {
    let tr = tracks().find((t) => t.kind === "sfx" && t.name === VOICE_COPY_TRACK);
    if (tr) return tr;
    tr = {
      id: "t" + uid(), name: VOICE_COPY_TRACK, kind: "sfx",
      gain: 1, pan: 0, mute: false, solo: false, clips: [],
    };
    const atSfxTop = (arr) => {
      const i = arr.findIndex((t) => t.kind && t.kind !== "voice");
      return i < 0 ? arr.length : i;
    };
    tr.clips = tr.clips || [];
    S.data.tracks.splice(atSfxTop(S.data.tracks), 0, tr);
    if (Array.isArray(S.data.project.tracks)) {
      S.data.project.tracks.splice(atSfxTop(S.data.project.tracks), 0, {
        id: tr.id, name: tr.name, kind: "sfx", gain: 1, pan: 0, mute: false, solo: false,
      });
    }
    return tr;
  }

  /* 把音声片段的听感属性抄到副本上，副本听起来才跟原句一致 */
  function copyVoiceSoundProps(c, item) {
    item.gain = c.gain; item.pan = c.pan;
    item.az = c.az || 0; item.el = c.el || 0;
    item.dist = c.dist == null ? 1 : c.dist;
    item.binaural = !!c.binaural;
    item.room = c.room || ""; item.send = Number(c.send) || 0;
    item.hrtf = c.hrtf || ""; item.sp_preset = c.sp_preset || "";
    item.fade_in = c.fade_in || 0; item.fade_out = c.fade_out || 0;
    /* 关键帧也带过去：音量/声像/空间距离的自动化是这一段最费工夫的部分，
       不带过去副本就是「一条直的声音」，等于白做。 */
    if (c.kf && Object.keys(c.kf).length) {
      S.data.project.kf = S.data.project.kf || {};
      S.data.project.kf[item.id] = JSON.parse(JSON.stringify(c.kf));
    }
    return item;
  }

  /* 批量：把若干音声片段各自复制成**独立素材**，落到「音声副本音轨」。
     台本那边一句都不多、原句不动；副本改名 / 裁剪 / 删除都与台本无关。 */
  async function copyVoicesToCopyTrack(list) {
    const all = (list || []).filter((x) => x && x.kind === "voice");
    if (!all.length) { toast("选中的不是音声片段", true); return []; }
    const ready = all.filter((x) => x.uid && x.has_audio);
    if (!ready.length) { toast("选中的音声片段都还没有生成音频", true); return []; }
    if (ready.length < all.length) {
      toast(`有 ${all.length - ready.length} 段还没生成音频，已跳过`);
    }
    /* 逐段请服务端把 audio/<uid>.wav 复制成独立素材。
       一段失败不影响其它段（比如某句音频文件被手工删了）。 */
    const got = [];
    for (const c of ready) {
      try {
        const r = await fetch(`${API}/media/from-voice`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uid: c.uid }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || "复制音频失败");
        got.push({ c, d });
      } catch (e) {
        toast(`「${(c.text || "").slice(0, 8)}…」复制失败：${e.message}`, true);
      }
    }
    if (!got.length) return [];
    await loadMedia().catch(() => {});
    const tr = ensureVoiceCopyTrack();
    const made = [];
    got.forEach(({ c, d }) => {
      const item = addSfx(d.name, c.start, tr.id, d.dur, d.display || d.name);
      if (item) made.push(copyVoiceSoundProps(c, item));
    });
    if (!made.length) { toast("插入失败", true); return []; }
    // 复制出来的这几段直接选中，方便接着拖 / 改属性
    S.multi.clear();
    made.forEach((x) => S.multi.add(x.id));
    S.sel = made[made.length - 1].id;
    updateBulkBar();
    markDirty("复制语音到素材轨");
    drawInspector(); draw(); resize(); buildHeads();
    await persist("复制语音到素材轨");
    toast(made.length > 1
      ? `已复制 ${made.length} 段到「${tr.name}」`
      : `已复制到「${tr.name}」（${got[0].d.display || got[0].d.name}）`);
    return made;
  }

  /* 单段入口：调试钩子与旧调用点用 */
  async function copyVoiceToCopyTrack(c) {
    const made = await copyVoicesToCopyTrack([c]);
    return made.length ? made[0] : null;
  }

  /* 粘贴整块：at = 第一段的起点；返回新片段数组。
     语音片段会被复制成独立素材（服务端拷一份 wav 到 media/），落到素材轨上，
     和台本彻底脱钩：改名 / 裁剪 / 删除都不影响原句，也不会新增句子。 */
  async function pasteClipboard(at, trackId) {
    const items = clipItems(S.clipboard);
    if (!items.length) { toast("剪贴板是空的：先 Ctrl+C 复制一段", true); return []; }
    const trackIds = new Set(tracks().map((t) => t.id));
    const fallbackSfx = (sfxTracks()[0] || tracks()[0] || {}).id;
    const out = [];
    for (const it of items) {
      const src = it.c;
      const when = Math.max(0, at + (it.dt || 0));
      if (src.kind === "voice") {
        try {
          const r = await fetch(`${API}/media/from-voice`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ uid: src.uid }),
          });
          const d = await r.json();
          if (!r.ok) throw new Error(d.detail || "复制音频失败");
          const trackOk = (src.track && tracks().find((t) => t.id === src.track && t.kind === "sfx"))
            ? src.track : fallbackSfx;
          const item = addSfx(d.name, when, trackOk, d.dur, d.display || d.name);
          if (item) {
            item.gain = src.gain; item.pan = src.pan;
            item.az = src.az || 0; item.el = src.el || 0;
            item.dist = src.dist == null ? 1 : src.dist;
            item.binaural = !!src.binaural;
            item.room = src.room || ""; item.send = Number(src.send) || 0;
            item.hrtf = src.hrtf || "";
            item.fade_in = src.fade_in || 0; item.fade_out = src.fade_out || 0;
            if (src.kf && Object.keys(src.kf).length) {
              S.data.project.kf = S.data.project.kf || {};
              S.data.project.kf[item.id] = JSON.parse(JSON.stringify(src.kf));
            }
            out.push(item);
          }
        } catch (e) {
          toast(`复制语音成素材失败：${e.message}`, true);
        }
        continue;
      }
      const tid = (it.track && trackIds.has(it.track)) ? it.track : (trackId || fallbackSfx);
      out.push(pasteClip(src, when, tid));
    }
    return out;
  }

  /* ---------------- 片段属性复制 / 选择性粘贴（Ctrl+Shift+C / Ctrl+Shift+V） ----------------
     属性 = 音量 / 声像 / 静音 / 速度 / 淡入淡出 / 空间位置 / 混响·HRIR / 关键帧曲线。
     关键帧两种贴法：
       time  = 按时间贴（原时间点照搬，超出目标片段时长的点丢掉）
       ratio = 按比例贴（可选用「显示的那一段」还是「整条片段的长度」当基准）
     目标片段被裁掉的部分（半透明那段）不影响：关键帧的时间都是相对片段起点的。 */
  let PROP_CLIP = null;

  const PROP_ITEMS = [
    ["gain", "音量"], ["pan", "声像"], ["mute", "静音"], ["speed", "速度"],
    ["fade", "淡入淡出"], ["space", "空间位置"], ["room", "混响 / HRIR"], ["kf", "关键帧曲线"],
  ];

  function copyClipProps(c) {
    PROP_CLIP = {
      gain: c.gain, pan: c.pan, mute: !!c.mute, speed: c.speed || 1,
      fade_in: c.fade_in || 0, fade_out: c.fade_out || 0,
      az: c.az || 0, el: c.el || 0, dist: c.dist == null ? 1 : c.dist,
      binaural: !!c.binaural,
      room: c.room || "", send: Number(c.send) || 0,
      hrtf: c.hrtf || "", sp_preset: c.sp_preset || "",
      kf: JSON.parse(JSON.stringify(c.kf || {})),
      dur: c.dur, src_dur: c.src_dur || c.dur, name: c.name || c.text || "",
    };
    PROP_CLIP.n = ["gain", "pan", "speed", "fade", "space", "room", "kf"]
      .filter((k) => propHas(PROP_CLIP, k)).length;
    toast(`已复制「${PROP_CLIP.name}」的属性`
      + `（${PROP_ITEMS.filter(([k]) => propHas(PROP_CLIP, k)).map(([, n]) => n).join(" / ")}）`);
  }

  function propHas(p, key) {
    if (key === "kf") return !!(p.kf && Object.keys(p.kf).length);
    if (key === "fade") return (p.fade_in || 0) > 0.001 || (p.fade_out || 0) > 0.001;
    if (key === "space") return !!(p.binaural || p.az || p.el || (p.dist != null && p.dist !== 1));
    if (key === "room") return !!p.room || Number(p.send) > 0 || !!p.hrtf;
    return true;
  }

  function pasteKf(src, t, mode, rangeMode) {
    const out = {};
    ["gain", "pan", "space"].forEach((prop) => {
      const pts = (src.kf && src.kf[prop]) || [];
      if (!pts.length) return;
      const sb = rangeMode === "full" ? (src.src_dur || src.dur) : src.dur;
      const tb = rangeMode === "full" ? (t.src_dur || t.dur) : t.dur;
      const k = sb > 0.001 ? tb / sb : 1;
      const arr = [];
      pts.forEach((p) => {
        const tt = mode === "ratio" ? p[0] * k : p[0];
        if (tt > t.dur + 1e-6) return;            // 超出目标片段 → 忽略
        arr.push(prop === "space"
          ? [r3(tt), p[1] || 0, p[2] || 0, p[3] == null ? 1 : p[3]]
          : [r3(tt), p[1]]);
      });
      if (arr.length) out[prop] = arr.sort((a, b) => a[0] - b[0]);
    });
    return out;
  }

  function applyPropsToClip(t, src, sel, kfMode, kfRange) {
    if (sel.gain) t.gain = src.gain;
    if (sel.pan) t.pan = src.pan;
    if (sel.mute) t.mute = !!src.mute;
    if (sel.speed) {
      const avail = Math.max(0.05, (t.src_dur || t.dur) - (t.offset || 0));
      t.speed = clamp(src.speed || 1, 0.25, 4);
      t.dur = clamp(avail / t.speed, 0.05, avail);
      if (t.kind === "voice") t.trim_end = Math.max(0, (t.src_dur || t.dur) - (t.offset || 0) - t.dur);
    }
    if (sel.fade) {
      setFade(t, src.fade_in || 0, src.fade_out || 0);
    }
    if (sel.space) {
      t.az = src.az || 0; t.el = src.el || 0;
      t.dist = src.dist == null ? 1 : src.dist;
      t.binaural = !!src.binaural;
      if (!t.binaural && KF.prop === "space") KF.prop = "gain";
    }
    if (sel.room) {
      t.room = src.room || ""; t.send = Number(src.send) || 0;
      t.hrtf = src.hrtf || ""; t.sp_preset = src.sp_preset || "";
    }
    if (sel.kf) {
      const kf = pasteKf(src, t, kfMode, kfRange);
      t.kf = Object.keys(kf).length ? kf : {};
    }
    return t;
  }

  function propsPasteDialog(targets, opts) {
    const tg = (targets || []).filter(Boolean);
    if (!PROP_CLIP) { toast("先按 Ctrl+Shift+C 复制一段的属性", true); return; }
    if (!tg.length) { toast("先选中要粘贴到哪一段", true); return; }
    const o = opts || {};
    modal(o.title || `粘贴属性到 ${tg.length} 段`, (box) => {
      box.appendChild(el("div", "phint",
        `来源：「${PROP_CLIP.name}」。勾选要粘贴的属性，没勾的保持目标片段原样。`
        + (o.track ? "（整条音轨：会给轨上每段都套一遍）" : "")));
      const grid = el("div", "propgrid");
      const chks = {};
      PROP_ITEMS.forEach(([key, label]) => {
        const has = propHas(PROP_CLIP, key);
        const lab = el("label", "chkrow" + (has ? "" : " off"));
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = has && key !== "mute";
        cb.disabled = !has;
        chks[key] = cb;
        lab.appendChild(cb);
        lab.appendChild(el("span", null, label));
        if (!has) lab.appendChild(el("span", "sub", "（源片段没有）"));
        grid.appendChild(lab);
      });
      box.appendChild(grid);

      // 关键帧的粘贴方式
      const kfBox = el("div", "field");
      kfBox.hidden = !propHas(PROP_CLIP, "kf");   // 源片段没有关键帧就别显示这一块
      kfBox.appendChild(el("div", "fl", "关键帧怎么贴"));
      const modeRow = el("div", "radios");
      modeRow.innerHTML =
        '<label><input type="radio" name="kfm" value="time" checked> 按时间贴（超出目标片段的点丢掉）</label>'
        + '<label><input type="radio" name="kfm" value="ratio"> 按时间比例贴（拉伸/压缩到目标）</label>';
      kfBox.appendChild(modeRow);
      const rangeRow = el("div", "radios", "");
      rangeRow.innerHTML =
        '<label><input type="radio" name="kfr" value="shown" checked> 比例基准：显示的那一段</label>'
        + '<label><input type="radio" name="kfr" value="full"> 比例基准：整条片段的长度</label>';
      kfBox.appendChild(rangeRow);
      box.appendChild(kfBox);
      box.appendChild(el("div", "phint",
        "片段被裁掉的部分（半透明那段）不参与：关键帧时间都相对片段起点，贴过去不会被裁掉的时长影响。"));
      box.__read = () => ({
        sel: Object.fromEntries(Object.entries(chks).map(([k, cb]) => [k, cb.checked && !cb.disabled])),
        kfMode: (box.querySelector('input[name="kfm"]:checked') || {}).value || "time",
        kfRange: (box.querySelector('input[name="kfr"]:checked') || {}).value || "shown",
      });
    }, "粘贴", (box) => {
      const r = box.__read();
      if (!Object.values(r.sel).some(Boolean)) { toast("至少勾一项", true); return false; }
      const n = tg.length;
      tg.forEach((t) => {
        applyPropsToClip(t, PROP_CLIP, r.sel, r.kfMode, r.kfRange);
        commitClip(t, "粘贴属性");
      });
      drawInspector(); draw();
      persist("粘贴属性");
      toast(`已把属性粘贴到 ${n} 段`);
      box.closest(".mask")?.remove();
      return true;
    });
  }
  /* ---------------- 撤销 / 重做（快照式，与「历史版本」同一套数据） ----------------
     HIST.base = 「上一次稳定状态」的工程 JSON。改动发生时先不动 base，等改动停下来
     （600ms 静默）再把它推进 undo 栈、base 换成当前 —— 这样滑杆一路拖、片段一路拖，
     都只算一步，不会把栈冲爆。撤销 = 把上一步的 base 写回服务端再重载。 */
  const HIST = { base: "", undo: [], redo: [], limit: 80, timer: null, label: "" };

  function projSnap() { return S.data ? JSON.stringify(S.data.project) : ""; }

  function updateUndoBtns() {
    const u = $("btnUndo"), r = $("btnRedo");
    if (u) {
      u.disabled = !HIST.undo.length;
      u.title = HIST.undo.length ? `撤销：${HIST.undo[HIST.undo.length - 1].label}（Ctrl+Z）` : "没有可撤销的操作";
    }
    if (r) {
      r.disabled = !HIST.redo.length;
      r.title = HIST.redo.length ? `重做：${HIST.redo[HIST.redo.length - 1].label}（Ctrl+Shift+Z）` : "没有可重做的操作";
    }
  }

  function undoMark(label) {
    if (!S.data) return;
    if (!HIST.base) HIST.base = projSnap();
    HIST.label = label || HIST.label || "编辑改动";
    clearTimeout(HIST.timer);
    HIST.timer = setTimeout(flushUndo, 600);
  }

  function flushUndo() {
    clearTimeout(HIST.timer);
    HIST.timer = null;
    if (!S.data) return;
    const cur = projSnap();
    if (!HIST.base) { HIST.base = cur; return; }
    if (cur === HIST.base) { HIST.label = ""; return; }
    HIST.undo.push({ snap: HIST.base, label: HIST.label || "编辑改动" });
    if (HIST.undo.length > HIST.limit) HIST.undo.shift();
    HIST.redo.length = 0;
    HIST.base = cur;
    HIST.label = "";
    updateUndoBtns();
  }

  async function restoreProject(snap, label) {
    clearTimeout(S.saveTimer);
    try {
      const r = await fetch(`${API}/project`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: snap,
      });
      if (!r.ok) throw new Error((await r.json()).detail || "恢复失败");
    } catch (e) { toast((label || "恢复") + "失败：" + e.message, true); return false; }
    S.dirty = false;
    await reload();
    HIST.base = projSnap();
    updateUndoBtns();
    return true;
  }

  async function doUndo() {
    flushUndo();
    if (!HIST.undo.length) { toast("没有可撤销的操作", true); return; }
    const it = HIST.undo.pop();
    HIST.redo.push({ snap: projSnap(), label: it.label });
    if (await restoreProject(it.snap, "撤销")) toast("已撤销：" + it.label);
  }

  async function doRedo() {
    flushUndo();
    if (!HIST.redo.length) { toast("没有可重做的操作", true); return; }
    const it = HIST.redo.pop();
    HIST.undo.push({ snap: projSnap(), label: it.label });
    if (await restoreProject(it.snap, "重做")) toast("已重做：" + it.label);
  }

  function markDirty(label) {
    S.dirty = true;
    const b = $("btnSave");
    b.disabled = true; b.textContent = "未保存";
    clearTimeout(S.saveTimer);
    /* 定时保存也要走同一条队列：否则它和 persist 的保存会并发，
       PATCH 乱序 = 后点的改动被先点的覆盖。 */
    S.saveTimer = setTimeout(() => {
      PERSIST_CHAIN = PERSIST_CHAIN.then(() => save()).catch(() => {});
    }, 700);
    undoMark(label);
  }

  // 自动历史快照（落盘，跨会话可回退）：节流到 90 秒一次，避免刷屏
  let autoHistAt = 0;
  async function autoSnapshot(label) {
    const now = Date.now();
    if (now - autoHistAt < 90000) return;
    autoHistAt = now;
    try {
      await fetch(`${API}/history`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label || "自动保存" }),
      });
    } catch (e) { /* 忽略 */ }
  }

  async function save() {
    if (!S.dirty || !S.data) return;
    S.dirty = false;
    try {
      const r = await fetch(`${API}/project`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(S.data.project),
      });
      if (!r.ok) throw new Error(await r.text());
      const b = $("btnSave");
      b.disabled = false;
      const d = new Date();
      b.textContent = "已保存 " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
      autoSnapshot("自动保存");
    } catch (e) {
      S.dirty = true;
      toast("保存失败：" + e.message, true);
    }
  }

  // 立即保存并重载（用于增删片段这类需要后端立即落盘、再拉回权威数据的操作，
  // 避免 markDirty 的 700ms 防抖和 reload 之间竞态导致新片段被旧数据覆盖丢失）
  /* 串行化落盘：快速连续操作（连着拖两下、批量改完再改一段）会并发 PATCH + reload。
     PATCH 乱序 = 旧数据盖掉新数据；reload 乱序 = 界面"退回上一版"。 */
  let PERSIST_CHAIN = Promise.resolve();
  function persist(label) {
    clearTimeout(S.saveTimer);
    S.dirty = true;
    undoMark(label || "编辑片段");
    PERSIST_CHAIN = PERSIST_CHAIN.then(async () => {
      await save();
      /* 保存期间又有新改动（dirty 被重新置位）：跳过这次 reload。
         否则会拿服务端的旧快照把刚改的内容冲掉，改由下一轮 persist 处理。 */
      if (!S.dirty) await reload();
    }).catch(() => {});
    return PERSIST_CHAIN;
  }

  /* 总时长跟着片段末端走：任何片段被拖到当前总时长之外，就把它撑大。
     （以前只在服务端算 duration，前端拖的时候画布/滚动都不跟着变，看着像拖不动。） */
  function extendDurationToClips() {
    if (!S.data) return;
    let end = 0;
    allClips().forEach((c) => { end = Math.max(end, c.start + c.dur); });
    if (end > (S.data.duration || 0) + 0.01) {
      S.data.duration = Math.round(end * 1000) / 1000;
      S.data.project.duration = S.data.duration;
      markDirty("延长总时长");
      $("timeTotal").textContent = fmtShort(S.data.duration);
      resize();
      drawNav();
    }
  }

  /* ------------------------------ 交互 ------------------------------ */
  function hitZone(c, x) {
    const x0 = xOf(c.start), x1 = x0 + c.dur * S.pps;
    // 边框裁剪手柄：10px 内算「左边/右边」，中间算「移动」（类似剪映）
    const E = Math.min(10, Math.max(5, c.dur * S.pps / 3));
    if (Math.abs(x - x0) <= E) return "left";
    if (Math.abs(x - x1) <= E) return "right";
    return "body";
  }

  function snapT(t) {
    if (!S.snap) return t;
    const th = 9 / S.pps;
    let best = t, bd = th;
    // 吸附到标记（句中/句间标签作插入点）
    for (const m of S.data.markers) {
      const d = Math.abs(m.time - t);
      if (d < bd) { bd = d; best = m.time; }
    }
    // 吸附到所有片段边缘（专业 DAW 吸附：拖动时对齐其它片段边界）
    for (const c of allClips()) {
      for (const edge of [c.start, c.start + c.dur]) {
        const d = Math.abs(edge - t);
        if (d < bd) { bd = d; best = edge; }
      }
    }
    if (t < th) { bd = t; best = 0; }
    return best;
  }

  cv.addEventListener("mousedown", (e) => {
    if (!S.data) return;
    hideCtx();
    /* 只有左键才走「点选 / 拖动」。右键以前也会进来：
       在多选集合里右键一段就进入 move 拖拽，松手时 endDrag 的 wasMultiSel 分支
       把集合收成这一段 —— 表现就是「右键一下就只剩一个片段被选中」。 */
    if (e.button !== 0) return;
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;

    if (y < RULER_H) {
      seek(clamp(tOf(x), 0, S.data.duration), S.playing);
      S.drag = { type: "scrub" };
      return;
    }
    // 悬窗是纯展示：在标记位置点一下即可选素材插入
    if (tryHoverInsertClick(x, y)) return;
    const ti = trackIndexAtY(y);
    const mod = e.shiftKey || e.ctrlKey || e.metaKey;
    const tr = ti >= 0 ? orderedTracks()[ti] : null;
    const c = tr ? clipAt(tr, x) : null;
    if (!c) {
      // 空白处按下（含所有轨道下方的空白）：可以拖出一块框选；单击不动 = 取消选择
      if (!mod) { S.sel = null; S.multi.clear(); S.bulkOpen = false; updateBulkBar(); }
      S.marquee = { x0: x, y0: y, x1: x, y1: y, add: mod, base: Array.from(S.multi) };
      S.drag = { type: "marquee", x0: x, y0: y };
      drawInspector(); draw(); return;
    }

    S.marquee = null;

    // 关键帧点优先：锁定的片段也能改关键帧（那不是位置），所以放在 locked 判断前面
    const kfIdx = kfHit(c, x, y);
    if (kfIdx !== null) {
      S.sel = c.id; S.anchor = c.id;
      if (KF.prop === "space") kfSelSet(c, kfIdx);   // 图形面板跟着切到这个点
      S.drag = { type: "kf", c, prop: KF.prop, idx: kfIdx, moved: false };
      drawInspector(); draw();
      return;
    }
    /* 插入模式（空间页签下点「✚ 在片段上点选插入点」）：
       在片段任意位置点一下 = 在那一刻插一个空间关键帧，随后上下拖就是改距离。
       和 Alt+点击同一条路径，只是不用按 Alt（触控板/触屏更友好）。 */
    if (KF.insert && KF.prop === "space") {
      addKfAt(c, clamp(tOf(x) - c.start, 0, c.dur), y, "click");
      return;
    }
    // Alt+点击片段 = 在那个位置加一个关键帧（并直接进入拖动）
    if (e.altKey) {
      addKfAt(c, clamp(tOf(x) - c.start, 0, c.dur), y, "alt");
      return;
    }

    if (e.shiftKey) {
      // Shift：同轨按时间连选
      rangeSelect(c);
      S.sel = c.id;
      drawInspector(); draw();
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      // Ctrl/⌘：加选 / 减选
      toggleMulti(c.id);
      return;
    }
    /* 点选规则：
       · 点在**不在集合里**的片段上 → 集合收成它一个（不然 Ctrl+C 会复制到上一次多选的旧片段）
       · 点在本就在集合里的片段上 → **先保留整组**（这样按住就能整组拖），
         松手时如果没拖动，再收成单选（见 endDrag 里的 wasMultiSel）。 */
    if (!inMulti(c.id) || S.multi.size === 0) {
      S.multi.clear();
      S.multi.add(c.id);
      updateBulkBar();
    }
    const wasMultiSel = S.multi.size > 1 && inMulti(c.id);
    S.anchor = c.id;
    S.sel = c.id;
    drawInspector();
    const zone = c.locked ? "body" : hitZone(c, x);
    /* 多选拖拽：拖其中一段时，选中的其它段一起走（保持相对时间与轨间相对位置）。
       只有「按在多选集合里的片段身上」才整组拖；点选后集合只有它自己，行为不变。 */
    /* 多选整组拖动：把选中的同伴都收进来（整组视为一个片段）。
       以前这里排除了 `locked` 的同伴 —— 而音声片段默认就是锁定的，
       于是「多选拖着走」实际只有被按住那一段会动，其余原地不动。
       拖动意味着用户明确要挪这一组，所以对锁定的同伴先解锁（服务端不接受
       修改锁定片段的 start），移动后保持解锁，用户想锁回去按 L 即可。 */
    const comps = [];
    if (!c.locked && zone === "body" && S.multi.size > 1 && inMulti(c.id)) {
      let unlocked = 0;
      S.multi.forEach((id) => {
        const z = clipById(id);
        if (!z || z.id === c.id) return;
        if (z.locked) { z.locked = false; unlocked++; }
        comps.push({ c: z, oStart: z.start, oTrack: z.track, oTi: orderedTracks().indexOf(trackOfClip(z)) });
      });
      if (unlocked) toast(`已解开 ${unlocked} 段的锁定，随整组一起移动（想锁回去按 L）`);
    }
    S.drag = {
      type: c.locked ? "moveLocked" : (zone === "body" ? "move" : "trim_" + zone),
      c, x0: x, y0: y, t0: tOf(x),
      oStart: c.start, oDur: c.dur, oOffset: c.offset, oSrcDur: c.src_dur,
      oTi: orderedTracks().indexOf(trackOfClip(c)),
      comps,
      wasMultiSel,
      dragMoved: false,
      moved: false,
    };
    cv.style.cursor = c.locked ? "not-allowed" : (zone === "body" ? "grabbing" : "col-resize");
    draw();
  });

  cv.addEventListener("mousemove", (e) => {
    if (!S.data) return;
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;

    if (!S.drag) {
      const ti = trackIndexAtY(y);
      const tr = ti >= 0 ? orderedTracks()[ti] : null;
      const c = tr ? clipAt(tr, x) : null;
      const overKf = c ? kfHit(c, x, y) !== null : false;
      cv.style.cursor = overKf ? "move"
        : (!c ? "default" : (c.locked ? "not-allowed"
          : (hitZone(c, x) === "body" ? "grab" : "col-resize")));
      hoverInsertPoint(x, y, ti, c);
      return;
    }
    const d = S.drag;
    if (d.type === "scrub") { seek(clamp(tOf(x), 0, S.data.duration), S.playing); return; }
    if (d.type === "marquee") {
      const mk = S.marquee;
      if (!mk) return;
      mk.x1 = x; mk.y1 = y;
      const hits = marqueeHits(mk.x0, mk.y0, mk.x1, mk.y1);
      S.multi.clear();
      (mk.add ? mk.base : []).forEach((id) => S.multi.add(id));
      hits.forEach((id) => S.multi.add(id));
      d.moved = Math.abs(x - d.x0) > 4 || Math.abs(y - d.y0) > 4;
      updateBulkBar();
      draw();
      return;
    }
    if (d.type === "kf") {
      const c = d.c, prop = d.prop;
      const pts = (c.kf && c.kf[prop]) || [];
      if (!pts[d.idx]) return;
      const ti = orderedTracks().indexOf(trackOfClip(c));
      if (ti < 0) return;
      const top = trackTop(ti) + 4, bh = TRACK_H - 8;
      const t = r3(clamp(tOf(x) - c.start, 0, c.dur));
      const v = kfV(c, prop, y, top, bh);
      const oldPt = pts[d.idx];
      pts.splice(d.idx, 1);
      let k = pts.findIndex((q) => q[0] > t);
      if (k < 0) k = pts.length;
      // 空间点：横向拖改时间、纵向拖改**距离**（方位/仰角留原值，去图形面板改）
      pts.splice(k, 0, prop === "space"
        ? [t, oldPt[SPACE_AZ] == null ? 0 : oldPt[SPACE_AZ],
           oldPt[SPACE_EL] == null ? 0 : oldPt[SPACE_EL],
           clamp(v, KF_META.space.lo, KF_META.space.hi)]
        : [t, v]);
      if (prop === "space") kfSelSet(c, k);
      d.idx = k;
      d.moved = true;
      showTip(e, c, `${KF_META[prop].label} ${KF_META[prop].fmt(v)} · ${t.toFixed(2)}s`);
      drawInspector();
      draw();
      return;
    }
    if (d.type === "moveLocked") { showTip(e, d.c, "已锁定：先在属性里解锁"); return; }

    const dt = tOf(x) - d.t0;
    const c = d.c;
    if (d.type === "move") {
      c.start = Math.max(0, snapT(d.oStart + dt));
      /* 整组一起移动：位移 = 主体实际挪了多少（含吸附/夹紧后的结果），
         再夹一次「没有任何一段被推到负时间」。 */
      if (d.comps && d.comps.length) {
        let mv = c.start - d.oStart;
        const minStart = Math.min(...d.comps.map((z) => z.oStart));
        if (minStart + mv < 0) {
          mv = -minStart;
          c.start = Math.max(0, Math.round((d.oStart + mv) * 1000) / 1000);
        }
        d.comps.forEach((z) => {
          z.c.start = Math.max(0, Math.round((z.oStart + mv) * 1000) / 1000);
        });
        d.mv = mv;
      }
      const ti = trackIndexAtY(y);
      if (ti >= 0) {
        const target = orderedTracks()[ti];
        // 类型限制：语音只能在音声轨，素材只能在素材轨
        const wantVoice = c.kind === "voice";
        const targetIsVoice = target.kind === "voice";
        if (wantVoice !== targetIsVoice) {
          showTip(e, c, wantVoice ? "语音只能放在音声轨" : "素材只能放在素材轨");
          draw();
          return;
        }
        if (target.id !== c.track) {
          // 跨轨移动
          moveClipToTrack(c, target);
          /* 多选整组换轨：同类型的同伴**全部跟到主体这条目标轨**，整组当成一个片段。
             以前是按「轨序差」各自平移，组内本来就分散在几条轨上的话，
             平移完仍然分散（哪怕旁边全是空轨，也合不到一条上）。
             类型不同的同伴（音声 vs 素材）不硬塞，留在原轨。 */
          if (d.comps && d.comps.length) {
            const wantVoice2 = target.kind === "voice";
            d.comps.forEach((z) => {
              if ((z.c.kind === "voice") !== wantVoice2) return;
              if (z.c.track === target.id) return;
              moveClipToTrack(z.c, target);
            });
          }
          drawInspector();
          d.overlapSince = null;
        } else {
          // 同轨移动：检测是否与其它片段重叠
          const overlap = target.clips.find((z) => z !== c &&
            c.start < z.start + z.dur - 0.001 && z.start < c.start + c.dur - 0.001);
          if (overlap) {
            // 方向：相对拖拽起点向下 → 建在下方，向上 → 建在上方
            d.overlapDir = (y - (d.y0 || y)) >= 0 ? 1 : -1;
            if (!d.overlapSince && !d.splitDone) {
              d.overlapSince = performance.now();
              showTip(e, c, "重叠中…保持 0.5 秒将挤到新音轨");
              // 用定时器判断「保持 0.5 秒」：静止不动也能触发
              clearTimeout(d.overlapTimer);
              d.overlapTimer = setTimeout(() => {
                if (!S.drag || S.drag !== d || d.splitDone) return;
                const cur = tracks().find((t) => t.id === c.track);
                if (!cur) return;
                const still = cur.clips.some((z) => z !== c &&
                  c.start < z.start + z.dur - 0.001 && z.start < c.start + c.dur - 0.001);
                if (!still) return;
                cur.clips = cur.clips.filter((z) => z !== c);
                moveToNewTrack(c, c.kind === "voice", d.overlapDir || 1);
                d.overlapSince = null;
                d.overlapTimer = null;
                d.splitDone = true;      // 一次拖拽只分流一次，避免连建多条轨
                d.moved = true;
              }, 520);
            }
          } else {
            d.overlapSince = null;
            if (d.overlapTimer) { clearTimeout(d.overlapTimer); d.overlapTimer = null; }
          }
        }
      }
      d.dragMoved = Math.abs(x - d.x0) > 2 || Math.abs(y - d.y0) > 2;
      d.moved = d.moved || d.dragMoved;
    } else if (d.type === "trim_right") {
      /* 右边缘：上限是「源文件还剩多少」。src_dur 是素材/音频文件的真实长度
         （后端按文件时长给，不跟着 dur 缩），所以裁完随时能拉回去。 */
      /* 变速后「轨道上的长度」= 用掉的源长度 / 速度。
         以前上限按源长度算，于是 2× 的片段还能拉回到两倍长，看起来像变速失效。 */
      const rateR = clamp(c.speed || 1, 0.25, 4);
      const maxDur = Math.max(0.1, ((d.oSrcDur || d.oDur) - d.oOffset) / rateR);
      c.dur = Math.round(clamp(d.oDur + dt, 0.1, maxDur) * 1000) / 1000;
      d.moved = true;
    } else if (d.type === "trim_left") {
      /* 左边缘：向左最多回到 offset=0（也就是「完整片段」），向右最多留 0.1s。
         再额外保证 start 不被拖成负数 —— 以前贴着头的位置往左拖会把 start
         写负，服务端落盘时又夹回 0，一刷新片段就短了一截。 */
      const rateL = clamp(c.speed || 1, 0.25, 4);
      const maxIn = Math.max(0, d.oDur - 0.1);
      // 往左最多回到 offset=0（此时时间轴上也最多再长 offset/rate 秒）
      const minDelta = -Math.min(d.oOffset / rateL, d.oStart);
      const delta = clamp(dt, minDelta, maxIn);
      c.start = Math.round((d.oStart + delta) * 1000) / 1000;
      // 时间轴长度按变速换算：源里少用 delta 秒 → 轨道上少 delta/rate 秒
      c.dur = Math.round((d.oDur - delta / rateL) * 1000) / 1000;
      c.offset = Math.round((d.oOffset + delta) * 1000) / 1000;
      if (Math.abs(delta) > 0.001) d.moved = true;
    }
    showTip(e, c);
    draw();
  });

  function showTip(e, c, extra) {
    const tip = $("tip");
    const box = $("scroll").getBoundingClientRect();
    tip.style.display = "block";
    tip.textContent = extra || `${fmt(c.start)} · ${c.dur.toFixed(2)}s`;
    tip.style.left = Math.min(box.width - 150, e.clientX - box.left + 12) + "px";
    tip.style.top = (e.clientY - box.top + 14) + "px";
  }

  function hideTip() { $("tip").style.display = "none"; }

  function endDrag() {
    const d = S.drag;
    S.drag = null;
    hideTip();
    if (d && d.overlapTimer) clearTimeout(d.overlapTimer);
    cv.style.cursor = "default";
    if (d && d.type === "marquee") {
      S.marquee = null;
      if (!d.moved) { S.multi.clear(); S.sel = null; updateBulkBar(); }
      else if (S.multi.size) {
        /* 框选不产生「被点的那一段」，但要给后续操作一个锚点：
           否则 S.sel 是空，按 L / V、看属性面板都找不到当前片段。 */
        const ids = Array.from(S.multi);
        S.sel = ids[ids.length - 1];
        S.anchor = S.sel;
      }
      updateBulkBar();
      drawInspector();
      draw();
      return;
    }
    if (d && d.type === "move" && d.wasMultiSel && !d.dragMoved) {
      // 在多选集合里点了一下，但没拖：按「只选这一段」处理（和以前的手感一致）
      S.multi.clear();
      S.multi.add(d.c.id);
      S.sel = d.c.id;
      updateBulkBar();
      drawInspector();
      draw();
      return;
    }
    if (d && d.type === "kf") {
      if (d.moved) kfCommit(d.c, d.prop, d.fresh ? "添加关键帧" : "调整关键帧");
      cv.style.cursor = "default";
      return;
    }
    if (!d || !d.moved) return;
    // 兜底：松手时若仍与同轨片段重叠，直接分流到新轨，保证不留重叠
    if (d.type === "move") {
      const c = d.c;
      const cur = tracks().find((t) => t.id === c.track);
      if (cur) {
        const still = cur.clips.some((z) => z !== c &&
          c.start < z.start + z.dur - 0.001 && z.start < c.start + c.dur - 0.001);
        if (still) {
          cur.clips = cur.clips.filter((z) => z !== c);
          moveToNewTrack(c, c.kind === "voice", d.overlapDir || 1);
        }
      }
    }
    commitClip(d.c, d.type === "move" ? "移动片段" : "裁剪片段");
    if (d.comps && d.comps.length) {
      // 整组移动：同伴的位置/轨道也要写回工程
      d.comps.forEach((z) => writeClipOverride(z.c));
      markDirty("移动片段（整组）");
    }
    extendDurationToClips();
    drawInspector();
  }
  window.addEventListener("mouseup", endDrag);

  // 插入素材悬窗：只在「素材轨 + 鼠标贴近某条标记垂直线 + 该处没有片段」时出现
  const HOVER_INS_PX = 16;   // 距标记线的最大像素距离
  let hoverHideTimer = null;
  function hideHoverIns(now) {
    const box = $("hoverIns");
    // 渐隐：先去掉 show（CSS 过渡到 opacity 0），过渡结束再 hidden
    box.classList.remove("show");
    clearTimeout(hoverHideTimer);
    if (now) { box.hidden = true; S.hoverIns = null; return; }
    hoverHideTimer = setTimeout(() => {
      if (!box.classList.contains("show")) box.hidden = true;
    }, 240);
    S.hoverIns = null;
  }
  /* 标记悬浮窗总开关（顶栏按钮）：关掉之后鼠标扫过标记不再弹窗，
     插入素材走右键菜单，适合「按着标记慢慢对齐」的时候。 */
  let HOVER_INS_ON = true;
  try { HOVER_INS_ON = localStorage.getItem("tl.hoverins") !== "0"; } catch (e) { HOVER_INS_ON = true; }

  /* 全局设置（工作台「⚙ 设置」里改的）：吸附 / 标记悬浮窗 / 混音导出默认值。
     本机手动切过开关的，以本机为准（localStorage 优先），否则用设置里的默认。 */
  let GSET = null;

  async function loadGlobalSettings() {
    try {
      const r = await fetch("/api/v1/lf/settings");
      const b = await r.json();
      GSET = (b && b.settings) || null;
    } catch (e) { GSET = null; }
  }

  function applyGlobalDefaults() {
    if (!GSET) return;
    const tl = GSET.tl || {};
    let v = null;
    try { v = localStorage.getItem("tl.snap"); } catch (e) { v = null; }
    S.snap = v == null ? !!tl.snap : v === "1";
    const bSnap = $("btnSnap");
    if (bSnap) bSnap.classList.toggle("on", S.snap);
    let h = null;
    try { h = localStorage.getItem("tl.hoverins"); } catch (e) { h = null; }
    HOVER_INS_ON = h == null ? !!tl.hoverIns : h !== "0";
    const bHov = $("btnHoverInsOn");
    if (bHov) bHov.classList.toggle("on", HOVER_INS_ON);
  }

  function hoverInsertPoint(x, y, ti, clip) {
    const box = $("hoverIns");
    if (!HOVER_INS_ON) { hideHoverIns(); return; }
    if (!S.data || ti < 0 || S.drag) { hideHoverIns(); return; }
    const tr = orderedTracks()[ti];
    if (tr.kind !== "sfx") { hideHoverIns(); return; }          // 只有素材轨
    if (clip) { hideHoverIns(); return; }                        // 该处已有片段
    // 触发范围：窗口宽度的 10%（限制在 48~260px），比原来宽松好命中
    const range = Math.max(48, Math.min(260, window.innerWidth * 0.1));
    let best = null, bestPx = range;
    for (const m of S.data.markers) {
      const px = Math.abs(xOf(m.time) - x);
      if (px < bestPx) { bestPx = px; best = m; }
    }
    if (!best) { hideHoverIns(); return; }
    // 标记位置在该轨上被片段占据 → 不显示
    const occupied = tr.clips.some((c) =>
      best.time >= c.start - 0.001 && best.time <= c.start + c.dur + 0.001);
    if (occupied) { hideHoverIns(); return; }
    S.hoverIns = { time: best.time, track: tr.id };
    clearTimeout(hoverHideTimer);
    box.hidden = false;
    box.classList.add("show");
    box.style.left = Math.round(xOf(best.time)) + "px";
    box.style.top = Math.round(trackTop(ti) + TRACK_H / 2) + "px";
    $("hoverInsT").textContent = `${best.name || "标记"} · ${fmt(best.time)}`;
  }
  // 鼠标离开画布 → 渐隐（悬窗本身不接收鼠标，不会自己抢焦点）
  cv.addEventListener("mouseleave", () => hideHoverIns());
  // 滚动时立即隐藏（画布坐标会变）
  $("scroll").addEventListener("scroll", () => hideHoverIns(true), { passive: true });

  // 悬窗是纯展示：点击画布上该标记位置即插入素材
  function tryHoverInsertClick(x, y) {
    const ti = trackIndexAtY(y);
    if (!S.data || ti < 0 || !S.hoverIns) return false;
    const tr = orderedTracks()[ti];
    if (!tr || tr.kind !== "sfx" || tr.id !== S.hoverIns.track) return false;
    const range = Math.max(48, Math.min(260, window.innerWidth * 0.1));
    if (Math.abs(xOf(S.hoverIns.time) - x) > range) return false;
    openInsertPicker(S.hoverIns.time, S.hoverIns.track, "sfx");
    hideHoverIns(true);
    return true;
  }

  $("btnHoverIns").onclick = (e) => {
    e.stopPropagation();
    const hi = S.hoverIns;
    if (!hi) return;
    openInsertPicker(hi.time, hi.track, "sfx");
    hideHoverIns(true);
  };

  /* 粘性标尺上点击 / 拖动 = 定位播放头（滚到下面也能操作） */
  if (cvRuler) {
    const seekFromRuler = (e) => {
      if (!S.data) return;
      const box = cvRuler.getBoundingClientRect();
      const x = e.clientX - box.left + S.scrollX;
      seek(clamp(x / S.pps, 0, S.data.duration), S.playing);
    };
    cvRuler.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      seekFromRuler(e);
      const move = (ev) => seekFromRuler(ev);
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
    cvRuler.addEventListener("dblclick", () => {
      // 双击标尺：整段铺满（全览）
      const btn = $("btnFit");
      if (btn) btn.click();
    });
  }

  cv.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (!S.data) return;
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const ti = trackIndexAtY(y);
    const at = clamp(tOf(x), 0, S.data.duration);
    /* 右键落在标记线上（±6px）→ 开「标记」菜单：挂音效 / 静音 / 删除…
       标记线很细，先判它再判片段，否则永远点不到 */
    const nearMark = (S.data.markers || []).find((m) => Math.abs(xOf(m.time) - x) <= 6);
    if (nearMark) { openMarkerMenu(nearMark, e.clientX, e.clientY); return; }
    const tr = ti >= 0 ? orderedTracks()[ti] : null;
    const c = tr ? clipAt(tr, x) : null;
    if (!c) {
      // 空白处（含标尺、所有轨道下方）：粘贴 / 插入素材 / 加标记 / 全轨分割
      if (!(e.shiftKey)) { S.sel = null; S.multi.clear(); updateBulkBar(); }
      drawInspector(); draw();
      openAreaMenu(at, tr, ti, e.clientX, e.clientY);
      return;
    }
    /* 右键不动已有多选：点的那段**在集合里**就保留整组（菜单里的锁定/静音/删除等
       都会作用于整组）；点在集合外面才把选择收成这一段的单选。 */
    if (!inMulti(c.id)) {
      S.multi.clear();
      S.multi.add(c.id);
      updateBulkBar();
    }
    S.sel = c.id;
    S.anchor = c.id;
    drawInspector(); draw();
    openClipMenu(c, e.clientX, e.clientY);
  });

  cv.addEventListener("dblclick", (e) => {
    const r = cv.getBoundingClientRect();
    const y = e.clientY - r.top, x = e.clientX - r.left;
    const ti = trackIndexAtY(y);
    if (ti < 0) return;
    const c = clipAt(orderedTracks()[ti], x);
    if (!c) return;
    // 双击关键帧点 = 删掉这个点（片段本身的「双击试听」不受影响）
    const idx = kfHit(c, x, y);
    if (idx !== null) {
      const pts = kfPts(c, KF.prop).slice();
      pts.splice(idx, 1);
      kfSet(c, KF.prop, pts, "删除关键帧");
      toast("已删除这个关键帧");
      return;
    }
    seek(c.start);
    play();
  });

  cv.addEventListener("wheel", (e) => {
    if (!S.data) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const r = cv.getBoundingClientRect();
      zoom(e.deltaY < 0 ? 1.25 : 0.8, tOf(e.clientX - r.left), e.clientX - r.left);
    } else {
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      S.scrollX = clamp(S.scrollX + dx, 0, maxScroll());
      draw();
    }
  }, { passive: false });

  cv.addEventListener("dragover", (e) => {
    if (!S.data) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  cv.addEventListener("drop", (e) => {
    e.preventDefault();
    const sfxMid = e.dataTransfer.getData("text/sfx");
    const matMid = e.dataTransfer.getData("text/mat");
    const refId = e.dataTransfer.getData("text/ref");
    if (!sfxMid && !matMid && !refId) return;
    const r = cv.getBoundingClientRect();
    const ti = trackIndexAtY(e.clientY - r.top);
    if (ti < 0) { toast("请放到某条音轨上", true); return; }
    const tr = orderedTracks()[ti];
    if (tr.kind !== "sfx") { toast("素材只能放到素材轨", true); return; }
    const t = snapT(tOf(e.clientX - r.left));
    if (sfxMid) { insertSfxLib(sfxMid, t, tr.id); return; }
    if (matMid) { insertMatLib(matMid, t, tr.id); return; }
    insertRefLib(refId, "", t, tr.id);
  });

  function zoom(f, atT, px) {
    const ax = px != null ? px : W / 2;
    const anchor = atT != null ? atT : tOf(ax);
    S.pps = clamp(S.pps * f, 4, 900);
    S.scrollX = clamp(anchor * S.pps - ax, 0, maxScroll());
    updateZoomTag();
    draw();
  }

  function updateZoomTag() { $("zoomTag").textContent = Math.round(S.pps) + " px/s"; }

  /* ------------------------------ 右键菜单 ------------------------------ */
  let ctxAt = 0;          // 菜单刚弹出的时间戳（同一次点击不能把它立刻关掉）

  function hideCtx() {
    const m = document.querySelector(".ctxmenu");
    if (m) m.remove();
  }
  document.addEventListener("click", (e) => {
    // 按钮点开菜单时，这个 click 会继续冒泡到 document：
    // 既排除菜单/批量条自身，也给刚弹出的菜单一个极短的免死窗口
    if (performance.now() - ctxAt < 120) return;
    if (e.target.closest(".ctxmenu") || e.target.closest(".bulkbar")) return;
    hideCtx();
  });

  /* ---------------- 跳转：切点 / 标记 / 关键帧 ---------------- */
  /* 所有「切点」= 片段起止 + 标记点（剪映里 ↑↓ 就是在这堆点上跳） */
  function cutPoints() {
    const set = new Set();
    allClips().forEach((c) => {
      set.add(Math.round(c.start * 1000) / 1000);
      set.add(Math.round((c.start + c.dur) * 1000) / 1000);
    });
    (S.data.markers || []).forEach((m) => set.add(Math.round(m.time * 1000) / 1000));
    return Array.from(set).sort((a, b) => a - b);
  }

  function jumpCut(dir) {
    const pts = cutPoints();
    const eps = 0.03;
    const t = dir > 0
      ? pts.find((x) => x > S.pos + eps)
      : pts.slice().reverse().find((x) => x < S.pos - eps);
    if (t == null) { toast(dir > 0 ? "已经是最后一个切点" : "已经是第一个切点"); return; }
    seek(t);
  }

  function jumpMarker(dir) {
    const ms = (S.data.markers || []).slice().sort((a, b) => a.time - b.time);
    if (!ms.length) { toast("还没有标记点：按 M 加一个", true); return; }
    const eps = 0.01;
    const m = dir > 0
      ? ms.find((x) => x.time > S.pos + eps)
      : ms.slice().reverse().find((x) => x.time < S.pos - eps);
    if (!m) { toast(dir > 0 ? "后面没有标记了" : "前面没有标记了"); return; }
    seek(m.time);
    toast(`标记：${m.name || "标记"} · ${fmt(m.time)}`);
  }

  function jumpKf(dir) {
    const cs = S.sel ? [clipById(S.sel)].filter(Boolean) : allClips();
    const pts = [];
    cs.forEach((c) => {
      ["gain", "pan", "space"].forEach((prop) => {
        kfPts(c, prop).forEach((q) => pts.push(c.start + q[0]));
      });
    });
    pts.sort((a, b) => a - b);
    if (!pts.length) { toast("这条片段没有关键帧", true); return; }
    const eps = 0.005;
    const t = dir > 0
      ? pts.find((x) => x > S.pos + eps)
      : pts.slice().reverse().find((x) => x < S.pos - eps);
    if (t == null) { toast(dir > 0 ? "后面没有关键帧了" : "前面没有关键帧了"); return; }
    seek(t);
  }

  /* ---------------- 标记点（M）：存在工程里，不动台本 ---------------- */
  /* 普通标记走**独立接口**（后端只动 project.marks）。
     以前加一个标记 = PATCH 整份工程 + reload：只要还有没落盘的改动（静音 / 换轨 / 音量
     在 700ms 防抖里），就可能被服务端快照盖回去 —— 用户看到的就是
     「按 M 加标注，某段音频自己解除静音了」。 */
  function addMarkAt(t, name) {
    if (!S.data) return;
    const at = Math.round(clamp(t, 0, S.data.duration) * 1000) / 1000;
    const dup = (S.data.markers || []).some((m) => m.custom && Math.abs(m.time - at) < 0.02);
    if (dup) { toast("这里已经有标记了"); return; }
    const body = JSON.stringify({ time: at, name: name || "标记" });
    fetch(`${API}/marks`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    }).then(async (r) => {
      const b = await r.json().catch(() => ({}));
      if (!r.ok) { toast(b.detail || "加标记失败", true); return; }
      const mk = (b.marks || []).find((x) => Math.abs(Number(x.time) - at) < 0.001) || {};
      S.data.markers.push({
        id: mk.id || ("mk_" + uid()), time: at, name: mk.name || "标记",
        kind: "mark", uid: "", index: 0, hold: 0, inline: false, custom: true,
      });
      S.data.markers.sort((a, b2) => a.time - b2.time);
      undoMark("添加标记点");
      drawMarkersList(); drawInspector(); draw();
      toast(`已在 ${fmt(at)} 加了标记点（Shift+M 往下跳）`);
    }).catch((e) => toast("加标记失败：" + e.message, true));
  }

  function delMark(id) {
    fetch(`${API}/marks/${id}`, { method: "DELETE" }).then(async (r) => {
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        toast(b.detail || "删标记失败", true);
        return;
      }
      S.data.markers = (S.data.markers || []).filter((m) => m.id !== id);
      MSEL.delete(id);
      undoMark("删除标记点");
      drawMarkersList(); drawInspector(); draw();
      toast("已删除标记点");
    }).catch((e) => toast("删标记失败：" + e.message, true));
  }

  /* ---------------- 空白音轨右键菜单 ---------------- */
  function openAreaMenu(at, tr, ti, cx, cy) {
    hideCtx();
    const menu = el("div", "ctxmenu");
    const add = (label, key, fn, danger, disabled) => {
      const b = el("button", "ctxitem" + (danger ? " danger" : ""));
      b.appendChild(el("span", null, label));
      if (key) b.appendChild(el("span", "k", key));
      b.disabled = !!disabled;
      if (disabled) b.style.opacity = ".45";
      b.onclick = (ev) => { ev.stopPropagation(); hideCtx(); fn(); };
      menu.appendChild(b);
      return b;
    };
    const sep = () => menu.appendChild(el("div", "ctxsep"));
    const sfxTrack = (tr && tr.kind === "sfx") ? tr.id : (sfxTracks()[0] || {}).id;
    menu.appendChild(el("div", "ctxhead", `${fmt(at)}${tr ? " · " + tr.name : ""}`));
    add("粘贴到这里", "Ctrl+V", async () => {
      if (!S.clipboard) { toast("剪贴板是空的：先 Ctrl+C 复制一段", true); return; }
      const made = await pasteClipboard(at, sfxTrack || (tracks()[0] || {}).id);
      if (!made.length) return;
      persist("插入片段").then(() => {
        setMulti(made.map((x) => x.id));
        S.sel = made[made.length - 1].id;
        drawInspector(); draw();
        toast(made.length > 1 ? `已粘贴 ${made.length} 段到 ${fmt(at)}` : `已粘贴到 ${fmt(at)}`);
      });
    }, false, !S.clipboard);
    add("粘贴属性…", "Ctrl+Shift+V",
      () => propsPasteDialog(S.sel ? [clipById(S.sel)] : []), false, !PROP_CLIP);
    add("在这里插入素材…", "", () => openInsertPicker(at, sfxTrack, "sfx"));
    add("添加标记点", "M", () => addMarkAt(at));
    sep();
    add("全轨在此处分割", "Ctrl+Shift+B", () => {
      S.pos = at; drawPlayheadDom(); draw();
      splitAllAt(at);
    });
    add("播放头移到这里", "", () => seek(at));
    if (tr) {
      add("选中这一轨的全部片段", "", () => {
        setMulti(tr.clips.map((z) => z.id));
        toast(`已选中「${tr.name}」的 ${tr.clips.length} 段`);
      }, false, !tr.clips.length);
    }
    sep();
    add("＋ 新建音声轨", "", () => addTrackOfKind("voice"));
    add("＋ 新建素材轨", "", () => addTrackOfKind("sfx"));
    add("整理重叠", "", () => fixOverlapsUI());
    add("清空空轨", "", () => cleanEmptyTracks());
    sep();
    add("⌨ 快捷键与操作说明", "?", () => openShortcuts());
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(cx, window.innerWidth - r.width - 8) + "px";
    menu.style.top = Math.min(cy, window.innerHeight - r.height - 8) + "px";
  }

  /* ---------------- 快捷键说明窗 ---------------- */
  const SHORTCUTS = [
    ["播放 / 跳转", [
      ["空格", "播放 / 暂停"],
      ["Home", "播放头回项目开头"],
      ["End", "播放头到项目末尾"],
      ["← / →", "前 / 后 1 秒（Shift 加速到 5 秒）"],
      ["↑ / ↓", "上一个 / 下一个切点（片段起止 + 标记点）"],
      ["Shift + M", "跳到下一个标记点"],
      ["Shift + Alt + M", "跳到上一个标记点"],
      ["Ctrl + ← / →", "上一个 / 下一个关键帧"],
      ["+ / -", "放大 / 缩小时间轴（Ctrl+滚轮同效）"],
    ]],
    ["剪辑", [
      ["Ctrl + B", "在播放头把选中片段一刀切开"],
      ["Ctrl + Shift + B", "全轨道在同一时间点一起切开"],
      ["V", "静音 / 取消静音（选中 1 段或多段）"],
      ["M", "在播放头加标记点（句间标签）"],
      ["L", "锁定 / 解锁选中片段（可多选；混合状态优先全部锁定）"],
      ["Ctrl + C / X / V", "复制 / 剪切 / 粘贴到播放头"],
      ["Delete", "删除选中片段（语音片段跟台本走）"],
      ["Ctrl + Z / Ctrl + Shift + Z", "撤销 / 重做"],
      ["Ctrl + A", "全选片段"],
      ["Esc", "退出插入模式 / 取消选择"],
    ]],
    ["关键帧", [
      ["Alt + K", "显示 / 隐藏关键帧曲线面板（隐藏后不能再误改）"],
      ["Alt + 点击片段", "在那个位置加一个关键帧"],
      ["拖动片段上的方块", "左右改时间、上下改距离（空间）"],
      ["双击关键帧点", "删除这个关键帧"],
      ["双击片段本体", "从头试听这一段"],
    ]],
    ["鼠标 / 视图", [
      ["拖片段中间", "移动（跨轨也行；重叠 0.5 秒会自动新建轨）"],
      ["拖片段左右边缘", "裁剪；往回收能拖回完整片段，右键可一键恢复"],
      ["空白处拖框", "框选多段"],
      ["片段右键", "锁定 / 拆分 / 复制 / 恢复完整片段…"],
      ["空白音轨右键", "粘贴、插入素材、加标记、全轨分割…"],
      ["滚轮 / Ctrl+滚轮", "横向滚动 / 缩放"],
    ]],
  ];

  function openShortcuts() {
    let m = null;
    m = modal("⌨ 快捷键与操作说明", (box) => {
      box.appendChild(el("div", "hint",
        "模仿剪映的时间轴操作：快捷键只在本页生效，选中片段后再按。"
        + "传输条右侧的「倍速」只影响试听，导出永远按原速。"));
      const wrap = el("div", "sc-wrap");
      SHORTCUTS.forEach(([group, rows]) => {
        const g = el("div", "sc-group");
        g.appendChild(el("div", "sc-title", group));
        rows.forEach(([k, d]) => {
          const r = el("div", "sc-row");
          const keys = String(k).split(" / ");
          const kb = el("span", "sc-keys");
          keys.forEach((kk, i) => {
            if (i) kb.appendChild(el("span", "sc-or", "/"));
            kb.appendChild(el("kbd", null, kk));
          });
          r.appendChild(kb);
          r.appendChild(el("span", "sc-desc", d));
          g.appendChild(r);
        });
        wrap.appendChild(g);
      });
      box.appendChild(wrap);
    }, "知道了", () => { if (m) m.mask.remove(); });
    m.box.classList.add("modal-keys");      // 快捷键表要宽一点，不然两列挤成一团
    const cancel = m.box.querySelector(".foot .btn.ghost");
    if (cancel) cancel.remove();
  }

  function openClipMenu(c, cx, cy) {
    hideCtx();
    const menu = el("div", "ctxmenu");
    const add = (label, key, fn, danger, disabled) => {
      const b = el("button", "ctxitem" + (danger ? " danger" : ""));
      b.appendChild(el("span", null, label));
      if (key) b.appendChild(el("span", "k", key));
      b.disabled = !!disabled;
      if (disabled) b.style.opacity = ".45";
      b.onclick = (ev) => { ev.stopPropagation(); hideCtx(); fn(); };
      menu.appendChild(b);
    };
    const lockSel = clipsForBatch(c);
    const allLockedNow = lockSel.length > 0 && lockSel.every((x) => x.locked);
    add(lockSel.length > 1
      ? (allLockedNow ? `解锁选中的 ${lockSel.length} 段` : `锁定选中的 ${lockSel.length} 段`)
      : (c.locked ? "解锁（可改位置时间）" : "锁定（位置时间固定）"), "", () => {
      lockSelection(c);
    });
    /* 多选时静音也作用于整批（否则「选了 5 段，右键静音只哑了 1 段」） */
    const muteSel = (S.multi.size > 1 && S.multi.has(c.id)) ? selClips() : [c];
    const allMuted = muteSel.length > 0 && muteSel.every((x) => x.mute);
    add(muteSel.length > 1
      ? (allMuted ? `取消静音（${muteSel.length} 段）` : `静音选中的 ${muteSel.length} 段`)
      : (c.mute ? "取消静音" : "静音这段"), "", () => {
      const toMute = !allMuted;
      const list = muteSel;
      list.forEach((x) => { x.mute = toMute; writeClipOverride(x); });
      drawInspector(); draw(); updateBulkBar();
      persist(toMute ? "静音片段" : "取消静音");   // 立刻落盘，别留在防抖里
    });
    if (c.kind === "voice" && c.uid) {
      add("🎛 改属性并重生成…（音色 / 情感 / 停顿）", "", () => openGenProps([c.uid], c));
      menu.appendChild(el("div", "ctxsep"));
    }
    if (c.kind === "voice") {
      const g = (c.group || "").trim() || "（未分组）";
      const same = allClips().filter((x) => x.kind === "voice"
        && (((x.group || "").trim() || "（未分组）") === g));
      if (same.length > 1) {
        add(`选中同组「${g}」（${same.length} 段）`, "", () => {
          setMulti(same.map((x) => x.id));
          toast(`已选中「${g}」的 ${same.length} 段`);
        });
      }
    }
    add("打开批量操作条（选择 / 按组 / 批量改）", "", () => {
      S.bulkOpen = true;
      updateBulkBar();
      toast("勾选方式：Ctrl 点加选、Shift 点连选、空白处拖框");
    });
    menu.appendChild(el("div", "ctxsep"));
    const nSel = S.multi.size;
    /* 音声片段：只能「复制」，没有「剪切」（剪切会把台本那一句的音频搬走，容易误会）。 */
    add(nSel > 1 ? `复制选中的 ${nSel} 段` : "复制", "Ctrl+C", () => {
      copySelection();
    }, false, !!c.from_tag);
    if (c.kind === "voice" || (S.multi.size > 1 && selClips().some((x) => x.kind === "voice"))) {
      /* 多选时（右键点在选中的片段上）一次把选中的音声片段全复制过去 */
      const vs = (S.multi.size > 1 && S.multi.has(c.id))
        ? selClips().filter((x) => x.kind === "voice")
        : [c];
      const okN = vs.filter((x) => x.uid && x.has_audio).length;
      add(vs.length > 1
        ? `⧉ 复制选中的 ${vs.length} 段到素材轨「音声副本音轨」`
        : "⧉ 复制到素材轨「音声副本音轨」", "",
      () => copyVoicesToCopyTrack(vs), false, okN === 0);
    }
    add(nSel > 1 ? `剪切选中的 ${nSel} 段` : "剪切", "Ctrl+X", () => {
      if (!copySelection(true)) return;
      S.data.project.sfx = (S.data.project.sfx || []).filter((x) => !S.multi.has(x.id));
      S.multi.clear(); S.sel = null;
      updateBulkBar();
      persist("剪切片段");
      toast("已剪切");
    }, false, c.kind === "voice" || !!c.from_tag);
    add("粘贴到播放头", "Ctrl+V", async () => {
      if (!S.clipboard) { toast("剪贴板是空的", true); return; }
      const tr = trackOfClip(c);
      const made = await pasteClipboard(S.pos, tr ? tr.id : (sfxTracks()[0] || tracks()[0]).id);
      if (!made.length) return;
      persist("插入片段").then(() => {
        setMulti(made.map((x) => x.id));
        S.sel = made[made.length - 1].id;
        drawInspector(); draw();
      });
    });
    add("复制属性（音量/声像/空间/关键帧…）", "Ctrl+Shift+C", () => copyClipProps(c));
    add("粘贴属性…（可选贴哪些）", "Ctrl+Shift+V",
      () => propsPasteDialog(S.multi.size ? selClips() : [c]), false, !PROP_CLIP);
    add("在播放头一刀切开", "Ctrl+B", () => splitClip(c), false, c.kind === "voice");
    menu.appendChild(el("div", "ctxsep"));
    const trimmed = Math.max(0, c.offset || 0) > 0.005
      || Math.abs((c.src_dur || 0) - (c.dur + (c.offset || 0))) > 0.01
      || (c.src_dur || 0) > c.dur + 0.005;
    if (trimmed) {
      add("↔ 恢复完整片段（取消裁剪）", "", () => restoreFullClip(c));
      menu.appendChild(el("div", "ctxsep"));
    }
    add("⚡ 调整速度…（输入框 / 滚动条 / 变速成固定时长）", "", () => speedDialog(c));
    add("恢复原速", "", () => {
      applySpeed(c, 1);
      toast("已恢复原速");
    });
    add("🌗 淡入 / 淡出…（按显示区段自动裁）", "", () => fadeDialog(c));
    menu.appendChild(el("div", "ctxsep"));
    const delSel = clipsForBatch(c);
    const delOk = delSel.filter((x) => x.kind === "sfx" && !x.from_tag);
    add(delSel.length > 1 ? `删除选中的 ${delSel.length} 段` : "删除这段", "Del", () => {
      if (delSel.length > 1) {
        const b = $("bkDel");
        if (b && !b.disabled) b.click();
        else toast("选中的都是语音片段，跟台本走，删句子请回台本页", true);
        return;
      }
      removeClip(c);
    }, true, delSel.length > 1 ? delOk.length === 0 : c.kind === "voice");
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(cx, window.innerWidth - r.width - 8) + "px";
    menu.style.top = Math.min(cy, window.innerHeight - r.height - 8) + "px";
  }

  /* 一次性取消裁剪：把这一段的源窗口拉回 [0, src_dur]。
     比在边缘上一点点拖稳得多（尤其左边被裁过、又挪过位置之后）。 */
  function restoreFullClip(c) {
    if (c.locked) { toast("这段已锁定：先在属性里解锁", true); return; }
    const srcDur = Math.max(c.src_dur || (c.dur + (c.offset || 0)), 0.1);
    const off = Math.max(0, c.offset || 0);
    // 左边被裁过就整体左移回到原位；已经贴着头（0s）就原地展开。
    // 效果 = 这一段完整地占满 [start, start+源长]，两头都能再拖。
    const start = Math.max(0, Math.round((c.start - off) * 1000) / 1000);
    c.start = start;
    c.dur = Math.round(srcDur * 1000) / 1000;
    c.offset = 0;
    if (c.kind === "voice") c.trim_start = 0;
    commitClip(c, "恢复完整片段");
    drawInspector(); draw();
    toast(`已恢复完整片段：${start.toFixed(2)}s 起，长 ${c.dur.toFixed(2)}s`);
  }

  /* 变速：c.dur 是「时间轴上的长度」，源里用掉的长度 = dur × speed。
     以前只改 speed 不改 dur，所以片段在轨道上的宽度一动不动，看着像没生效。
     现在保持「用到的源范围」不变，反推新的 dur = 旧 dur × 旧 speed / 新 speed。 */
  function applySpeed(c, s) {
    const oldS = clamp(Number(c.speed) || 1, 0.25, 4);
    const span = Math.max(0.05, c.dur * oldS);
    const nS = clamp(Number(s) || 1, 0.25, 4);
    c.speed = Math.round(nS * 1000) / 1000;
    const maxDur = Math.max(0.05, (c.src_dur || span) - (c.offset || 0));
    c.dur = Math.max(0.05, Math.min(maxDur, Math.round((span / nS) * 1000) / 1000));
    if (c.kind === "voice") {
      c.trim_end = Math.max(0, (c.src_dur || (c.dur + (c.offset || 0))) - (c.offset || 0) - c.dur);
    }
    commitClip(c, "变速");
    drawInspector(); draw();
    return c.dur;
  }

  /* 淡入淡出：以「片段显示的那一段」为基准（c.dur），
     并且淡入 + 淡出 不会超过片段长度，改时长/裁剪后会自己夹回来。 */
  function setFade(c, fi, fo) {
    const d = Math.max(0.05, c.dur);
    let a = clamp(Number(fi) || 0, 0, d);
    let b = clamp(Number(fo) || 0, 0, d);
    if (a + b > d) {
      const k = d / (a + b);
      a = Math.floor(a * k * 1000) / 1000;
      b = Math.floor(b * k * 1000) / 1000;
    }
    c.fade_in = a;
    c.fade_out = b;
  }

  function fadeDialog(c) {
    const fadeList = clipsForBatch(c);   // 多选时整批套同样的淡入淡出
    if (c.locked) { toast("这段已锁定：先在属性里解锁", true); return; }
    modal("淡入 / 淡出", (box) => {
      box.appendChild(el("div", "phint",
        `淡入淡出按片段**显示的那一段**算（当前 ${c.dur.toFixed(2)}s），`
        + "素材被裁掉/拖短之后会自动夹回范围内，不会溢出到片段外面。"));
      const mkRow = (label, val, setter) => {
        const f = el("div", "field");
        f.appendChild(fieldLabel(label, "秒"));
        const rng = document.createElement("input");
        rng.type = "range"; rng.min = "0"; rng.max = c.dur.toFixed(2); rng.step = "0.01";
        rng.value = String(val); rng.className = "grow";
        const num = document.createElement("input");
        num.type = "number"; num.min = "0"; num.max = c.dur.toFixed(2); num.step = "0.01";
        num.value = Number(val).toFixed(2); num.className = "inp tiny";
        rng.oninput = () => { num.value = Number(rng.value).toFixed(2); setter(Number(rng.value)); };
        num.onchange = () => { rng.value = num.value; setter(Number(num.value) || 0); };
        const row = el("div", "row2");
        row.appendChild(rng); row.appendChild(num);
        f.appendChild(row);
        box.appendChild(f);
        return { rng, num };
      };
      const bar = el("div", "row2");
      ["0", "0.2", "0.5", "1", "2"].forEach((v) => {
        const b = el("button", "btn mini ghost", v + "s");
        b.onclick = () => {
          setFade(c, v === "0" ? 0 : Number(v), c.fade_out);
          commitClip(c, "修改属性"); drawInspector(); draw();
          rIn.rng.value = c.fade_in; rIn.num.value = c.fade_in.toFixed(2);
        };
        bar.appendChild(b);
      });
      box.appendChild(el("div", "phint", "淡入快捷："));
      box.appendChild(bar);
      const rIn = mkRow("淡入", c.fade_in || 0, (v) => { setFade(c, v, c.fade_out); });
      const rOut = mkRow("淡出", c.fade_out || 0, (v) => { setFade(c, c.fade_in, v); });
      const sym = el("button", "btn mini", "两头一样长（取当前淡入）");
      sym.onclick = () => {
        setFade(c, c.fade_in, c.fade_in);
        rOut.rng.value = c.fade_out; rOut.num.value = c.fade_out.toFixed(2);
      };
      box.appendChild(sym);
      box.__apply = () => {
        const fin = Number(rIn.num.value) || 0;
        const fout = Number(rOut.num.value) || 0;
        fadeList.forEach((x) => setFade(x, fin, fout));
      };
    }, "应用", (box) => {
      box.__apply();
      fadeList.forEach((x) => commitClip(x, "修改淡入淡出"));
      drawInspector(); draw();
      box.closest(".mask")?.remove();
      return true;
    });
  }
  function speedDialog(c) {
    const spdList = clipsForBatch(c);    // 多选时整批按同一速度
    if (c.locked) { toast("这段已锁定：先在属性里解锁", true); return; }
    const oldS = clamp(Number(c.speed) || 1, 0.25, 4);
    const span = Math.max(0.05, c.dur * oldS);
    const maxDur = Math.max(0.05, (c.src_dur || span) - (c.offset || 0));
    modal("调整速度", (box) => {
      box.appendChild(el("div", "phint",
        `当前 ×${oldS.toFixed(2)}，占用时长 ${c.dur.toFixed(2)}s（源里用了 ${span.toFixed(2)}s）。`
        + "改速度会按同样的源范围重算轨道上的长度：变快 → 片段变短，变慢 → 变长。"));

      const spdRow = el("div", "field");
      spdRow.appendChild(fieldLabel("速度", "×0.25 ~ ×4"));
      const rng = document.createElement("input");
      rng.type = "range"; rng.min = "0.25"; rng.max = "4"; rng.step = "0.01";
      rng.value = String(oldS); rng.className = "grow";
      const num = document.createElement("input");
      num.type = "number"; num.min = "0.25"; num.max = "4"; num.step = "0.01";
      num.value = oldS.toFixed(2); num.className = "inp tiny";
      const durOut = el("span", "mono", "");
      const syncFromSpeed = (v) => {
        const s = clamp(Number(v) || 1, 0.25, 4);
        rng.value = String(s); num.value = s.toFixed(2);
        durOut.textContent = "→ " + (span / s).toFixed(2) + "s";
      };
      rng.oninput = () => syncFromSpeed(rng.value);
      num.onchange = () => syncFromSpeed(num.value);
      const row1 = el("div", "row2");
      row1.appendChild(rng); row1.appendChild(num); row1.appendChild(durOut);
      spdRow.appendChild(row1);
      box.appendChild(spdRow);

      /* 反着来：给定目标时长，自动算速度 */
      const durRow = el("div", "field");
      durRow.appendChild(fieldLabel("变速成固定时长", "填时长，自动算速度"));
      const target = document.createElement("input");
      target.type = "number"; target.min = "0.1"; target.max = "600"; target.step = "0.1";
      target.value = c.dur.toFixed(2); target.className = "inp";
      const mk = el("button", "btn mini", "按这个时长算速度");
      mk.onclick = () => {
        const T = clamp(Number(target.value) || 0, 0.1, 3600);
        if (T <= 0) { toast("时长不对", true); return; }
        syncFromSpeed(span / T);
        toast(`目标 ${T.toFixed(2)}s → 速度 ×${(span / T).toFixed(2)}`);
      };
      const row2 = el("div", "row2");
      row2.appendChild(target);
      row2.appendChild(el("span", "hint", "秒"));
      row2.appendChild(mk);
      durRow.appendChild(row2);
      box.appendChild(durRow);
      box.appendChild(el("div", "phint",
        "速度只改变播放快慢（音高会跟着变），不改变源文件。想恢复原样把速度调回 1.00 即可。"));
      box.__getSpeed = () => clamp(Number(num.value) || 1, 0.25, 4);
      syncFromSpeed(oldS);
    }, "应用", (box) => {
      const sp = box.__getSpeed();
      spdList.forEach((x) => applySpeed(x, sp));
      box.closest(".mask")?.remove();
      return true;
    });
  }

  /* 真正「一刀切开」：两段各自拥有自己的 offset，关键帧在切点插值补点，
     所以切完曲线是连续的（不会「啪」地跳一下）。 */
  function splitClipCore(c, t) {
    if (c.kind === "voice" || c.from_tag) return null;
    const left = t - c.start;
    if (left < 0.05 || c.dur - left < 0.05) return null;
    const right = c.dur - left;
    const item = (S.data.project.sfx || []).find((s) => s.id === c.id);
    if (!item) return null;
    item.dur = left;
    const clone = { ...item, id: uid(), start: t, dur: right,
      offset: item.offset + left * (item.speed || 1) };
    S.data.project.sfx = S.data.project.sfx.concat([clone]);
    // 关键帧跟着切：切点补一个点，两段各自连续（否则切开后曲线会跳变）
    const kf0 = c.kf && Object.keys(c.kf).length ? JSON.parse(JSON.stringify(c.kf)) : null;
    if (kf0) {
      const Lp = {}, Rp = {};
      ["gain", "pan"].forEach((prop) => {
        const pts = kf0[prop] || [];
        if (!pts.length) return;
        const mid = r3(kfAt(pts, left, kfStatic(c, prop)));
        Lp[prop] = pts.filter((q) => q[0] < left - 1e-6).concat([[r3(left), mid]]);
        Rp[prop] = [[0, mid]].concat(pts.filter((q) => q[0] > left + 1e-6)
          .map((q) => [r3(q[0] - left), q[1]]));
      });
      // 空间关键帧是四点组，单独切：切点处插值出一个完整位置
      const sp = kf0.space || [];
      if (sp.length) {
        const at = kfSpaceAt(c, left);
        const mid = [r3(left), r3(at.az), r3(at.el), r3(at.dist)];
        const L = sp.filter((q) => q[0] < left - 1e-6)
          .concat([[...mid]]);
        const R = [[0, mid[1], mid[2], mid[3]]].concat(
          sp.filter((q) => q[0] > left + 1e-6)
            .map((q) => [r3(q[0] - left), q[1], q[2], q[3]]));
        Lp.space = L; Rp.space = R;
      }
      if (kf0.shape) { Lp.shape = kf0.shape; Rp.shape = kf0.shape; }
      S.data.project.kf = S.data.project.kf || {};
      if (Object.keys(Lp).length) S.data.project.kf[c.id] = Lp;
      if (Object.keys(Rp).length) S.data.project.kf[clone.id] = Rp;
    }
    return clone;
  }

  function splitClip(c) {
    if (c.kind === "voice") {
      toast("语音片段跟随台本：要拆分请回台本页把这一句拆成两句", true);
      return;
    }
    if (c.from_tag) { toast("标签音效不能拆分：位置由标签决定", true); return; }
    undoMark("拆分片段");
    const clone = splitClipCore(c, S.pos);
    if (!clone) { toast("播放头要落在这段里面", true); return; }
    persist("拆分片段").then(() => { S.sel = clone.id; drawInspector(); draw(); });
    toast("已在播放头拆成两段");
  }

  /* 全轨道批量分割：所有轨道在同一个时间点一起切开（Ctrl+Shift+B） */
  function splitAllAt(t) {
    const todo = allClips().filter((c) => c.kind === "sfx" && !c.from_tag
      && t > c.start + 0.05 && t < c.start + c.dur - 0.05);
    if (!todo.length) {
      toast("这个时间点没有可切的素材片段（语音片段请回台本页拆句）", true);
      return;
    }
    undoMark("全轨拆分");
    let n = 0;
    todo.forEach((c) => { if (splitClipCore(c, t)) n += 1; });
    persist("全轨拆分").then(() => { drawInspector(); draw(); });
    toast(`已在 ${fmt(t)} 把 ${n} 段一起切成两半`);
  }

  /* ------------------------------ 属性面板 ------------------------------ */
  let lastInspSel = null, inspScrollBusy = false;

  // 选中片段后把「片段属性」整块滚进视野（它现在在最上面，但右栏本身可滚动）
  function revealInspector() {
    const side = $("tlSide"), sec = $("secInspector");
    if (!side || !sec || inspScrollBusy) return;
    if (sec.classList.contains("collapsed")) sec.classList.remove("collapsed");
    const sr = side.getBoundingClientRect(), r = sec.getBoundingClientRect();
    if (r.top < sr.top - 1 || r.bottom > sr.bottom + 1) {
      inspScrollBusy = true;
      sec.scrollIntoView({ block: "start", behavior: "smooth" });
      setTimeout(() => { inspScrollBusy = false; }, 320);
    }
  }

  /* ==================== 空间音频 / 混响：方案、标尺、图形摆位 ====================
     菜单逻辑只有三层，避免以前那种「一屏十几个控件」：
       ① 开关：空间音频 开/关（关着就只剩一行提示，不占地方）
       ② 方案：一组预设（ASMR / 床边耳语 / 近讲 / 室内 / 影院 / 大厅 / 户外 / 走廊）
                —— 每个方案自带 HRIR 数据集、混响房间、干湿比、默认距离，
                并且决定下面那张图的**标尺**（范围大小 + 对数/线性比例）
       ③ 摆位：罗盘（俯视）或三视图（X/Y/Z 两根轴一拖），改的是「当前选中的插入点」
     预设只是「一次把几个参数摆好」，改完照样可以单项微调（会变成「自定义」）。
   ============================================================== */

  const SPACE_PRESETS = [
    { id: "asmr", icon: "🎧", name: "贴耳 ASMR",
      desc: "嘴贴耳朵：25cm 实测 HRIR、录音棚混响 6%、音量 70%。标尺放大到 0.12–0.8m",
      hrtf: "KU100_near_circ", room: "booth", send: 0.06, gain: 0.7,
      az: 72, el: -4, dist: 0.28, view: "top",
      pad: { min: 0.12, max: 0.8, log: true } },
    { id: "bed", icon: "🛏", name: "床边耳语",
      desc: "侧后方 30cm、略微向下：像躺着有人在你耳边说话。标尺 0.12–0.6m",
      hrtf: "KU100_near_circ", room: "booth", send: 0.04, gain: 0.75,
      az: 118, el: -16, dist: 0.32, view: "top",
      pad: { min: 0.12, max: 0.6, log: true } },
    { id: "close", icon: "🎙", name: "近讲旁白",
      desc: "45cm 正前，干净的小房间：播客/口播的默认摆法。标尺 0.15–1.5m",
      hrtf: "KU100_near_circ", room: "booth", send: 0.12, gain: 0.9,
      az: 0, el: 0, dist: 0.45, view: "top",
      pad: { min: 0.15, max: 1.5, log: true } },
    { id: "room", icon: "🛋", name: "室内对话",
      desc: "1.2m、客厅混响 22%：两个人在屋里说话的距离感。标尺 0.4–4m",
      hrtf: "", room: "living", send: 0.22, gain: 1.0,
      az: 24, el: 0, dist: 1.2, view: "top",
      pad: { min: 0.4, max: 4, log: true } },
    { id: "cinema", icon: "🎬", name: "影院环绕",
      desc: "2.5m、大厅混响 35%、略高：环绕声的「包住你」。标尺 0.5–10m",
      hrtf: "", room: "hall", send: 0.35, gain: 1.0,
      az: 110, el: 14, dist: 2.5, view: "tri",
      pad: { min: 0.5, max: 10, log: true } },
    { id: "hall", icon: "🏛", name: "大厅回声",
      desc: "4m、RT60 1.9s、湿声 45%：教堂/礼堂那种尾巴。标尺 0.5–15m",
      hrtf: "", room: "hall", send: 0.45, gain: 1.0,
      az: 0, el: 8, dist: 4, view: "tri",
      pad: { min: 0.5, max: 15, log: true } },
    { id: "outdoor", icon: "🌳", name: "户外开阔",
      desc: "8m、只有空气衰减：远处飘来的声音。标尺 1–20m（线性刻度，看得清远近）",
      hrtf: "", room: "outdoor", send: 0.06, gain: 1.0,
      az: -40, el: 2, dist: 8, view: "tri",
      pad: { min: 1, max: 20, log: false } },
    { id: "corridor", icon: "🚶", name: "走廊经过",
      desc: "背后 2m、走廊混响 20%：有人从身后走过。标尺 0.5–10m",
      hrtf: "", room: "corridor", send: 0.2, gain: 1.0,
      az: 165, el: 0, dist: 2, view: "top",
      pad: { min: 0.5, max: 10, log: true } },
    { id: "custom", icon: "🎛", name: "自定义",
      desc: "不改任何参数，只按当前值摆位；标尺固定 0.2–10m",
      hrtf: null, room: null, send: null, gain: null,
      az: null, el: null, dist: null, view: null,
      pad: { min: 0.2, max: 10, log: true } },
  ];
  const presetOf = (id) => SPACE_PRESETS.find((p) => p.id === id) || null;
  function curPad(c) {
    const p = presetOf(c && c.sp_preset);
    return (p && p.pad) || { min: 0.2, max: 10, log: true };
  }

  /* 位置 → 直角坐标（x 右 / y 上 / z 前）。俯视、正视、侧视三个视图都用它。 */
  function posXYZ(p) {
    const a = Number(p.az || 0) * Math.PI / 180;
    const e = Number(p.el || 0) * Math.PI / 180;
    const d = clamp(Number(p.dist) || 1, 0.05, 40);
    return { x: d * Math.cos(e) * Math.sin(a),
             y: d * Math.sin(e),
             z: d * Math.cos(e) * Math.cos(a) };
  }
  function xyzPos(x, y, z) {
    const d = clamp(Math.hypot(x, y, z), 0.2, 10);
    const el = Math.asin(clamp(y / Math.max(1e-6, d), -1, 1)) * 180 / Math.PI;
    const az = Math.atan2(x, z) * 180 / Math.PI;
    return { az, el, dist: d };
  }

  /* 标尺：距离 ↔ 半径像素比。对数刻度让贴耳区间（0.2~1m）也占得开。 */
  function dist2r(d, g, R) {
    const u = g.log
      ? Math.log(clamp(d, g.min, g.max) / g.min) / Math.log(g.max / g.min)
      : (clamp(d, g.min, g.max) - g.min) / (g.max - g.min);
    return u * R;
  }
  function r2dist(px, g, R) {
    const u = clamp(px / Math.max(1, R), 0, 1);
    return g.log ? g.min * Math.pow(g.max / g.min, u) : g.min + u * (g.max - g.min);
  }

  /* 一次性把预设摆上去（只改它自己声明的字段，其余保留） */
  function applySpacePreset(c, id, silent) {
    const p = presetOf(id);
    if (!p) return;
    c.sp_preset = id;
    if (!c.binaural) c.binaural = true;
    if (p.hrtf != null) c.hrtf = p.hrtf;
    if (p.room != null) c.room = p.room;
    if (p.send != null) c.send = p.send;
    if (p.gain != null) c.gain = p.gain;
    if (p.az != null) c.az = p.az;
    if (p.el != null) c.el = p.el;
    if (p.dist != null) c.dist = p.dist;
    /* 方案不再强行切平面：你现在在看哪个平面就留在哪个（俯视看距离、侧视看高度），
       免得选一个方案把视图抢走。 */
    commitClip(c, `空间方案：${p.name}`);
    drawInspector();
    draw();
    if (!silent) {
      toast(`${p.icon} ${p.name}：${p.dist ? p.dist + "m · " : ""}`
        + `${p.room ? "混响 " + (ROOMS.find((r) => r.id === p.room) || {}).name : "干声"}`
        + (p.send != null ? ` · 干湿 ${Math.round(p.send * 100)}%` : ""));
    }
  }

  /* ---------------- 摆位：一张网格 + 三个平面（照 dearVR POSITION 的思路） ----------------
     · X/Z 俯视：横 X、纵 Z（上 = 正前），叠上距离环 + 方位刻度（原来的罗盘）
     · Y/Z 侧视：横 Z（右 = 正前）、纵 Y（高）
     · X/Y 正视：横 X、纵 Y
     听者人头按平面分别画（俯视 / 侧面 / 正面），声源是「圈 + 中心点」，
     离得远时用一条虚线连到人头，一眼看出在哪一侧、多高、多远。 */
  const SP_PLANES = [
    { id: "xz", name: "X/Z", label: "俯视", hint: "横 X（右）· 纵 Z（前）" },
    { id: "yz", name: "Y/Z", label: "侧视", hint: "横 Z（前）· 纵 Y（高）" },
    { id: "xy", name: "X/Y", label: "正视", hint: "横 X（右）· 纵 Y（高）" },
  ];
  const spPlane = () => (SP_PLANES.some((p) => p.id === KF.view) ? KF.view : "xz");
  const spColor = (name, fb) => {
    try {
      const v = getComputedStyle(document.body).getPropertyValue(name).trim();
      return v || fb;
    } catch (e) { return fb; }
  };

  /* ---- 人头线稿（三个平面各一版，照着 dearVR 的样式：细线 + 头梁 + 耳罩） ---- */
  function spHead(g2, plane, cx, cy, s, col) {
    g2.save();
    g2.strokeStyle = col;
    g2.lineWidth = 1.35;
    g2.lineJoin = "round";
    g2.lineCap = "round";
    const padRect = (x, y, w, h, r) => {
      g2.beginPath();
      g2.moveTo(x + r, y);
      g2.arcTo(x + w, y, x + w, y + h, r);
      g2.arcTo(x + w, y + h, x, y + h, r);
      g2.arcTo(x, y + h, x, y, r);
      g2.arcTo(x, y, x + w, y, r);
      g2.closePath();
      g2.stroke();
    };
    if (plane === "xz") {
      /* 俯视（dearVR 的 X/Z）：椭圆头顶 + 朝前的鼻子小凸起 + 横跨的耳罩带 + 两侧耳杯 */
      g2.beginPath();
      g2.ellipse(cx, cy + s * 0.08, s * 0.94, s * 0.98, 0, 0, Math.PI * 2);
      g2.stroke();
      g2.beginPath();                                   // 鼻子（正前 = 屏幕上方）
      g2.moveTo(cx - s * 0.13, cy - s * 0.86);
      g2.quadraticCurveTo(cx - s * 0.15, cy - s * 1.2, cx, cy - s * 1.2);
      g2.quadraticCurveTo(cx + s * 0.15, cy - s * 1.2, cx + s * 0.13, cy - s * 0.86);
      g2.stroke();
      g2.beginPath();                                   // 头梁（横跨头顶的一条带子）
      padRect(cx - s * 1.16, cy - s * 0.02, s * 2.32, s * 0.36, s * 0.18);
      padRect(cx - s * 1.42, cy - s * 0.08, s * 0.28, s * 0.48, s * 0.12);
      padRect(cx + s * 1.14, cy - s * 0.08, s * 0.28, s * 0.48, s * 0.12);
    } else if (plane === "yz") {
      /* 侧视（dearVR 的 Y/Z）：脸朝右（正前）+ 耳杯圆 + 头梁弧 + 头顶竖带 */
      g2.beginPath();
      g2.moveTo(cx - s * 0.46, cy - s * 0.78);
      g2.bezierCurveTo(cx - s * 0.06, cy - s * 0.94, cx + s * 0.3, cy - s * 0.82,
        cx + s * 0.46, cy - s * 0.44);                    // 额头
      g2.bezierCurveTo(cx + s * 0.58, cy - s * 0.22, cx + s * 0.62, cy - s * 0.08,
        cx + s * 0.76, cy - s * 0.02);                    // 鼻梁 → 鼻尖
      g2.lineTo(cx + s * 0.6, cy + s * 0.08);             // 鼻底
      g2.lineTo(cx + s * 0.66, cy + s * 0.2);             // 上唇
      g2.bezierCurveTo(cx + s * 0.6, cy + s * 0.44, cx + s * 0.44, cy + s * 0.56,
        cx + s * 0.3, cy + s * 0.66);                     // 下巴
      g2.bezierCurveTo(cx + s * 0.04, cy + s * 0.8, cx - s * 0.3, cy + s * 0.72,
        cx - s * 0.44, cy + s * 0.4);                     // 下颌 → 后颈
      g2.bezierCurveTo(cx - s * 0.66, cy + s * 0.06, cx - s * 0.64, cy - s * 0.52,
        cx - s * 0.46, cy - s * 0.78);                    // 后脑
      g2.closePath();
      g2.stroke();
      g2.beginPath();                                    // 耳杯
      g2.arc(cx - s * 0.02, cy + s * 0.02, s * 0.3, 0, Math.PI * 2);
      g2.stroke();
      g2.beginPath();                                    // 头梁：从耳杯上沿绕到额头（只画上半圈）
      g2.arc(cx - s * 0.02, cy + s * 0.02, s * 0.62, Math.PI * 1.2, Math.PI * 1.86);
      g2.stroke();
      padRect(cx - s * 0.2, cy - s * 1.22, s * 0.26, s * 0.46, s * 0.1);
    } else {
      /* 正视（dearVR 的 X/Y）：正面头型 + 头梁弧 + 两侧耳杯 + 脖子 */
      g2.beginPath();
      g2.moveTo(cx - s * 0.5, cy + s * 0.78);
      g2.bezierCurveTo(cx - s * 0.86, cy + s * 0.28, cx - s * 0.86, cy - s * 0.5,
        cx - s * 0.44, cy - s * 0.86);
      g2.bezierCurveTo(cx - s * 0.18, cy - s * 1.06, cx + s * 0.18, cy - s * 1.06,
        cx + s * 0.44, cy - s * 0.86);
      g2.bezierCurveTo(cx + s * 0.86, cy - s * 0.5, cx + s * 0.86, cy + s * 0.28,
        cx + s * 0.5, cy + s * 0.78);
      g2.bezierCurveTo(cx + s * 0.34, cy + s * 0.9, cx - s * 0.34, cy + s * 0.9,
        cx - s * 0.5, cy + s * 0.78);
      g2.closePath();
      g2.stroke();
      g2.beginPath();
      g2.arc(cx, cy - s * 0.12, s * 1.14, Math.PI * 1.1, Math.PI * 1.9);
      g2.stroke();
      padRect(cx - s * 1.28, cy - s * 0.3, s * 0.4, s * 0.72, s * 0.16);
      padRect(cx + s * 0.88, cy - s * 0.3, s * 0.4, s * 0.72, s * 0.16);
      g2.beginPath();                                    // 脖子
      g2.moveTo(cx - s * 0.36, cy + s * 0.84);
      g2.lineTo(cx + s * 0.36, cy + s * 0.84);
      g2.lineTo(cx + s * 0.3, cy + s * 1.24);
      g2.lineTo(cx - s * 0.3, cy + s * 1.24);
      g2.closePath();
      g2.stroke();
    }
    g2.restore();
  }

  function buildSpacePad(c) {
    const g = curPad(c);
    const wrap = el("div", "sp-pad-wrap");

    /* 平面切换（原来的「罗盘 / 三视图」合成一个） */
    const tabs = el("div", "sp-plane");
    SP_PLANES.forEach((p) => {
      const b = el("button", "sp-planeb" + (spPlane() === p.id ? " on" : ""), p.name);
      b.type = "button";
      const bi = document.createElement("i");
      bi.textContent = p.label;
      b.appendChild(bi);
      b.title = `${p.label}：${p.hint}`;
      b.onclick = () => {
        KF.view = p.id;
        try { localStorage.setItem("tl.spview", p.id); } catch (e) { /* 忽略 */ }
        drawInspector();
      };
      tabs.appendChild(b);
    });
    tabs.appendChild(el("span", "sp-planeb-hint", (SP_PLANES.find((p) => p.id === spPlane()) || {}).hint || ""));
    wrap.appendChild(tabs);

    /* 方位滑杆（横，最上）+ 高度滑杆（竖，左侧）：dearVR 的 AZIMUTH / ELEVATION */
    const azRow = el("div", "sp-azrow");
    azRow.appendChild(el("span", "sp-axl", "方位"));
    const azr = document.createElement("input");
    azr.type = "range"; azr.min = "-180"; azr.max = "180"; azr.step = "1";
    azr.className = "sp-azrange";
    const azv = el("b", "sp-azval", "0°");
    azRow.appendChild(azr);
    azRow.appendChild(azv);
    wrap.appendChild(azRow);

    const flexy = el("div", "sp-pad-flex");
    const elCol = el("div", "sp-elcol");
    elCol.appendChild(el("span", "sp-el-lab", "高度"));
    const elWrap = el("div", "sp-elwrap");
    const er = document.createElement("input");
    er.type = "range"; er.min = "-90"; er.max = "90"; er.step = "1";
    er.className = "sp-el-range";
    er.title = "高度（仰角）：+ 在上方，− 在下方，0 = 与耳同高";
    elWrap.appendChild(er);
    elCol.appendChild(elWrap);
    const ev = document.createElement("input");
    ev.type = "number"; ev.className = "inp tiny sp-el-num";
    ev.min = "-90"; ev.max = "90"; ev.step = "1";
    const numRow = el("div", "sp-el-numrow");
    numRow.appendChild(ev);
    numRow.appendChild(el("span", "sp-el-unit", "°"));
    elCol.appendChild(numRow);
    flexy.appendChild(elCol);

    const pad = el("div", "spad2");
    const cv2 = document.createElement("canvas");
    cv2.className = "spad2-cv";
    pad.appendChild(cv2);
    flexy.appendChild(pad);
    wrap.appendChild(flexy);

    // 距离刻度数字（俯视时显示，和原来的罗盘一致）
    const tickEls = [];
    for (let i = 1; i <= 3; i++) {
      const dl = el("b", "spad2-tick", "");
      pad.appendChild(dl);
      tickEls.push({ el: dl, f: i / 3 });
    }
    const dot = el("i", "spad2-dot");
    pad.appendChild(dot);
    pad.appendChild(el("i", "spad2-rec"));

    const read = el("div", "sp-read");
    wrap.appendChild(read);
    const xyzRow = el("div", "sp-xyzline");
    wrap.appendChild(xyzRow);

    const quick = el("div", "sp-quick");
    [["前", 0], ["右", 90], ["后", 180], ["左", -90]].forEach(([n, v]) => {
      const b = el("button", "sp-qb", n);
      b.type = "button";
      b.title = `方位 ${v}°（距离不变）`;
      b.onclick = () => {
        posSet(c, { az: v });
        posCommit(c, "空间方位");
        drawInspector(); draw();
      };
      quick.appendChild(b);
    });
    const bNear = el("button", "sp-qb", "贴耳");
    bNear.type = "button";
    bNear.title = "距离直接拉到 0.3m（方位不变）";
    bNear.onclick = () => {
      posSet(c, { dist: 0.3 });
      posCommit(c, "空间距离");
      drawInspector(); draw();
    };
    quick.appendChild(bNear);
    wrap.appendChild(quick);

    const paint = () => {
      const rect = pad.getBoundingClientRect();
      const W2 = Math.max(40, Math.round(rect.width));
      const H2 = Math.max(40, Math.round(rect.height));
      const dpr = window.devicePixelRatio || 1;
      if (cv2.width !== Math.round(W2 * dpr) || cv2.height !== Math.round(H2 * dpr)) {
        cv2.width = Math.round(W2 * dpr);
        cv2.height = Math.round(H2 * dpr);
      }
      cv2.style.width = W2 + "px";
      cv2.style.height = H2 + "px";
      const g2 = cv2.getContext("2d");
      g2.setTransform(dpr, 0, 0, dpr, 0, 0);
      g2.clearRect(0, 0, W2, H2);

      const plane = spPlane();
      const cx = W2 / 2, cy = H2 / 2;
      const R = Math.min(W2, H2) / 2 - 14;          // 半宽（= 标尺上限，米）
      const ext = Math.max(0.2, g.max);             // 视野半径（米）
      const col = spColor("--border-2", "rgba(120,120,120,.5)");
      const faint = spColor("--faint", "rgba(120,120,120,.45)");
      const grid = spColor("--border", "rgba(120,120,120,.25)");

      // 网格：等距细线 + 边框（俯视时同心环更有用，所以两者叠加）
      const stepM = (() => {
        const raw = (ext * 2) / 8;                  // 目标 8 格
        const pow = Math.pow(10, Math.floor(Math.log10(raw)));
        const m = raw / pow;
        return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * pow;
      })();
      g2.save();
      g2.strokeStyle = grid;
      g2.lineWidth = 1;
      const toPx = (u, v) => ({ x: cx + (u / ext) * R, y: cy - (v / ext) * R });
      g2.beginPath();
      for (let t = -Math.floor(ext / stepM) * stepM; t <= ext + 1e-6; t += stepM) {
        const a = toPx(t, -ext), b = toPx(t, ext);
        g2.moveTo(a.x, a.y); g2.lineTo(b.x, b.y);
        const c1 = toPx(-ext, t), c2 = toPx(ext, t);
        g2.moveTo(c1.x, c1.y); g2.lineTo(c2.x, c2.y);
      }
      g2.stroke();
      // 轴（0 线加重）
      g2.strokeStyle = col;
      g2.beginPath();
      g2.moveTo(cx, cy - R); g2.lineTo(cx, cy + R);
      g2.moveTo(cx - R, cy); g2.lineTo(cx + R, cy);
      g2.stroke();

      // 俯视再叠距离环 + 前后左右 + 刻度（原来的罗盘）
      if (plane === "xz") {
        for (let i = 1; i <= 3; i++) {
          const f = i / 3;
          g2.beginPath();
          g2.arc(cx, cy, R * f, 0, Math.PI * 2);
          g2.globalAlpha = i === 3 ? 0.6 : 0.42;
          g2.strokeStyle = col;
          g2.setLineDash(i === 3 ? [] : [3, 5]);
          g2.stroke();
        }
        g2.setLineDash([]);
        g2.globalAlpha = 1;
      }
      g2.restore();

      // 听者人头
      spHead(g2, plane, cx, cy,
        Math.max(10, Math.min(22, R * 0.185)) * (plane === "yz" ? 1.08 : 1),
        spColor("--muted", "rgba(110,106,98,.9)"));

      const cur = posNow(c);
      const P = posXYZ(cur);
      const u = plane === "xz" ? P.x : plane === "yz" ? P.z : P.x;
      const v = plane === "xz" ? P.z : P.y;
      const px = cx + (u / ext) * R;
      const py = cy - (v / ext) * R;

      // 连线（虚线）+ 声源标记（圈 + 点）
      g2.save();
      g2.setLineDash([3, 4]);
      g2.strokeStyle = spColor("--primary", "rgba(210,55,46,.8)");
      g2.globalAlpha = 0.55;
      g2.beginPath(); g2.moveTo(cx, cy); g2.lineTo(px, py); g2.stroke();
      g2.restore();
      /* 超出视野时，沿「中心 → 声源」的方向贴到边框上（不是简单夹到角上，
         否则方向会被拉歪，看着像在角落）。同时保留 far 样式做提示。 */
      let px2 = px, py2 = py;
      const vx = px - cx, vy = py - cy;
      const limX = W2 - 9 - Math.abs(cx - W2 / 2);   // 到左右边框的可用距离
      const limY = H2 - 9 - Math.abs(cy - H2 / 2);
      const kx = vx !== 0 ? limX / Math.abs(vx) : Infinity;
      const ky = vy !== 0 ? limY / Math.abs(vy) : Infinity;
      const kk = Math.min(kx, ky);
      if (kk < 1) { px2 = cx + vx * kk; py2 = cy + vy * kk; }
      dot.style.left = px2 + "px";
      dot.style.top = py2 + "px";
      dot.classList.toggle("far", px2 !== px || py2 !== py);

      // 刻度：俯视用距离，侧/正视用米
      /* 刻度数字放在「声源反向」的上方对角：声源在右上就把数字甩到左上，
         免得数字压在人头和声源圆点上 */
      const srcA = Math.atan2(px - cx, -(py - cy));       // 声源的屏幕角度
      const tickA = (() => {
        const d1 = Math.abs(Math.atan2(Math.sin(srcA - 0.72), Math.cos(srcA - 0.72)));
        const d2 = Math.abs(Math.atan2(Math.sin(srcA + 0.72), Math.cos(srcA + 0.72)));
        return d1 >= d2 ? 0.72 : -0.72;
      })();
      tickEls.forEach(({ el: d2, f }) => {
        if (plane === "xz") {
          const d = r2dist(f, g, 1);
          d2.textContent = fmtDist(d);
          const rr = Math.max(28, dist2r(d, g, R));       // 贴耳的环也要离开人头
          d2.style.left = (cx + rr * Math.sin(tickA)) + "px";
          d2.style.top = (cy - rr * Math.cos(tickA)) + "px";
          d2.style.display = "";
        } else {
          d2.style.display = "none";
        }
      });

      // 读数
      const i = kfSelIdx(c);
      const rec = KF.rec && KF.rec.cid === c.id && KF.rec.prop === "space";
      read.innerHTML = "";
      read.appendChild(el("b", null,
        `${Math.abs(cur.az) < 2 ? "正前" : (cur.az > 0 ? "右 " : "左 ") + Math.round(Math.abs(cur.az)) + "°"}`
        + ` · ${Math.abs(cur.el) < 2 ? "水平" : (cur.el > 0 ? "上 " : "下 ") + Math.round(Math.abs(cur.el)) + "°"}`
        + ` · ${fmtDist(cur.dist)}`));
      read.appendChild(el("span", null, rec
        ? `● 录制距离中（${KF.rec.pts.length} 点）`
        : (i != null
          ? `插入点 ${i + 1}/${kfSpace(c).length}（点片段上的方块可换）`
          : (S.playing ? "播放中：圆点跟着曲线走"
            : (kfSpace(c).length ? "静态位置（点下面的插入点行可改那个点）" : "静态位置")))));
      read.title = `标尺 ±${fmtDist(ext)} · 每格 ${stepM >= 1 ? stepM : stepM.toFixed(2)}m`;

      xyzRow.innerHTML = "";
      [["X", P.x, "右"], ["Y", P.y, "上"], ["Z", P.z, "前"]].forEach(([k, val, hint]) => {
        const s2 = el("span", "xyzcell");
        s2.appendChild(el("i", null, k));
        s2.appendChild(el("b", null, (val >= 0 ? "+" : "") + val.toFixed(2)));
        s2.appendChild(el("u", null, hint));
        xyzRow.appendChild(s2);
      });
      xyzRow.appendChild(el("span", "xyzspan", `视野 ±${fmtDist(ext)}`));

      pad.classList.toggle("rec", !!rec);
      pad.title = `拖 = 改这个平面的两个轴（第三轴不变）；左边竖条改高度；`
        + `上方滑杆改方位。当前 ${plane} 平面，视野 ±${fmtDist(ext)}`;
    };
    wrap.__paint = paint;

    /* 三个滑杆 + 拖拽：都只改内存，松手才提交 */
    const syncCtl = () => {
      const cur = posNow(c);
      azr.value = String(Math.round(cur.az));
      azv.textContent = `${Math.round(cur.az)}°`;
      er.value = String(Math.round(cur.el));
      ev.value = String(Math.round(cur.el));
    };
    wrap.__syncEl = syncCtl;
    wrap.__sync = syncCtl;

    const applyAz = (v) => {
      posSet(c, { az: clamp(Math.round(Number(v) || 0), -180, 180) });
      paint(); draw();
    };
    azr.oninput = () => { azv.textContent = `${azr.value}°`; applyAz(azr.value); };
    azr.onchange = () => { posCommit(c, "空间方位"); drawInspector(); draw(); };

    const applyEl = (v) => {
      posSet(c, { el: clamp(Math.round(Number(v) || 0), -90, 90) });
      paint(); draw();
    };
    er.oninput = () => { ev.value = er.value; applyEl(er.value); };
    er.onchange = () => { posCommit(c, "空间仰角"); drawInspector(); draw(); };
    ev.onchange = () => {
      const v = clamp(parseFloat(ev.value) || 0, -90, 90);
      applyEl(v);
      posCommit(c, "空间仰角");
      drawInspector(); draw();
    };

    let dragging = false;
    const dragTo = (e) => {
      const r = pad.getBoundingClientRect();
      const R2 = Math.max(6, Math.min(r.width, r.height) / 2 - 14);
      const ext2 = Math.max(0.2, curPad(c).max);     // 与 paint() 里的视野一致
      const u = ((e.clientX - r.left - r.width / 2) / R2) * ext2;
      const v = (-(e.clientY - r.top - r.height / 2) / R2) * ext2;
      const P0 = posXYZ(posNow(c));
      const plane = spPlane();
      const nx = plane === "yz" ? P0.x : u;
      const ny = plane === "xz" ? P0.y : v;
      const nz = plane === "xz" ? v : plane === "yz" ? u : P0.z;
      posSet(c, xyzPos(nx, ny, nz));
      paint();
      draw();
    };
    pad.onpointerdown = (e) => {
      e.preventDefault();
      dragging = true;
      try { pad.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
      dragTo(e);
    };
    pad.onpointermove = (e) => { if (dragging) dragTo(e); };
    pad.onpointerup = (e) => {
      if (!dragging) return;
      dragging = false;
      try { pad.releasePointerCapture(e.pointerId); } catch (err) { /* noop */ }
      if (!(KF.rec && KF.rec.cid === c.id)) {
        posCommit(c, "空间位置");
        drawInspector();
      }
      draw();
    };
    pad.ondblclick = () => {
      const p = presetOf(c.sp_preset);
      posSet(c, { az: 0, el: p && p.el != null ? p.el : 0, dist: p && p.dist ? p.dist : 1 });
      posCommit(c, "空间位置");
      drawInspector(); draw();
      toast("已回到正前方（双击 = 归位）");
    };
    setTimeout(() => { paint(); syncCtl(); }, 0);
    return wrap;
  }

  /* 摆位辅助：拖动时只改内存（不写盘、不重建面板），松手才提交 */
  function posSet(c, patch) {
    /* 正在录「距离」时：先只改「待录位置」，到间隔点才落成关键帧 */
    if (KF.rec && KF.rec.cid === c.id && KF.rec.prop === "space") {
      const q = KF.rec.val;
      if (patch.az != null) q.az = r3(patch.az);
      if (patch.el != null) q.el = r3(patch.el);
      if (patch.dist != null) q.dist = r3(clamp(patch.dist, 0.2, 10));
      return;
    }
    let i = kfSelIdx(c);
    if (i == null && kfSpace(c).length) {
      /* 有曲线时静态值不起作用（曲线优先）。这时候在图上一拖就该改「离播放头最近
         的那个插入点」，而不是往一个永远不会被读的静态值里写。 */
      const pts = kfSpace(c);
      const local = clamp(S.pos - c.start, 0, c.dur);
      let best = 0, bd = Infinity;
      pts.forEach((q, k) => {
        const dd = Math.abs(q[0] - local);
        if (dd < bd) { bd = dd; best = k; }
      });
      kfSelSet(c, best);
      i = best;
    }
    if (i != null) {
      const pts = kfSpace(c);
      const q = pts[i];
      pts[i] = [q[0],
        patch.az == null ? (q[SPACE_AZ] || 0) : r3(patch.az),
        patch.el == null ? (q[SPACE_EL] || 0) : r3(patch.el),
        patch.dist == null ? (q[SPACE_DIST] == null ? 1 : q[SPACE_DIST])
          : r3(clamp(patch.dist, 0.2, 10))];
      return;
    }
    if (patch.az != null) c.az = r3(patch.az);
    if (patch.el != null) c.el = r3(patch.el);
    if (patch.dist != null) c.dist = r3(clamp(patch.dist, 0.2, 10));
  }
  function posCommit(c, label) {
    if (KF.rec && KF.rec.cid === c.id) return;    // 录制中由 recStop 统一写盘

    if (kfSelIdx(c) != null) kfSpaceWrite(c, kfSpace(c), label || "调整空间关键帧");
    else commitClip(c, label || "空间位置");
  }
  /* 「这个片段此刻自己的位置」：静态值，或按曲线插值。
     不看选中了哪个插入点、也不看录制状态。 */
  function posStatic(c, local) {
    const t = local == null ? clamp(S.pos - c.start, 0, c.dur) : local;
    if (kfSpace(c).length) return kfSpaceAt(c, t);
    return { az: Number(c.az || 0), el: Number(c.el || 0),
             dist: c.dist == null ? 1 : Number(c.dist) };
  }

  /* 当前要显示/编辑的位置：
     · 录制中 → 你手拖的那个位置
     · 播放中 → 跟着播放头走（这就是「播放时图形面板实时更新」）
     · 停下来 → 选中了插入点就是那个点，否则跟着播放头插值 */
  function posNow(c) {
    if (KF.rec && KF.rec.cid === c.id && KF.rec.prop === "space") {
      return { ...KF.rec.val };
    }
    if (S.playing) return posStatic(c);
    const i = kfSelIdx(c);
    if (i != null) {
      const p = kfSpace(c)[i];
      return { az: Number(p[SPACE_AZ] || 0), el: Number(p[SPACE_EL] || 0),
               dist: p[SPACE_DIST] == null ? 1 : Number(p[SPACE_DIST]) };
    }
    return posStatic(c);
  }
  const fmtDist = (d) => (d < 1 ? d.toFixed(2) : d.toFixed(1)) + "m";

  /* ---------------- 预设运动脚本 ----------------
     给一段音频自动铺一条「声源怎么走」的轨迹，参数可调。
     生成的是普通的空间关键帧（[t, 方位, 仰角, 距离]），生成后照样能逐点微调。 */
  const SPACE_MOTIONS = [
    { id: "pingpong", name: "左右往返", icon: "↔",
      hint: "在左右两耳之间来回（像在你面前走来走去）",
      params: { span: 90, cycles: 2, dist: 1.0, el: 0 } },
    { id: "orbit", name: "绕头圆周", icon: "⟳",
      hint: "绕着你的头转圈（一圈 360°）",
      params: { cycles: 1, dist: 1.2, el: 0, dir: 1 } },
    { id: "approach", name: "由远及近", icon: "→",
      hint: "从远处走到贴耳（ASMR 常用）",
      params: { d0: 6, d1: 0.3, az: 0, el: 0 } },
    { id: "retreat", name: "由近及远", icon: "←",
      hint: "从耳边走开（送别/远去）",
      params: { d0: 0.3, d1: 6, az: 0, el: 0 } },
    { id: "frontback", name: "前后穿越", icon: "⇅",
      hint: "从正前掠过耳侧、绕到身后（左右可换）",
      params: { dist: 0.6, side: 1, el: 0 } },
    { id: "figure8", name: "8 字绕行", icon: "∞",
      hint: "横向 8 字轨迹，幅度可调",
      params: { span: 100, cycles: 2, dist: 1.1, el: 0 } },
    { id: "spiral", name: "螺旋升降", icon: "◉",
      hint: "一边绕圈一边升高/降低，距离也变",
      params: { cycles: 1, d0: 2.0, d1: 0.5, el0: -10, el1: 20 } },
    { id: "random", name: "随机游走", icon: "⁂",
      hint: "在给定范围内随机飘（种子固定，可复现）",
      params: { span: 120, dist: 1.5, jitter: 0.5, n: 8 } },
    { id: "nearshake", name: "贴耳微晃", icon: "≈",
      hint: "很近的距离上小幅左右晃（耳语 / 呼吸感）",
      params: { span: 35, cycles: 4, dist: 0.35, el: 0, n: 24 } },
    { id: "overhead", name: "头顶环绕", icon: "☊",
      hint: "在头顶上方绕圈（天花板漏水 / 上方经过）",
      params: { cycles: 1, dist: 0.8, el: 62, n: 24 } },
    { id: "flyby", name: "掠耳而过", icon: "➤",
      hint: "从一侧远处掠过耳侧再到另一侧（一段飞过）",
      params: { side: 1, dmin: 0.3, dmax: 3.0, el: 0, n: 24 } },
    { id: "breath", name: "远近呼吸", icon: "◌",
      hint: "距离在一段内来回呼吸（不进不退，忽近忽远）",
      params: { d0: 0.5, d1: 2.5, cycles: 2, az: 0, el: 0, n: 20 } },
    { id: "behind", name: "背后低语", icon: "⌾",
      hint: "贴在脑后小幅移动（背后有人说话）",
      params: { az: 180, dist: 0.5, jitter: 20, el: -6, n: 16 } },
  ];

  /* 生成轨迹点（相对片段秒）。统一用「正弦/线性 + 缓动」，避免听起来一顿一顿。 */
  function motionPoints(id, prm, dur) {
    const P = Object.assign({}, prm);
    const N = Math.max(3, Math.min(512, Math.round(P.n || 12)));   // 512 点上限：长片段也能铺细
    const out = [];
    const ts = [];
    for (let i = 0; i < N; i++) ts.push(dur * i / (N - 1));
    if (id === "pingpong") {
      const span = clamp(P.span, 5, 180), cyc = clamp(P.cycles, 0.5, 8);
      ts.forEach((t, i) => {
        const u = i / (N - 1);
        const az = Math.sin(u * Math.PI * 2 * cyc) * span;
        out.push([t, az, P.el || 0, clamp(P.dist, 0.2, 10)]);
      });
    } else if (id === "orbit") {
      const cyc = clamp(P.cycles, 0.25, 6), dir = P.dir < 0 ? -1 : 1;
      ts.forEach((t, i) => {
        const u = i / (N - 1);
        out.push([t, -180 + u * 360 * cyc * dir, P.el || 0, clamp(P.dist, 0.2, 10)]);
      });
    } else if (id === "approach" || id === "retreat") {
      const a = clamp(P.d0, 0.2, 10), b = clamp(P.d1, 0.2, 10);
      ts.forEach((t, i) => {
        const u = i / (N - 1);
        // 距离用对数插值：听起来是「匀速靠近」而不是前面快后面慢
        const d = a * Math.pow(b / a, u);
        out.push([t, P.az || 0, P.el || 0, d]);
      });
    } else if (id === "frontback") {
      const side = P.side < 0 ? -1 : 1;
      const d = clamp(P.dist, 0.2, 5);
      ts.forEach((t, i) => {
        const u = i / (N - 1);
        // 0° → 90°（掠过耳侧）→ 180°（身后），距离固定
        out.push([t, side * (u * 180), P.el || 0, d]);
      });
    } else if (id === "figure8") {
      const span = clamp(P.span, 10, 170), cyc = clamp(P.cycles, 0.5, 6);
      ts.forEach((t, i) => {
        const u = i / (N - 1) * Math.PI * 2 * cyc;
        out.push([t, Math.sin(u) * span, Math.sin(u * 2) * 12 + (P.el || 0),
                  clamp(P.dist, 0.2, 10)]);
      });
    } else if (id === "spiral") {
      const cyc = clamp(P.cycles, 0.25, 5);
      ts.forEach((t, i) => {
        const u = i / (N - 1);
        const d = P.d0 * Math.pow(clamp(P.d1, 0.2, 10) / P.d0, u);
        out.push([t, -180 + u * 360 * cyc, (P.el0 || 0) + (P.el1 - P.el0) * u, d]);
      });
    } else if (id === "random") {
      let seed = 20261025;
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      ts.forEach((t, i) => {
        const az = (rnd() * 2 - 1) * clamp(P.span, 10, 180);
        const d = clamp(P.dist * (1 + (rnd() * 2 - 1) * clamp(P.jitter, 0, 0.9)), 0.2, 10);
        const el = (rnd() * 2 - 1) * 20;
        out.push([t, i === 0 ? 0 : az, i === 0 ? 0 : el, i === 0 ? clamp(P.dist, 0.2, 10) : d]);
      });
    } else if (id === "nearshake") {
      const span = clamp(P.span, 5, 120), cyc = clamp(P.cycles, 0.5, 8);
      const d = clamp(P.dist, 0.2, 3);
      ts.forEach((t, i) => {
        const u = i / (N - 1);
        const az = Math.sin(u * Math.PI * 2 * cyc) * span;
        // 距离跟着晃一点点：贴耳时这一点点变化最明显
        const dd = d * (1 + 0.12 * Math.sin(u * Math.PI * 2 * cyc * 2));
        out.push([t, az, P.el || 0, dd]);
      });
    } else if (id === "overhead") {
      const cyc = clamp(P.cycles, 0.25, 5);
      const d = clamp(P.dist, 0.2, 5);
      ts.forEach((t, i) => {
        const u = i / (N - 1);
        out.push([t, -180 + u * 360 * cyc, clamp(P.el, 20, 85), d]);
      });
    } else if (id === "flyby") {
      const side = P.side < 0 ? -1 : 1;
      const dmin = clamp(P.dmin, 0.2, 5), dmax = Math.max(dmin + 0.2, clamp(P.dmax, 0.3, 12));
      ts.forEach((t, i) => {
        const u = i / (N - 1);
        const az = side * (-90 + u * 200);              // 前方一侧 → 掠过 → 另一侧偏后
        const d = dmin + (dmax - dmin) * Math.abs(2 * u - 1);   // 中间最近
        out.push([t, az, P.el || 0, d]);
      });
    } else if (id === "breath") {
      const d0 = clamp(P.d0, 0.2, 10), d1 = clamp(P.d1, 0.2, 10);
      const cyc = clamp(P.cycles, 0.5, 8);
      ts.forEach((t, i) => {
        const u = i / (N - 1);
        const k = 0.5 - 0.5 * Math.cos(u * Math.PI * 2 * cyc);   // 0→1→0
        out.push([t, P.az || 0, P.el || 0, d0 * Math.pow(d1 / d0, k)]);
      });
    } else if (id === "behind") {
      const az0 = clamp(P.az == null ? 180 : P.az, -180, 180);
      const d = clamp(P.dist, 0.2, 3), jt = clamp(P.jitter, 0, 60);
      let seed = 20261025;
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      ts.forEach((t, i) => {
        const u = i / (N - 1);
        const az = az0 + Math.sin(u * Math.PI * 2) * jt + (i ? (rnd() * 2 - 1) * 2 : 0);
        out.push([t, az, (P.el || -6) + (rnd() * 2 - 1), d * (1 + (rnd() * 2 - 1) * 0.12)]);
      });
    }
    return out.map((q) => [r3(q[0]), r3(q[1]), r3(q[2]), r3(clamp(q[3], 0.2, 10))]);
  }

  /* 八个脚本做成一个选择窗（两列卡片），而不是长下拉菜单：
     菜单里每条带说明会撑到屏幕外，卡片一眼能扫完，也不会被窗口切掉。 */
  function openMotionPicker(c) {
    let dlg = null;
    dlg = modal("🎞 空间运动脚本", (box) => {
      box.appendChild(el("div", "hint",
        "选一种走法 → 下一窗调幅度 / 圈数 / 距离。生成的是普通空间关键帧，"
        + "之后照样能逐点微调，也可以再叠一条别的走法。"));
      const grid = el("div", "motiongrid");
      SPACE_MOTIONS.forEach((mo) => {
        const card = el("button", "mcard");
        card.type = "button";
        card.appendChild(el("b", null, `${mo.icon} ${mo.name}`));
        card.appendChild(el("span", null, mo.hint));
        card.onclick = () => {
          dlg.mask.remove();
          openMotionDialog(c, mo);
        };
        grid.appendChild(card);
      });
      box.appendChild(grid);
      const row = el("div", "btnrow");
      const bClear = el("button", "btn mini ghost", "🧹 清空空间关键帧");
      bClear.type = "button";
      bClear.onclick = () => {
        if (!kfSpace(c).length) { toast("还没有空间关键帧"); return; }
        if (!confirm("清掉这条片段的空间关键帧？位置会回到静态值")) return;
        dlg.mask.remove();
        kfSelSet(c, null);
        kfSpaceWrite(c, [], "清空空间关键帧");
        drawInspector(); draw();
      };
      row.appendChild(bClear);
      box.appendChild(row);
    }, "关闭", () => { dlg.mask.remove(); });
    const cancel = dlg.box.querySelector(".foot .btn.ghost");
    if (cancel) cancel.remove();
  }

  function openMotionDialog(c, m) {
    const prm = Object.assign({ n: 12 }, m.params);
    const dur = Math.max(0.2, c.dur);
    /* 弹窗的「内容」和「确定」是两个回调，中间不能靠局部变量传值：
       把输入框引用和字段表挂在 box 上（之前 fields 写在内容回调里，
       点「生成轨迹」直接 ReferenceError）。 */
    const fields = [];
    modal(`${m.icon} ${m.name}`, (box) => {
      box.appendChild(el("div", "hint", m.hint + `（在这段 ${dur.toFixed(2)}s 内生成）`));
      const f0 = el("div", "field");
      f0.appendChild(fieldLabel("时间范围（相对片段，秒）", null));
      const row = el("div", "rowline");
      row.style.flex = "1";
      const inpFrom = document.createElement("input");
      inpFrom.type = "number"; inpFrom.className = "inp"; inpFrom.min = "0";
      inpFrom.max = String(dur); inpFrom.step = "0.05"; inpFrom.value = "0";
      const inpTo = document.createElement("input");
      inpTo.type = "number"; inpTo.className = "inp"; inpTo.min = "0";
      inpTo.max = String(dur); inpTo.step = "0.05"; inpTo.value = dur.toFixed(2);
      row.appendChild(inpFrom); row.appendChild(inpTo);
      f0.appendChild(row);
      box.appendChild(f0);
      box.__from = inpFrom; box.__to = inpTo;

      const addNum = (key, label, lo, hi, step, unit) => {
        const f = el("div", "field");
        f.appendChild(fieldLabel(label, null));
        const r = el("div", "rowline");
        r.style.flex = "1";
        const i = document.createElement("input");
        i.type = "number"; i.className = "inp"; i.min = String(lo); i.max = String(hi);
        i.step = String(step); i.value = String(prm[key]);
        r.appendChild(i);
        r.appendChild(el("span", "hint", unit || ""));
        f.appendChild(r);
        box.appendChild(f);
        fields.push({ key, i });
      };
      const addSel = (key, label, opts) => {
        const f = el("div", "field");
        f.appendChild(fieldLabel(label, null));
        const sel = document.createElement("select");
        sel.className = "sel";
        opts.forEach(([v, t]) => {
          const o = document.createElement("option");
          o.value = String(v); o.textContent = t; sel.appendChild(o);
        });
        sel.value = String(prm[key] == null ? opts[0][0] : prm[key]);
        f.appendChild(sel);
        box.appendChild(f);
        fields.push({ key, i: sel });
      };
      if (m.id === "pingpong" || m.id === "figure8" || m.id === "random") {
        addNum("span", "横向幅度（度）", 5, 180, 5, "± 度");
      }
      if (m.id === "orbit") {
        addSel("dir", "方向", [[1, "顺时针（从上方看）"], [-1, "逆时针"]]);
      }
      if (m.id === "frontback") {
        addSel("side", "方向", [[1, "向右绕到身后（先右耳）"], [-1, "向左绕到身后（先左耳）"]]);
      }
      if (m.id === "orbit" || m.id === "pingpong" || m.id === "figure8" || m.id === "spiral") {
        addNum("cycles", "循环次数", 0.25, 8, 0.25, "圈");
      }
      if (m.id === "approach" || m.id === "retreat") {
        addNum("d0", "起始距离（米）", 0.2, 10, 0.1, "m");
        addNum("d1", "结束距离（米）", 0.2, 10, 0.1, "m");
        addNum("az", "方位（度）", -180, 180, 5, "0 正前");
      } else if (m.id === "spiral") {
        addNum("d0", "起始距离（米）", 0.2, 10, 0.1, "m");
        addNum("d1", "结束距离（米）", 0.2, 10, 0.1, "m");
        addNum("el0", "起始仰角（度）", -80, 80, 5, "°");
        addNum("el1", "结束仰角（度）", -80, 80, 5, "°");
      } else if (m.id === "frontback") {
        addNum("dist", "距离（米）", 0.2, 5, 0.05, "m");
        addNum("el", "仰角（度）", -60, 60, 5, "°");
      } else if (m.id === "random") {
        addNum("dist", "中心距离（米）", 0.2, 10, 0.1, "m");
        addNum("jitter", "距离抖动比例", 0, 0.9, 0.05, "0~0.9");
        addNum("n", "插入点数量", 3, 512, 1, "个");
      } else if (m.id === "nearshake") {
        addNum("span", "横向幅度（度）", 5, 120, 5, "± 度");
        addNum("cycles", "摇晃次数", 0.5, 8, 0.5, "次");
        addNum("dist", "距离（米）", 0.2, 3, 0.05, "m");
        addNum("el", "仰角（度）", -60, 60, 5, "°");
      } else if (m.id === "overhead") {
        addNum("el", "仰角（度）", 20, 85, 5, "°");
        addNum("dist", "距离（米）", 0.2, 5, 0.05, "m");
        addNum("cycles", "绕圈次数", 0.25, 5, 0.25, "圈");
      } else if (m.id === "flyby") {
        addSel("side", "方向", [[1, "从左往右掠"], [-1, "从右往左掠"]]);
        addNum("dmin", "最近距离（米）", 0.2, 5, 0.05, "m");
        addNum("dmax", "最远距离（米）", 0.3, 12, 0.1, "m");
        addNum("el", "仰角（度）", -60, 60, 5, "°");
      } else if (m.id === "breath") {
        addNum("d0", "近点距离（米）", 0.2, 10, 0.05, "m");
        addNum("d1", "远点距离（米）", 0.2, 10, 0.1, "m");
        addNum("cycles", "呼吸次数", 0.5, 8, 0.5, "次");
        addNum("az", "方位（度）", -180, 180, 5, "0 正前");
      } else if (m.id === "behind") {
        addNum("az", "中心方位（度）", -180, 180, 5, "180 = 正后");
        addNum("dist", "距离（米）", 0.2, 3, 0.05, "m");
        addNum("jitter", "摆动幅度（度）", 0, 60, 5, "± 度");
        addNum("el", "仰角（度）", -60, 60, 5, "°");
      } else {
        addNum("dist", "距离（米）", 0.2, 10, 0.05, "m");
        addNum("el", "仰角（度）", -60, 60, 5, "°");
      }
      // 密度：默认按片段长度给 12 个点左右
      if (m.id !== "random") addNum("n", "插入点数量", 3, 512, 1, "个");
      box.appendChild(el("div", "kfnote",
        "生成的是普通空间关键帧：默认平滑过渡；想听「一段一段」的直线走势，"
        + "生成后把关键帧区切成折线即可。"));
    }, "生成轨迹", (box) => {
      const t0 = clamp(parseFloat(box.__from.value) || 0, 0, dur);
      const t1 = clamp(parseFloat(box.__to.value) || dur, 0, dur);
      if (t1 - t0 < 0.15) { toast("时间范围太短", true); return; }
      fields.forEach((f) => { prm[f.key] = parseFloat(f.i.value); });
      prm.n = Math.round(prm.n || 12);
      const pts = motionPoints(m.id, prm, t1 - t0)
        .map((q) => [r3(q[0] + t0), q[1], q[2], q[3]]);
      // 合并：默认替换整段（否则一条轨迹叠在旧点上会互相打结）
      c.kf = c.kf || {};
      c.kf.space = pts;
      c.binaural = true;
      c.sp_preset = c.sp_preset || "custom";
      kfSelSet(c, 0);
      kfSpaceWrite(c, pts, `空间轨迹：${m.name}`);
      drawInspector(); draw();
      const msk = box.closest(".mask");
      if (msk) msk.remove();
      toast(`已生成 ${pts.length} 个插入点（${m.name}）`);
    });
  }

  /* ---------------- 空间 + 混响：主面板 ---------------- */
  /* ---------------- 关键帧录制（音量 / 声像 / 空间距离） ----------------
     三个属性一套逻辑：点「⏺ 录制」→ 开始播放 → 你一边听一边把
     滑块（音量/声像）或声源点（距离）拖到想要的位置，按「间隔」记点。
     记点的时间一律取播放头位置（= 你实际听到的位置），
     所以 2 倍速试听也不会录歪；手不动就不重复记点。 */
  let REC_INT = 0.1;        // 每多少秒一个关键帧
  try {
    REC_INT = clamp(Number(localStorage.getItem("tl.recint")) || 0.1, 0.02, 2);
  } catch (e) { REC_INT = 0.1; }
  const recMs = () => Math.round(clamp(REC_INT, 0.02, 2) * 1000);
  const recIsOn = (c, prop) => !!(KF.rec && KF.rec.cid === (c && c.id)
    && (!prop || KF.rec.prop === prop));

  function recStart(c, prop) {
    prop = prop || KF.prop;
    if (prop === "space" && !c.binaural) {
      toast("先打开「空间音频」再录距离", true);
      return;
    }
    if (KF.rec) { recStop(false); return; }
    if (S.pos < c.start - 0.01 || S.pos > c.start + c.dur - 0.05) seek(c.start);
    KF.sel = null; KF.selFor = c.id;
    const local = clamp(S.pos - c.start, 0, c.dur);
    const startVal = prop === "space"
      ? { ...posStatic(c, local) }
      : r3(kfValue(c, prop, local));
    KF.rec = {
      cid: c.id, prop, val: startVal, pts: [],
      base: (prop === "space" ? kfSpace(c) : kfPts(c, prop)).map((q) => q.slice()),
      timer: null,
    };
    if (!S.playing) play();
    recSample(true);
    KF.rec.timer = setInterval(recSample, recMs());
    drawInspector(); draw();
    toast(`开始录制${KF_META[prop].label}：每 ${REC_INT}s 一个点，一边播一边拖`);
  }

  function recRestartTimer() {
    if (!KF.rec) return;
    clearInterval(KF.rec.timer);
    KF.rec.timer = setInterval(recSample, recMs());
  }

  function recSample(force) {
    const rec = KF.rec;
    if (!rec) return;
    const c = clipById(rec.cid);
    if (!c) { recStop(true); return; }
    const local = S.pos - c.start;
    if (local < -0.02) return;
    if (local > c.dur) { recStop(false, "播到片段末尾"); return; }
    const t = r3(clamp(local, 0, c.dur));
    const pts = rec.pts;
    const last = pts[pts.length - 1];
    let pt;
    if (rec.prop === "space") {
      const p = rec.val;
      const same = last && Math.abs(p.az - last[1]) < 0.25
        && Math.abs(p.el - last[2]) < 0.25 && Math.abs(p.dist - last[3]) < 0.004;
      if (same && !force) return;
      pt = [t, r3(p.az), r3(p.el), r3(clamp(p.dist, 0.2, 10))];
    } else {
      const m = KF_META[rec.prop];
      const v = r3(clamp(Number(rec.val), m.lo, m.hi));
      if (last && Math.abs(v - last[1]) < 1e-4 && !force) return;
      pt = [t, v];
    }
    if (last && Math.abs(t - last[0]) < 0.004) pts[pts.length - 1] = pt;
    else pts.push(pt);
    // 边录边把已录到的点画到片段上（不写盘，停止时一次性提交）
    c.kf = c.kf || {};
    if (rec.prop === "space") c.kf.space = pts.slice().sort((a, b) => a[0] - b[0]);
    else c.kf[rec.prop] = pts.slice().sort((a, b) => a[0] - b[0]);
    draw();
  }

  function recStop(cancel, msg) {
    const rec = KF.rec;
    if (!rec) return;
    clearInterval(rec.timer);
    KF.rec = null;
    const c = clipById(rec.cid);
    if (!c) { drawInspector(); draw(); return; }
    const restore = () => {
      c.kf = c.kf || {};
      if (rec.prop === "space") {
        if (rec.base && rec.base.length) c.kf.space = rec.base;
        else delete c.kf.space;
      } else if (rec.base && rec.base.length) {
        c.kf[rec.prop] = rec.base;
      } else {
        delete c.kf[rec.prop];
      }
      if (!Object.keys(c.kf).length) delete c.kf;
      drawInspector(); draw();
    };
    if (cancel) { restore(); toast("已取消录制（关键帧没变）"); return; }
    const pts = rec.pts.slice().sort((a, b) => a[0] - b[0]);
    if (pts.length < 2) {
      restore();
      toast("录到的点太少（至少 2 个）：一边播一边拖一下再停", true);
      return;
    }
    if (rec.prop === "space") kfSpaceWrite(c, pts, "录制空间轨迹");
    else kfSet(c, rec.prop, pts, `录制${KF_META[rec.prop].label}`);
    kfSelSet(c, null);
    drawInspector(); draw();
    toast(`录制完成：${pts.length} 个${KF_META[rec.prop].label}关键帧`
      + (msg ? `（${msg}）` : ""));
  }

  var SPUI = { cid: null, sync: null };
  var spSyncAt = 0;

  function buildSpatialUI(box, c) {
    box.appendChild(el("div", "kfsep"));
    const head = el("div", "kfhead");
    head.appendChild(el("span", "kflab", "空间音频"));
    const sw = el("button", "sp-switch" + (c.binaural ? " on" : ""), c.binaural ? "已开启" : "未开启");
    sw.type = "button";
    sw.title = "开启后选 HRIR 数据集 / 混响方案，并在下面的图上摆位置";
    sw.onclick = () => {
      const turnOn = !c.binaural;
      c.binaural = turnOn;
      if (turnOn) {
        if (c.az == null) c.az = 0;
        if (c.el == null) c.el = 0;
        if (c.dist == null) c.dist = 1;
        // 第一次开启：整套落「近讲旁白」，省得开了双耳却只有一个不知道听什么的空壳
        if (!c.sp_preset && !c.hrtf && !c.room) {
          applySpacePreset(c, "close", true);
          toast("已开启空间音频：默认用「近讲旁白」，想换方案在「方案」里选");
          return;
        }
      } else {
        kfSelSet(c, null);
        KF.insert = false;
      }
      commitClip(c, "空间音频");
      drawInspector(); draw();
    };
    head.appendChild(sw);
    const cur = presetOf(c.sp_preset);
    head.appendChild(el("span", "kfhint", cur ? `${cur.icon} ${cur.name}` : "自定义"));
    box.appendChild(head);

    if (!c.binaural) {
      box.appendChild(el("div", "kfnote",
        "想把这段放到某个方位（左后方 2 米 / 贴耳 / 大厅）→ 点「未开启」打开。"
        + "开启后才出现方案、HRIR、混响和图形摆位。"));
      return;
    }

    /* 方案：一个下拉（就是「子菜单」），选中即整套参数 + 标尺一起换。 */
    const pRow = el("div", "rowline");
    pRow.appendChild(el("label", null, "方案"));
    const pSel = document.createElement("select");
    pSel.className = "sel grow";
    pSel.innerHTML = SPACE_PRESETS.map((p) =>
      `<option value="${p.id}">${p.icon} ${p.name}</option>`).join("");
    pSel.value = c.sp_preset || "custom";
    pSel.onchange = () => applySpacePreset(c, pSel.value);
    pRow.appendChild(pSel);
    box.appendChild(pRow);
    const pNow = presetOf(c.sp_preset);
    box.appendChild(el("div", "kfnote", pNow ? pNow.desc
      : "还没有选方案：点上面的下拉挑一个（ASMR / 床边耳语 / 近讲 / 影院 …），"
        + "HRIR、混响和标尺会一起换。"));
    box.appendChild(el("div", "kfnote",
      "方案只是「一次把参数摆好」：之后单独改 HRIR / 混响 / 距离，会自动变成「自定义」。"));

    /* HRIR + 混响（只在开启后出现） */
    const defName = (HRIR_STATUS && HRIR_STATUS.name) || "";
    const hRow = el("div", "rowline");
    hRow.appendChild(el("label", null, "HRIR"));
    const hSel = document.createElement("select");
    hSel.className = "sel grow";
    hSel.innerHTML = HRIR_PROFILES.map((p) =>
      `<option value="${p.id}">${p.id ? p.label : "跟随默认"}</option>`).join("");
    hSel.value = c.hrtf || "";
    hSel.onchange = () => {
      c.hrtf = hSel.value;
      if (c.sp_preset) c.sp_preset = "custom";   // 单项微调 → 变成自定义
      commitClip(c, "HRIR 数据集");
      drawInspector();
    };
    hRow.appendChild(hSel);
    box.appendChild(hRow);

    const used = HRIR_PROFILES.find((p) => p.id === (c.hrtf || "")) || null;
    const nearOk = used ? (used.layers > 1) : !!(HRIR_STATUS && HRIR_STATUS.dist_layers > 1);
    box.appendChild(el("div", "kfnote",
      `这段用 ${c.hrtf ? (used ? used.label : c.hrtf) : `${defName || "球头近似"}（默认）`}。`
      + (nearOk ? "这套带多距离层，0.2~1m 贴耳是实测值。"
        : "这套是远场数据：≤1m 的近场效果来自近似补偿，不是实测 HRIR。")));

    const rmRow = el("div", "rowline");
    rmRow.appendChild(el("label", null, "混响"));
    const rmSel = document.createElement("select");
    rmSel.className = "sel grow";
    rmSel.innerHTML = '<option value="">— 干声（无房间）—</option>' +
      ROOMS.map((r) => `<option value="${r.id}">${r.name}`
        + `${r.rt60 ? `（RT60 ${r.rt60}s）` : ""}</option>`).join("");
    rmSel.value = c.room || "";
    rmSel.onchange = () => {
      c.room = rmSel.value;
      if (c.room && !(Number(c.send) > 0)) c.send = 0.25;
      if (c.sp_preset) c.sp_preset = "custom";
      commitClip(c, "房间");
      drawInspector(); draw();
    };
    rmRow.appendChild(rmSel);
    box.appendChild(rmRow);
    if (c.room) {
      box.appendChild(sliderRow("干湿比", Number(c.send) || 0, 0, 1, 0.05, (v) => {
        c.send = v; commitClip(c, "房间");
      }, (v) => Math.round(v * 100) + "%", 0.25));
    }

    /* 图形摆位：一张网格 + 三个平面（X/Z 俯视、Y/Z 侧视、X/Y 正视），
       头像按平面画，声源点＋连线，方位/高度滑杆就在旁边。 */
    box.appendChild(el("div", "sp-sect", "摆位"));
    const wrap = buildSpacePad(c);
    box.appendChild(wrap);

    // 距离滑杆（0.2~10m，对数刻度：贴耳区间也拖得动）+ 数字框
    const distWrap = el("div", "sp-dist");
    const dcur = posNow(c).dist;
    const dr = document.createElement("input");
    dr.type = "range"; dr.min = "0"; dr.max = "1000"; dr.step = "1";
    dr.value = String(Math.round(Math.log(clamp(dcur, 0.2, 10) / 0.2) / Math.log(50) * 1000));
    const dnum = document.createElement("input");
    dnum.type = "number"; dnum.className = "inp tiny";
    dnum.min = "0.2"; dnum.max = "10"; dnum.step = "0.01";
    dnum.value = dcur.toFixed(2);
    const fromSlider = (v) => 0.2 * Math.pow(50, clamp(v, 0, 1000) / 1000);
    dr.oninput = () => {
      const d = Math.round(fromSlider(parseFloat(dr.value)) * 100) / 100;
      dnum.value = d.toFixed(2);
      posSet(c, { dist: d });
      if (wrap.__paint) wrap.__paint();
      if (wrap.__sync) wrap.__sync();
      draw();
    };
    dr.onchange = () => { posCommit(c, "空间距离"); drawInspector(); draw(); };
    dnum.onchange = () => {
      const d = clamp(parseFloat(dnum.value) || 1, 0.2, 10);
      posSet(c, { dist: d });
      posCommit(c, "空间距离");
      drawInspector(); draw();
    };
    /* 播放 / 录制时把「距离」「仰角」「读数」一起刷（不然只有圆点在动） */
    const syncLive = () => {
      const cur = posNow(c);
      const d2 = clamp(Number(cur.dist) || 1, 0.2, 10);
      dr.value = String(Math.round(Math.log(d2 / 0.2) / Math.log(50) * 1000));
      dnum.value = d2.toFixed(2);
      if (wrap.__syncEl) wrap.__syncEl();       // 方位 / 高度滑杆
    };
    SPUI.cid = c.id;
    SPUI.sync = syncLive;
    const dl = el("label", null, "距离");
    distWrap.appendChild(dl);
    distWrap.appendChild(dr);
    distWrap.appendChild(dnum);
    distWrap.appendChild(el("span", "hint", "米"));
    box.appendChild(distWrap);
    box.appendChild(el("div", "kfnote",
      "距离滑杆是对数刻度：0.2m 和 10m 之间，中间那一段拖一格不会从 30cm 跳到 3m。"
      + "片段上的曲线纵轴也是距离（上远下近）。"));

    /* 空间关键帧：插入点 */
    box.appendChild(el("div", "sp-sect", "插入点"));
    const spPts = kfSpace(c);
    const selI = kfSelIdx(c);
    const krow = el("div", "kfbar");
    const insBtn = el("button", "btn mini sp-ins" + (KF.insert ? " on" : ""),
      KF.insert ? "✚ 点选插入中…（Esc 退出）" : "✚ 在片段上点选插入点");
    insBtn.type = "button";
    insBtn.title = "开启后，在片段任意位置点一下就在那一刻插一个插入点；"
      + "按住上下拖 = 改距离；方位/仰角在上面的图里摆";
    insBtn.onclick = () => {
      KF.insert = !KF.insert;
      if (KF.insert) { KF.prop = "space"; }
      drawInspector(); draw();
      if (KF.insert) toast("在片段上点一下插入插入点；上下拖改距离");
    };
    krow.appendChild(insBtn);
    if (spPts.length) {
      const bMotion = el("button", "btn mini ghost", "🎞 运动脚本");
      bMotion.type = "button";
      bMotion.title = "左右往返 / 绕头圆周 / 由远及近 / 前后穿越 / 8 字 / 螺旋…";
      bMotion.onclick = () => openMotionPicker(c);
      krow.appendChild(bMotion);
      const bClear = el("button", "btn mini ghost", "清空");
      bClear.type = "button";
      bClear.onclick = () => {
        if (!confirm("清掉这条片段的空间关键帧？位置回到静态值")) return;
        kfSelSet(c, null);
        kfSpaceWrite(c, [], "清空空间关键帧");
        drawInspector(); draw();
      };
      krow.appendChild(bClear);
    } else {
      const bMotion2 = el("button", "btn mini ghost", "🎞 运动脚本");
      bMotion2.type = "button";
      bMotion2.onclick = () => openMotionPicker(c);
      krow.appendChild(bMotion2);
    }
    box.appendChild(krow);

    if (spPts.length) {
      // 过渡方式：折线 / 平滑（只改连法，点与数值不动）
      const shp = kfShape(c, "space");
      const srow = el("div", "sp-shape");
      srow.appendChild(el("span", null, "过渡"));
      [["linear", "折线（笔直）"], ["smooth", "平滑（曲线）"]].forEach(([k, t]) => {
        const b = el("button", "sp-segb" + (shp === k ? " on" : ""), t);
        b.type = "button";
        b.title = k === "linear"
          ? "点与点之间直线连接：声源匀速直线走过（会有折角）"
          : "经过每个点的平滑曲线（不过冲），听起来是连续的运动";
        b.onclick = () => {
          c.kf = c.kf || {};
          c.kf.shape = c.kf.shape || {};
          if (k === "smooth") delete c.kf.shape.space; else c.kf.shape.space = "linear";
          if (!Object.keys(c.kf.shape).length) delete c.kf.shape;
          kfCommit(c, "space", "空间过渡方式");
        };
        srow.appendChild(b);
      });
      srow.appendChild(el("span", "kfhint", `${spPts.length} 个点`));
      box.appendChild(srow);
      // 点列表：点一行 = 图形面板切到这个点
      const list = el("div", "kflist sp-list");
      spPts.forEach((q, i) => {
        const r = el("div", "kfrow" + (selI === i ? " on" : ""));
        const btn = el("button", "sp-li" + (selI === i ? " on" : ""),
          `${i + 1}. ${q[0].toFixed(2)}s`);
        btn.type = "button";
        btn.onclick = () => { kfSelSet(c, i); drawInspector(); draw(); };
        r.appendChild(btn);
        const info = el("span", "sp-li2",
          `${Math.abs(q[SPACE_AZ] || 0) < 2 ? "正前" : (q[SPACE_AZ] > 0 ? "右" : "左") + Math.round(Math.abs(q[SPACE_AZ])) + "°"}`
          + ` · ${Math.round(q[SPACE_EL] || 0)}° · ${fmtDist(q[SPACE_DIST] == null ? 1 : q[SPACE_DIST])}`);
        info.title = "格式：方位 · 仰角 · 距离";
        r.appendChild(info);
        const go = el("button", "iconbtn", "◎");
        go.type = "button";
        go.title = "播放头跳到这个插入点";
        go.onclick = (e) => { e.stopPropagation(); seek(c.start + q[0]); };
        r.appendChild(go);
        const del = el("button", "iconbtn", "✕");
        del.type = "button";
        del.title = "删除这个插入点";
        del.onclick = (e) => {
          e.stopPropagation();
          const rest = spPts.filter((z, k) => k !== i);
          if (selI === i) kfSelSet(c, null);
          else if (selI != null && selI > i) kfSelSet(c, selI - 1);
          kfSpaceWrite(c, rest, "删除插入点");
          drawInspector(); draw();
        };
        r.appendChild(del);
        r.onclick = (e) => {
          if (e.target && e.target.tagName === "BUTTON" && e.target !== btn) return;
          kfSelSet(c, i); drawInspector(); draw();
        };
        list.appendChild(r);
      });
      box.appendChild(list);
      box.appendChild(el("div", "kfnote",
        "片段上的方块 = 插入点：左右拖改时间、上下拖改距离（纵轴是距离）。"
        + "方位/仰角在图上摆；点一行或点方块都能切换当前编辑的点。"));
    } else {
      box.appendChild(el("div", "kfnote",
        "还没有插入点：点「✚ 在片段上点选插入点」后在片段上点几下（每点一下 = 一个位置，"
        + "纵向落点就是距离）；也可以直接用「🎞 运动脚本」一次生成一整条轨迹。"));
    }
  }

  function drawInspector() {
    const box = $("inspector");
    box.innerHTML = "";
    const c = S.sel ? clipById(S.sel) : null;
    if (S.sel && S.sel !== lastInspSel) {
      lastInspSel = S.sel;
      setTimeout(revealInspector, 0);
    }
    if (!c) {
      lastInspSel = null;
      box.appendChild(el("div", "hint",
        "点一个片段看它的属性。\n语音片段默认锁定（位置时间跟台本走），解锁后才能拖动。\n右键片段有完整菜单：复制 / 剪切 / 拆分 / 静音 / 变速。"));
      return;
    }
    const tr = trackOfClip(c);
    const title = el("div", "insp-title", c.kind === "voice" ? (c.index ? `第 ${c.index} 行` : "语音片段") : "素材片段");
    title.appendChild(el("small", null,
      c.kind === "voice"
        ? `语音 · ${c.has_audio ? (c.stale ? "需重生成" : "已生成") : "未生成（占位）"}`
        : `素材 · ${c.media}`));
    box.appendChild(title);

    const badges = el("div");
    badges.style.marginBottom = "4px";
    badges.appendChild(el("span", "insp-badge" + (c.locked ? " lock" : ""), c.locked ? "已锁定" : "未锁定"));
    if (c.mute) badges.appendChild(el("span", "insp-badge mute", "静音"));
    if (tr) badges.appendChild(el("span", "insp-badge", tr.name));
    if (c.speed && Math.abs(c.speed - 1) > 0.01) badges.appendChild(el("span", "insp-badge", "×" + c.speed.toFixed(2)));
    if (c.kind === "voice" && c.ov && Object.keys(c.ov).length) {
      badges.appendChild(el("span", "insp-badge ov", "改过生成属性"));
    }
    box.appendChild(badges);

    // 改生成属性 + 重生成（音色/情感/停顿），写的就是台本页那份数据
    if (c.kind === "voice" && c.uid) {
      const bGen = el("button", "btn mini gen", "🎛 改属性并重生成…");
      bGen.type = "button";
      bGen.title = "音色 / 情感 / 停顿 / 慢语速 —— 改完直接重生成，台本页同步可见";
      bGen.style.cssText = "margin:2px 0 7px;width:100%";
      bGen.onclick = () => openGenProps([c.uid], c);
      box.appendChild(bGen);
      genBarMount(box, c);
    }

    if (c.changes && c.changes.length) {
      box.appendChild(el("div", "chgline", "和生成时比，改了：" +
        c.changes.map((x) => x.label).join("、") + "（回台本页可撤回）"));
    }

    if (c.kind === "voice" && c.initial_start != null && c.initial_start !== c.start) {
      const d = (c.initial_start - c.start).toFixed(2);
      box.appendChild(el("div", "chgline", "初始样本时间码 " + fmt(c.initial_start) +
        " → 当前 " + fmt(c.start) + "（偏移 " + (d >= 0 ? "+" : "") + d + "s）"));
    }

    /* 位置 / 时长 / 源内起点：数值 + 滚动条一起给（拖滑杆比敲数字快得多） */
    const clipEndMax = Math.max(30, Math.round((S.data.duration || 60) * 1.2));
    box.appendChild(numSliderRow("位置", c.start, 0, clipEndMax, 0.01, c.locked, (v) => {
      c.start = Math.max(0, v); commitClip(c, "修改属性"); draw();
    }, "秒"));
    box.appendChild(numSliderRow("时长", c.dur, 0.1, Math.max(1, c.src_dur || c.dur * 2), 0.01,
      c.locked, (v) => {
        c.dur = Math.max(0.1, v);
        if (c.kind === "voice") c.trim_end = Math.max(0, (c.src_dur || c.dur) - c.offset - c.dur);
        setFade(c, c.fade_in, c.fade_out);
        commitClip(c, "修改属性"); draw();
      }, "秒"));
    if (c.kind === "sfx") {
      box.appendChild(numSliderRow("源内起点", c.offset, 0,
        Math.max(0.1, (c.src_dur || 1) - c.dur), 0.01, false, (v) => {
          setClipOffset(c, v);
        }, "秒"));
    }

    const gainRow = sliderRow("音量", c.gain, 0, 2, 0.05, (v) => {
      c.gain = v; commitClip(c, "修改属性");
    }, (v) => (v === 0 ? "静音" : Math.round(v * 100) + "%"), 1);
    box.appendChild(gainRow);

    const panRow = sliderRow("声像", c.pan || 0, -1, 1, 0.05, (v) => {
      c.pan = v; commitClip(c, "修改属性");
    }, (v) => (Math.abs(v) < 0.02 ? "居中" : (v < 0 ? "左" : "右") + Math.round(Math.abs(v) * 100) + "%"), 0);
    box.appendChild(panRow);

    // 有曲线时静态滑块让位（否则拖了没反应，像坏了）
    [["gain", gainRow], ["pan", panRow]].forEach(([prop, rowEl]) => {
      if (!kfPts(c, prop).length) return;
      rowEl.classList.add("kf-off");
      const inp = rowEl.querySelector("input");
      if (inp) {
        inp.disabled = true;
        inp.title = `已由关键帧控制，去下面「关键帧」里改`;
      }
      rowEl.title = `这一段的${KF_META[prop].label}由关键帧曲线控制`;
    });

    /* 速度：滑杆中间就是 1×（往左变慢、往右变快），旁边给数字框；
       下面再给「变速时长」——填目标秒数，自动算速度。 */
    const spdBox = el("div", "speedblock");
    spdBox.appendChild(sliderRow("速度", clamp(c.speed || 1, 0.5, 2), 0.5, 2, 0.01, (v) => {
      applySpeed(c, v);
    }, (v) => "×" + v.toFixed(2), 1));
    const durRow = el("div", "rowline");
    durRow.appendChild(el("label", null, "变速时长"));
    const durInp = document.createElement("input");
    durInp.type = "number"; durInp.step = "0.01"; durInp.min = "0.1";
    const spanSec = Math.max(0.05, (c.src_dur || c.dur) - (c.offset || 0));
    durInp.value = Number(c.dur).toFixed(2);
    durInp.title = "把这一段变速成这个时长（自动算速度）";
    durInp.onchange = () => {
      const T = clamp(Number(durInp.value) || 0, 0.1, 3600);
      if (T <= 0) return;
      applySpeed(c, clamp(spanSec / T, 0.25, 4));
      toast(`已变速成 ${T.toFixed(2)}s（×${c.speed.toFixed(2)}）`);
    };
    durRow.appendChild(durInp);
    durRow.appendChild(el("span", "val", "秒"));
    const resetS = el("button", "btn mini ghost", "1×");
    resetS.type = "button";
    resetS.title = "恢复原速";
    resetS.onclick = () => { applySpeed(c, 1); drawInspector(); };
    durRow.appendChild(resetS);
    spdBox.appendChild(durRow);
    box.appendChild(spdBox);

    box.appendChild(sliderRow("淡入", c.fade_in, 0, Math.max(0.1, c.dur), 0.01, (v) => {
      setFade(c, v, c.fade_out); commitClip(c, "修改属性");
    }, (v) => v.toFixed(2) + "s", 0));
    box.appendChild(sliderRow("淡出", c.fade_out, 0, Math.max(0.1, c.dur), 0.01, (v) => {
      setFade(c, c.fade_in, v); commitClip(c, "修改属性");
    }, (v) => v.toFixed(2) + "s", 0));

    /* ---------------- 空间音频 + 混响（开关 → 方案 → 图形摆位） ---------------- */
    buildSpatialUI(box, c);


    /* ---------------- 关键帧（音量 / 声像 / 方位自动化） ----------------
       Alt+K 可以把整块藏起来：藏起来时不画曲线、点不到方块、也没有任何输入框，
       就是「只看波形、别碰自动化」的状态。 */
    if (!KF.hidden) {
    if (KF.prop === "space" && !c.binaural) KF.prop = "gain";   // 关掉双耳就没空间这条了
    box.appendChild(el("div", "kfsep"));
    const kfHead = el("div", "kfhead");
    kfHead.appendChild(el("span", "kflab", "关键帧"));
    (c.binaural ? ["gain", "pan", "space"] : ["gain", "pan"]).forEach((p) => {
      const b = el("button", "kftab" + (KF.prop === p ? " on" : ""), KF_META[p].label);
      b.type = "button";
      b.title = `编辑${KF_META[p].label}的自动化曲线`;
      b.onclick = () => { KF.prop = p; drawInspector(); draw(); };
      kfHead.appendChild(b);
    });
    const km = KF_META[KF.prop];
    const kpts = kfPts(c, KF.prop);
    kfHead.appendChild(el("span", "kfhint",
      kpts.length ? `${kpts.length} 个点` : "无"));
    box.appendChild(kfHead);

    const kfBar = el("div", "kfbar");
    const addKf = el("button", "btn mini", "＋ 播放头加点");
    addKf.type = "button";
    addKf.title = `在播放头处给「${km.label}」加一个关键帧（也可以 Alt+点击片段）`;
    addKf.onclick = () => {
      const t = r3(clamp(S.pos - c.start, 0, c.dur));
      const arr = kpts.slice();
      const i = arr.findIndex((q) => Math.abs(q[0] - t) < 0.002);
      if (KF.prop === "space") {
        // 空间点：在这个时刻的「当前位置」原样插一个（不改变听感），
        // 插完在右侧图形面板里摆方位、在片段上上下拖改距离。
        const sp = kfSpaceAt(c, t);
        const pt = [t, r3(sp.az), r3(sp.el), r3(sp.dist)];
        if (i >= 0) arr[i] = pt; else arr.push(pt);
        arr.sort((a, b) => a[0] - b[0]);
        kfSpaceWrite(c, arr, "添加关键帧");
        kfSelSet(c, Math.max(0, arr.findIndex((q) => Math.abs(q[0] - t) < 0.002)));
        drawInspector(); draw();
        toast(`已在 ${t.toFixed(2)}s 插入插入点：上下拖改距离，方位在右侧面板摆`);
        return;
      }
      const val = r3(kfValue(c, KF.prop, t));
      if (i >= 0) arr[i] = [t, val]; else arr.push([t, val]);
      kfSet(c, KF.prop, arr, "添加关键帧");
      toast(`已在 ${t.toFixed(2)}s 加${km.label}关键帧（${km.fmt(val)}）`);
    };
    kfBar.appendChild(addKf);
    const clrKf = el("button", "btn mini ghost", "清空");
    clrKf.type = "button";
    clrKf.disabled = !kpts.length;
    clrKf.onclick = () => {
      if (!kpts.length) return;
      if (!confirm(`清掉这条片段的${km.label}关键帧？`)) return;
      kfSet(c, KF.prop, [], "清空关键帧");
      toast("已清空");
    };
    kfBar.appendChild(clrKf);
    const shapeNow = kfShape(c, KF.prop);
    const smBtn = el("button", "btn mini ghost" + (shapeNow === "smooth" ? " on" : ""),
      shapeNow === "smooth" ? "〰 平滑曲线" : "〰 折线");
    smBtn.type = "button";
    smBtn.title = "只改「点与点之间怎么连」：平滑曲线 / 折线。关键帧的位置和数值都不动";
    smBtn.disabled = kpts.length < 2;
    smBtn.onclick = (ev) => openShapeMenu(ev.currentTarget, "single");
    kfBar.appendChild(smBtn);
    const other = KF.prop === "gain" ? "pan" : "gain";
    if (kfPts(c, other).length) {
      const b2 = el("button", "btn mini ghost", `看${KF_META[other].label}曲线`);
      b2.type = "button";
      b2.onclick = () => { KF.prop = other; drawInspector(); draw(); };
      kfBar.appendChild(b2);
    }
    box.appendChild(kfBar);

    /* ---------------- 录制（音量 / 声像 / 空间距离 同一套） ----------------
       点开始 → 自动从头播 → 一边听一边拖（音量/声像拖下面出现的滑块，
       距离拖上面图形面板的声源点）→ 停止后按「间隔」生成关键帧。 */
    const recOn = recIsOn(c, KF.prop);
    const recRow = el("div", "kf-rec" + (recOn ? " on" : ""));
    const bRec = el("button", "btn mini sp-rec" + (recOn ? " on" : ""),
      recOn ? "■ 停止录制" : `⏺ 录制${km.label}`);
    bRec.type = "button";
    bRec.title = `点一下开始播放并录制${km.label}：每 ${REC_INT} 秒记一个点，`
      + "一边听一边拖，再点一次停止。时间按你实际听到的位置记。";
    bRec.onclick = () => {
      if (KF.rec) recStop(false);
      else recStart(c, KF.prop);
    };
    recRow.appendChild(bRec);

    const intWrap = el("span", "kf-rec-int");
    intWrap.appendChild(el("span", "kfhint", "每"));
    const intInp = document.createElement("input");
    intInp.type = "number"; intInp.className = "inp tiny";
    intInp.min = "0.02"; intInp.max = "2"; intInp.step = "0.01";
    intInp.value = String(REC_INT);
    intInp.title = "每多少秒记一个关键帧（0.02 ~ 2 秒）。越小越跟手，点也越多";
    intInp.onchange = () => {
      const v = clamp(parseFloat(intInp.value) || 0.1, 0.02, 2);
      REC_INT = Math.round(v * 1000) / 1000;
      intInp.value = String(REC_INT);
      try { localStorage.setItem("tl.recint", String(REC_INT)); } catch (e) { /* 忽略 */ }
      recRestartTimer();
      drawInspector();
    };
    intWrap.appendChild(intInp);
    intWrap.appendChild(el("span", "kfhint", `秒一个点（≈${(1 / REC_INT).toFixed(1)}/秒）`));
    recRow.appendChild(intWrap);
    box.appendChild(recRow);

    if (recOn) {
      const live = el("div", "kf-rec-live");
      if (KF.prop === "space") {
        live.appendChild(el("span", "kfhint",
          `● 录制中：在上面图形面板拖声源点 / 距离滑杆 · 已记 ${KF.rec.pts.length} 点`));
      } else {
        const rr = document.createElement("input");
        rr.type = "range";
        rr.min = String(km.lo); rr.max = String(km.hi); rr.step = String(km.step);
        rr.value = String(Number(KF.rec.val) || 0);
        const out = el("b", null, km.fmt(Number(KF.rec.val) || 0));
        rr.oninput = () => {
          if (KF.rec) KF.rec.val = Number(rr.value);
          out.textContent = km.fmt(Number(rr.value));
        };
        live.appendChild(rr);
        live.appendChild(out);
        live.appendChild(el("span", "kfhint", `${KF.rec.pts.length} 点`));
      }
      box.appendChild(live);
    } else {
      box.appendChild(el("div", "kfnote",
        `录${km.label}：点「⏺ 录制${km.label}」→ 自动开始播放 → 一边听一边拖`
        + (KF.prop === "space" ? "上面图形面板的声源点（或距离滑杆）" : "下面会出现的滑块")
        + "，再点一次停止就会生成关键帧。时间按你听到的位置记，倍速试听也录不歪。"));
    }

    if (KF.prop === "space") {
      // 空间关键帧在「空间音频」里有专门的插入点列表（带方位/仰角/距离），
      // 这里不重复一份四列输入框，只指个路。
      box.appendChild(el("div", "kfnote",
        kpts.length
          ? `空间关键帧在上面「空间音频 → 插入点」里编辑：点一行切到那个点，`
            + `图形面板改方位/仰角，片段上上下拖改距离。片段曲线共 ${kpts.length} 个点。`
          : "还没有空间关键帧：开启「空间音频」后，在片段上点选插入点，或用「运动脚本」一次生成。"));
    } else if (kpts.length) {
      const list = el("div", "kflist");
      const selI = KF.prop === "space" ? kfSelIdx(c) : null;
      kpts.forEach((pt, i) => {
        const near = Math.abs(c.start + pt[0] - S.pos) < 0.08;
        const r = el("div", "kfrow" + (near ? " cur" : "")
          + (selI === i ? " on" : ""));
        const ti = document.createElement("input");
        ti.type = "number"; ti.className = "inp tiny"; ti.step = "0.01";
        ti.min = "0"; ti.max = String(Math.max(0.1, c.dur));
        ti.value = pt[0].toFixed(2);
        ti.title = "时间（相对片段起点，秒）";
        ti.onchange = () => {
          const t = clamp(parseFloat(ti.value) || 0, 0, c.dur);
          const arr = kpts.map((q, k) => {
            if (k !== i) return q;
            const nq = q.slice(); nq[0] = r3(t); return nq;
          });
          arr.sort((a, b) => a[0] - b[0]);
          if (KF.prop === "space") {
            kfSpaceWrite(c, arr, "调整关键帧时间");
            kfSelSet(c, Math.max(0, arr.findIndex((q) => q[0] === r3(t))));
            drawInspector(); draw();
          } else kfSet(c, KF.prop, arr, "调整关键帧时间");
        };
        const vi = document.createElement("input");
        vi.type = "number"; vi.className = "inp tiny"; vi.step = String(Math.round(km.step * km.scale));
        vi.min = String(Math.round(km.lo * km.scale));
        vi.max = String(Math.round(km.hi * km.scale));
        vi.value = String(Math.round(pt[1] * km.scale));
        vi.title = `${km.label}（${km.scale === 100 ? "%" : ""}）`;
        vi.onchange = () => {
          const v = clamp((parseFloat(vi.value) || 0) / km.scale, km.lo, km.hi);
          const arr = kpts.map((q, k) => {
            if (k !== i) return q;
            const nq = q.slice(); nq[1] = r3(v); return nq;
          });
          if (KF.prop === "space") kfSpaceWrite(c, arr, "调整关键帧数值");
          else kfSet(c, KF.prop, arr, "调整关键帧数值");
        };
        /* 空间点是四个值，横着排会挤出面板（单位还会折行）：
           第一行「时间 / 距离」（距离就是片段上那条曲线的纵轴），
           第二行「方位 / 仰角」（与右侧图形面板同一份数据）。 */
        const mkNum = (idx2, lo, hi, step, unit, title) => {
          const inp = document.createElement("input");
          inp.type = "number"; inp.className = "inp tiny"; inp.step = String(step);
          inp.min = String(lo); inp.max = String(hi);
          const dv = pt[idx2] == null ? 0 : pt[idx2];
          inp.value = String(dv < 1 ? Math.round(dv * 100) / 100 : Math.round(dv * 10) / 10);
          inp.title = title;
          inp.onchange = () => {
            const v2 = clamp(parseFloat(inp.value) || 0, lo, hi);
            const arr2 = kpts.map((q, k) => {
              if (k !== i) return q;
              const nq = q.slice();
              nq[idx2] = r3(v2);
              return nq;
            });
            kfSelSet(c, i);
            kfSpaceWrite(c, arr2, "调整空间关键帧");
          };
          inp.onfocus = () => { if (KF.prop === "space") { kfSelSet(c, i); draw(); } };
          const wrap = el("span", "kfnum");
          wrap.appendChild(inp);
          wrap.appendChild(el("span", "kfu", unit));
          return wrap;
        };
        if (KF.prop === "space") {
          const grid = el("div", "kfgrid");
          const f1 = el("span", "kfnum");
          f1.appendChild(ti); f1.appendChild(el("span", "kfu", "s"));
          grid.appendChild(f1);
          grid.appendChild(mkNum(SPACE_DIST, 0.2, 10, 0.05, "m", "距离（曲线纵轴）：越小越贴耳"));
          grid.appendChild(mkNum(SPACE_AZ, -180, 180, 5, "°", "方位：0 正前，+ 右，180 背后"));
          grid.appendChild(mkNum(SPACE_EL, -90, 90, 5, "°", "仰角：+ 上，− 下"));
          r.appendChild(grid);
          // 点一下这一行 = 右侧图形面板切到这个点（改方位/仰角/距离）
          r.style.cursor = "pointer";
          r.title = "点这一行：右侧图形面板切到这个插入点";
          r.onclick = (ev) => {
            if (ev.target && ev.target.tagName === "INPUT") return;
            kfSelSet(c, i);
            drawInspector(); draw();
          };
        } else {
          r.appendChild(ti);
          r.appendChild(el("span", "kfu", "s"));
          r.appendChild(vi);
          r.appendChild(el("span", "kfu", km.unit));
        }
        const del = el("button", "iconbtn", "✕");
        del.type = "button";
        del.title = "删除这个关键帧";
        del.onclick = () => {
          const rest = kpts.filter((q, k) => k !== i);
          if (KF.prop === "space") {
            if (selI === i) kfSelSet(c, null);
            else if (selI != null && selI > i) kfSelSet(c, selI - 1);
            kfSpaceWrite(c, rest, "删除关键帧");
            drawInspector(); draw();
          } else kfSet(c, KF.prop, rest, "删除关键帧");
        };
        r.appendChild(del);
        list.appendChild(r);
      });
      box.appendChild(list);
      box.appendChild(el("div", "kfnote",
        "拖片段上的方块改时间/数值 · Alt+点击片段加点 · 双击方块删除。"
        + "曲线默认是经过点的平滑曲线，可在「〰」里切成折线（点不变）。"
        + "有曲线的属性以曲线为准（上面那个静态滑块让位）。"
        + "混音导出按同一条曲线算；工程导出会把音量/声像曲线写进 RPP 的自动化包络。"));
    } else {
      box.appendChild(el("div", "kfnote",
        `给这一段的${km.label}做自动化：Alt+点击片段加点，或用「＋ 播放头加点」。`));
    }
    } else {
      /* 隐藏态：只留一个入口，避免「看不见却还能误改」 */
      box.appendChild(el("div", "kfsep"));
      const kh = el("div", "kfhead");
      kh.appendChild(el("span", "kflab", "关键帧"));
      kh.appendChild(el("span", "kfhint", "已隐藏"));
      box.appendChild(kh);
      const bShow = el("button", "btn mini", "👁 显示关键帧面板（Alt+K）");
      bShow.type = "button";
      bShow.onclick = () => toggleKfPanel();
      box.appendChild(bShow);
      box.appendChild(el("div", "kfnote",
        "关键帧面板已隐藏：片段上的曲线不画，也点不到关键帧方块，"
        + "不会在看波形时误拖。按 Alt+K 随时切回来。"));
    }

    const row = el("div", "btnrow");
    const bLock = el("button", "btn mini" + (c.locked ? " on" : ""), c.locked ? "🔒 解锁" : "🔓 锁定");
    bLock.onclick = () => { c.locked = !c.locked; commitClip(c, "修改属性"); drawInspector(); draw(); };
    row.appendChild(bLock);
    const bMute = el("button", "btn mini" + (c.mute ? " on" : ""), c.mute ? "🔇 已静音" : "静音");
    bMute.onclick = () => { c.mute = !c.mute; commitClip(c, "修改属性"); drawInspector(); };
    row.appendChild(bMute);
    const bPlay = el("button", "btn mini", "▶ 试听");
    bPlay.onclick = () => { seek(c.start); play(); };
    row.appendChild(bPlay);
    if (c.has_audio) {
      const bExp = el("button", "btn mini ghost", "⬇ 导出这句");
      bExp.type = "button";
      bExp.title = "把这一句单独渲染成一个音频文件（带它自己的空间位置 / 混响 / 淡入淡出）";
      bExp.onclick = () => exportClip(c);
      row.appendChild(bExp);
    }
    const bDef = el("button", "btn mini ghost", "恢复默认");
    bDef.title = "音量 100% · 声像居中 · 速度 ×1.00 · 淡入淡出 0";
    bDef.onclick = () => {
      c.gain = 1; c.pan = 0; c.speed = 1; c.fade_in = 0; c.fade_out = 0;
      commitClip(c, "修改属性"); drawInspector(); draw();
      toast("已恢复默认属性");
    };
    row.appendChild(bDef);
    if (c.kind === "voice") {
      const bBack = el("button", "btn mini ghost", "回到台本位置");
      bBack.onclick = () => {
        const o = S.data.project.clips[c.uid];
        if (o) { delete o.start; delete o.trim_start; delete o.trim_end; }
        persist("回台本位置");
      };
      row.appendChild(bBack);
    } else {
      const bDel = el("button", "btn mini ghost", "删除");
      bDel.onclick = () => removeClip(c);
      row.appendChild(bDel);
    }
    box.appendChild(row);
  }

  /* ---------------- 单句 / 单段导出 ----------------
     走的是混音同一条渲染链路（HRTF + 房间），只是把时间范围裁到这一段，
     所以「导出这句」听到的和整体混音里的这一句完全一致。 */
  async function exportClip(c) {
    const body = el("div");
    const title = (c.text || c.media || c.name || "这一段").slice(0, 28);
    body.appendChild(el("div", "hint", `正在渲染「${title}」…（带空间位置与混响）`));
    const line = el("div", "progress", "");
    body.appendChild(line);
    let dlg = null;
    dlg = modal("⬇ 单句导出", (box) => box.appendChild(body), "关闭", () => {
      if (dlg) dlg.mask.remove();
    });
    const cancel = dlg.box.querySelector(".foot .btn.ghost");
    if (cancel) cancel.remove();
    try {
      const r = await fetch(`${API}/export/clip`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid: c.id, sample_rate: 44100, channels: 2 }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || "导出失败");
      line.textContent = "";
      const info = el("div", "hint",
        `完成：${(d.duration || 0).toFixed(2)}s，${((d.size || 0) / 1048576).toFixed(2)} MB，`
        + `${((d.sample_rate || 44100) / 1000).toFixed(1)}kHz / 立体声　`);
      const a = document.createElement("a");
      a.href = encodeURI(d.url);
      a.textContent = "下载 " + d.file;
      a.style.color = "var(--primary)";
      info.appendChild(a);
      body.appendChild(info);
      // 顺手给个「直接听一下」
      const au = document.createElement("audio");
      au.controls = true;
      au.src = encodeURI(d.url);
      au.style.cssText = "width:100%;margin-top:6px";
      body.appendChild(au);
      toast("单句导出完成");
    } catch (e) {
      line.textContent = "失败：" + e.message;
    }
  }

  /* 数字 + 滚动条一行（位置 / 时长 / 源内起点用）。
     拖滑杆即时生效，输入框失焦或回车也生效；两边互相回读。 */
  function numSliderRow(label, value, min, max, step, disabled, onChange, unit) {
    const row = el("div", "rowline");
    row.appendChild(el("label", null, label));
    const r = document.createElement("input");
    r.type = "range";
    r.min = String(min); r.max = String(Math.max(max, min + step)); r.step = String(step);
    r.value = String(clamp(Number(value) || 0, min, Number(r.max)));
    r.className = "grow";
    const i = document.createElement("input");
    i.type = "number"; i.step = String(step); i.min = String(min); i.max = String(r.max);
    i.value = Number(value).toFixed(2);
    i.className = "inp tiny";
    r.disabled = !!disabled; i.disabled = !!disabled;
    const fire = (v, from) => {
      const nv = clamp(Number(v) || 0, min, Number(r.max));
      if (from !== "r") r.value = String(nv);
      if (from !== "i") i.value = nv.toFixed(2);
      onChange(nv);
    };
    r.oninput = () => fire(r.value, "r");
    r.onchange = () => fire(r.value, "r");
    i.onchange = () => fire(i.value, "i");
    row.appendChild(r);
    row.appendChild(i);
    row.appendChild(el("span", "val", unit || ""));
    if (disabled) row.title = "已锁定：先解锁才能改位置/时间";
    return row;
  }

  function numRow(label, value, disabled, onChange, unit) {
    const row = el("div", "rowline");
    row.appendChild(el("label", null, label));
    const i = document.createElement("input");
    i.type = "number"; i.step = "0.01"; i.min = "0"; i.value = Number(value).toFixed(2);
    i.disabled = !!disabled;
    i.onchange = () => onChange(parseFloat(i.value) || 0);
    row.appendChild(i);
    row.appendChild(el("span", "val", unit || ""));
    if (disabled) row.title = "已锁定：先解锁才能改位置/时间";
    return row;
  }

  /**
   * 滑块行。origin = 默认原点（音量 1、声像 0、速度 1、淡入淡出 0）。
   * 靠近原点时自动吸附过去，避免「差 0.03 就不是 100%」的尴尬；
   * 双击滑块或点「原点」小按钮可精确回到原点。
   */
  function sliderRow(label, value, min, max, step, onChange, fmtVal, origin) {
    const row = el("div", "rowline");
    row.appendChild(el("label", null, label));
    const r = document.createElement("input");
    r.type = "range"; r.min = min; r.max = Math.max(max, min + 0.01); r.step = step; r.value = value;
    const val = el("span", "val", fmtVal(value));
    const tol = Math.max(step * 1.2, (max - min) * 0.025);
    const snap = (v) => (origin == null ? v : (Math.abs(v - origin) <= tol ? origin : v));
    r.oninput = () => {
      let v = parseFloat(r.value);
      const sv = snap(v);
      if (sv !== v) { v = sv; r.value = String(sv); }
      else if (origin != null && Math.abs(v - origin) < step / 2) { v = origin; r.value = String(origin); }
      val.textContent = fmtVal(v);
      onChange(v);
    };
    if (origin != null) {
      r.title = "靠近默认值会自动吸附；双击回到默认";
      r.ondblclick = () => { r.value = String(origin); val.textContent = fmtVal(origin); onChange(origin); };
    }
    row.appendChild(r); row.appendChild(val);
    return row;
  }

  /* ------------------------------ 轨道头 ------------------------------ */
  function buildHeads() {
    const box = $("heads");
    box.innerHTML = "";
    const sp = el("div", "head-spacer");
    sp.style.height = (RULER_H + 4) + "px";
    box.appendChild(sp);

    const renderHead = (tr, globalIndex) => {
      const isVoice = tr.kind === "voice";
      const h = el("div", "head " + (isVoice ? "voice" : "sfx"));
      h.style.height = TRACK_H + "px";

      // 第一行：类型点 + 完整轨道名 + 更多菜单
      const r1 = el("div", "hrow htop");
      r1.appendChild(el("span", "hdot"));
      const name = el("div", "hname", tr.name || "音轨");
      name.title = `${tr.name}\n双击可直接改名`;
      name.ondblclick = () => renameTrack(tr);
      r1.appendChild(name);
      // 右键轨道头也开同一个菜单（和画布、片段的手感一致）
      h.oncontextmenu = (e2) => {
        e2.preventDefault();
        e2.stopPropagation();
        openTrackMenu(tr, e2.clientX, e2.clientY, globalIndex);
      };
      const more = el("button", "hmini hmore", "⋯");
      more.title = "更多：详情 / 上移 / 下移 / 删除";
      more.onclick = (e) => { e.stopPropagation(); openTrackMenu(tr, e.clientX, e.clientY, globalIndex); };
      r1.appendChild(more);
      h.appendChild(r1);

      // 第二行：M / S / 音量 / 详情
      const r2 = el("div", "hrow hctl");
      const bm = el("button", "hmini" + (tr.mute ? " on" : ""), "M");
      bm.title = "静音这条轨";
      bm.onclick = () => patchTrack(tr.id, { mute: !tr.mute });
      const bs = el("button", "hmini solo" + (tr.solo ? " on" : ""), "S");
      bs.title = "独奏（只听这条轨）";
      bs.onclick = () => patchTrack(tr.id, { solo: !tr.solo });
      const vol = document.createElement("input");
      vol.type = "range"; vol.min = "0"; vol.max = "2"; vol.step = "0.05"; vol.value = tr.gain;
      vol.title = "音轨音量 " + Math.round(tr.gain * 100) + "%（靠近 100% 自动吸附，双击复位）";
      vol.oninput = () => {
        let v = parseFloat(vol.value);
        if (Math.abs(v - 1) <= 0.06) { v = 1; vol.value = "1"; }   // 原点吸附
        vol.title = "音轨音量 " + Math.round(v * 100) + "%（双击复位 100%）";
      };
      vol.onchange = () => {
        let v = parseFloat(vol.value);
        if (Math.abs(v - 1) <= 0.06) { v = 1; vol.value = "1"; }
        patchTrack(tr.id, { gain: v }, true);
      };
      vol.ondblclick = () => { vol.value = "1"; patchTrack(tr.id, { gain: 1 }, true); };
      const det = el("button", "hmini hdet", "⚙");
      det.title = "音轨详情（声道平衡 / 音量 / 静音独奏…）";
      det.onclick = () => openTrackDetail(tr);
      r2.appendChild(bm); r2.appendChild(bs); r2.appendChild(vol); r2.appendChild(det);
      h.appendChild(r2);
      return h;
    };

    const btnRow = (label, kind, title) => {
      const b = el("button", "btn mini addtrack", label);
      b.title = title;
      b.style.height = BTN_ROW_H + "px";
      b.onclick = () => addTrackOfKind(kind);
      const wrap = el("div", "head-addrow");
      wrap.style.height = BTN_ROW_H + "px";
      wrap.appendChild(b);
      return wrap;
    };

    // 音声轨组
    voiceTracks().forEach((tr, i) => {
      const h = renderHead(tr, i);
      if (i) h.style.marginTop = GAP + "px";
      box.appendChild(h);
    });
    // 音声轨组下方 → 新建音声轨按钮（与素材轨组之间留空隙）
    if (voiceTracks().length) {
      const b = btnRow("＋ 新建音声轨", "voice", "新建一条音声轨");
      b.style.marginTop = GAP + "px";
      b.style.marginBottom = GROUP_GAP + "px";
      box.appendChild(b);
    }
    // 素材轨组
    sfxTracks().forEach((tr, i) => {
      const h = renderHead(tr, voiceTracks().length + i);
      if (i) h.style.marginTop = GAP + "px";
      box.appendChild(h);
    });
    // 素材轨组下方 → 新建素材轨按钮
    if (sfxTracks().length) {
      const b = btnRow("＋ 新建素材轨", "sfx", "新建一条素材轨");
      b.style.marginTop = GAP + "px";
      box.appendChild(b);
    }
    // 没有任何轨时也放两个按钮
    if (!tracks().length) {
      const b1 = btnRow("＋ 新建音声轨", "voice", "新建一条音声轨");
      b1.style.marginTop = GAP + "px";
      box.appendChild(b1);
      const b2 = btnRow("＋ 新建素材轨", "sfx", "新建一条素材轨");
      b2.style.marginTop = GAP + "px";
      box.appendChild(b2);
    }
  }

  async function moveTrack(tid, dirOrPos) {
    const body = typeof dirOrPos === "string" ? { pos: dirOrPos } : { dir: dirOrPos };
    const r = await fetch(`${API}/tracks/${tid}/move`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      await reload();
      toast(("top" === body.pos) ? "已移到组内第一条"
        : ("bottom" === body.pos) ? "已移到组内最后一条"
          : (body.dir < 0 ? "上移一格" : "下移一格"));
    } else {
      toast((await r.json()).detail || "移动失败", true);
    }
  }

  async function patchTrack(tid, body, quiet) {
    const r = await fetch(`${API}/tracks/${tid}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) reload(quiet); else toast("改音轨失败", true);
  }

  async function renameTrack(tr) {
    const v = prompt("音轨名称", tr.name);
    if (v == null) return;
    const name = v.trim();
    if (!name) return;
    await fetch(`${API}/tracks/${tr.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    reload();
  }

  async function deleteTrack(tr) {
    if (!confirm(`删除音轨「${tr.name}」？轨上还有片段时会被拒绝`)) return;
    const r = await fetch(`${API}/tracks/${tr.id}`, { method: "DELETE" });
    if (!r.ok) toast((await r.json()).detail || "删不掉", true);
    reload();
  }

  // 轨道「⋯」菜单
  function openTrackMenu(tr, cx, cy, idx) {
    hideCtx();
    const menu = el("div", "ctxmenu");
    const add = (label, key, fn, danger) => {
      const b = el("button", "ctxitem" + (danger ? " danger" : ""));
      b.appendChild(el("span", null, label));
      if (key) b.appendChild(el("span", "k", key));
      b.onclick = (ev) => { ev.stopPropagation(); hideCtx(); fn(); };
      menu.appendChild(b);
    };
    add("详情…（声道/音量）", "", () => openTrackDetail(tr));
    add("重命名", "F2", () => renameTrack(tr));
    menu.appendChild(el("div", "ctxsep"));
    /* 整轨批量：这条轨上的片段多起来以后，一条条改混响/属性很痛苦 */
    add(`🌫 整轨混响…（${(tr.clips || []).length} 段一起改）`, "", () => trackReverbDialog(tr));
    add(`📌 把复制的属性套到整轨…（${(tr.clips || []).length} 段）`, "Ctrl+Shift+V",
      () => propsPasteDialog((tr.clips || []).slice(),
        { track: true, title: `把属性套到「${tr.name}」整轨（${(tr.clips || []).length} 段）` }));
    add("⚖ 整轨统一音量…", "", () => trackGainDialog(tr));
    menu.appendChild(el("div", "ctxsep"));
    const gname = tr.kind === "voice" ? "音声轨组" : "素材轨组";
    add(`移到${gname}第一条`, "⇤", () => moveTrack(tr.id, "top"));
    add(`移到${gname}最后一条`, "⇥", () => moveTrack(tr.id, "bottom"));
    add("组内上移一格", "▲", () => moveTrack(tr.id, -1));
    add("组内下移一格", "▼", () => moveTrack(tr.id, 1));
    menu.appendChild(el("div", "ctxsep"));
    add("静音", "M", () => patchTrack(tr.id, { mute: !tr.mute }));
    add("独奏", "S", () => patchTrack(tr.id, { solo: !tr.solo }));
    menu.appendChild(el("div", "ctxsep"));
    add("删除音轨", "Del", () => deleteTrack(tr), true);
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(cx, window.innerWidth - r.width - 8) + "px";
    menu.style.top = Math.min(cy, window.innerHeight - r.height - 8) + "px";
  }

  /* 整轨混响：一次把这条轨上所有片段设成同一个房间 / 湿度，
     也可以顺手统一「双耳空间」和 HRIR 数据集。片段级关键帧一个都不动。 */
  function trackReverbDialog(tr) {
    const cs = (tr.clips || []).slice();
    if (!cs.length) { toast("这条轨上还没有片段", true); return; }
    const first = cs[0];
    modal(`整轨混响 · ${tr.name}`, (box) => {
      box.appendChild(el("div", "phint",
        `会给这条轨上的 ${cs.length} 段一起设混响。片段自己的音量 / 关键帧 / 位置都不动。`));
      const f1 = el("div", "field");
      f1.appendChild(fieldLabel("房间", ""));
      const sel = document.createElement("select");
      sel.className = "sel";
      sel.innerHTML = '<option value="">— 干声（关掉混响）—</option>'
        + ROOMS.map((r) => `<option value="${r.id}">${r.name}</option>`).join("");
      sel.value = first.room || "";
      f1.appendChild(sel);
      box.appendChild(f1);

      const f2 = el("div", "field");
      f2.appendChild(fieldLabel("湿度（送出量）", ""));
      const rng = document.createElement("input");
      rng.type = "range"; rng.min = "0"; rng.max = "1"; rng.step = "0.01";
      rng.value = String(Number(first.send) || 0.2); rng.className = "grow";
      const out = el("span", "mono", Number(rng.value).toFixed(2));
      rng.oninput = () => { out.textContent = Number(rng.value).toFixed(2); };
      const row = el("div", "row2");
      row.appendChild(rng); row.appendChild(out);
      f2.appendChild(row);
      box.appendChild(f2);

      const f3 = el("div", "field");
      f3.appendChild(fieldLabel("顺便一起统一", ""));
      const bins = {};
      [["binaural", "打开双耳空间（HRTF）"], ["hrtf", "统一 HRIR 数据集"]].forEach(([k, lab]) => {
        const l = el("label", "chkrow");
        const cb = document.createElement("input");
        cb.type = "checkbox"; cb.checked = k === "binaural" ? !!first.binaural : false;
        bins[k] = cb;
        l.appendChild(cb); l.appendChild(el("span", null, lab));
        f3.appendChild(l);
      });
      const hsel = document.createElement("select");
      hsel.className = "sel";
      hsel.innerHTML = '<option value="">跟随全局</option>'
        + ["KU100", "MIT_KEMAR"].map((x) => `<option value="${x}">${x}</option>`).join("");
      hsel.value = first.hrtf || "";
      f3.appendChild(hsel);
      box.appendChild(f3);
      box.appendChild(el("div", "phint",
        "房间靠卷积 IR 实现，越湿越靠后；干声 = 完全不加混响。改完可以 Ctrl+Z 整体撤回。"));
      box.__read = () => ({
        room: sel.value, send: Number(rng.value) || 0,
        binaural: bins.binaural.checked, hrtf: hsel.value,
      });
    }, "应用到整轨", (box) => {
      const r = box.__read();
      undoMark("整轨混响");
      cs.forEach((c) => {
        c.room = r.room;
        c.send = r.room ? r.send : 0;
        if (r.binaural) c.binaural = true;
        if (r.hrtf) c.hrtf = r.hrtf;
        writeClipOverride(c);
      });
      markDirty("整轨混响");
      drawInspector(); draw();
      persist("整轨混响");
      toast(`已给「${tr.name}」的 ${cs.length} 段设混响：${r.room ? r.room : "干声"}`);
      box.closest(".mask")?.remove();
      return true;
    });
  }

  /* 整轨音量：统一成某个值，或按比例增减 */
  function trackGainDialog(tr) {
    const cs = (tr.clips || []).slice();
    if (!cs.length) { toast("这条轨上还没有片段", true); return; }
    modal(`整轨音量 · ${tr.name}`, (box) => {
      box.appendChild(el("div", "phint", `作用于这条轨上的 ${cs.length} 段。`));
      const f = el("div", "field");
      f.appendChild(fieldLabel("统一到", "%"));
      const rng = document.createElement("input");
      rng.type = "range"; rng.min = "0"; rng.max = "2"; rng.step = "0.01";
      rng.value = "1"; rng.className = "grow";
      const out = el("span", "mono", "100%");
      rng.oninput = () => { out.textContent = Math.round(rng.value * 100) + "%"; };
      const row = el("div", "row2");
      row.appendChild(rng); row.appendChild(out);
      f.appendChild(row);
      box.appendChild(f);
      const mode = el("div", "radios");
      mode.innerHTML = '<label><input type="radio" name="gmode" value="set" checked> 全部设成这个音量</label>'
        + '<label><input type="radio" name="gmode" value="mul"> 在各自音量上乘这个系数</label>';
      box.appendChild(mode);
      box.__read = () => ({
        v: Number(rng.value) || 0,
        mode: (box.querySelector('input[name="gmode"]:checked') || {}).value || "set",
      });
    }, "应用", (box) => {
      const r = box.__read();
      undoMark("整轨音量");
      cs.forEach((c) => {
        c.gain = r.mode === "set" ? r.v : clamp((c.gain || 1) * r.v, 0, 2);
        writeClipOverride(c);
      });
      markDirty("整轨音量");
      drawInspector(); draw();
      persist("整轨音量");
      toast(`已调整「${tr.name}」的 ${cs.length} 段音量`);
      box.closest(".mask")?.remove();
      return true;
    });
  }

  // 轨道详情弹窗：名称/音量/左右声道平衡/静音/独奏
  function openTrackDetail(tr) {    const mask = el("div", "mask");
    const box = el("div", "modal");
    box.appendChild(el("h3", null, `音轨详情 · ${tr.kind === "voice" ? "音声" : "素材"}`));
    const state = { name: tr.name, gain: tr.gain, pan: tr.pan || 0, mute: !!tr.mute, solo: !!tr.solo };

    const field = (label, node, hint) => {
      const f = el("div", "field");
      f.appendChild(el("span", null, label));
      f.appendChild(node);
      if (hint) f.appendChild(el("span", null, hint));
      return f;
    };
    // 名称
    const ni = document.createElement("input");
    ni.type = "text"; ni.value = state.name;
    ni.oninput = () => { state.name = ni.value; };
    box.appendChild(field("名称", ni));
    // 音量
    const gv = el("span", "val", Math.round(state.gain * 100) + "%");
    const gr = document.createElement("input");
    gr.type = "range"; gr.min = "0"; gr.max = "2"; gr.step = "0.01"; gr.value = state.gain;
    gr.title = "靠近 100% 自动吸附；双击复位";
    gr.oninput = () => {
      let v = parseFloat(gr.value);
      if (Math.abs(v - 1) <= 0.05) { v = 1; gr.value = "1"; }
      state.gain = v; gv.textContent = Math.round(v * 100) + "%";
    };
    gr.ondblclick = () => { gr.value = "1"; state.gain = 1; gv.textContent = "100%"; };
    const grow = el("div", "rowline");
    grow.style.flex = "1"; grow.appendChild(gr); grow.appendChild(gv);
    box.appendChild(field("音量", grow));
    // 声道平衡
    const pv = el("span", "val", panLabel(state.pan));
    const pr = document.createElement("input");
    pr.type = "range"; pr.min = "-1"; pr.max = "1"; pr.step = "0.01"; pr.value = state.pan;
    pr.title = "靠近居中自动吸附；双击复位";
    pr.oninput = () => {
      let v = parseFloat(pr.value);
      if (Math.abs(v) <= 0.05) { v = 0; pr.value = "0"; }
      state.pan = v; pv.textContent = panLabel(v);
    };
    pr.ondblclick = () => { pr.value = "0"; state.pan = 0; pv.textContent = panLabel(0); };
    const prow = el("div", "rowline");
    prow.style.flex = "1"; prow.appendChild(pr); prow.appendChild(pv);
    box.appendChild(field("左右声道平衡", prow, "L=左声道 / C=居中 / R=右声道"));
    // 静音 / 独奏
    const chkRow = el("div", "rowline");
    const mk = (label, key) => {
      const lb = el("label", "check");
      const inp = document.createElement("input");
      inp.type = "checkbox"; inp.checked = state[key];
      inp.onchange = () => { state[key] = inp.checked; };
      lb.appendChild(inp); lb.appendChild(el("span", null, label));
      return lb;
    };
    chkRow.appendChild(mk("静音", "mute"));
    chkRow.appendChild(mk("独奏", "solo"));
    box.appendChild(chkRow);

    const foot = el("div", "foot");
    const cancel = el("button", "btn ghost", "取消");
    cancel.onclick = () => mask.remove();
    const ok = el("button", "btn primary", "保存");
    ok.onclick = async () => {
      ok.disabled = true;
      try {
        await fetch(`${API}/tracks/${tr.id}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: state.name.trim() || tr.name,
            gain: state.gain, pan: state.pan,
            mute: state.mute, solo: state.solo,
          }),
        });
        mask.remove();
        reload();
      } finally { ok.disabled = false; }
    };
    foot.appendChild(cancel); foot.appendChild(ok);
    box.appendChild(foot);
    mask.appendChild(box);
    mask.onclick = (e) => { if (e.target === mask) mask.remove(); };
    document.body.appendChild(mask);
  }

  function panLabel(v) {
    if (Math.abs(v) < 0.02) return "居中";
    return (v < 0 ? "L" : "R") + Math.round(Math.abs(v) * 100) + "%";
  }

  // 一键清理空白音轨（每类至少保留一条）
  /* ============ 重叠检测 / 一键整理（保持时间不变） ============
     为什么需要：EDL（PR / 达芬奇）里「一条轨 = 一个声道」，同一时间放两段会被截断或丢掉一段；
     Reaper 的 rpp 虽然允许叠，但同一轨两段同时出声、位置也看不清。所以导出工程前要提醒。
     「整理」只改片段所在的轨道，start / dur / offset 全部不动。
  */
  function overlapPairs() {
    const out = [];
    for (const tr of tracks()) {
      const cs = [...tr.clips].sort((a, b) => a.start - b.start);
      for (let i = 0; i < cs.length; i++) {
        const a = cs[i];
        const ae = a.start + a.dur;
        for (let j = i + 1; j < cs.length; j++) {
          const b = cs[j];
          if (b.start >= ae - 1e-4) break;
          const be = b.start + b.dur;
          out.push({ track: tr, a, b, over: Math.min(ae, be) - b.start });
        }
      }
    }
    return out;
  }

  function trackFits(occ, id, s, e) {
    const arr = occ[id] || [];
    for (const [a, b] of arr) if (s < b - 1e-4 && e > a + 1e-4) return false;
    return true;
  }

  function distributeOverlaps() {
    if (!S.data) return { moved: 0, created: 0, left: 0 };
    let moved = 0, created = 0;
    for (const kind of ["voice", "sfx"]) {
      const occ = {};
      const order = [];
      tracks().filter((t) => t.kind === kind).forEach((tr) => {
        [...tr.clips].sort((a, b) => a.start - b.start).forEach((c) => order.push({ tr, c }));
      });
      for (const { tr, c } of order) {
        const s0 = c.start, e0 = c.start + c.dur;
        if (trackFits(occ, tr.id, s0, e0)) {
          (occ[tr.id] = occ[tr.id] || []).push([s0, e0]);
          continue;
        }
        const curIdx = S.data.tracks.indexOf(tr);
        const cands = S.data.tracks
          .filter((t) => t.kind === kind && t.id !== tr.id)
          .sort((x, y) => Math.abs(S.data.tracks.indexOf(x) - curIdx)
            - Math.abs(S.data.tracks.indexOf(y) - curIdx));
        let target = cands.find((t) => trackFits(occ, t.id, s0, e0));
        if (!target) {
          const n = tracks().filter((t) => t.kind === kind).length + 1;
          target = {
            id: "t" + uid(), name: (kind === "voice" ? "音声轨 " : "素材轨 ") + n,
            kind, gain: 1, pan: 0, mute: false, solo: false, clips: [],
          };
          S.data.tracks.splice(curIdx + 1, 0, target);
          if (Array.isArray(S.data.project.tracks)) {
            const pi = S.data.project.tracks.findIndex((t) => t.id === tr.id);
            const at = pi < 0 ? S.data.project.tracks.length : pi + 1;
            S.data.project.tracks.splice(at, 0, {
              id: target.id, name: target.name, kind, gain: 1, pan: 0, mute: false, solo: false,
            });
          }
          created++;
        }
        tr.clips = tr.clips.filter((z) => z !== c);
        target.clips = target.clips || [];
        target.clips.push(c);
        c.track = target.id;
        commitClip(c, "整理重叠");
        (occ[target.id] = occ[target.id] || []).push([s0, e0]);
        moved++;
      }
    }
    if (moved) {
      markDirty();
      buildHeads();
      drawInspector();
      resize();
      draw();
      updateOverlapBadge();
    }
    return { moved, created, left: overlapPairs().length };
  }

  function fixOverlapsUI() {
    const pairs = overlapPairs();
    if (!pairs.length) { toast("没有重叠，轨道已经很干净"); return; }
    const r = distributeOverlaps();
    const msg = `已整理重叠：移动 ${r.moved} 段${r.created ? `，新建 ${r.created} 条轨` : ""}` +
      (r.left ? `；仍有 ${r.left} 处没地方放（时间完全填满）` : "；现在每条轨都不重叠了");
    toast(msg, !!r.left);
  }

  function updateOverlapBadge() {
    const b = $("btnFixOverlap");
    if (!b || !S.data) return;
    const n = overlapPairs().length;
    b.textContent = n ? `⇄ 整理重叠 (${n})` : "⇄ 整理重叠";
    b.classList.toggle("warn", !!n);
    b.title = n
      ? `有 ${n} 处同轨重叠。点一下把它们挪到空白轨 / 邻近轨道（时间不变）`
      : "同一条音轨上没有重叠片段";
  }

  async function cleanEmptyTracks() {
    const tks = tracks();
    const keep = [];
    const seenKind = {};
    let removed = 0;
    for (const t of tks) {
      const hasClip = t.clips && t.clips.length > 0;
      if (hasClip) { keep.push(t); seenKind[t.kind] = true; continue; }
      if (!seenKind[t.kind]) { keep.push(t); seenKind[t.kind] = true; continue; }
      removed++;
    }
    if (!removed) { toast("没有空白音轨需要清理"); return; }
    if (!confirm(`将删除 ${removed} 条空白音轨（每类至少保留一条），继续？`)) return;
    const proj = {
      tracks: keep.map((t) => ({
        id: t.id, name: t.name, kind: t.kind,
        gain: t.gain, pan: t.pan, mute: t.mute, solo: t.solo,
      })),
      clips: S.data.project.clips || {},
      sfx: (S.data.project.sfx || []).filter((s) => keep.some((k) => k.id === s.track)),
    };
    const r = await fetch(`${API}/project`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(proj),
    });
    if (!r.ok) { toast("清理失败：" + (await r.text()), true); return; }
    toast(`已清理 ${removed} 条空白音轨`);
    reload();
  }

  /* ------------------------------ 标记 ------------------------------ */
  /* ------------------------------ 标签跟随 ------------------------------
     follow  : 标签跟着句子走（句子拖走 / 重生成变长，标签跟着动）
     fixed   : 钉在第一次冻结的位置（绝对时间）
     inline  : 只有句中标签跟着走
     between : 只有句间标签跟着走
     标签挂的音效是派生的，位置永远等于标签落点 —— 标签怎么动，音效就怎么动。 */
  const TAG_FOLLOW_TIP = {
    follow: "标签跟着句子走：句子拖动 / 重生成变长，句中·句间标签和它们的音效一起移动",
    fixed: "标签钉在第一次冻结的位置，句子怎么变都不动",
    inline: "只有句中标签跟着句子走，句间标签固定在首次位置",
    between: "只有句间标签跟着句子走，句中标签固定在首次位置",
  };

  function syncTagFollowUI() {
    const sel = $("tagFollowMode");
    if (!sel) return;
    const m = ((S.data && S.data.project && S.data.project.tagfollow) || {}).mode || "follow";
    sel.value = m;
    sel.title = TAG_FOLLOW_TIP[m] || "";
  }

  async function setTagFollow(mode, resnap) {
    if (!S.data) return;
    try {
      const r = await fetch(`${API}/tagfollow`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, resnap: !!resnap }),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) { toast("设置失败：" + (b.detail || r.status), true); return; }
      toast(`标签跟随：${b.label || mode}`
        + (b.frozen ? `（冻结 ${b.frozen} 个标签位置）` : "")
        + (mode === "follow" ? "" : "　不满意就再选一次「重新取当前位置」"));
      if (S.dirty) await save();
      await reload();
    } catch (e) {
      toast("设置失败：" + e.message, true);
    }
  }

  /* ------------------------------ 标记：筛选 / 多选 / 批量 / 右键 ------------------------------
     三种标记：
       句中（台本 line.inline）· 句间（台本里的标签行）· 普通（M 键手加，存在 project.marks）
     后两种都能被「标签跟随」挪位置，普通标记跟句子无关，永远钉在绝对时间上。 */
  const MFILTER = { kind: "all", sfxOnly: false };
  const MSEL = new Set();          // 选中的标记 key（标签用 marker.key，普通标记用 id）
  let MSEL_ANCHOR = null;          // Shift 连选的锚点

  function markerKeyOf(m) { return m.key || m.id; }
  function markerKindOf(m) { return m.custom ? "mark" : (m.inline ? "inline" : "tag"); }
  function markerHasSfx(m) { return !!(m.sfx_mid || (m.sfx && m.sfx.mid)); }
  function markersOf(kind) {
    return (S.data && S.data.markers) || [];
  }
  function markersVisible() {
    return markersOf().filter((m) => {
      if (MFILTER.kind !== "all" && markerKindOf(m) !== MFILTER.kind) return false;
      if (MFILTER.sfxOnly && !markerHasSfx(m)) return false;
      return true;
    });
  }
  function selMarkers() {
    const all = markersOf();
    return all.filter((m) => MSEL.has(markerKeyOf(m)));
  }
  function markerRangeSelect(m) {
    const list = markersVisible();
    const a = list.findIndex((x) => markerKeyOf(x) === MSEL_ANCHOR);
    const b = list.findIndex((x) => markerKeyOf(x) === markerKeyOf(m));
    if (a < 0 || b < 0) { MSEL.add(markerKeyOf(m)); return; }
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    for (let i = lo; i <= hi; i++) MSEL.add(markerKeyOf(list[i]));
  }
  function updateMarkerBar() {
    const bar = $("mBulk");
    const tip = $("mSelTip");
    const n = MSEL.size;
    if (!bar) return;
    bar.hidden = n === 0;
    if (tip) tip.textContent = `已选 ${n} 个标记`;
    const hasTag = selMarkers().some((m) => !m.custom);
    const hasMark = selMarkers().some((m) => m.custom);
    const hasSfx = selMarkers().some(markerHasSfx);
    const set = (id, on, why) => {
      const b = $(id);
      if (!b) return;
      b.disabled = !on;
      b.title = on ? (why || "") : "选中的标记里没有可以这么做的";
    };
    set("mBkSfx", hasTag, "给选中的标签/标记挂一个音效（普通标记会变成普通音效片段）");
    set("mBkDrop", hasSfx, "摘掉选中标记上挂的音效");
    set("mBkMute", hasSfx, "把选中标记挂的音效静音");
    set("mBkUnmute", hasSfx, "取消静音");
    set("mBkDel", hasMark, "只删普通标记（台本标签请回台本页删）");
  }

  /* 批量：把选中标记挂上同一个音效 / 摘掉 / 静音 */
  function tagKeysOf(list) {
    return list.filter((m) => !m.custom).map((m) => markerKeyOf(m));
  }
  async function tagSfxApply(list, mid) {
    const keys = tagKeysOf(list);
    if (!keys.length) { toast("选中的普通标记没有「挂音效」这个属性：请用 ＋♪ 插素材", true); return; }
    try {
      const r = await fetch(`${API}/tags/sfx`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys, mid, gain: 1.0 }),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) { toast(b.detail || "挂音效失败", true); return; }
      toast(mid ? `已给 ${b.changed} 个标签挂上音效` : `已摘掉 ${b.changed} 个标签的音效`);
      await reload();
    } catch (e) { toast("挂音效失败：" + e.message, true); }
  }
  async function tagMuteApply(list, mute) {
    const keys = tagKeysOf(list);
    if (!keys.length) { toast("普通标记没有音效可以静音", true); return; }
    try {
      const r = await fetch(`${API}/tags/mute`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys, mute }),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) { toast(b.detail || "操作失败", true); return; }
      toast(mute ? `已静音 ${b.changed} 个标签音效` : `已取消静音 ${b.changed} 个`);
      await reload();
    } catch (e) { toast("操作失败：" + e.message, true); }
  }

  /* 音效库挑一个（给标签挂音效用；插入素材仍走 openInsertPicker） */
  function pickSfxForTags(list) {
    const box = el("div");
    const q = document.createElement("input");
    q.className = "inp"; q.placeholder = "搜音效名…";
    box.appendChild(q);
    const info = el("div", "hint", `将给选中的 ${tagKeysOf(list).length} 个标签挂同一个音效。`);
    box.appendChild(info);
    const listBox = el("div", "picklist");
    box.appendChild(listBox);
    let sel = null;
    const draw = () => {
      listBox.innerHTML = "";
      const kw = (q.value || "").trim().toLowerCase();
      const rows = SFXLIB.filter((x) => !kw
        || ((x.name || "") + " " + (x.source || "") + " " + (x.file || "")).toLowerCase().includes(kw));
      if (!rows.length) {
        listBox.appendChild(el("div", "hint mempty",
          SFXLIB.length ? "没有匹配的音效" : "音效库是空的，先去「📥 导入台」存一段。"));
        return;
      }
      rows.forEach((it) => {
        const row = el("div", "pickrow" + (sel === it.id ? " cur" : ""));
        row.appendChild(el("span", "pn", it.name || it.file));
        row.appendChild(el("span", "pm", matMetaText(it)));
        row.onclick = () => { sel = it.id; draw(); };
        row.ondblclick = () => {
          sel = it.id;
          const ok = box.parentNode && box.parentNode.querySelector(".foot .btn.primary");
          if (ok) ok.click();
        };
        listBox.appendChild(row);
      });
    };
    q.oninput = draw;
    draw();
    q.focus();
    modal("给标签挂音效", box, async () => {
      if (!sel) { toast("先在下面挑一个音效", true); return false; }
      await tagSfxApply(list, sel);
    }, "挂上");
  }

  /* 标记的右键菜单（列表行 + 画布上的标记线都开这个） */
  function openMarkerMenu(m, cx, cy) {
    hideCtx();
    const key = markerKeyOf(m);
    if (!MSEL.has(key)) { MSEL.clear(); MSEL.add(key); MSEL_ANCHOR = key; drawMarkersList(); }
    const list = selMarkers().length ? selMarkers() : [m];
    const n = list.length;
    const tags = list.filter((x) => !x.custom);
    const marks = list.filter((x) => x.custom);
    const withSfx = list.filter(markerHasSfx);
    const menu = el("div", "ctxmenu");
    const add = (label, sub, fn, danger, disabled) => {
      const b = el("button", "ctxitem" + (danger ? " danger" : ""));
      b.appendChild(el("span", null, label));
      if (sub) b.appendChild(el("span", "k", sub));
      b.disabled = !!disabled;
      if (disabled) b.style.opacity = ".45";
      b.onclick = (ev) => { ev.stopPropagation(); hideCtx(); if (!disabled) fn(); };
      menu.appendChild(b);
    };
    add("跳到 " + fmt(m.time), "", () => seek(m.time));
    /* 右键落在标记线上时，也想把刚才复制的素材贴到这个时刻 —— 顺手带上，
       否则「标记正好在要贴的位置」反而贴不了（只能挪开半个像素再右键）。 */
    add("粘贴到这里", "Ctrl+V", async () => {
      if (!S.clipboard) { toast("剪贴板是空的：先 Ctrl+C 复制一段", true); return; }
      const tid = (sfxTracks()[0] || tracks()[0] || {}).id;
      const made = await pasteClipboard(m.time, tid);
      if (!made.length) return;
      persist("插入片段").then(() => {
        setMulti(made.map((x) => x.id));
        S.sel = made[made.length - 1].id;
        drawInspector(); draw();
        toast(`已粘贴到 ${fmt(m.time)}`);
      });
    }, false, !S.clipboard);
    menu.appendChild(el("div", "ctxsep"));
    add(`🔔 挂音效…${n > 1 ? `（${n} 个）` : ""}`, "", () => pickSfxForTags(list), false, !tags.length);
    add("✕ 移除音效", "", () => tagSfxApply(list, null), false, !withSfx.length);
    add("🔇 音效静音", "", () => tagMuteApply(list, true), false, !withSfx.length);
    add("🔊 取消音效静音", "", () => tagMuteApply(list, false), false, !withSfx.length);
    menu.appendChild(el("div", "ctxsep"));
    add("＋♪ 在此插入素材…", "", () => openInsertPicker(m.time, null, "sfx"));
    if (m.custom) {
      add("重命名…", "", () => renameMark(m));
      add(`🗑 删除标记${n > 1 && marks.length > 1 ? `（${marks.length} 个）` : ""}`, "Del",
        () => { marks.forEach((x) => delMarkOrQueue(x)); }, true, !marks.length);
    } else {
      add("标签要在台本页改 / 删", "", () => {}, false, true);
    }
    document.body.appendChild(menu);
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.min(cx, window.innerWidth - w - 8) + "px";
    menu.style.top = Math.min(cy, window.innerHeight - h - 8) + "px";
  }

  function delMarkOrQueue(m) { delMark(m.id); }

  function renameMark(m) {
    const v = prompt("标记名称", m.name || "标记");
    if (v == null) return;
    const name = v.trim();
    if (!name) return;
    fetch(`${API}/marks/${m.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }).then(async (r) => {
      if (!r.ok) { toast("改名失败", true); return; }
      m.name = name;
      drawMarkersList(); draw();
      toast("已改名");
    });
  }

  function drawMarkersList() {
    const box = $("markerList");
    box.innerHTML = "";
    const all = markersOf();
    const mc = $("markerCount");
    if (mc) mc.textContent = String(all.length);
    if (!all.length) {
      box.appendChild(el("div", "hint",
        "还没有标记点。台本里可以用「＋ 句间标签」加；时间轴上在播放头按 M "
        + "（或空白处右键「添加标记点」）也能加。"));
      updateMarkerBar();
      return;
    }
    // 筛选项上的数字
    const cnt = { all: all.length, inline: 0, tag: 0, mark: 0, sfx: 0 };
    all.forEach((m) => {
      cnt[markerKindOf(m)] += 1;
      if (markerHasSfx(m)) cnt.sfx += 1;
    });
    document.querySelectorAll("#mFilters .chip").forEach((b) => {
      const k = b.dataset.mf;
      b.classList.toggle("on", k === "sfx" ? MFILTER.sfxOnly : (MFILTER.kind === k && !MFILTER.sfxOnly));
      const n = k === "sfx" ? cnt.sfx : cnt[k];
      b.textContent = b.dataset.label + (n ? ` ${n}` : "");
    });
    const rows = markersVisible();
    if (!rows.length) {
      box.appendChild(el("div", "hint", "这个筛选条件下没有标记（点「全部」看看）"));
      updateMarkerBar();
      return;
    }
    rows.forEach((m) => {
      const key = markerKeyOf(m);
      const row = el("div", "markerrow" + (m.pinned ? " pinned" : "") + (MSEL.has(key) ? " sel" : ""));
      row.dataset.mk = key;
      row.appendChild(el("span", "mt", fmt(m.time)));
      row.appendChild(el("span", "mg",
        (m.custom ? "〔标记〕" : (m.inline ? "〔句中〕" : "〔句间〕")) + (m.name || "")));
      if (m.pinned) {
        const pin = el("span", "mpin", "📌");
        pin.title = "按「标签跟随」设置，这个标签固定在首次位置，不跟句子走";
        row.appendChild(pin);
      }
      if (markerHasSfx(m)) {
        const b = el("span", "mfromtag", "🔔");
        b.title = "这个标签挂了音效：已在素材轨上自动放好（位置 = 标签落点"
          + (m.inline ? "" : " + 留白") + "），标签怎么动它就怎么动";
        row.appendChild(b);
      }
      const tools = el("span", "mi");
      const b1 = el("button", "iconbtn", "＋♪");
      b1.title = "在这个标记处插入音效素材（从音效库挑）";
      b1.onclick = (e) => { e.stopPropagation(); openInsertPicker(m.time, null, "sfx"); };
      tools.appendChild(b1);
      if (m.custom) {
        const bDel = el("button", "iconbtn", "✕");
        bDel.title = "删除这个标记点（只删标记，不动音频）";
        bDel.onclick = (e) => {
          e.stopPropagation();
          if (confirm(`删除 ${fmt(m.time)} 的标记点？`)) delMark(m.id);
        };
        tools.appendChild(bDel);
      }
      row.appendChild(tools);
      row.onclick = (e) => {
        if (e.ctrlKey || e.metaKey) {
          if (MSEL.has(key)) MSEL.delete(key); else MSEL.add(key);
          MSEL_ANCHOR = key;
        } else if (e.shiftKey && MSEL_ANCHOR) {
          markerRangeSelect(m);
        } else {
          MSEL.clear(); MSEL.add(key); MSEL_ANCHOR = key;
          seek(m.time);
        }
        drawMarkersList();
      };
      row.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        openMarkerMenu(m, e.clientX, e.clientY);
      };
      box.appendChild(row);
    });
    updateMarkerBar();
  }

  /* ------------------------------ 素材库 ------------------------------
     与全能音声工作台保持同一套「单向流水线」：
        素材导入台（中转） → 音效库（成品，可反复插入）/ 音色库（只用于生成语音）
     时间轴只需要「能被当素材插入」的东西，所以这里只有两个页签：
        · 🔔 音效库  —— 导入台存出来的成品，跨工程复用
        · 本工程    —— 工程目录 media/ 里的副本（插入过的都会在这留一份）
     以前多出来的「🎙 音色库」页签是错的：音色是喂给 TTS 模型的，不能当素材插入，
     把它放在素材库里会让人以为两个库是一回事。
  */
  /* 三个库都是**全局**的（跨台本/工程共用，存在 longform/ 下）：
       · 音效库   longform/sfx/        成品音效
       · 音色库   longform/refs/       参考音频 / 克隆音色
       · 导入台   longform/materials/  还没处理、没标记的原始素材
     工程目录里 media/ 只是「插入时拷一份副本」，让工程自带素材、换机器能开，
     它不再是「一个工程一个素材库」——这个页签已经删掉了。 */
  let MEDIA = [];          // 导入台素材库
  let REFS = [];           // 音色素材库
  let mediaQuery = "";
  let MTAB = localStorage.getItem("tl.mtab") || "sfx";
  let SFXLIB = [];
  let sfxPrev = null, sfxPrevId = null;    // 试听器（三个库共用）
  const mtKey = (kind, id) => kind + ":" + id;

  async function loadMedia() {
    try {
      const r = await fetch(`${LFAPI}/media`);
      MEDIA = (await r.json()).items || [];
    } catch (e) { MEDIA = []; }
    await loadSfxLib(false);
    await loadRefsLib(false);
    drawMediaList();
  }

  async function loadSfxLib(redraw = true) {
    try {
      const r = await fetch(`${LFAPI}/sfx`);
      SFXLIB = (await r.json()).items || [];
    } catch (e) { SFXLIB = []; }
    if (redraw) drawMediaList();
  }

  async function loadRefsLib(redraw = true) {
    try {
      const r = await fetch(`${LFAPI}/meta`);
      REFS = (await r.json()).refs || [];
    } catch (e) { REFS = []; }
    if (redraw) drawMediaList();
  }

  const MTAB_HINT = {
    sfx: "音效库（全局）：导入台存出来的成品。拖到素材轨插入，或「＋」插到播放头。",
    ref: "音色库（全局）：主界面/工作台的音色与参考音频。可试听；也能当素材插进时间轴。",
    mat: "导入台素材库（全局）：还没处理/标记的原始素材。用得上的先插进来，"
      + "要处理或存成音效请点「📥 素材导入台」。",
  };

  function matMetaText(x) {
    const bits = [];
    if (x.dur) bits.push(x.dur >= 60 ? `${Math.floor(x.dur / 60)}:${String(Math.round(x.dur % 60)).padStart(2, "0")}` : x.dur.toFixed(1) + "s");
    if (x.sr) bits.push((x.sr / 1000).toFixed(1) + "k");
    if (x.ch) bits.push(x.ch >= 2 ? "立体声" : "单声道");
    return bits.join(" · ");
  }

  function matRow(opt) {
    // opt: {key, name, title, src, meta, draggable, dnd:{type,value}, play, insert, menu, dbl}
    const row = el("div", "mediaitem");
    row.dataset.name = opt.key;
    row.title = opt.title || "";
    if (opt.draggable && opt.dnd) {
      row.draggable = true;
      row.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData(opt.dnd.type, opt.dnd.value);
        e.dataTransfer.effectAllowed = "copy";
        row.classList.add("dragging");
      });
      row.addEventListener("dragend", () => row.classList.remove("dragging"));
    }
    // 两行式：第一行名字（+ 来源小标），第二行时长/采样率/声道。
    // 右栏只有 300px，挤成一行会把名字压成「340…」，根本分不清是哪个。
    const main = el("div", "mmain");
    const l1 = el("div", "ml1");
    l1.appendChild(el("span", "mn", opt.name));
    if (opt.src) l1.appendChild(el("span", "msrc", opt.src));
    main.appendChild(l1);
    if (opt.meta) main.appendChild(el("div", "ml2", opt.meta));
    row.appendChild(main);
    const acts = el("div", "mact");
    if (opt.play) {
      const b = el("button", "iconbtn", opt.playing ? "⏸" : "▶");
      b.title = "试听 / 暂停";
      b.onclick = (e) => { e.stopPropagation(); opt.play(b); };
      acts.appendChild(b);
    }
    if (opt.insert) {
      const b = el("button", "iconbtn", "＋");
      b.title = "插入到播放头";
      b.onclick = (e) => { e.stopPropagation(); opt.insert(); };
      acts.appendChild(b);
    }
    if (opt.menu) {
      const b = el("button", "iconbtn", "⋯");
      b.title = "更多（属性 / 重命名 / 删除）";
      b.onclick = (e) => { e.stopPropagation(); opt.menu(e.clientX, e.clientY); };
      acts.appendChild(b);
      row.oncontextmenu = (e) => { e.preventDefault(); opt.menu(e.clientX, e.clientY); };
    }
    if (opt.dbl) row.ondblclick = () => opt.dbl();
    row.appendChild(acts);
    return row;
  }

  function drawMediaList() {
    const box = $("mediaList");
    if (!box) return;
    box.innerHTML = "";
    if (!["sfx", "ref", "mat"].includes(MTAB)) MTAB = "sfx";
    document.querySelectorAll("#mSeg .msb").forEach((b) => {
      b.classList.toggle("cur", b.dataset.mt === MTAB);
    });
    if ($("mediaHint")) $("mediaHint").textContent = MTAB_HINT[MTAB] || "";
    // 上传/入库统一走「素材导入台」，时间轴里不再往工程目录临时塞文件
    if ($("btnMediaUpload")) $("btnMediaUpload").style.display = "none";
    if (MTAB === "sfx") { drawSfxList(box); return; }
    if (MTAB === "ref") { drawRefList(box); return; }
    drawMatList(box);
  }

  /* ---- 导入台素材库（全局；未处理/未标记的原始素材） ---- */
  function drawMatList(box) {
    const cnt = $("mediaCount");
    if (cnt) cnt.textContent = MEDIA.length;
    const q = mediaQuery.trim().toLowerCase();
    const list = q ? MEDIA.filter((m) => (m.name || "").toLowerCase().includes(q)) : MEDIA;
    if (!MEDIA.length) {
      box.appendChild(el("div", "hint mempty",
        "导入台是空的。点上面「📥 素材导入台」上传音频/视频，处理完可以存成音效或音色；"
        + "没处理的原始素材会一直留在这里。"));
      return;
    }
    if (!list.length) { box.appendChild(el("div", "hint mempty", "没有匹配的素材。")); return; }
    for (const m of list) {
      const display = (m.name || "").replace(/\.wav$/, "").replace(/_[0-9a-f]{6}$/, "");
      box.appendChild(matRow({
        key: "mat:" + m.id, name: display, meta: matMetaText(m),
        src: m.op ? m.op.split("+")[0] : (m.kind === "video" ? "视频" : "导入台"),
        title: "拖到素材轨插入 · 双击插入到播放头 · 右键更多",
        draggable: true, dnd: { type: "text/mat", value: m.id },
        playing: sfxPrevId === mtKey("mat", m.id),
        play: () => previewLib("mat", m),
        insert: () => insertMatLib(m.id, S.pos, (sfxTracks()[0] || tracks()[0]).id),
        dbl: () => insertMatLib(m.id, S.pos, (sfxTracks()[0] || tracks()[0]).id),
        menu: (x, y) => openMatMenu(m, x, y),
      }));
    }
  }

  /* ---- 音色素材库（全局；参考音频 / 克隆音色） ---- */
  function drawRefList(box) {
    const cnt = $("mediaCount");
    if (cnt) cnt.textContent = REFS.length;
    const q = mediaQuery.trim().toLowerCase();
    const list = q ? REFS.filter((m) => (m.name || "").toLowerCase().includes(q)) : REFS;
    if (!REFS.length) {
      box.appendChild(el("div", "hint mempty",
        "音色库是空的。回工作台「🎙 音色素材库」上传一段参考音频，这里就会看到。"));
      return;
    }
    if (!list.length) { box.appendChild(el("div", "hint mempty", "没有匹配的音色。")); return; }
    for (const m of list) {
      box.appendChild(matRow({
        key: "ref:" + m.id, name: m.name || m.id,
        meta: matMetaText({ dur: m.dur, sr: null, ch: null }),
        src: m.group || (String(m.id).startsWith("p:") ? "内置" : "我的音色"),
        title: "试听 · 插入到素材轨（当参考声用）· 右键更多",
        draggable: true, dnd: { type: "text/ref", value: m.id },
        playing: sfxPrevId === mtKey("ref", m.id),
        play: () => previewLib("ref", m),
        insert: () => insertRefLib(m.id, m.name, S.pos, (sfxTracks()[0] || tracks()[0]).id),
        dbl: () => insertRefLib(m.id, m.name, S.pos, (sfxTracks()[0] || tracks()[0]).id),
        menu: (x, y) => openRefMenu(m, x, y),
      }));
    }
  }

  /* ---- 音效素材库（只读 + 插入；管理在导入台） ---- */
  function drawSfxList(box) {
    const cnt = $("mediaCount");
    if (cnt) cnt.textContent = SFXLIB.length;
    const q = mediaQuery.trim().toLowerCase();
    const list = q ? SFXLIB.filter((m) => (m.name || "").toLowerCase().includes(q)) : SFXLIB;
    if (!SFXLIB.length) {
      box.appendChild(el("div", "hint mempty",
        "音效库是空的。点上面「📥 导入台」上传/处理一段音频，存进音效库就会出现在这里。"));
      return;
    }
    if (!list.length) { box.appendChild(el("div", "hint mempty", "没有匹配的音效。")); return; }
    for (const m of list) {
      box.appendChild(matRow({
        key: "sfx:" + m.id, name: m.name, meta: matMetaText(m),
        src: m.op ? m.op.split("+")[0] : "音效",
        title: "拖到素材轨插入 · 双击插入到播放头 · 右键更多",
        draggable: true, dnd: { type: "text/sfx", value: m.id },
        playing: sfxPrevId === mtKey("sfx", m.id),
        play: () => previewSfxLib(m),
        insert: () => insertSfxLib(m.id, S.pos, (sfxTracks()[0] || tracks()[0]).id),
        dbl: () => insertSfxLib(m.id, S.pos, (sfxTracks()[0] || tracks()[0]).id),
        menu: (x, y) => openSfxMenu(m, x, y),
      }));
    }
  }

  /* 试听：三个库共用一只播放器，sfxPrevId 存 "kind:id" */
  function previewLib(kind, m) {
    const key = mtKey(kind, m.id || m.name);
    if (sfxPrevId === key) { sfxPrev.pause(); sfxPrevId = null; drawMediaList(); return; }
    if (!sfxPrev) {
      sfxPrev = new Audio();
      sfxPrev.onended = () => { sfxPrevId = null; drawMediaList(); };
    }
    const url = kind === "sfx" ? `${LFAPI}/sfx/${encodeURIComponent(m.id)}/audio`
      : kind === "mat" ? `${LFAPI}/media/${encodeURIComponent(m.id)}/audio`
        : `${LFAPI}/refs/${encodeURIComponent(m.id)}/audio`;
    sfxPrev.src = `${url}?t=${Date.now()}`;
    sfxPrev.play().then(() => { sfxPrevId = key; drawMediaList(); })
      .catch(() => toast("这个音频读不出来", true));
  }
  function previewSfxLib(m) { return previewLib("sfx", m); }

  /* 从任意库拷一份进工程目录再插入：三个库走同一条流程 */
  async function insertFromLib(url, payload, at, trackId) {
    try {
      const r = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || "拷贝失败");
      const item = addSfx(d.name, at, trackId || (sfxTracks()[0] || tracks()[0]).id,
        d.dur, d.display);
      if (!item) return null;
      await persist("插入素材");
      S.sel = item.id;
      drawInspector(); draw();
      toast(`已插入「${d.display || d.name}」`);
      return item;
    } catch (e) {
      toast("插入失败：" + e.message, true);
      return null;
    }
  }
  const insertSfxLib = (mid, at, trackId) =>
    insertFromLib(`${API}/media/from-sfx`, { mid }, at, trackId);
  const insertMatLib = (mid, at, trackId) =>
    insertFromLib(`${API}/media/from-material`, { mid }, at, trackId);
  const insertRefLib = (rid, name, at, trackId) =>
    insertFromLib(`${API}/media/from-ref`, { rid, name }, at, trackId);

  function copyText(t) {
    const done = () => toast(`已复制：${String(t).slice(0, 40)}`);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(done).catch(() => {
          const ta = document.createElement("textarea");
          ta.value = t;
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand("copy"); done(); } catch (e) { /* 忽略 */ }
          ta.remove();
        });
        return;
      }
    } catch (e) { /* 忽略 */ }
    const ta = document.createElement("textarea");
    ta.value = t;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch (e) { /* 忽略 */ }
    ta.remove();
  }

  /* ---- 右键菜单（三个来源共用一套构造函数） ---- */
  function buildMenu(cx, cy, entries) {
    hideCtx();
    const menu = el("div", "ctxmenu");
    for (const it of entries) {
      if (it === "-") { menu.appendChild(el("div", "ctxsep")); continue; }
      if (it.head) { menu.appendChild(el("div", "ctxhead", it.head)); continue; }
      const b = el("button", "ctxitem" + (it.danger ? " danger" : "") + (it.disabled ? " disabled" : ""));
      b.appendChild(el("span", null, it.label));
      if (it.key) b.appendChild(el("span", "k", it.key));
      if (!it.disabled) b.onclick = (ev) => { ev.stopPropagation(); hideCtx(); it.fn(); };
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(cx, window.innerWidth - r.width - 8)) + "px";
    menu.style.top = Math.max(4, Math.min(cy, window.innerHeight - r.height - 8)) + "px";
    ctxAt = performance.now();
    return menu;
  }


  // 导入台素材
  function openMatMenu(m, cx, cy) {
    const nm = (m.name || "").replace(/\.wav$/, "");
    buildMenu(cx, cy, [
      { head: nm + " · " + (m.dur ? m.dur.toFixed(1) + "s" : "-") },
      { label: sfxPrevId === mtKey("mat", m.id) ? "⏸ 停止试听" : "▶ 试听", fn: () => previewLib("mat", m) },
      { label: "ℹ 属性（声道 / 格式 / 采样率 / 位深…）", fn: () => showProps("mat", m.id) },
      "-",
      { label: "＋ 插入到播放头", fn: () => insertMatLib(m.id, S.pos, (sfxTracks()[0] || tracks()[0]).id) },
      { label: "＋ 插入到某条素材轨开头", fn: () => insertMatLib(m.id, 0, (sfxTracks()[0] || tracks()[0]).id) },
      "-",
      { label: "⧉ 复制名称", fn: () => copyText(nm) },
      {
        label: "📥 去导入台：处理 / 存成音效或音色", fn: () => {
          window.open(`/longform?desk=1&target=sfx&mat=${encodeURIComponent(m.id)}`, "_blank");
        },
      },
    ]);
  }

  // 音色素材
  function openRefMenu(m, cx, cy) {
    buildMenu(cx, cy, [
      { head: (m.name || m.id) + " · " + (m.dur ? m.dur.toFixed(1) + "s" : "-") },
      { label: sfxPrevId === mtKey("ref", m.id) ? "⏸ 停止试听" : "▶ 试听", fn: () => previewLib("ref", m) },
      { label: "ℹ 属性（声道 / 格式 / 采样率 / 位深…）", fn: () => showProps("ref", m.id) },
      "-",
      { label: "＋ 插入到播放头（当参考声）", fn: () => insertRefLib(m.id, m.name, S.pos, (sfxTracks()[0] || tracks()[0]).id) },
      { label: "＋ 插入到某条素材轨开头", fn: () => insertRefLib(m.id, m.name, 0, (sfxTracks()[0] || tracks()[0]).id) },
      "-",
      { label: "⧉ 复制名称", fn: () => copyText(m.name || m.id) },
      { label: "🎙 去工作台音色库（设为默认 / 用于生成）", fn: () => { window.open("/longform", "_blank"); } },
    ]);
  }

  // 音效库条目
  function openSfxMenu(m, cx, cy) {
    buildMenu(cx, cy, [
      { head: m.name + " · " + (m.dur ? m.dur.toFixed(1) + "s" : "-") },
      { label: sfxPrevId === mtKey("sfx", m.id) ? "⏸ 停止试听" : "▶ 试听", fn: () => previewSfxLib(m) },
      { label: "ℹ 属性（声道 / 格式 / 采样率 / 位深…）", fn: () => showProps("sfx", m.id) },
      "-",
      { label: "＋ 插入到播放头", fn: () => insertSfxLib(m.id, S.pos, (sfxTracks()[0] || tracks()[0]).id) },
      { label: "＋ 插入到某条素材轨开头", fn: () => insertSfxLib(m.id, 0, (sfxTracks()[0] || tracks()[0]).id) },
      "-",
      { label: "⧉ 复制名称", fn: () => copyText(m.name) },
      {
        label: "📥 去导入台改一改", fn: () => {
          window.open(`/longform?desk=1&target=sfx&sfx=${encodeURIComponent(m.id)}`, "_blank");
        },
      },
      { label: "管理音效库（打开导入台）", fn: () => window.open("/longform?desk=1&target=sfx", "_blank") },
    ]);
  }

  /* 音频属性（本工程 / 音效库） */
  async function showProps(kind, key) {
    const url = kind === "mat" ? `${LFAPI}/media/${encodeURIComponent(key)}/info`
      : kind === "ref" ? `${LFAPI}/refs/${encodeURIComponent(key)}/info`
        : `${LFAPI}/sfx/${encodeURIComponent(key)}/info`;
    let info;
    try {
      const r = await fetch(url);
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || "读取失败");
      info = d.info || {};
    } catch (e) { toast("读不到属性：" + e.message, true); return; }
    modal("音频属性", (box) => {
      const tb = el("table", "ptable");
      const rows = [
        ["名称", info.name || "—"],
        ["文件", info.file || "—"],
        ["容器 / 编码", `${info.format || "—"}${info.subtype ? " · " + info.subtype : ""}`],
        ["位深", info.bit_depth ? info.bit_depth + " bit" : "—"],
        ["采样率", info.sample_rate ? `${info.sample_rate} Hz（${(info.sample_rate / 1000).toFixed(1)} kHz）` : "—"],
        ["声道", `${info.layout || "—"}（${info.channels || "?"} 声道）`],
        ["时长", info.dur ? info.dur.toFixed(2) + " 秒" : "—"],
        ["码率", info.bitrate_kbps ? info.bitrate_kbps + " kbps" : "—"],
        ["大小", info.size ? (info.size / 1048576).toFixed(2) + " MB" : "—"],
        ["来源", info.source || "—"],
        ["处理", info.op || "（原样）"],
      ];
      for (const [k, v] of rows) {
        const tr = el("tr");
        tr.appendChild(el("th", null, k));
        tr.appendChild(el("td", null, String(v)));
        tb.appendChild(tr);
      }
      box.appendChild(tb);
      const tip = kind === "sfx"
        ? "音效库是全局的（跨台本共用）；插进某条时间轴时会拷一份到那个工程的 media。"
        : kind === "ref"
          ? "音色库是全局的：主要用于生成语音时的参考音频，也可以当素材插进时间轴。"
          : "导入台是全局的中转站：还没处理/标记的原始素材都在这里，处理后可存成音效或音色。";
      box.appendChild(el("div", "phint", tip));
    }, "关闭", async (box) => { box.closest(".mask").remove(); });
  }

  function startRename(m, row, span) {
    const input = document.createElement("input");
    input.className = "renameinput";
    input.value = m.name.replace(/\.wav$/, "").replace(/_[0-9a-f]{6}$/, "");
    span.replaceWith(input);
    input.focus(); input.select();
    const commit = async () => {
      const v = input.value.trim();
      if (!v) { drawMediaList(); return; }
      const r = await fetch(`${API}/media/${encodeURIComponent(m.name)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: v }),
      });
      if (!r.ok) toast((await r.json()).detail || "改名失败", true);
      reload();
    };
    input.onblur = commit;
    input.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      if (e.key === "Escape") { input.onblur = null; drawMediaList(); }
    };
  }

  /* 上传一律进「导入台素材库」（全局），不再往某个工程目录里加临时素材。
     时间轴里已经没有上传入口了，这个留着给拖文件进列表时的兜底。 */
  async function uploadFiles(files) {
    let n = 0;
    for (const f of files) {
      const fd = new FormData();
      fd.append("file", f);
      try {
        const r = await fetch(`${LFAPI}/media/upload`, { method: "POST", body: fd });
        if (!r.ok) throw new Error((await r.json()).detail || "上传失败");
        n++;
      } catch (e) { toast(`「${f.name}」上传失败：${e.message}`, true); }
    }
    if (n) {
      await loadMedia();
      MTAB = "mat";
      drawMediaList();
      toast(`已上传 ${n} 个素材到导入台`);
    }
  }

  /* ------------------------------ 弹层 ------------------------------ */
  function modal(title, build, okText, onOk) {
    const mask = el("div", "mask");
    const box = el("div", "modal");
    box.appendChild(el("h3", null, title));
    build(box);
    const foot = el("div", "foot");
    const cancel = el("button", "btn ghost", "关闭");
    cancel.onclick = () => mask.remove();
    const ok = el("button", "btn primary", okText || "确定");
    ok.onclick = async () => {
      ok.disabled = true;
      let keep = false;
      try { keep = (await onOk(box, ok)) === false; }
      finally { if (!keep) ok.disabled = false; }
      // onOk 返回 false = 有校验没过，弹窗留着让人改（否则关掉还要重新点一遍）
    };
    foot.appendChild(cancel); foot.appendChild(ok);
    box.appendChild(foot);
    mask.appendChild(box);
    mask.onclick = (e) => { if (e.target === mask) mask.remove(); };
    document.body.appendChild(mask);
    return { mask, box, ok };
  }

  /* ============ 插入素材选择器 ============
     标签 / 标记处插的现在统一是「音效素材」（音效库），也允许从本工程挑一个临时素材。
     以前只列本工程 MEDIA：素材刚在导入台存进音效库，这里根本看不到，只能先上传一遍。
  */
  let PICK = { tab: "sfx", q: "", sel: null };

  function openInsertPicker(at, trackId, preferTab) {
    const tabs = [["sfx", "🔔 音效库"], ["ref", "🎙 音色库"], ["mat", "📥 导入台"]];
    PICK = { tab: tabs.some(([k]) => k === preferTab) ? preferTab : "sfx", q: "", sel: null };
    const track = trackId || (sfxTracks()[0] || tracks()[0] || {}).id;
    modal("在 " + fmt(at) + " 插入素材", (box) => {
      /* 三个库和素材面板一致：音效库 / 音色库 / 导入台（不再是老的「本工程」） */
      const seg = el("div", "pickseg");
      const tabsBtn = {};
      tabs.forEach(([k, label]) => {
        const b = el("button", "btn mini", label);
        b.type = "button";
        b.onclick = () => { PICK.tab = k; PICK.sel = null; draw(); };
        tabsBtn[k] = b;
        seg.appendChild(b);
      });
      box.appendChild(seg);

      const q = document.createElement("input");
      q.className = "inp"; q.placeholder = "搜名字…";
      q.style.marginBottom = "8px";
      box.appendChild(q);

      const list = el("div", "picklist");
      box.appendChild(list);
      const info = el("div", "hint");
      info.style.marginTop = "6px";
      box.appendChild(info);

      const draw = () => {
        list.innerHTML = "";
        Object.entries(tabsBtn).forEach(([k, b]) => b.classList.toggle("cur", PICK.tab === k));
        const kw = (PICK.q || "").trim().toLowerCase();
        const src = PICK.tab === "sfx" ? SFXLIB : PICK.tab === "ref" ? REFS : MEDIA;
        const rows = src.filter((x) => !kw
          || ((x.name || "") + " " + (x.source || "") + " " + (x.file || "")).toLowerCase().includes(kw));
        info.textContent = PICK.tab === "sfx"
          ? (SFXLIB.length ? "音效库（全局）：插进来会拷一份到本工程。" : "音效库是空的，先去「📥 导入台」存一段。")
          : PICK.tab === "ref"
            ? (REFS.length ? "音色库（全局）：参考音频也能当素材用。" : "音色库是空的。")
            : (MEDIA.length ? "导入台（中转站）：还没处理/标记的原始素材。" : "导入台是空的。");
        if (!rows.length) {
          list.appendChild(el("div", "hint mempty", src.length ? "没有匹配的素材" : "这里是空的"));
          return;
        }
        for (const it of rows) {
          const key = it.id || it.name;
          const row = el("div", "pickrow" + (PICK.sel === key ? " cur" : ""));
          row.appendChild(el("span", "pn", it.name || it.file));
          row.appendChild(el("span", "pm", matMetaText(it)));
          row.onclick = () => { PICK.sel = key; draw(); };
          row.ondblclick = () => { PICK.sel = key; const ok = box.parentNode.querySelector(".foot .btn.primary"); if (ok) ok.click(); };
          list.appendChild(row);
        }
      };
      q.oninput = () => { PICK.q = q.value; draw(); };
      draw();
      box._pickTrack = track;
    }, "插入", async (box) => {
      if (!PICK.sel) { toast("先选一个素材（也可以双击）", true); return false; }
      const at2 = at, tid = box._pickTrack;
      const mask = box.closest(".mask");
      if (mask) mask.remove();
      if (PICK.tab === "sfx") await insertSfxLib(PICK.sel, at2, tid);
      else if (PICK.tab === "ref") {
        const r = (REFS || []).find((x) => x.id === PICK.sel);
        await insertRefLib(PICK.sel, (r && r.name) || "", at2, tid);
      } else {
        await insertMatLib(PICK.sel, at2, tid);
      }
      return true;
    });
  }

  function checkbox(id, label, checked) {
    const wrap = el("label", "check");
    const input = document.createElement("input");
    input.type = "checkbox"; input.id = id; input.checked = checked;
    wrap.appendChild(input);
    wrap.appendChild(el("span", null, label));
    return { wrap, input };
  }

  // 导出选项的「?」说明：讲清楚每个选项做什么、对成品有什么影响
  const OPT_HELP = {
    fmt: { t: "格式：选什么容器", p: [
      "<b>WAV</b> — 无损未压缩，通用性最好，体积最大（44.1k 16bit 立体声约 10MB/分钟）。",
      "<b>FLAC</b> — 无损压缩，音质与 WAV 等价，体积小 35~40%，适合存档与投稿。",
      "<b>MP3 / OGG</b> — 有损压缩，体积小。本机没有 ffmpeg/lame，用内置编码器，码率上限较低（MP3≈48kbps、OGG≈31kbps），人声可用但高频会闷；<b>要交付音质请选 WAV/FLAC</b>。",
      "换格式不改变时间轴、音量、声像、淡入淡出，只是压缩方式不同。",
    ] },
    qual: { t: "音质 / 位深：动态范围与噪声底", p: [
      "<b>16 bit</b> — CD 标准，噪声底约 -96dB，人声足够。",
      "<b>24 bit</b> — 噪声底约 -144dB，给后期留余量（多轨叠加/EQ/压缩后不易露底噪）；体积比 16bit 大 50%。",
      "<b>32 bit 浮点</b> — 不会削波，适合继续在 DAW 里处理；体积是 16bit 的 2 倍。",
      "MP3/OGG 没有位深，这里是编码器的质量档：越高细节越多、体积越大。",
    ] },
    rate: { t: "采样率：每秒采多少个点", p: [
      "决定能记住的最高频率（上限 ≈ 一半）。人声齿音能量集中在 6~10kHz，所以 22.05kHz 也够用。",
      "<b>22050 Hz</b> — 与 TTS 模型原始输出一致，不重采样、体积最省。",
      "<b>44100 Hz</b> — CD/播放器标准，通用推荐（默认）。",
      "<b>48000 Hz</b> — 视频剪辑（PR/达芬奇）标准，混进视频不会被二次重采样。",
      "<b>16000 Hz</b> — 语音识别/AI 训练常用，人声略闷。",
      "<b>96000 Hz</b> — 母版级，对 TTS 音源没有实际增益，体积翻倍。",
      "降采样会滤掉高频（不可逆）；升采样只是补点、不会变清晰。",
    ] },
    ch: { t: "声道：立体声 / 单声道", p: [
      "<b>立体声</b> — 保留每个片段/音轨的左右声像，做背景乐、音效摆位必须选它。体积是单声道的 2 倍。",
      "<b>单声道</b> — 左右相加取平均，体积减半。纯人声成品、语音交付推荐。",
      "注意：单声道会把声像信息抹平（左右不同的内容会合到一起）。",
    ] },
    range: { t: "导出时段：只导其中一段", p: [
      "填「开始/结束」秒就只渲染这一段，用于试听、抽检、交片段；留空 = 整条。",
      "时间是时间轴上的绝对时间（从 0 秒算），不是某个片段的内部时间。",
      "勾选/取消音轨会改变全片长度，改完记得看下面的「预计」再填时段。",
    ] },
    tracks: { t: "包含音轨：哪些轨参与混音", p: [
      "勾选的音轨才会被混进来；默认勾选所有未静音的轨。",
      "静音（M）、独奏（S）状态在「导出混音」时也会生效：有独奏时只混独奏轨。",
      "想单独导出某一条轨（例如只要人声），只勾那一条即可，其余轨不参与。",
    ] },
    packrate: { t: "工程采样率：影响分轨与工程头", p: [
      "这个值会写进 Reaper 工程的 SAMPLERATE 头，并决定 stems/ 下分轨 WAV 的采样率。",
      "剪辑软件（PR/达芬奇）常用 48000；纯音频工程用 44100 即可。",
      "选 48000 时服务端会做一次高质量重采样（soxr），不会改变时长与对齐。",
    ] },
    packaudio: { t: "把音频一起打包：自包含 or 引用本机路径", p: [
      "<b>勾选</b> — 用到的音频复制进 zip（audio/、media/），工程用相对路径，换电脑/发给别人也能直接打开。体积大。",
      "<b>不勾</b> — 工程里写本机绝对路径，zip 很小，但只能在<b>这台机器</b>上打开。",
      "要让别人帮你混音，请勾上。",
    ] },
  };

  function showOptHelp(key) {
    const h = OPT_HELP[key];
    if (!h) return;
    const wrap = el("div", "optinfo");
    h.p.forEach((t) => {
      const p = document.createElement("p");
      p.innerHTML = t;
      wrap.appendChild(p);
    });
    const m = modal(h.t, (box) => { box.appendChild(wrap); }, "知道了",
      (box) => { const mm = box.closest(".mask"); if (mm) mm.remove(); });
    const cancel = m.box.querySelector(".foot .btn.ghost");
    if (cancel) cancel.remove();
  }

  // 带「?」的字段标题
  function fieldLabel(text, key) {
    const sp = el("span", null, text);
    if (key) {
      const q = el("button", "qbtn", "?");
      q.type = "button";
      q.title = "说明：" + text;
      q.onclick = (e) => { e.preventDefault(); e.stopPropagation(); showOptHelp(key); };
      sp.appendChild(q);
    }
    return sp;
  }

  // 混音的「音质/位深」选项：WAV/FLAC 选位深，MP3/OGG 选质量档
  const MIX_QUALITY = {
    wav: [["16", "16 bit（默认）"], ["24", "24 bit"], ["32", "32 bit 浮点（后期用）"]],
    flac: [["16", "16 bit"], ["24", "24 bit"]],
    mp3: [["high", "高质量 ≈48kbps"], ["standard", "标准 ≈36kbps"], ["small", "精简 ≈30kbps"]],
    ogg: [["high", "高质量 ≈32kbps"], ["standard", "标准 ≈28kbps"], ["small", "精简 ≈25kbps"]],
  };

  function bytesTxt(b) {
    b = Number(b) || 0;
    if (b >= 1073741824) return (b / 1073741824).toFixed(2) + " GB";
    if (b >= 1048576) return (b / 1048576).toFixed(2) + " MB";
    return Math.max(1, Math.round(b / 1024)) + " KB";
  }

  function openMix() {
    let timer = null;
    const estBox = { el: null };
    const buildBody = (box) => {
      const fmt = box._fmt.value;
      const q = box._q.value || "16";
      const isBit = fmt === "wav" || fmt === "flac";
      const ids = box._tracks.filter((x) => x.c.input.checked).map((x) => x.t.id);
      const num = (inp) => {
        const v = (inp.value || "").trim();
        if (v === "") return null;
        const n = parseFloat(v);
        return isNaN(n) ? null : n;
      };
      return {
        tracks: ids,
        format: fmt,
        bit_depth: isBit ? parseInt(q, 10) : 16,
        quality: isBit ? "standard" : q,
        channels: parseInt(box._ch.value, 10) || 2,
        sample_rate: parseInt(box._rate.value, 10) || 44100,
        range_start: num(box._from),
        range_end: num(box._to),
        duration_mode: (box._dmode && box._dmode.value) === "full" ? "full" : "visible",
      };
    };
    const refresh = (box) => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const body = buildBody(box);
        if (!body.tracks.length) { estBox.el.textContent = "至少勾一条音轨"; return; }
        if (body.range_start != null && body.range_end != null && body.range_end <= body.range_start) {
          estBox.el.textContent = "⚠ 结束时间要大于开始时间";
          return;
        }
        estBox.el.textContent = "正在估算…";
        try {
          const r = await fetch(`${API}/mix/estimate`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          const d = await r.json();
          if (!r.ok) throw new Error(d.detail || "估算失败");
          const clipped = Math.abs(d.span_duration - d.total_duration) > 0.05;
          estBox.el.innerHTML = `预计：全片 <b>${fmtShort(d.total_duration)}</b>` +
            (clipped ? `，本次导出 <b>${fmtShort(d.span_duration)}</b>` : "") +
            `，文件约 <b>${bytesTxt(d.est_bytes)}</b>`;
        } catch (e) { estBox.el.textContent = "估算失败：" + e.message; }
      }, 250);
    };
    const syncQ = (box) => {
      const fmt = box._fmt.value;
      const keep = box._q.value;
      box._q.innerHTML = "";
      (MIX_QUALITY[fmt] || MIX_QUALITY.wav).forEach(([v, t]) => {
        const o = document.createElement("option");
        o.value = v; o.textContent = t; box._q.appendChild(o);
      });
      if ([...box._q.options].some((o) => o.value === keep)) box._q.value = keep;
    };

    modal("导出混音", (box) => {
      // 格式
      const f1 = el("div", "field");
      f1.appendChild(fieldLabel("格式", "fmt"));
      const fmt = document.createElement("select");
      /* 格式按后端能力过滤：mp3 / ogg 要靠 ffmpeg，没装就不该让用户选
         （以前能选，导出时才报错）。能力清单 GET /lf/manifest。 */
      [["wav", "WAV — 无损，最通用"], ["flac", "FLAC — 无损压缩，约省 40%"],
       ["mp3", "MP3 — 体积小（内置编码器，码率偏低）"], ["ogg", "OGG — 体积小"]]
        .filter(([v]) => v === "wav" || v === "flac"
          || !window.GenParams || GenParams.can("ffmpeg"))
        .forEach(([v, t]) => {
          const o = document.createElement("option");
          o.value = v; o.textContent = t; fmt.appendChild(o);
        });
      f1.appendChild(fmt);
      box.appendChild(f1);

      // 音质 / 位深
      const f2 = el("div", "field");
      f2.appendChild(fieldLabel("音质 / 位深", "qual"));
      const q = document.createElement("select");
      f2.appendChild(q);
      box.appendChild(f2);

      // 采样率
      const f25 = el("div", "field");
      f25.appendChild(fieldLabel("采样率", "rate"));
      const rate = document.createElement("select");
      [["16000", "16000 Hz — 语音识别 / AI 训练"],
       ["22050", "22050 Hz — 与 TTS 原输出一致（最省）"],
       ["32000", "32000 Hz — 语音/播客折中"],
       ["44100", "44100 Hz — CD / 通用（推荐）"],
       ["48000", "48000 Hz — 视频剪辑（PR / 达芬奇）"],
       ["96000", "96000 Hz — 高保真母版"]].forEach(([v, t]) => {
        const o = document.createElement("option");
        o.value = v; o.textContent = t; rate.appendChild(o);
      });
      const MX = (GSET && GSET.mix) || {};
      rate.value = MX.rate || "44100";
      f25.appendChild(rate);
      box.appendChild(f25);

      // 声道
      const f3 = el("div", "field");
      f3.appendChild(fieldLabel("声道", "ch"));
      const ch = document.createElement("select");
      [["2", "立体声（保留声像）"], ["1", "单声道（体积减半）"]].forEach(([v, t]) => {
        const o = document.createElement("option");
        o.value = v; o.textContent = t; ch.appendChild(o);
      });
      if (MX.channels) ch.value = String(MX.channels);
      f3.appendChild(ch);
      f3.appendChild(el("span", null,
        "开了「空间音频」的片段会按 HRTF 双耳渲染，房间混响一并混进这两轨——"
        + "导出听到的就是刚才试听的。"));
      box.appendChild(f3);

      // 时段
      const f4 = el("div", "field");
      f4.appendChild(fieldLabel("导出时段（秒）", "range"));
      const row = el("div", "rowline");
      row.style.flex = "1";
      const from = document.createElement("input");
      from.type = "number"; from.min = "0"; from.step = "0.1"; from.placeholder = "开始 0";
      from.className = "inp";
      const to = document.createElement("input");
      to.type = "number"; to.min = "0"; to.step = "0.1"; to.placeholder = "结束（到末尾）";
      to.className = "inp";
      const bAll = el("button", "btn mini ghost", "整条");
      bAll.onclick = () => { from.value = ""; to.value = ""; refresh(box); };
      row.appendChild(from); row.appendChild(to); row.appendChild(bAll);
      f4.appendChild(row);
      f4.appendChild(el("span", null, "留空 = 整条；也可以只导某一段做试听/审核"));
      box.appendChild(f4);

      // 总时长口径：显示末端 / 源末端
      const f45 = el("div", "field");
      f45.appendChild(fieldLabel("总时长算到哪儿", ""));
      const dmode = document.createElement("select");
      [["visible", "最后一段的「显示末端」（和眼睛里看到的一致）"],
       ["full", "最后一段的「未显示部分末端」（被裁掉/变速压掉的那段也算）"]]
        .forEach(([v, t]) => {
          const o = document.createElement("option");
          o.value = v; o.textContent = t; dmode.appendChild(o);
        });
      if (MX.dmode) dmode.value = MX.dmode;
      f45.appendChild(dmode);
      f45.appendChild(el("span", null,
        "收尾有混响尾巴时会再多留一点，避免把余响切掉。"));
      box.appendChild(f45);

      // 包含音轨
      const f5 = el("div", "field");
      f5.appendChild(fieldLabel("包含音轨", "tracks"));
      const cares = tracks().map((t) => ({ t, c: checkbox("tr" + t.id, t.name, !t.mute) }));
      cares.forEach((x) => f5.appendChild(x.c.wrap));
      box.appendChild(f5);

      const est = el("div", "hint", "正在估算…");
      box.appendChild(est);
      estBox.el = est;
      box.appendChild(el("div", "progress", ""));

      const MXF = (GSET && GSET.mix) || {};
      if (MXF.format) fmt.value = MXF.format;
      if (MXF.bitDepth) q.value = String(MXF.bitDepth);
      box._fmt = fmt; box._q = q; box._ch = ch; box._rate = rate;
      box._from = from; box._to = to; box._tracks = cares; box._dmode = dmode;
      syncQ(box);
      fmt.onchange = () => { syncQ(box); refresh(box); };
      q.onchange = () => refresh(box);
      ch.onchange = () => refresh(box);
      rate.onchange = () => refresh(box);
      from.oninput = () => refresh(box);
      to.oninput = () => refresh(box);
      dmode.onchange = () => refresh(box);
      cares.forEach((x) => { x.c.input.onchange = () => refresh(box); });
      refresh(box);
    }, "开始渲染", async (box) => {
      const body = buildBody(box);
      if (!body.tracks.length) { toast("至少选一条轨", true); return; }
      if (body.range_start != null && body.range_end != null && body.range_end <= body.range_start) {
        toast("结束时间要大于开始时间", true); return;
      }
      const p = box.querySelector(".progress");
      p.textContent = "渲染中…（两小时工程大约 1~3 分钟）";
      try {
        const r = await fetch(`${API}/mix`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || "渲染失败");
        p.innerHTML = "";
        const a = document.createElement("a");
        a.href = encodeURI(d.url); a.textContent = `下载 ${d.file}`;
        a.style.color = "var(--primary)";
        p.appendChild(document.createTextNode(
          `完成：${fmtShort(d.duration)}，${bytesTxt(d.size)}（${(d.format || "wav").toUpperCase()} ${d.kbps}kbps）` +
          (d.channels === 1 ? "，单声道" : "，立体声") +
          `，${((d.sample_rate || 44100) / 1000).toFixed(1)}kHz，耗时 ${d.seconds}s` +
          (d.peak > 0.99 ? "，⚠ 峰值已贴上限（整体音量降 2~3dB 更安全）" : "") +
          (d.trimmed > 0 ? `，${d.trimmed} 段比音频长（已按实际长度收尾）` : "") +
          (d.prepared > 0 ? `，重建 ${d.prepared} 段变速缓存` : "") + "　"));
        p.appendChild(a);
        toast("混音导出完成");
      } catch (e) { p.textContent = "失败：" + e.message; }
    });
  }

  // ---- 各工程格式的详细使用说明（点「说明」按钮弹出） ----
  const FORMAT_HELP = {
    rpp: {
      title: "Reaper 工程（project.rpp）使用说明",
      lead: "功能最全：位置、裁剪、音量、声像、淡入淡出、变速全部保留，适合直接混音出成品。",
      steps: [
        "把 zip 全部解压到一个文件夹（不要在压缩包里直接双击打开）。",
        "打开 Reaper → 菜单 File › Open project… → 选 project.rpp。",
        "若提示找不到媒体：Project Bay（View › Project Media Bay）里选中缺失项 → Relink 指向解压出来的 audio/ 与 media/。",
        "轨道：一条 TRACK 对应一条音轨；一个 ITEM 对应一个片段，名字是句子前 60 字，「需重生成」的会带【需重生成】前缀。",
        "标记：台本的句中/句间标签已写成 MARKER，用 View › Region/Marker Manager 查看和跳转。",
        "变速片段用的是预渲染后的音频（文件名带 _x1.25 之类），不要再改 item 的 playback rate，否则会二次变速。",
        "出成品：File › Render… → Source 选 Master mix、Bounds 选 Entire project、格式按需 → Render。",
        "提示：本工具里的「锁定」只是编辑保护，不会写进工程；在 Reaper 里片段可以随意拖。",
      ],
    },
    edl: {
      title: "CMX3600 EDL（Premiere / 达芬奇）使用说明",
      lead: "行业通用的剪辑表：只记录「哪段素材、从哪里到哪里、放在时间线哪一段」，适合把配音铺到剪辑软件里。",
      steps: [
        "解压整个 zip，确保 timeline.edl 与 audio/、media/ 在同一个父目录下（否则素材会离线）。",
        "Premiere Pro：文件 › 导入… → 选 timeline.edl → 序列预设按 25fps 建（本项目按 25fps 写时间码）。",
        "DaVinci Resolve：文件 › 导入 › 时间线… → 选 timeline.edl → 帧率选 25 → 勾「自动导入源片段」。",
        "素材离线时：在媒体池里全选 → 右键 Relink / 重新链接，指向解压目录里的 audio/（语音）与 media/（素材）。",
        "声道映射：每条音轨按顺序映射到 A / A2 / A3 / A4 声道，片段名后面带 * TRACK: 音轨名 注释便于核对。",
        "限制：EDL 只带位置与源入出点，音量、淡入淡出、声像、变速都不会写进去。",
        "需要保留这些效果：用 project.rpp，或者直接用「导出混音」的成品音轨铺进剪辑软件。",
      ],
    },
    audacity: {
      title: "Audacity 4 使用说明（分轨 WAV + 标签）",
      lead: "Audacity 的工程文件 .aup3 是数据库格式，外部无法生成，所以用业界通行的「每轨一条 WAV + 标签文件」，导入后时间轴天然对齐。",
      steps: [
        "解压 zip，进入 audacity/ 目录（里面有 01_xxx.wav、02_xxx.wav…、labels.txt、README_audacity.txt）。",
        "启动 Audacity 4 → 文件 › 导入 › 音频…（或把该目录里的 wav 全选拖进窗口）→ 一条 wav 生成一条音轨，全部从 0 秒开始。",
        "时间轴对齐检查：如果手动拖动过，用 轨道 › 对齐 › 对齐所有轨道 复原。",
        "导入标签：文件 › 导入 › 标签… → 选 labels.txt → 生成一条标签轨；范围标签=每个片段，点标签=句中/句间标记。",
        "调音量/声像：直接拖每条音轨左侧的 -/+ 滑块与 Pan 旋钮；需要裁掉某段用选择工具框选后 Ctrl+X。",
        "出成品：轨道 › 混音 › 混音并渲染（Mix and Render）合成一条 → 文件 › 导出 选格式/位深。",
        "如果想让每个片段都能单独拖动/裁剪：改用同包的 project.rpp（Reaper）或 timeline.edl。",
      ],
    },
  };

  function openFormatHelp(key) {
    const h = FORMAT_HELP[key];
    if (!h) return;
    const m = modal(h.title, (box) => {
      box.appendChild(el("div", "hint", h.lead));
      const ol = el("ol", "helpsteps");
      ol.style.margin = "10px 0 0 18px";
      ol.style.padding = "0";
      ol.style.fontSize = "12.5px";
      ol.style.lineHeight = "1.75";
      h.steps.forEach((t) => {
        const li = el("li", null, t);
        li.style.marginBottom = "5px";
        ol.appendChild(li);
      });
      box.appendChild(ol);
      box.appendChild(el("div", "hint",
        "包内还会附 timeline.csv（每段起止秒）与 markers.csv（标签点），可当核对清单用。"));
    }, "知道了", (box) => { const mm = box.closest(".mask"); if (mm) mm.remove(); });
    // 只有一个「知道了」就够，去掉多余的「关闭」
    const cancel = m.box.querySelector(".foot .btn.ghost");
    if (cancel) cancel.remove();
  }

  function prePackCheck() {
    const pairs = overlapPairs();
    if (!pairs.length) { openPack(); return; }
    const byTrack = {};
    pairs.forEach((p) => { (byTrack[p.track.name] = byTrack[p.track.name] || []).push(p); });
    const mask = el("div", "mask");
    const box = el("div", "modal");
    box.appendChild(el("h3", null, "导出前提醒：同一轨道上有重叠片段"));
    box.appendChild(el("div", "hint",
      `检测到 ${pairs.length} 处重叠，涉及 ${Object.keys(byTrack).length} 条轨道。`));
    box.appendChild(el("div", "phint",
      "EDL（PR / 达芬奇）里一条轨就是一个声道，同一时间放两段会被截断或只剩一段；"
      + "Reaper 的 rpp 虽然能叠，但同一轨两段会同时出声、位置也难看准。"
      + "建议先「整理重叠」——只把它们挪到空白轨/邻近轨，时间轴上的位置一个都不变。"));
    const ul = el("ul", "ovlist");
    Object.keys(byTrack).slice(0, 8).forEach((name) => {
      const p = byTrack[name][0];
      ul.appendChild(el("li", null,
        `${name}：${byTrack[name].length} 处（例如 ${fmt(p.b.start)} 有两段叠了 ${p.over.toFixed(2)}s）`));
    });
    box.appendChild(ul);
    const foot = el("div", "foot");
    const cancel = el("button", "btn ghost", "取消");
    cancel.onclick = () => mask.remove();
    const force = el("button", "btn", "仍然导出");
    force.title = "不整理，直接把重叠写进工程（EDL 里可能丢片段）";
    force.onclick = () => { mask.remove(); openPack(); };
    const fix = el("button", "btn primary", "先整理重叠再导出");
    fix.onclick = () => {
      mask.remove();
      const r = distributeOverlaps();
      toast(`已整理：移动 ${r.moved} 段，剩余重叠 ${r.left} 处`, !!r.left);
      setTimeout(openPack, 150);
    };
    foot.appendChild(cancel); foot.appendChild(force); foot.appendChild(fix);
    box.appendChild(foot);
    mask.appendChild(box);
    mask.onclick = (e) => { if (e.target === mask) mask.remove(); };
    document.body.appendChild(mask);
  }

  function openPack() {
    modal("导出工程包", (box) => {
      const f1 = el("div", "field");
      f1.appendChild(el("span", null, "工程格式（可多选，每种都附使用说明）"));
      const row = (id, label, hint, helpKey, checked) => {
        const c = checkbox(id, label, checked);
        const wrap = el("div", "fmtrow");
        wrap.appendChild(c.wrap);
        const b = el("button", "btn mini ghost", "说明");
        b.title = "查看在 " + label + " 里的详细导入/使用步骤";
        b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openFormatHelp(helpKey); };
        wrap.appendChild(b);
        f1.appendChild(wrap);
        if (hint) f1.appendChild(el("div", "fmthint", hint));
        return c;
      };
      const c1 = row("fRpp", "Reaper .rpp", "功能最全：位置/裁剪/音量/声像/淡入淡出/变速都保留。", "rpp", true);
      const c2 = row("fEdl", "CMX3600 EDL（PR / 达芬奇）", "通用剪辑表：只带位置与源入出点，不带音量与淡入淡出。", "edl", true);
      const c4 = row("fAud", "Audacity 4（每轨 WAV + 标签）", "Audacity 无外部可写的工程格式，用「分轨 WAV + labels.txt」，导入即对齐。", "audacity", false);
      box.appendChild(f1);

      // 工程采样率（写进 rpp 头 + 决定 stems 分轨采样率）
      const fr = el("div", "field");
      fr.appendChild(fieldLabel("工程采样率", "packrate"));
      const rate = document.createElement("select");
      [["22050", "22050 Hz — 与 TTS 原输出一致"],
       ["44100", "44100 Hz — 音频工程通用（推荐）"],
       ["48000", "48000 Hz — 视频剪辑（PR / 达芬奇）"],
       ["96000", "96000 Hz — 母版级"]].forEach(([v, t]) => {
        const o = document.createElement("option");
        o.value = v; o.textContent = t; rate.appendChild(o);
      });
      rate.value = "44100";
      fr.appendChild(rate);
      box.appendChild(fr);

      const f2 = el("div", "field");
      // RPP 里要不要写「音量/声像自动化」：曲线面板里画的东西，Reaper 也能看到
      const fa = el("div", "field");
      const c5 = checkbox("fEnv", "把音量 / 声像自动化写进 RPP（VOLENV2 / PANENV2）",
        !!(S.data && allClips().some((z) => z.kf && (z.kf.gain || z.kf.pan))));
      fa.appendChild(c5.wrap);
      fa.appendChild(el("span", null,
        "有曲线时静态音量/声像会让位（否则会乘两遍）。空间 HRTF 与混响不写进工程——"
        + "它们是实时渲染的，已经烘在 stems/ 和「导出混音」里了。"));
      box.appendChild(fa);
      const c3 = checkbox("fAudio", "把用到的音频一起打包（自包含，体积大）", false);
      f2.appendChild(c3.wrap);
      const qa = el("button", "qbtn", "?");
      qa.type = "button"; qa.title = "说明：自包含打包";
      qa.onclick = (e) => { e.preventDefault(); e.stopPropagation(); showOptHelp("packaudio"); };
      f2.querySelector(".check").appendChild(qa);
      f2.appendChild(el("span", null, "不勾选时工程引用本机绝对路径，体积小；发给别人/换机器请勾上。"));
      box.appendChild(f2);
      box.appendChild(el("div", "hint", "包内一定包含：stems 分轨、timeline.csv、markers.csv、README。"));
      box.appendChild(el("div", "progress", ""));
      box._c = [c1.input, c2.input, c3.input, c4.input];
      box._env = c5.input;
      box._rate = rate;
    }, "开始导出", async (box) => {
      const [rpp, edl, audio, aud] = box._c;
      const formats = [];
      if (rpp.checked) formats.push("rpp");
      if (edl.checked) formats.push("edl");
      if (aud.checked) formats.push("audacity");
      if (!formats.length) { toast("至少选一种工程格式", true); return; }
      const p = box.querySelector(".progress");
      p.textContent = "正在生成工程包（含分轨渲染）…";
      try {
        const r = await fetch(`${API}/export/pack`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ formats, include_audio: audio.checked,
                                 auto_env: !!box._env.checked,
                                 sample_rate: parseInt(box._rate.value, 10) || 44100 }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || "导出失败");
        p.innerHTML = "";
        const a = document.createElement("a");
        a.href = encodeURI(d.url); a.textContent = `下载 ${d.file}`;
        a.style.color = "var(--primary)";
        p.appendChild(document.createTextNode(
          `完成：${(d.size / 1048576).toFixed(1)} MB，${d.clips} 个片段，${d.sample_rate || 44100} Hz　`));
        p.appendChild(a);
        if (d.skipped) {
          // 有片段找不到音频文件时明确说出来，别让人以为「导出成功了但少了东西」
          p.appendChild(document.createElement("br"));
          p.appendChild(document.createTextNode(
            `⚠ 有 ${d.skipped} 段的音频文件不见了，已跳过（回时间轴检查素材/重生成）。`));
        }
        toast(d.skipped ? `工程包已生成（跳过 ${d.skipped} 段）` : "工程包已生成");
      } catch (e) { p.textContent = "失败：" + e.message; }
    });
  }

  /* ------------------------- 素材导入台（内嵌） -------------------------
     直接在本页用 iframe 打开台本页的导入台（?desk=1&embed=1），不再跳转/新开标签。
     导入台存成功会 postMessage 回来，这里顺手刷新音效库列表。
  */
  const DESK = { open: false, loaded: false };
  function openDesk(target) {
    const mask = $("deskMask");
    if (!mask) { window.open(`/longform?desk=1&target=${target || "sfx"}`, "_blank"); return; }
    mask.hidden = false;
    DESK.open = true;
    if (!DESK.loaded) {
      $("deskFrame").src = `/longform?desk=1&embed=1&target=${target || "sfx"}&sid=${SID}`;
      DESK.loaded = true;
    }
  }
  function closeDesk() {
    const mask = $("deskMask");
    if (mask) mask.hidden = true;
    DESK.open = false;
    loadMedia();
  }
  window.addEventListener("message", (e) => {
    const d = e.data || {};
    if (d.type === "lf-desk-close") { closeDesk(); return; }
    if (d.type === "lf-stored" || d.type === "lf-desk-refresh") {
      loadMedia();
      if (d.type === "lf-stored") toast(`已存入${d.target === "ref" ? "音色库" : "音效库"}，素材列表已刷新`);
    }
  });

  /* ------------------------- 历史版本（落盘快照） ------------------------- */
  // 后端存的是 epoch 秒（float），旧数据可能是 ISO 字符串，两种都兜住
  function fmtHistTime(t) {
    if (typeof t === "string" && t) return t.slice(5, 16).replace("T", " ");
    const n = Number(t) || 0;
    if (!n) return "";
    const d = new Date(n * 1000);
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  async function historyList() {
    try {
      const r = await fetch(`${API}/history`);
      return (await r.json()).items || [];
    } catch (e) { return null; }
  }

  async function openHistory() {
    let items = await historyList();
    if (items === null) { toast("读不到历史版本", true); return; }
    if (!items.length) {
      // 第一次打开：先落一份「初始状态」，否则面板是空的，看着像坏了
      try {
        await fetch(`${API}/history`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label: "初始状态" }),
        });
        items = (await historyList()) || [];
      } catch (e) { /* 忽略 */ }
    }
    const m = modal("历史版本", (box) => {
      box.appendChild(el("div", "hint",
        "改动会自动存一份（最多保留 40 个）。回退前会先把「当前状态」也存一份，随时能反悔。"));
      const list = el("div", "histlist");
      box.appendChild(list);
      const bar = el("div", "btnrow");
      const snap = el("button", "btn mini", "＋ 现在存一份");
      snap.onclick = async () => {
        const name = prompt("给这个版本起个名字（可留空）", "手动存档");
        if (name === null) return;
        try {
          await fetch(`${API}/history`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ label: name || "手动存档" }),
          });
          box.closest(".mask").remove();
          openHistory();
          toast("已存一份历史版本");
        } catch (e) { toast("存快照失败", true); }
      };
      bar.appendChild(snap);
      box.appendChild(bar);
      if (!items.length) {
        list.appendChild(el("div", "hint", "还没有历史版本。改点东西（或点上面「现在存一份」）就会有了。"));
        return;
      }
      for (const it of items) {
        const row = el("div", "histrow");
        row.appendChild(el("span", "ht", fmtHistTime(it.time)));
        row.appendChild(el("span", "hl", it.label || "编辑"));
        row.appendChild(el("span", "hm", `${it.tracks || 0} 轨 · ${it.clips || 0} 素材`));
        const acts = el("div", "hact");
        const rb = el("button", "btn mini", "回退");
        rb.onclick = async () => {
          if (!confirm(`回退到「${it.label || "这个版本"}」？\n当前状态会先自动存一份。`)) return;
          rb.disabled = true;
          try {
            const r = await fetch(`${API}/history/${encodeURIComponent(it.name)}/restore`, { method: "POST" });
            if (!r.ok) throw new Error((await r.json()).detail || "恢复失败");
            box.closest(".mask").remove();
            await reload();
            HIST.undo.length = 0; HIST.redo.length = 0;
            HIST.base = projSnap(); updateUndoBtns();
            toast("已回退到历史版本");
          } catch (e) { toast("回退失败：" + e.message, true); rb.disabled = false; }
        };
        const db = el("button", "iconbtn", "✕");
        db.title = "删除这个历史版本";
        db.onclick = async () => {
          if (!confirm("删除这个历史版本？")) return;
          try {
            await fetch(`${API}/history/${encodeURIComponent(it.name)}`, { method: "DELETE" });
            box.closest(".mask").remove();
            openHistory();
          } catch (e) { toast("删除失败", true); }
        };
        acts.appendChild(rb); acts.appendChild(db);
        row.appendChild(acts);
        list.appendChild(row);
      }
    }, "关闭", async (box) => { const m2 = box.closest(".mask"); if (m2) m2.remove(); });
    // 只留一个「关闭」，不要下面再挂个 ghost
    const ghost = m.box.querySelector(".foot .btn.ghost");
    if (ghost) ghost.remove();
  }

  /* ============================ 批量操作条 ============================ */
  let renderPoll = 0;

  function dropMenuBelow(btn, entries) {
    const r = btn.getBoundingClientRect();
    buildMenu(Math.max(8, Math.min(r.left, window.innerWidth - 260)),
      Math.max(8, r.top - 300), entries);
    const m = document.querySelector(".ctxmenu");
    if (m) {
      const rr = m.getBoundingClientRect();
      m.style.top = Math.max(8, r.top - rr.height - 6) + "px";
      m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - rr.width - 8)) + "px";
    }
  }

  async function pollRender(tries) {
    clearTimeout(renderPoll);
    const btn = $("bkRegen");
    try {
      const r = await fetch(`${LFAPI}/scripts/${SID}/render`);
      const d = await r.json();
      const job = d.render;
      if (job && ["running", "queued", "stopping"].includes(job.state)) {
        if (btn) btn.textContent = `↻ 生成中 ${job.done || 0}/${job.total || 0}`;
        renderPoll = setTimeout(() => pollRender((tries || 0) + 1), 2000);
        return;
      }
    } catch (e) { /* 忽略，下面照常收尾 */ }
    if (btn) btn.textContent = "↻ 重新生成";
    await reload(true);
    pruneMulti();
    draw();
    // 位置是锁死的：新音频时长一变，很可能和前一段叠上——提醒一下，别让人以为坏了
    try {
      const ov = overlapPairs();
      if (ov && ov.length) {
        toast(`重新生成完成。有 ${ov.length} 处重叠（位置按约定锁死），可点「⇄ 整理重叠」挪开`, false);
      } else {
        toast("重新生成完成（位置未变）");
      }
    } catch (e) { /* 忽略 */ }
  }

  function initBulk() {
    const bar = $("bulkBar");
    if (!bar) return;
    const cs = () => selClips();
    const applyAll = (fn, label, tip) => {
      const l = cs();
      if (!l.length) return;
      l.forEach((c) => fn(c));
      bulkCommit(l, label);
      toast((tip || label) + ` · ${l.length} 段`);
    };

    $("bkClear").onclick = clearMulti;

    /* --- 选择方式 --- */
    $("bkPick").onclick = (ev) => {
      const vis = () => {
        const t0 = tOf(0), t1 = tOf(W);
        return allClips().filter((c) => c.start + c.dur >= t0 && c.start <= t1);
      };
      const sel = () => Array.from(S.multi);
      dropMenuBelow(ev.currentTarget, [
        { head: "选哪些片段" },
        { label: "全部片段", key: "Ctrl+A", fn: () => setMulti(allClips().map((c) => c.id)) },
        { label: "全部语音", fn: () => setMulti(allClips().filter((c) => c.kind === "voice").map((c) => c.id)) },
        { label: "全部素材", fn: () => setMulti(allClips().filter((c) => c.kind === "sfx").map((c) => c.id)) },
        "-",
        {
          label: "本条音轨（当前选中片段所在的轨）", fn: () => {
            const c = S.sel ? clipById(S.sel) : null;
            const tr = c ? trackOfClip(c) : null;
            if (!tr) { toast("先点一个片段", true); return; }
            setMulti(tr.clips.map((x) => x.id));
          },
        },
        { label: "当前可见范围", fn: () => setMulti(vis().map((c) => c.id)) },
        "-",
        {
          label: "未生成（还没配音的句子）",
          fn: () => setMulti(allClips().filter((c) => c.kind === "voice" && !c.has_audio).map((c) => c.id)),
        },
        {
          label: "需重新生成（内容改过的）",
          fn: () => setMulti(allClips().filter((c) => c.kind === "voice" && c.stale).map((c) => c.id)),
        },
        {
          label: "已静音", fn: () => setMulti(allClips().filter((c) => c.mute).map((c) => c.id)),
        },
        {
          label: "已锁定", fn: () => setMulti(allClips().filter((c) => c.locked).map((c) => c.id)),
        },
        "-",
        {
          label: "反选", fn: () => {
            const cur = new Set(sel());
            setMulti(allClips().filter((c) => !cur.has(c.id)).map((c) => c.id));
          },
        },
        { label: "清空选择", key: "Esc", fn: clearMulti },
      ]);
    };

    /* --- 按组 --- */
    $("bkGroup").onclick = (ev) => {
      const gs = groupNames();
      if (!gs.length) { toast("这份台本还没有分组", true); return; }
      const entries = [{ head: "按台本里的分组整组选" }];
      gs.slice(0, 30).forEach(([g, n]) => {
        entries.push({
          label: `${g} · ${n} 段`,
          fn: () => setMulti(allClips().filter((c) => c.kind === "voice"
            && (((c.group || "").trim() || "（未分组）") === g)).map((c) => c.id)),
        });
      });
      dropMenuBelow(ev.currentTarget, entries);
    };

    /* --- 锁定 / 静音：一个按钮两态，点一下切换（和 L / V 键同一套逻辑） --- */
    $("bkLock").onclick = () => {
      const l = cs();
      if (!l.length) { toast("先选片段", true); return; }
      lockSelection(l[0]);
    };
    $("bkMute").onclick = () => muteSel();

    /* --- 音量 --- */
    $("bkGain").onclick = () => {
      const l = cs();
      if (!l.length) return;
      const base = l[0].gain == null ? 1 : l[0].gain;
      modal(`批量音量 · ${l.length} 段`, (box) => {
        box.appendChild(el("div", "hint",
          "拖动滑块设定音量。勾「在各自当前值上增减」就是按比例调，不勾则统一设成这个值。"));
        const row = el("div", "rowline");
        const rng = document.createElement("input");
        rng.type = "range"; rng.min = "0"; rng.max = "200"; rng.step = "1";
        rng.value = String(Math.round(base * 100));
        const out = el("b", "val", Math.round(base * 100) + "%");
        rng.oninput = () => { out.textContent = rng.value + "%"; };
        row.appendChild(rng); row.appendChild(out);
        box.appendChild(row);
        const lab = el("label", "chk");
        lab.style.cssText = "display:flex;align-items:center;gap:6px;font-size:12px;margin-top:8px;cursor:pointer";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        lab.appendChild(cb);
        lab.appendChild(el("span", null, "在各自当前值上增减（按比例）"));
        box.appendChild(lab);
        box._getGain = () => ({
          v: Math.max(0, Math.min(4, parseInt(rng.value, 10) / 100)),
          rel: cb.checked,
        });
      }, "应用", (box) => {
        const { v, rel } = box._getGain();
        applyAll((c) => {
          c.gain = rel ? Math.max(0, Math.min(4, (c.gain == null ? 1 : c.gain) * v)) : v;
        }, "批量音量", `音量→${Math.round(v * 100)}%`);
        box.closest(".mask").remove();
      });
    };

    /* --- 移到别的音轨 --- */
    $("bkMove").onclick = (ev) => {
      const l = cs();
      if (!l.length) return;
      const wantVoice = l[0].kind === "voice";
      const list = tracks().filter((t) => (t.kind === "voice") === wantVoice);
      const entries = [{ head: wantVoice ? "移到哪条音声轨" : "移到哪条素材轨" }];
      list.forEach((t) => {
        entries.push({ label: `→ ${t.name}　顺序排开（不重叠）`, fn: () => moveSelectedTo(t.id, "pack") });
        entries.push({ label: `→ ${t.name}　保持原时间（可能重叠）`, fn: () => moveSelectedTo(t.id, "keep") });
      });
      if (!list.length) entries.push({ label: "没有可用的音轨", disabled: true });
      dropMenuBelow(ev.currentTarget, entries);
    };

    /* --- 属性：复制 / 粘贴到整批 --- */
    const bkCP = $("bkCopyProps"), bkPP = $("bkPasteProps");
    if (bkCP) {
      bkCP.onclick = () => {
        const l = cs();
        if (!l.length) { toast("先选中一段", true); return; }
        copyClipProps(l[0]);
      };
    }
    if (bkPP) {
      bkPP.onclick = () => propsPasteDialog(cs());
    }

    /* --- 复制 / 删除（素材片段）--- */
    $("bkDup").onclick = async () => {
      const l = cs().filter((c) => c.kind === "sfx" && !c.from_tag);
      if (!l.length) { toast("只能复制素材片段（语音跟台本走）", true); return; }
      undoMark("批量复制");
      const items = S.data.project.sfx || (S.data.project.sfx = []);
      const newIds = [];
      l.forEach((c) => {
        const src = items.find((s) => s.id === c.id);
        if (!src) return;
        const clone = { ...src, id: uid(), start: Math.max(0, c.start + c.dur + 0.01) };
        items.push(clone);
        // 关键帧存在 project.kf 里，不在片段对象上 —— 不显式拷一份，复制出来的就没有自动化
        const kk = (S.data.project.kf || {})[src.id];
        if (kk && Object.keys(kk).length) {
          S.data.project.kf = S.data.project.kf || {};
          S.data.project.kf[clone.id] = JSON.parse(JSON.stringify(kk));
        }
        newIds.push(clone.id);
      });
      await persist("批量复制");
      S.multi.clear();
      setMulti(newIds);
      toast(`已复制 ${newIds.length} 段`);
    };

    $("bkDel").onclick = async () => {
      const l = cs();
      const del = l.filter((c) => c.kind === "sfx" && !c.from_tag);
      const skip = l.length - del.length;
      if (!del.length) { toast("语音片段跟台本走，删句子请回台本页", true); return; }
      if (!confirm(`删除 ${del.length} 段素材片段？${skip ? `\n（另外 ${skip} 段语音/标签派生片段会跳过）` : ""}`)) return;
      undoMark("批量删除");
      const ids = new Set(del.map((c) => c.id));
      S.data.project.sfx = (S.data.project.sfx || []).filter((s) => !ids.has(s.id));
      if (S.data.project.kf) ids.forEach((id) => delete S.data.project.kf[id]);
      S.multi.clear();
      await persist("批量删除");
      updateBulkBar();
      toast(`已删除 ${del.length} 段${skip ? `，跳过 ${skip} 段` : ""}`);
    };

    /* --- 重新生成（位置不变）--- */
    const bkSm = $("bkSmooth");
    if (bkSm) {
      bkSm.onclick = (ev) => {
        if (!cs().length) { toast("先选几段", true); return; }
        openShapeMenu(ev.currentTarget, "batch");
      };
    }

    /* --- 批量套空间方案（HRTF 是实时渲染的，不用重生成） --- */
    const bkSpace = $("bkSpace");
    if (bkSpace) {
      bkSpace.onclick = (ev) => {
        const list = cs();
        if (!list.length) { toast("先选几段", true); return; }
        const entries = [{ head: `给选中的 ${list.length} 段统一套一个方案` }];
        SPACE_PRESETS.forEach((p) => {
          entries.push({
            label: `${p.icon} ${p.name}`,
            fn: () => {
              list.forEach((c) => {
                c.binaural = true;
                c.sp_preset = p.id;
                if (p.hrtf != null) c.hrtf = p.hrtf;
                if (p.room != null) c.room = p.room;
                if (p.send != null) c.send = p.send;
                if (p.gain != null) c.gain = p.gain;
                if (p.az != null) c.az = p.az;
                if (p.el != null) c.el = p.el;
                if (p.dist != null) c.dist = p.dist;
              });
              bulkCommit(list, `批量空间方案：${p.name}`);
              toast(`${list.length} 段已套用「${p.name}」（不用重新生成，试听就能听出来）`);
            },
          });
        });
        entries.push("-");
        entries.push({ label: "🔇 关掉双耳（回到声像）", fn: () => {
          list.forEach((c) => { c.binaural = false; c.sp_preset = ""; });
          bulkCommit(list, "批量关闭双耳");
          toast(`${list.length} 段已关闭空间音频`);
        } });
        dropMenuBelow(ev.currentTarget, entries);
      };
    }

    const bkGen = $("bkGenProps");
    if (bkGen) {
      bkGen.onclick = () => {
        const uids = cs().filter((c) => c.kind === "voice" && c.uid).map((c) => c.uid);
        if (!uids.length) { toast("选中的里面没有语音片段", true); return; }
        openGenProps(uids, null);
      };
    }

    $("bkRegen").onclick = async () => {
      const l = cs().filter((c) => c.kind === "voice" && c.uid);
      if (!l.length) { toast("选中的里面没有语音片段", true); return; }
      const ok = confirm(`重新生成 ${l.length} 句？\n\n` +
        "· 每句的位置会保持现在不动（其它音轨也不会被挤动）\n" +
        "· 时长可能变，波形会重画；万一和前一段叠了，点「⇄ 整理重叠」\n" +
        "· 想让某句重新自动排位：片段属性里点「回到台本位置」\n" +
        "· 生成期间可以继续编辑，完成后自动刷新");
      if (!ok) return;
      const btn = $("bkRegen");
      btn.disabled = true;
      try {
        const r = await fetch(`${API}/regen`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uids: l.map((c) => c.uid), pin_start: true }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || "启动失败");
        toast(`已开始重新生成 ${d.count} 句（位置不变，锁住 ${d.pinned || 0} 处）`);
        pollRender(0);
      } catch (e) {
        toast("重新生成失败：" + e.message, true);
      } finally {
        btn.disabled = false;
      }
    };
  }

  /* ==================== 改生成属性 + 重生成（与台本页同一份数据） ====================
     写的是 script.json 里行上的 ov / pause / slow —— 就是台本工作台编辑的那份，
     进时间轴时台本页已经切到同一个脚本，所以不需要「同步」这一步，本来就是一份。
     改完 sig 变了，状态自动变「需重生成」，接着就把这几句重跑一遍（位置钉住不变）。 */
  const EMO_MODE_NAMES = ["同音色", "情感音频", "情感向量", "情感文本"];
  let META_REFS = null;

  async function loadRefs() {
    if (META_REFS) return META_REFS;
    try {
      const r = await fetch(`${LFAPI}/meta`);
      const d = await r.json();
      META_REFS = d.refs || [];
    } catch (e) { META_REFS = []; }
    return META_REFS;
  }

  function refNameOf(rid) {
    if (!rid) return "跟随默认";
    const r = (META_REFS || []).find((x) => x.id === rid);
    return r ? r.name : rid.slice(0, 6);
  }

  /* 参数预设（跨台本）：时间轴改属性弹窗里可以直接套。
     只用来**填控件**，最后仍然走「应用」那一步（能看见改了哪些项）。 */
  let TPRESETS = null;
  async function loadTPresets() {
    if (TPRESETS) return TPRESETS;
    try {
      const r = await fetch("/api/v1/lf/presets");
      const d = await r.json();
      TPRESETS = d.presets || [];
    } catch (e) { TPRESETS = []; }
    return TPRESETS;
  }

  async function openGenProps(uids, oneClip) {
    if (!uids || !uids.length) return;
    const single = uids.length === 1;
    const btnCount = uids.length;
    let data = null;
    try {
      const r = await fetch(`${API}/line-props?uids=${encodeURIComponent(uids.join(","))}`);
      data = await r.json();
      if (!r.ok) throw new Error(data.detail || "读取属性失败");
    } catch (e) {
      toast("读取属性失败：" + e.message, true);
      return;
    }
    const lines = data.lines || [];
    if (!lines.length) { toast("这几段没有可改属性的句子", true); return; }
    const dflt = data.defaults || {};
    const refs = await loadRefs();

    // 批量时把「值不一致」的字段标成多值
    const sameVal = (k) => {
      if (lines.length < 2) return true;
      const v0 = JSON.stringify(lines[0].eff ? lines[0].eff[k] : null);
      return lines.every((l) => JSON.stringify((l.eff || {})[k]) === v0);
    };
    const sample = lines[0];

    const body = el("div");
    body.appendChild(el("div", "hint",
      single
        ? `第 ${oneClip && oneClip.index ? oneClip.index : 1} 句：改完会写回台本（台本页刷新就能看到），并重跑这一句。`
        : `将作用于选中的 ${btnCount} 句语音；只应用左边打了勾的项目。改完写回台本并重跑这几句。`));

    const mkRow = (label, node, on, wide) => {
      const row = el("div", "bulkrow" + (wide ? " wide" : ""));
      let chk = null;
      if (!single) {
        const lab = el("label", "mini-chk bulkchk");
        chk = document.createElement("input");
        chk.type = "checkbox";
        chk.checked = on !== false;
        lab.appendChild(chk);
        lab.appendChild(el("span", null, label));
        row.appendChild(lab);
      } else {
        row.appendChild(el("span", "bulklab", label));
      }
      const bodyEl = el("div", "bulkbody");
      bodyEl.appendChild(node);
      row.appendChild(bodyEl);
      body.appendChild(row);
      return { row, chk, body: bodyEl };
    };

    /* 预设条常驻（两页共用 GenParams.presetBar）：
       · 「填入」把参数灌进下面的控件，仍然要点「应用」—— 弹窗里有
         「立即重生成 / 保持位置」两个开关，直接生效会绕过它们；
       · 「＋ 存为预设」用当前这套控件值新建方案，不碰任何句子。 */
    await loadTPresets();
    if (typeof GenParams !== "undefined") {
      body.appendChild(GenParams.presetBar({
        presets: () => TPRESETS || [],
        label: "预设",
        refName: (id) => refNameOf(id),
        toast,
        onFill: (p) => fillFromPreset(p),
        onSave: (name) => savePanelAsPreset(name),
        onManage: () => toast("在台本页顶栏「⚙ 设置 → 参数预设」里新建 / 改名 / 删除"),
      }));
    }

    // 音色
    const refSel = document.createElement("select");
    refSel.className = "sel grow";
    refSel.innerHTML = '<option value="">' + (dflt.ref
      ? '跟随默认（' + refNameOf(dflt.ref) + '）'
      : '跟随默认（台本还没设默认音色）') + '</option>';
    const groups = {};
    refs.forEach((r) => (groups[r.group || "默认"] = groups[r.group || "默认"] || []).push(r));
    Object.keys(groups).forEach((g) => {
      const og = document.createElement("optgroup");
      og.label = g;
      groups[g].forEach((r) => {
        const op = el("option", null, r.name + (r.dur ? `（${r.dur}s）` : ""));
        op.value = r.id;
        og.appendChild(op);
      });
      refSel.appendChild(og);
    });
    refSel.value = single ? (sample.ov.ref || "") : (sameVal("ref") ? (sample.ov.ref || "") : "");
    const rowRef = mkRow("音色", refSel);

    /* 情感：模式 / 参考音频 / 向量 / 文本 / 权重。
       用两页共用的组件（web/emoctl.js）渲染，字段跟主界面、台本页完全一致——
       以前这里只有「情感描述」，选不了情感音频、也调不了向量。 */
    const emoHost = el("div");
    const emoRow = mkRow("情感", emoHost, true, true);
    const emoCtl = EmoCtl.mount(emoHost, {
      mode: single ? (sample.ov && sample.ov.emo_mode != null ? sample.ov.emo_mode : null) : null,
      weight: Number(sample.eff && sample.eff.emo_weight != null
        ? sample.eff.emo_weight
        : (single && sample.ov && sample.ov.emo_weight != null)
          ? sample.ov.emo_weight : (dflt.emo_weight != null ? dflt.emo_weight : 0.65)),
      vec: single ? ((sample.ov && sample.ov.emo_vec) || (sample.eff && sample.eff.emo_vec) || []) : [],
      text: single ? ((sample.ov && sample.ov.emo_text) || "") : "",
      emoRef: single
        ? ((sample.ov && sample.ov.emo_ref) || (sample.eff && sample.eff.emo_ref) || "")
        : "",
      refs,
      follow: true,
      defaultMode: Number(dflt.emo_mode || 0),
      defaultRef: dflt.emo_ref || "",
      defaultName: refNameOf(dflt.emo_ref || ""),
      api: LFAPI,
      toast,
      onUploaded: async (ref) => {
        META_REFS = null;
        const list = await loadRefs();
        if (list.some((x) => x.id === ref.id)) return list;
        return list.concat([{ ...ref, group: "我的音色", editable: true, uses: ["emo"] }]);
      },
    });
    // 批量：左边一个勾选框管整块；但**只提交真正改过的字段**，
    // 否则「批量改个停顿」会把所有人的情感模式/向量一起清成默认。
    emoRow.row.title = "音色 / 情感音频 / 情感向量 / 描述 / 权重（只写入你改过的项）";
    const emoBase = {
      mode: emoCtl.mode, weight: emoCtl.weight,
      vec: JSON.stringify(emoCtl.vec || []),
      text: emoCtl.text || "", ref: emoCtl.emoRef || "",
    };

    // 行后停顿
    const pa = document.createElement("input");
    pa.className = "inp grow";
    pa.type = "number"; pa.min = "0"; pa.max = "30000"; pa.step = "10";
    pa.placeholder = "毫秒；留空 = 不改";
    pa.value = single && sample.pause != null ? String(sample.pause) : "";
    const paWrap = el("div", "rowline");
    paWrap.appendChild(pa);
    const paDef = el("button", "btn mini ghost", "用默认");
    paDef.type = "button";
    paDef.title = "清掉这一行的停顿覆盖，回到台本默认";
    paDef.onclick = () => { pa.value = ""; pa.dataset.def = "1"; toast("停顿将回到默认"); };
    pa.oninput = () => { delete pa.dataset.def; };
    paWrap.appendChild(paDef);
    const rowPa = mkRow("行后停顿", paWrap);

    // 慢语速
    const sl = document.createElement("input");
    sl.type = "checkbox";
    sl.checked = single ? !!sample.slow : lines.every((l) => l.slow);
    const slLab = el("label", "mini-chk");
    slLab.style.cssText = "display:flex;align-items:center;gap:6px;font-size:12px";
    slLab.appendChild(sl);
    slLab.appendChild(el("span", null, "慢语速标记（不影响生成，供导出参考）"));
    const rowSl = mkRow("语速", slLab);

    /* 预设 → 控件 / 控件 → 预设（声明在这两个函数里，靠闭包拿 refSel / emoCtl / pa / sl） */
    function fillFromPreset(p) {
      const np = GenParams.normalize(p.params);
      if (np.ref !== undefined) refSel.value = np.ref || "";
      emoCtl.apply(np);
      if (np.pause != null) { pa.value = String(np.pause); delete pa.dataset.def; }
      if (np.slow != null) sl.checked = !!np.slow;
      toast(`已填入预设「${p.name}」：看完点「应用」才生效`);
    }

    function readPanelParams() {
      const em = emoCtl.read();
      const out = {
        ref: refSel.value || "",
        emo_mode: em.emo_mode,
        emo_weight: em.emo_weight,
        emo_vec: em.emo_vec,
        emo_text: em.emo_text,
        emo_ref: em.emo_ref,
      };
      const pv = (pa.value || "").trim();
      if (pv !== "") out.pause = Math.max(0, Math.min(30000, parseInt(pv, 10) || 0));
      if (sl.checked) out.slow = true;
      return out;
    }

    async function savePanelAsPreset(name) {
      const r = await fetch("/api/v1/lf/presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, params: readPanelParams() }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.detail || "保存失败");
      TPRESETS = (TPRESETS || []).concat([d.preset]);
      toast(`预设「${name}」已保存：只新增了方案，没有改任何句子`);
      return d.preset;
    }

    // 选项
    const opt = el("div", "genopt");
    const cbRegen = document.createElement("input");
    cbRegen.type = "checkbox";
    cbRegen.checked = true;
    const l1 = el("label", "mini-chk");
    l1.appendChild(cbRegen);
    l1.appendChild(el("span", null, "改完立即重生成这几句"));
    opt.appendChild(l1);
    const cbPin = document.createElement("input");
    cbPin.type = "checkbox";
    cbPin.checked = true;
    const l2 = el("label", "mini-chk");
    l2.appendChild(cbPin);
    l2.appendChild(el("span", null, "保持它们现在的位置（其它句子不动）"));
    opt.appendChild(l2);
    body.appendChild(opt);

    const m = modal(single ? "改属性并重生成" : `批量改属性（${btnCount} 句）`,
      (box) => box.appendChild(body), "应用", async (box) => {
        const ov = {};
        const use = (r) => single || !r.chk || r.chk.checked;
        // 单个片段：只提交真正改过的字段，免得平白多出一条「改过生成属性」
        const curOv = sample.ov || {};
        const curEff = sample.eff || {};
        if (use(rowRef)) {
          const v = refSel.value || "";
          if (!single || v !== (curOv.ref || "")) ov.ref = v || null;
        }
        if (use(emoRow)) {
          const em = emoCtl.read();
          if (em.emo_mode === 1 && !em.emo_ref) {
            toast("情感模式是「情感音频」，但还没选音频", true);
            return false;
          }
          // 只提交「和打开弹窗时不一样」的字段：
          // 单条时避免平白多出一条「改过生成属性」；批量时避免一次「只改停顿」
          // 就把大家的情感模式 / 向量一起清成默认。
          if (em.emo_mode !== emoBase.mode) ov.emo_mode = em.emo_mode;
          if (Math.abs(em.emo_weight - emoBase.weight) > 0.005) ov.emo_weight = em.emo_weight;
          if (JSON.stringify(em.emo_vec || []) !== emoBase.vec) ov.emo_vec = em.emo_vec;
          if ((em.emo_text || "") !== emoBase.text) ov.emo_text = em.emo_text;
          if ((em.emo_ref || "") !== emoBase.ref) ov.emo_ref = em.emo_ref;
        }
        const req = { uids, ov, regen: cbRegen.checked, pin_start: cbPin.checked };
        if (use(rowPa)) {
          const v = pa.value.trim();
          if (pa.dataset.def === "1") req.pause_clear = true;
          else if (v !== "") req.pause = Math.max(0, Math.min(30000, parseInt(v, 10) || 0));
        }
        if (use(rowSl)) req.slow = !!sl.checked;
        box.closest(".mask").remove();
        await applyGenProps(req, single ? oneClip : null);
      });
    m.box.classList.add("genprops");
  }

  /* ---------------- 重生成进度条 ----------------
     以前只有批量条上的文字「生成中 3/8」，属性面板里看不到。
     这里在「改属性并重生成」按钮下面挂一条进度，轮询 /render 更新。
     不重建面板（只改宽度和文字），所以滑块、滚动位置都不会被打断。 */
  const GEN = { uids: [], state: "", done: 0, total: 0, timer: null, bar: null };

  function genBarMount(host, c) {
    if (!GEN.state || !c || !c.uid || !GEN.uids.includes(c.uid)) return;
    const wrap = el("div", "genprog");
    const top = el("div", "genprog-h");
    const lab = el("span", "genprog-l", "准备中…");
    const num = el("span", "genprog-n", "");
    top.appendChild(lab); top.appendChild(num);
    const track = el("div", "genprog-t");
    const fill = el("i", "genprog-f");
    track.appendChild(fill);
    wrap.appendChild(top); wrap.appendChild(track);
    host.appendChild(wrap);
    GEN.bar = { wrap, lab, num, fill };
    genBarPaint();
  }

  function genBarPaint() {
    const b = GEN.bar;
    if (!b) return;
    const total = Math.max(1, GEN.total || 1);
    const done = Math.max(0, Math.min(total, GEN.done || 0));
    const pct = GEN.state === "done" ? 100 : Math.round(done / total * 100);
    b.fill.style.width = pct + "%";
    b.num.textContent = `${done}/${total}`;
    b.lab.textContent = GEN.state === "queued" ? "排队中…"
      : (GEN.state === "running" ? "正在重生成…" : "已完成");
  }

  async function startGenWatch(uids) {
    if (!uids || !uids.length) return;
    GEN.uids = uids.slice();
    GEN.state = "queued"; GEN.done = 0; GEN.total = uids.length;
    clearTimeout(GEN.timer);
    drawInspector();
    const tick = async () => {
      try {
        const r = await fetch(`${LFAPI}/scripts/${SID}/render`);
        const d = await r.json();
        const job = d.render;
        if (job) {
          GEN.state = job.state || "running";
          GEN.done = job.done || 0;
          GEN.total = job.total || GEN.total;
        } else {
          GEN.state = "done";
          GEN.done = GEN.total;
        }
      } catch (e) {
        GEN.state = "done";
      }
      genBarPaint();
      if (["running", "queued", "stopping"].includes(GEN.state)) {
        GEN.timer = setTimeout(tick, 900);
        return;
      }
      GEN.timer = null;
      await reload(true);
      // 先让进度条停在 100% 一下（不然刚做完就消失，像没跑一样）
      genBarPaint();
      draw();
      await new Promise((r) => setTimeout(r, 1200));
      GEN.state = ""; GEN.bar = null;
      drawInspector(); draw();
      toast("重生成完成");
    };
    tick();
  }

  async function applyGenProps(req, oneClip) {
    try {
      const r = await fetch(`${API}/line-props`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || "保存失败");
      const n = d.count || (req.uids || []).length;
      toast(`已改 ${n} 句的属性${req.regen ? "，正在重生成…" : "（未重生成）"}`);
      if (d.regen_error) toast("重生成没起来：" + d.regen_error, true);
      if (d.render) {
        pollRender(0);
        if (req.regen) startGenWatch(req.uids || []);
      } else await reload(true);
      drawInspector();
      draw();
    } catch (e) {
      toast("改属性失败：" + e.message, true);
    }
  }

  /* ------------------------------ 房间预设 ------------------------------ */
  let ROOMS = [
    { id: "small", name: "小卧室", rt60: 0.35 },
    { id: "living", name: "客厅", rt60: 0.6 },
    { id: "corridor", name: "走廊", rt60: 0.95 },
    { id: "hall", name: "大厅", rt60: 1.9 },
    { id: "outdoor", name: "室外", rt60: 0.1 },
  ];
  /* HRIR 数据集清单：空字符串 = 跟随默认（环境变量 / assets 里第一个）。
     每段片段可以单独选 —— 这就是「多套 HRIR 方案共存」的入口。 */
  let HRIR_PROFILES = [{ id: "", label: "跟随默认" }];
  let HRIR_STATUS = null;
  async function loadRoomsMeta() {
    try {
      const r = await fetch(`${LFAPI}/tl-rooms`);
      const d = await r.json();
      if (Array.isArray(d.rooms) && d.rooms.length) {
        ROOMS = d.rooms;
      }
      if (Array.isArray(d.hrir_profiles) && d.hrir_profiles.length) {
        HRIR_PROFILES = [{ id: "", label: "跟随默认" }].concat(
          d.hrir_profiles.map((p) => ({
            id: p.id,
            kind: p.kind,
            layers: (p.dist && p.dist[2]) || 0,
            distMin: (p.dist && p.dist[0]) || 99,
            label: p.kind === "analytic" ? p.label
              // 下拉很窄：只标层数，具体范围写在下面的说明里
              : `${p.label}${p.dist && p.dist.length > 1 ? `（${p.dist[2]} 层）`
                : (p.dist && p.dist.length ? `（${p.dist[0].toFixed(1)}m）` : "")}`,
          })));
        HRIR_STATUS = d.hrir || null;
      }
      if (S.data) drawInspector();
    } catch (e) { /* 离线就用兜底 */ }
  }

  /* ------------------------------ 加载 ------------------------------ */
  async function reload(quiet) {
    const r = await fetch(API);
    if (!r.ok) { toast("加载失败", true); return; }
    const d = await r.json();
    d.tracks.forEach((t) => t.clips.sort((a, b) => a.start - b.start));
    /* 淡入淡出按「显示区段」夹紧：老工程里可能存着比片段还长的值
       （以前淡出上限写死 5s，变速/裁短后就会溢出到片段外，画面上整段都被压暗）。 */
    d.tracks.forEach((t) => t.clips.forEach((c) => {
      const dd = Math.max(0.05, Number(c.dur) || 0);
      let a = clamp(Number(c.fade_in) || 0, 0, dd);
      let b = clamp(Number(c.fade_out) || 0, 0, dd);
      if (a + b > dd) {
        const k = dd / (a + b);
        a = Math.floor(a * k * 1000) / 1000;
        b = Math.floor(b * k * 1000) / 1000;
      }
      c.fade_in = a;
      c.fade_out = b;
    }));
    S.data = d;
    if (!S.data.duration) S.data.duration = 1;
    $("scriptTitle").textContent = d.title || "未命名";
    $("projTag").hidden = !(d.project && d.project.source_id);
    $("timeTotal").textContent = fmtShort(d.duration);
    localStorage.setItem("lf.last", SID);
    if (!quiet) buildHeads();   // 拖音量滑块时不重建轨道头（否则滑块会被替换掉）
    pruneMulti();
    prunePeaks();          // 换版本后的旧波形缓存丢掉
    drawInspector();
    updateZoomTag();
    drawMarkersList();
    syncTagFollowUI();
    refreshMeterModes();
    loadMedia();
    resize();
    // 撤销栈的基准：没有待落定的改动时，把基准对齐到刚拉回来的数据。
    // 有 pending（persist 紧跟着 reload 的路径）就保持旧基准，
    // 让 flushUndo 还能把「改之前」的那一步记进栈里。
    if (!HIST.timer) { HIST.base = projSnap(); updateUndoBtns(); }
  }

  /* ---------------- 重排音声片段延迟 ----------------
     按台本里的句间停顿（行上没设就跟默认）把音声片段依次排开：
     只改 start，不动 dur / 裁剪 / 音量 / 空间 / 关键帧，也不碰素材片段。 */
  function relayoutVoiceDelays() {
    const cs = allClips().filter((c) => c.kind === "voice" && c.index != null);
    if (!cs.length) { toast("这条时间轴上还没有音声片段", true); return; }
    /* 按**句序全局排队**，不看片段在哪条音声轨上。
       以前是「每条轨各自从头排」，句子一旦分散在多条音声轨上，
       排完就变成 A(轨1) / C(轨2) / B(轨1) 这种错乱顺序。
       现在：所有音声片段按 index 排成一条队，从最早的那个起点开始，
       一段接一段 + 句间停顿；轨上有没有空白都不影响。 */
    const sorted = cs.slice().sort((a, b) => (a.index - b.index) || (a.start - b.start));
    const plan = [];
    let totalPause = 0;
    let t = Math.min(...sorted.map((c) => c.start));
    sorted.forEach((c) => {
      const pause = Math.max(0, Number(c.pause_ms != null ? c.pause_ms : (c.pause || 0))) / 1000;
      plan.push({ c, from: c.start, to: Math.round(t * 1000) / 1000, pause });
      t += (c.dur || 0) + pause;
      totalPause += pause;
    });
    const trackN = new Set(plan.map((x) => x.c.track)).size;
    const moved = plan.filter((x) => Math.abs(x.to - x.from) > 0.001);
    const dur = plan.reduce((m, x) => Math.max(m, x.to + (x.c.dur || 0)), 0);

    modal("重排音声片段延迟", (box) => {
      const firstTrack = trackOfClip(plan[0].c);
      const lastTrack = trackOfClip(plan[plan.length - 1].c);
      box.appendChild(el("div", "phint",
        `按台本句序把 ${plan.length} 段音声片段排成一条时间线（跨 ${trackN} 条音声轨，`
        + `不按轨分组 —— 句子在轨上怎么分布都不影响顺序）。`));
      if (firstTrack && lastTrack && firstTrack.id !== lastTrack.id) {
        box.appendChild(el("div", "phint",
          `注意：第 1 句在「${firstTrack.name}」、最后一句在「${lastTrack.name}」，`
          + `它们是同一条时间线上的先后关系，只是换了轨。`));
      }
      const ul = el("div", "phint");
      ul.innerHTML = [
        "· <b>只改开始时间</b>：时长、裁剪、音量、声像、空间、关键帧、淡入淡出都不动",
        "· <b>素材轨上的片段一律不动</b>，保持它们现在的位置",
        `· 停顿用台本里的值（行上没单独设就是全局默认），合计 ${totalPause.toFixed(2)}s`,
        `· 排完最后一段落在 ${fmtShort(dur)}，${moved.length} 段位置会变`,
        "· 只看句子顺序和停顿；片段仍留在各自原来的音声轨上，不会为了排序而换轨",
      ].join("<br>");
      box.appendChild(ul);
      const lockedN = plan.filter((x) => x.c.locked).length;
      if (lockedN) {
        box.appendChild(el("div", "phint",
          `其中 ${lockedN} 段是「锁定」状态：重排时会临时解锁写入新位置，写完立刻锁回去，锁不会丢。`));
      }
      box.appendChild(el("div", "phint", "重排会进撤销栈，不满意可以 Ctrl+Z 退回。"));
    }, "重排", async (box) => {
      undoMark("重排音声延迟");
      /* 音声片段默认是「锁定」的（保护位置），服务端会拒绝改 start。
         这里先临时解锁写入新位置，落盘后再把锁加回去（此时服务端以新位置为基准，不会再回滚）。 */
      const lockedOnes = plan.filter((x) => x.c.locked).map((x) => x.c);
      lockedOnes.forEach((c) => { c.locked = false; });
      plan.forEach((x) => {
        x.c.start = x.to;
        writeClipOverride(x.c);
      });
      markDirty("重排音声延迟");
      extendDurationToClips();
      drawInspector(); draw();
      await persist("重排音声延迟");
      if (lockedOnes.length) {
        lockedOnes.forEach((c) => { c.locked = true; writeClipOverride(c); });
        markDirty("重排音声延迟（恢复锁定）");
        await persist("重排音声延迟（恢复锁定）");
      }
      box.closest(".mask")?.remove();
      toast(`已按句间停顿重排 ${plan.length} 段（${moved.length} 段位置变化`
        + (lockedOnes.length ? `，${lockedOnes.length} 段仍保持锁定` : "") + "）");
      return true;
    });
  }

  const btnRelayout = $("btnRelayout");
  if (btnRelayout) btnRelayout.onclick = relayoutVoiceDelays;

  /* ------------------------------ 事件 ------------------------------ */
  // 轨道头与画布纵向滚动同步
  const scrollEl = $("scroll"), headsEl = $("heads");
  let syncingScroll = false;
  scrollEl.addEventListener("scroll", () => {
    if (syncingScroll) return;
    syncingScroll = true;
    headsEl.scrollTop = scrollEl.scrollTop;
    syncingScroll = false;
  });
  headsEl.addEventListener("scroll", () => {
    if (syncingScroll) return;
    syncingScroll = true;
    scrollEl.scrollTop = headsEl.scrollTop;
    syncingScroll = false;
  });

  // 主题切换（本页独立控制，默认浅色）
  (function initThemeBtn() {
    const btn = $("btnTheme");
    const sync = () => {
      const dark = document.documentElement.dataset.theme === "dark";
      btn.textContent = dark ? "☀ 白天" : "🌙 夜间";
    };
    sync();
    btn.onclick = () => {
      const dark = document.documentElement.dataset.theme === "dark";
      const next = dark ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      localStorage.setItem("lf.theme", next);
      applyCol();
      draw(); drawNav();
      sync();
    };
  })();
  $("btnPlay").onclick = play;
  $("btnStop").onclick = () => { pause(); seek(0); };
  $("btnHome").onclick = () => seek(0);
  $("btnEnd").onclick = () => seek(S.data ? S.data.duration : 0);
  $("btnBack5").onclick = () => seek(S.pos - 5);
  $("btnFwd5").onclick = () => seek(S.pos + 5);
  $("btnLoop").onclick = () => {
    S.loop = !S.loop;
    $("btnLoop").classList.toggle("on", S.loop);
    toast(S.loop ? "循环播放已开" : "循环播放已关");
  };
  $("btnSnap").onclick = () => {
    S.snap = !S.snap;
    $("btnSnap").classList.toggle("on", S.snap);
    try { localStorage.setItem("tl.snap", S.snap ? "1" : "0"); } catch (e) { /* 忽略 */ }
    toast(S.snap ? "吸附已开" : "吸附已关");
  };
  document.querySelectorAll("#mFilters .chip").forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.mf;
      if (k === "sfx") {
        MFILTER.sfxOnly = !MFILTER.sfxOnly;
      } else {
        MFILTER.kind = k;
        MFILTER.sfxOnly = false;
      }
      MSEL.clear(); MSEL_ANCHOR = null;
      drawMarkersList();
    };
  });
  const mBkSfx = $("mBkSfx");
  if (mBkSfx) {
    mBkSfx.onclick = () => pickSfxForTags(selMarkers());
    $("mBkDrop").onclick = () => tagSfxApply(selMarkers(), null);
    $("mBkMute").onclick = () => tagMuteApply(selMarkers(), true);
    $("mBkUnmute").onclick = () => tagMuteApply(selMarkers(), false);
    $("mBkDel").onclick = () => {
      const ms = selMarkers().filter((m) => m.custom);
      if (!ms.length) return;
      if (!confirm(`删除选中的 ${ms.length} 个普通标记？（台本标签不受影响）`)) return;
      ms.forEach((m) => delMark(m.id));
    };
  }
  const tfSel = $("tagFollowMode");
  if (tfSel) {
    tfSel.onchange = () => setTagFollow(tfSel.value, false);
  }
  const tfSnap = $("btnTagFollowSnap");
  if (tfSnap) {
    tfSnap.onclick = () => {
      const m = ((S.data && S.data.project && S.data.project.tagfollow) || {}).mode || "follow";
      if (m === "follow") { toast("「跟随句子」不需要冻结位置 —— 标签本来就跟着句子走"); return; }
      setTagFollow(m, true);
    };
  }
  const bHov = $("btnHoverInsOn");
  if (bHov) {
    bHov.classList.toggle("on", HOVER_INS_ON);
    bHov.onclick = () => {
      HOVER_INS_ON = !HOVER_INS_ON;
      bHov.classList.toggle("on", HOVER_INS_ON);
      try { localStorage.setItem("tl.hoverins", HOVER_INS_ON ? "1" : "0"); } catch (e) { /* 忽略 */ }
      if (!HOVER_INS_ON) hideHoverIns(true);
      toast(HOVER_INS_ON ? "标记悬浮窗：显示" : "标记悬浮窗：隐藏（右键标记仍可插入素材）");
    };
  }

  /* ---------------- 预览倍速（0.5× ~ 4×，可自定义） ----------------
     只改试听：tick 的时间推进 + 每个 audio 元素的 playbackRate。
     导出混音永远按原速渲染，所以「1.5 倍速听一遍」不会影响成品。 */
  const rateSel = $("rateSel");
  function applyRate(v, quiet) {
    const r = clamp(Number(v) || 1, 0.2, 4);
    S.rate = r;
    try { localStorage.setItem("tl.rate", String(r)); } catch (e) { /* 忽略 */ }
    // 正在播时换速：保住当前位置，别跳一下
    if (S.playing) S.t0 = t0For(S.pos);
    for (const [id, a] of audioPool.entries()) {
      const c = clipById(id);
      a.playbackRate = clamp((c ? clamp(c.speed || 1, 0.25, 4) : 1) * r, 0.25, 4);
    }
    if (rateSel) {
      const hit = [...rateSel.options].some((o) => Math.abs(parseFloat(o.value) - r) < 1e-6);
      if (!hit) {
        const o = document.createElement("option");
        o.value = String(r);
        o.textContent = `${r.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}×（自定义）`;
        rateSel.insertBefore(o, rateSel.lastElementChild);
        rateSel.value = String(r);
      } else {
        rateSel.value = String(r);
      }
    }
    if (!quiet) toast(`预览倍速 ${r}×` + (r === 1 ? "" : "（导出不受影响）"));
  }
  window.applyTlRate = applyRate;
  if (rateSel) {
    rateSel.onchange = () => {
      if (rateSel.value !== "custom") { applyRate(rateSel.value); return; }
      const cur = S.rate || 1;
      const v = prompt("自定义预览倍速（0.2 ~ 4，例如 1.35）：", String(cur));
      if (v == null) { rateSel.value = String(cur); return; }
      const n = parseFloat(v);
      if (!(n >= 0.2 && n <= 4)) {
        toast("倍速要在 0.2 ~ 4 之间", true);
        rateSel.value = String(cur);
        return;
      }
      applyRate(n);
      // 选中刚插进去的那一项
      rateSel.value = String(clamp(n, 0.2, 4));
    };
    let saved = 1;
    try { saved = parseFloat(localStorage.getItem("tl.rate") || "1") || 1; } catch (e) { saved = 1; }
    applyRate(saved, true);
  }
  if ($("btnHelp")) $("btnHelp").onclick = () => openShortcuts();
  // 折叠面板
  const toggleSec = (secId, tgId) => {
    const sec = $(secId), tg = $(tgId);
    tg.onclick = () => sec.classList.toggle("collapsed");
  };
  toggleSec("secInspector", "tgInspector");
  toggleSec("secMedia", "tgMedia");
  toggleSec("secMarker", "tgMarker");
  $("btnZoomIn").onclick = () => zoom(1.4);  $("btnZoomOut").onclick = () => zoom(1 / 1.4);
  $("btnFit").onclick = () => {
    if (!S.data) return;
    S.pps = clamp((W - 40) / Math.max(1, S.data.duration), 4, 900);
    S.scrollX = 0;
    updateZoomTag(); draw();
  };
  const addTrackOfKind = async (kind) => {
    const r = await fetch(`${API}/tracks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind }),
    });
    if (!r.ok) toast((await r.json()).detail || "加不了", true);
    reload();
  };
  setInterval(updateOverlapBadge, 900);
  setTimeout(updateOverlapBadge, 600);
  $("btnAddVoiceTrack").onclick = () => addTrackOfKind("voice");
  $("btnAddSfxTrack").onclick = () => addTrackOfKind("sfx");
  if ($("btnCleanTracks")) $("btnCleanTracks").onclick = cleanEmptyTracks;
  if ($("btnMediaRefresh")) $("btnMediaRefresh").onclick = () => { loadMedia(); toast("素材列表已刷新"); };
  if ($("btnDesk")) $("btnDesk").onclick = () => openDesk("sfx");
  if ($("mediaSearch")) $("mediaSearch").oninput = (e) => { mediaQuery = e.target.value; drawMediaList(); };
  document.querySelectorAll("#mSeg .msb").forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.mt;
      MTAB = ["sfx", "ref", "mat"].includes(k) ? k : "sfx";
      try { localStorage.setItem("tl.mtab", MTAB); } catch (e) { /* 忽略 */ }
      // 切到某个库时顺手拉一次最新的（三个库都是全局的，别处可能刚加过东西）
      if (MTAB === "sfx") loadSfxLib();
      else if (MTAB === "ref") loadRefsLib();
      else loadMedia();
    };
  });
  if ($("btnUndo")) $("btnUndo").onclick = doUndo;
  if ($("btnRedo")) $("btnRedo").onclick = doRedo;
  if ($("btnHistory")) $("btnHistory").onclick = openHistory;
  if ($("btnDeskClose")) $("btnDeskClose").onclick = closeDesk;
  if ($("btnDeskReload")) {
    $("btnDeskReload").onclick = () => { if (DESK.loaded) $("deskFrame").src = $("deskFrame").src; };
  }
  if ($("btnDeskFull")) {
    $("btnDeskFull").onclick = () => window.open(`/longform?desk=1&target=sfx`, "_blank");
  }
  if ($("deskMask")) {
    $("deskMask").addEventListener("mousedown", (e) => { if (e.target.id === "deskMask") closeDesk(); });
  }
  updateUndoBtns();
  initMeterMode();
  initBottomSplit();
  loadRoomsMeta();
  initBulk();
  $("btnMix").onclick = openMix;

  /* 顶部时间窗：点总时长可以主动改（调大留白 / 缩短，短于最后一段会被自动撑回） */
  (function initDurationEdit() {
    const tt = $("timeTotal");
    if (!tt) return;
    tt.style.cursor = "pointer";
    tt.title = "点击修改工程总时长（秒）";
    tt.onclick = () => {
      if (!S.data) return;
      const cur = Number(S.data.duration || 0).toFixed(2);
      const v = prompt("工程总时长（秒）：\n可以调大留出空白；调得比最后一段末端还小的话，会自动以片段为准。", cur);
      if (v == null) return;
      const n = Math.max(1, Number(v) || 0);
      S.data.duration = Math.round(n * 1000) / 1000;
      S.data.project.duration = S.data.duration;
      extendDurationToClips();          // 比片段末端短 → 撑回去
      tt.textContent = fmtShort(S.data.duration);
      markDirty("修改总时长");
      resize(); drawNav(); draw();
      toast(`总时长 ${fmtShort(S.data.duration)}`);
    };
  })();
  $("btnPack").onclick = prePackCheck;
  if ($("btnFixOverlap")) $("btnFixOverlap").onclick = fixOverlapsUI;
  $("btnSave").onclick = save;
  $("fileMedia").onchange = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length) uploadFiles(files);
    e.target.value = "";
  };
  $("mediaList").addEventListener("dragover", (e) => e.preventDefault());
  $("mediaList").addEventListener("drop", (e) => {
    e.preventDefault();
    // 三个库都是全局库：这里不直接收文件（避免又变成「工程里的临时素材」）
    toast("要加新素材请点「📥 素材导入台」：上传 → 处理 → 存成音效/音色", true);
  });

  /* ---------------- 键盘（模仿剪映；? 看完整列表） ---------------- */
  function muteSel() {
    const list = S.multi.size ? selClips()
      : (S.sel ? [clipById(S.sel)].filter(Boolean) : []);
    if (!list.length) { toast("先选一段（或多段）再按 V", true); return; }
    const want = !list.every((z) => z.mute);       // 全都静音了 → 一起取消
    list.forEach((z) => { z.mute = want; writeClipOverride(z); });
    drawInspector(); draw(); updateBulkBar();
    /* 立刻落盘：静音/取消静音是最容易被「后面的某个 reload」吃掉的状态之一，
       留在 700ms 防抖里就会变成「过一会儿自己恢复了」。 */
    persist(want ? "静音片段" : "取消静音");
    toast(want ? `已静音 ${list.length} 段` : `已取消静音 ${list.length} 段`);
  }

  function toggleKfPanel() {
    KF.hidden = !KF.hidden;
    if (KF.hidden) { KF.insert = false; KF.drag = null; }
    drawInspector();
    draw();
    toast(KF.hidden ? "关键帧面板已隐藏（Alt+K 再按显示）" : "关键帧面板已显示");
  }

  document.addEventListener("keydown", async (e) => {
    const tg = e.target;
    if (tg && tg.matches && tg.matches("input, select, textarea, [contenteditable=true]")) return;
    const c = S.sel ? clipById(S.sel) : null;
    const mod = e.ctrlKey || e.metaKey;
    const key = (e.key || "").toLowerCase();

    // 帮助
    if (e.key === "?" || (e.shiftKey && e.key === "/")) {
      e.preventDefault(); openShortcuts(); return;
    }
    // 播放 / 跳转
    if (e.code === "Space") { e.preventDefault(); play(); return; }
    if (e.key === "Home") { e.preventDefault(); seek(0); return; }
    if (e.key === "End") { e.preventDefault(); seek(S.data ? S.data.duration : 0); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); jumpCut(-1); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); jumpCut(1); return; }
    if (e.key === "ArrowLeft" && mod) { e.preventDefault(); jumpKf(-1); return; }
    if (e.key === "ArrowRight" && mod) { e.preventDefault(); jumpKf(1); return; }
    if (e.key === "ArrowLeft") { seek(S.pos - (e.shiftKey ? 5 : 1)); return; }
    if (e.key === "ArrowRight") { seek(S.pos + (e.shiftKey ? 5 : 1)); return; }
    // 标记点
    if (key === "m" && e.shiftKey && !mod) {
      e.preventDefault(); jumpMarker(e.altKey ? -1 : 1); return;
    }
    if (key === "m" && !mod) { e.preventDefault(); addMarkAt(S.pos); return; }
    // 缩放
    if (e.key === "+" || e.key === "=") { e.preventDefault(); zoom(1.4); return; }
    if (e.key === "-" || e.key === "_") { e.preventDefault(); zoom(1 / 1.4); return; }
    // 视图
    if (e.altKey && key === "k") { e.preventDefault(); toggleKfPanel(); return; }
    // 剪辑
    if (mod && key === "b") {
      e.preventDefault();
      if (e.shiftKey) splitAllAt(S.pos);
      else if (c) splitClip(c);
      else toast("先选一段素材片段，再 Ctrl+B", true);
      return;
    }
    /* Ctrl+Shift+C / Ctrl+Shift+V：复制 / 粘贴「片段属性」（不含音频内容） */
    if (mod && e.shiftKey && key === "c") {
      e.preventDefault();
      const targets = S.multi.size ? selClips() : [c].filter(Boolean);
      if (!targets.length) { toast("先选中一段", true); return; }
      copyClipProps(targets[0]);
      return;
    }
    if (mod && e.shiftKey && key === "v") {
      e.preventDefault();
      const targets = S.multi.size ? selClips() : [c].filter(Boolean);
      propsPasteDialog(targets);
      return;
    }
    if (mod && key === "c" && (S.multi.size > 1 || (c && c.kind !== "tag"))) {
      e.preventDefault();
      copySelection(false, S.multi.size > 1 ? null : (c ? [c.id] : null));
      return;
    }
    if (mod && key === "x" && c && c.kind === "sfx") {
      if (S.multi.size > 1) {
        if (copySelection(true)) {
          S.data.project.sfx = (S.data.project.sfx || []).filter((s) => !S.multi.has(s.id));
          S.multi.clear(); S.sel = null;
          updateBulkBar();
          persist("剪切片段");
        }
        return;
      }
      S.clipboard = { items: [{ c: { ...c }, dt: 0, track: c.track }], n: 1 };
      removeClip(c);
      return;
    }
    if (mod && key === "v" && S.clipboard) {
      e.preventDefault();
      const tr = c ? trackOfClip(c) : (sfxTracks()[0] || tracks()[0]);
      const made = await pasteClipboard(S.pos, tr.id);
      if (!made.length) return;
      setMulti(made.map((x) => x.id));      // 先选中：persist 里的 reload 会 prune 一次
      S.sel = made[made.length - 1].id;
      drawInspector(); draw();
      persist("插入素材").then(() => {
        setMulti(made.map((x) => x.id));
        S.sel = made[made.length - 1].id;
        drawInspector(); draw();
        toast(made.length > 1 ? `已粘贴 ${made.length} 段（保持相对位置）` : "已粘贴");
      });
      return;
    }
    if (mod && key === "z" && !e.shiftKey) { e.preventDefault(); doUndo(); return; }
    if (mod && (key === "y" || (key === "z" && e.shiftKey))) { e.preventDefault(); doRedo(); return; }
    if (mod && key === "s") { e.preventDefault(); save(); return; }
    if (mod && key === "a") { e.preventDefault(); setMulti(allClips().map((x) => x.id)); return; }
    if (e.key === "Delete" || e.key === "Backspace") {
      if (S.multi.size >= 2) {
        const b = $("bkDel");
        if (b && !b.disabled) b.click();
        else toast("语音片段跟台本走，删句子请回台本页", true);
      } else if (c) removeClip(c);
      return;
    }
    if (key === "v" && !mod) { e.preventDefault(); muteSel(); return; }
    if (key === "l" && !mod) { e.preventDefault(); lockSelection(c); return; }
    if (e.key === "Escape") {
      S.marquee = null;
      hideCtx();
      if (KF.insert) { KF.insert = false; drawInspector(); draw(); }
      else clearMulti();
      return;
    }
  });

  window.addEventListener("resize", resize);
  window.addEventListener("beforeunload", () => { if (S.dirty) save(); });

  window.__tl = {
    get state() { return S; },
    get clips() { return S.data ? S.data.tracks.reduce((n, t) => n + t.clips.length, 0) : 0; },
    get trackCount() { return S.data ? S.data.tracks.length : 0; },
    get undoLen() { return HIST.undo.length; },
    get redoLen() { return HIST.redo.length; },
    get histBase() { return HIST.base; },
    get tab() { return MTAB; },
    fmt, seek, play, pause, doUndo, doRedo, openDesk, openHistory,
    flushUndo, openInsertPicker,
    // 给自动化测试用：选中某个片段（等价于点它一下）
    selectClip(id) {
      // 「只选这一段」：顺手把多选集合也归位，否则批量操作（V 静音等）会作用到旧的多选上
      S.sel = id;
      S.multi.clear();
      if (id) S.multi.add(id);
      updateBulkBar();
      drawInspector(); draw();
    },
    // 批量选择 / 片段在画布上的屏幕坐标（测试里模拟真实点击用）
    get multi() { return Array.from(S.multi); },
    selectMany(ids) { setMulti(ids); },
    clearMulti,
    clipRect(id) {
      const c = clipById(id);
      if (!c) return null;
      const i = orderedTracks().indexOf(trackOfClip(c));
      if (i < 0) return null;
      return { i, x: xOf(c.start) + Math.min(12, c.dur * S.pps / 2),
               y: trackTop(i) + TRACK_H / 2, w: c.dur * S.pps };
    },
    groups: () => groupNames(),
    // 关键帧取值（测试与外部调试用）
    kfValueAt(id, prop, t) {
      const c = clipById(id);
      return c ? kfValue(c, prop, clamp(t, 0, c.dur)) : null;
    },
    // 关键帧点在画布上的坐标（测试用：真实点一下、拖一下）
    waveInfo(id) { return S.waveN[id] || null; },
    /* 本轮新增：剪贴板 / 属性剪贴板的状态（测试与外部调试用） */
    get clipboardCount() { return clipItems(S.clipboard).length; },
    get propClip() { return PROP_CLIP ? { ...PROP_CLIP } : null; },
    get propClipName() { return PROP_CLIP ? (PROP_CLIP.name || "") : ""; },
    get motionPresets() { return SPACE_MOTIONS.map((m) => m.id); },
    /* 本轮新增：语音复制到「音声副本音轨」 / 重排计划的预览 */
    setSpeed(id, sp) { const c = clipById(id); if (c) applySpeed(c, sp); },
    /* 测试用：直接设多选集合（模拟 Ctrl 点选的结果） */
    setMultiIds(ids) {
      setMulti((ids || []).filter((x) => !!clipById(x)));
      if (ids && ids.length) S.sel = ids[ids.length - 1];
      updateBulkBar(); drawInspector(); draw();
      return S.multi.size;
    },
    multiCount() { return S.multi.size; },
    markDirtyForTest(label) { markDirty(label || "测试标脏"); },
    /* 第 i 条轨的中心 y（画布内坐标），测试拖拽换轨用 */
    trackY(i) { return trackTop(i) + TRACK_H / 2; },
    copyVoiceToTrack(idOrIds) {
      // 传数组 = 批量（多选复制）；传单个 id = 老行为，返回新片段 id
      const many = Array.isArray(idOrIds);
      const cs = (many ? idOrIds : [idOrIds]).map((x) => clipById(x)).filter(Boolean);
      return copyVoicesToCopyTrack(cs).then((made) => (many ? made.map((x) => x.id)
        : (made[0] ? made[0].id : null)));
    },
    trackNames() { return orderedTracks().map((t) => [t.kind, t.name]); },
    relayoutPlan() {
      const cs = allClips().filter((c) => c.kind === "voice" && c.index != null)
        .slice().sort((a, b) => a.index - b.index);
      let t = cs.length ? Math.min(...cs.map((c) => c.start)) : 0;
      return cs.map((c) => {
        const row = { uid: c.uid, index: c.index, track: c.track, from: c.start,
                      to: Math.round(t * 1000) / 1000 };
        t += (c.dur || 0) + Math.max(0, Number(c.pause_ms != null ? c.pause_ms : (c.pause || 0))) / 1000;
        return row;
      });
    },
    kfPoints(id, prop) {
      const c = clipById(id);
      if (!c) return [];
      const use = prop || KF.prop;
      const i = orderedTracks().indexOf(trackOfClip(c));
      if (i < 0) return [];
      const top = trackTop(i) + 4, bh = TRACK_H - 8;
      return kfPts(c, use).map((q) => {
        const o = {
          t: q[0], v: kfYVal(use, q), x: kfX(c, q[0]),
          y: kfY(c, use, kfYVal(use, q), top, bh),
        };
        if (use === "space") {
          o.az = q[SPACE_AZ] || 0; o.el = q[SPACE_EL] || 0;
          o.dist = q[SPACE_DIST] == null ? 1 : q[SPACE_DIST];
        }
        return o;
      });
    },
    get kfProp() { return KF.prop; },
    get insertMode() { return KF.insert; },
    // 调试：试听元素的 URL（带 ?r=版本号）与波形缓存键，测试用来确认「重生成后换源」
    get audioUrls() {
      const out = {};
      for (const [id, a] of audioPool.entries()) out[id] = a._url || a.src || "";
      return out;
    },
    peakKeyOf(id) { const c = clipById(id); return c ? peakKey(c) : null; },
    // 调试：手动开一次进度条（不用真跑生成）
    genWatch(uids) { return startGenWatch(uids); },
    get spaceView() { return KF.view; },
    get kfSel() { return KF.sel; },
    // ---- 本轮新增功能的调试钩子（测试用） ----
    get rate() { return S.rate; },
    get kfHidden() { return KF.hidden; },
    get plane() { return spPlane(); },      // 当前摆位平面 xz/yz/xy
    get rec() {
      return KF.rec ? { cid: KF.rec.cid, n: KF.rec.pts.length, pos: { ...KF.rec.pos } } : null;
    },
    recStart(id, prop) { const c = clipById(id); if (c) recStart(c, prop); return !!KF.rec; },
    recStop() { recStop(false); },
    toggleKfPanel,
    marks() { return S.data ? (S.data.markers || []).filter((m) => m.custom) : []; },
    posNow(id) {
      const c = clipById(id);
      return c ? posNow(c) : null;
    },
    openAreaMenu,
    openShortcuts,
    get audioGraph() {
      let convs = 0, wet = 0;
      for (const n of AG.nodes.values()) {
        if (n && n.conv) convs += 1;
        if (n && n.wetGain) wet += 1;
      }
      return { ctx: AG.ctx ? AG.ctx.state : null, nodes: AG.nodes.size,
               convs, wet, rooms: ROOM_IR.size };
    },
    // 时间 + 轨序号 → 画布坐标（选空白处、画框选用）
    pointAt(t, i) {
      return { x: xOf(t), y: trackTop(Math.max(0, i || 0)) + TRACK_H / 2 };
    },
  };

  /* 启动顺序：先拿全局设置（吸附 / 悬浮窗 / 导出默认），再拉工程。
     设置接口挂了也不影响打开页面（GSET 为 null 时全用内置默认）。 */
  (async () => {
    await loadGlobalSettings();
    /* 能力清单：决定哪些按钮该显示（导出格式 / Demucs / 空间音频）。
       读不到就当全支持，不影响打开页面。 */
    if (window.GenParams) await GenParams.manifest();
    applyGlobalDefaults();
    if (!SID) { toast("没有指定台本", true); return; }
    try {
      await reload();
      applyGlobalDefaults();
    } catch (e) {
      toast("加载失败：" + e.message, true);
    }
  })();
})();
