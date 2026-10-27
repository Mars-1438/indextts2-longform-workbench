/* 全能音声工作台 前端：编辑 / 工作台 / 句中句间标签 / 批量任务 / 渲染 / 导出 / 音色与预设 */
(() => {
"use strict";

const API = "/api/v1/lf";
const $ = (id) => document.getElementById(id);
const EMO_NAMES = ["喜悦", "愤怒", "悲伤", "恐惧", "厌恶", "低落", "惊喜", "平静"];
const EMO_MODE_NAMES = ["同音色", "情感音频", "情感向量", "情感文本"];
const SOFT_PUNCT = "，,、：:－—-~～";
const SENT_END = "。！？!?…；;";
const MAX_HISTORY = 60;

let META = null, SCRIPT = null, STATS = null, RENDER = null;
let SEL = new Set();
let dirty = false, saveTimer = null, pollTimer = null;
let view = "edit";
let FILTER = { status: "", ref: "", emo: "", q: "", tagOnly: false, changed: false };
let UNDO = [], REDO = [], snapTimer = null;
let histChain = Promise.resolve();
let lastDiskAt = 0;
let lastClickUid = null, lastFocusUid = null;
let playingUid = null, playingRefId = null;
let lastDownAt = 0, lastDownUid = "";
let PRESETS = [];
let MODEL = { loaded: false, phase: "unloaded" };
let REFV = { view: localStorage.getItem("lf.refView") || "list", q: "" };
let PROG_STYLE = localStorage.getItem("lf.progStyle") || "bar";
/* 所有能出声的元素都登记到这里：一个按钮就能全部停掉，
   切换试听时也不会出现「前一个还在响」的叠音。 */
const PLAYERS = new Map();
function regPlayer(el, onStop) { PLAYERS.set(el, onStop || null); return el; }
function stopAllAudio() {
  PLAYERS.forEach((cb, el) => {
    try { el.pause(); el.currentTime = 0; } catch (e) { /* 忽略 */ }
    if (typeof cb === "function") cb();
  });
  updatePlayBtns();
  if ($("matList")) renderMatList();
  if ($("sfxList")) renderSfxList();
}
function pauseOthers(keep) {
  PLAYERS.forEach((cb, el) => {
    if (el === keep) return;
    try { el.pause(); } catch (e) { /* 忽略 */ }
    if (typeof cb === "function") cb();
  });
}

const audio = regPlayer(new Audio(), () => { playingUid = null; });
const refAudio = regPlayer(new Audio(), () => {
  playingRefId = null;
  if (typeof syncRefPlayBtns === "function") syncRefPlayBtns();
});

/* ------------------------------ 基础工具 ------------------------------ */
function toast(msg, isErr) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, isErr ? 4200 : 2400);
}

async function api(path, opts = {}) {
  let body = opts.body;
  let headers = undefined;
  if (body != null && !(body instanceof FormData)) {
    // 对象需要序列化成 JSON 字符串；已经是字符串（如 JSON.stringify 结果）则原样发送
    if (typeof body !== "string") body = JSON.stringify(body);
    headers = { "Content-Type": "application/json" };
  }
  const r = await fetch(API + path, {
    method: opts.method || "GET",
    headers,
    body,
  });
  let data = null;
  try { data = await r.json(); } catch (e) { /* 空响应 */ }
  if (!r.ok) {
    const msg = (data && (data.detail || data.error)) || `HTTP ${r.status}`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data;
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const deepCopy = (o) => JSON.parse(JSON.stringify(o));
const uid = () => ("u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7))
  .replace(/[^0-9a-zA-Z_-]/g, "");
const fmtDur = (s) => {
  if (s == null || isNaN(s)) return "—";
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(ss).padStart(2, "0");
};
const fmtBytes = (b) => b > 1 << 20 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB";
const download = (url, name) => {
  const a = document.createElement("a");
  a.href = url;
  if (name) a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
};
const idxOf = (line) => (SCRIPT.lines.indexOf(line) + 1);
const speechLines = () => ((SCRIPT && SCRIPT.lines) || []).filter((l) => l.kind !== "tag");

function wps() {
  let chars = 0, dur = 0;
  ((SCRIPT && SCRIPT.lines) || []).forEach((l) => {
    if (l.kind !== "tag" && l.dur && l.text) { chars += l.text.length; dur += Number(l.dur); }
  });
  if (chars > 20 && dur > 1) return Math.max(1.5, Math.min(8, chars / dur));
  return 3.0;
}
const estSec = (line) => (line.kind === "tag" ? 0 : (line.text || "").length / wps());

/* 一句到底有多长：生成过就用**实际时长**，没生成才用字数估。
   stale（改过文本但还没重生成）也算有实际时长，只是标一下「待重生成」。 */
function hasRealDur(line) {
  return !!(line && line.kind !== "tag" && line.out && Number(line.dur) > 0);
}
function lineDurSec(line) {
  if (!line || line.kind === "tag") return 0;
  return hasRealDur(line) ? Number(line.dur) : estSec(line);
}
function durLabel(line) {
  if (!line || line.kind === "tag") return "";
  if (!hasRealDur(line)) return `≈${estSec(line).toFixed(1)}s`;
  const d = Number(line.dur).toFixed(1);
  return line.status === "stale" ? `实际 ${d}s（待重生成）` : `实际 ${d}s`;
}
/* 这一行在整篇里的起始时间（按实际时长累加，句中标签的绝对时间要用） */
function lineStartSec(target) {
  const def = Number((SCRIPT && SCRIPT.defaults && SCRIPT.defaults.pause) ?? 0) || 0;
  let t = 0;
  for (const l of (SCRIPT && SCRIPT.lines) || []) {
    if (l.uid === (target && target.uid)) return t;
    if (l.kind === "tag") { t += (Number(l.hold) || 0) / 1000; continue; }
    t += lineDurSec(l) + (l.pause == null ? def : Number(l.pause) || 0) / 1000;
  }
  return t;
}
const byUid = (u) => (((SCRIPT && SCRIPT.lines) || []).find((l) => l.uid === u) || null);

/* ------------------------------ 元信息 ------------------------------ */
async function loadMeta() {
  META = await api("/meta");
  if (META.model) MODEL = META.model;
  fillRefSelects();
  renderRefList();
  // 模型状态统一在进度区显示（rModelRow），这里不再重复一遍
  if ($("rModel")) $("rModel").textContent = "";
  paintModelState();
}

function refOptions() { return (META && META.refs) || []; }
function refName(id) {
  if (!id) return "";
  const r = refOptions().find((x) => x.id === id);
  if (!r) return String(id).slice(0, 12);
  return r.name || r.id;
}

function fillRefSelects() {
  const refs = refOptions();
  const groups = {};
  refs.forEach((r) => (groups[r.group] = groups[r.group] || []).push(r));
  const og = (g, list, withDur) => {
    const o = document.createElement("optgroup");
    o.label = g;
    list.forEach((r) => {
      const opt = el("option", null, r.name + (withDur && r.dur ? `（${r.dur}s）` : ""));
      opt.value = r.id;
      o.appendChild(opt);
    });
    return o;
  };
  const dRef = $("dRef");
  if (dRef) {
    const keep = dRef.value;
    dRef.innerHTML = "";
    const first = el("option", null, "— 未设置 —");
    first.value = "";
    dRef.appendChild(first);
    Object.keys(groups).forEach((g) => dRef.appendChild(og(g, groups[g], true)));
    if (keep) dRef.value = keep;
  }
  const fRef = $("fRef");
  const kept = fRef.value;
  fRef.innerHTML = '<option value="">全部音色</option>';
  Object.keys(groups).forEach((g) => fRef.appendChild(og(g, groups[g], false)));
  fRef.value = kept;
}

/* ------------------------------ 台本列表 ------------------------------
   多选：Ctrl/⌘ 点逐个加选，Shift 点从锚点连选。
   单击仍然 = 打开那一份（并且清掉多选），所以原来的手感不变。
   选中的集合只在内存里，刷新页面就清空。 */
const SSEL = new Set();     // 选中的 sid
let SANC = null;            // Shift 连选的锚点
let SORDER = [];            // 当前列表的显示顺序（Shift 连选按这个算）

function ssCount() { return SSEL.size; }

function ssUpdateBar() {
  const bar = $("scriptSelBar");
  if (!bar) return;
  const n = SSEL.size;
  bar.hidden = n < 1;
  const info = $("scriptSelInfo");
  if (info) info.textContent = n ? `已选 ${n} 份` : "已选 0";
  const dup = $("btnSsDup"), del = $("btnSsDel");
  if (dup) dup.disabled = n < 1;
  if (del) del.disabled = n < 1;
  // 卡片高亮跟着走
  document.querySelectorAll("#scriptsList .scard").forEach((c) => {
    c.classList.toggle("multi", SSEL.has(c.dataset.sid));
  });
}

function ssClear() {
  SSEL.clear();
  SANC = null;
  ssUpdateBar();
}

function ssToggle(sid) {
  if (SSEL.has(sid)) SSEL.delete(sid); else SSEL.add(sid);
  SANC = sid;
  ssUpdateBar();
}

function ssRange(toId) {
  const a = SORDER.indexOf(SANC), b = SORDER.indexOf(toId);
  if (a < 0 || b < 0) { ssToggle(toId); return; }
  const [x, y] = a <= b ? [a, b] : [b, a];
  for (let i = x; i <= y; i++) SSEL.add(SORDER[i]);
  ssUpdateBar();     // 锚点保持不动，方便反复调范围
}

async function loadScripts() {
  const r = await api("/scripts");
  const box = $("scriptsList"), sel = $("scriptSel");
  box.innerHTML = ""; sel.innerHTML = "";
  SORDER = [];
  const alive = new Set(r.scripts.map((x) => x.id));
  Array.from(SSEL).forEach((id) => { if (!alive.has(id)) SSEL.delete(id); });
  if (SANC && !alive.has(SANC)) SANC = null;
  const sources = r.scripts.filter((x) => !x.is_project);
  const projects = HIDE_PROJECTS ? [] : r.scripts.filter((x) => x.is_project);
  const group = (title, list) => {
    if (!list.length) return;
    box.appendChild(el("div", "sgroup", title));
    list.forEach((s) => makeCard(s));
  };
  const makeCard = (s) => {
    const card = el("div", "scard" + (SCRIPT && SCRIPT.id === s.id ? " cur" : ""));
    card.dataset.sid = s.id;
    const top = el("div", "scard-top");
    const ttl = el("div", "t", s.title || s.id);
    if (s.is_project) ttl.appendChild(el("span", "pbadge", "工程"));
    top.appendChild(ttl);
    const more = el("button", "scard-more", "⋯");
    more.title = "重命名 / 复制 / 导出 / 删除";
    more.onclick = (e) => { e.stopPropagation(); openScriptMenu(s, e.clientX, e.clientY); };
    top.appendChild(more);
    card.appendChild(top);
    card.appendChild(el("div", "m", `${s.speech || s.lines} 句 · ${s.chars} 字 · 完成 ${s.done}` +
      (s.stale ? ` · 待重生成 ${s.stale}` : "") +
      (s.error ? ` · 失败 ${s.error}` : "") +
      (s.tags ? ` · 标签 ${s.tags}` : "")));
    card.onclick = (e) => {
      if (e.shiftKey && SANC) { e.preventDefault(); ssRange(s.id); return; }
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); ssToggle(s.id); return; }
      ssClear();                 // 普通点击 = 打开它，并清掉多选
      SANC = s.id;
      switchScript(s.id);
    };
    card.oncontextmenu = (e) => {
      e.preventDefault();
      // 右键点在「已多选」的卡片上：直接把菜单作用到这一批（菜单里会显示数量）
      if (!SSEL.has(s.id)) { SSEL.clear(); SSEL.add(s.id); SANC = s.id; ssUpdateBar(); }
      openScriptMenu(s, e.clientX, e.clientY);
    };
    box.appendChild(card);
    const o = el("option", null, (s.is_project ? "〔工程〕" : "") + (s.title || s.id));
    o.value = s.id;
    sel.appendChild(o);
  };
  group("台本（源文件）", sources);
  group("工程（时间轴副本）", projects);
  SORDER = Array.from(box.querySelectorAll(".scard")).map((c) => c.dataset.sid);
  if (SCRIPT) sel.value = SCRIPT.id;
  ssUpdateBar();
  return r.scripts;
}

/* 切换台本的序列号：快速连点两份时，先发出去的请求可能后返回，
   不认这个号就会「后点的台本被先点的覆盖」。 */
let SWITCH_SEQ = 0;

async function switchScript(sid) {
  const seq = ++SWITCH_SEQ;
  clearTimeout(saveTimer);          // 别让旧台本的防抖保存晚一步打过来
  if (dirty && SCRIPT) await saveNow();
  if (seq !== SWITCH_SEQ) return;   // 等保存的这段时间里又点了别的台本
  stopAllAudio();
  stopPolling();
  const r = await api(`/scripts/${sid}`);
  if (seq !== SWITCH_SEQ) return;   // 这个响应已经过时，直接丢掉
  SCRIPT = r.script;
  STATS = r.stats;
  RENDER = r.render || null;
  SEL.clear(); REDO = [];
  localStorage.setItem("lf.last", sid);
  fillRefSelects();
  syncDefaultPanel();
  UNDO = [{ label: "打开台本", time: Date.now(), lines: deepCopy(SCRIPT.lines), key: snapshotKey() }];
  updateUndoButtons();
  renderAll();
  paintRender();
  if (RENDER && (RENDER.state === "running" || RENDER.state === "stopping")) startPolling();
}

function renderAll() {
  renderCenter();
  renderStats();
  renderBatchList();
  renderBatchStats();
  renderRenderBatches();
  if (SCRIPT) $("scriptSel").value = SCRIPT.id;
  renderProjectState();
  loadScripts().catch(() => {});
}

function renderProjectState() {
  const isProj = !!(SCRIPT && SCRIPT.project);
  const btn = $("btnInitial");
  if (btn) btn.hidden = !isProj;
  const tl = $("btnTimeline");
  if (tl) {
    const txt = tl.querySelector(".cta-txt");
    const label = isProj ? "进入时间轴编辑" : "保存并进入时间轴";
    if (txt) txt.textContent = label; else tl.textContent = "⏱ " + label;
  }
  document.title = ((SCRIPT && SCRIPT.title) || "台本") + (isProj ? " · 工程" : "") + " · 全能音声工作台";
}

function renderStats() {
  const st = STATS || {};
  const box = $("statChips");
  if (!box) return;
  const est = st.est_dur != null ? st.est_dur : Math.round((st.chars || 0) / wps());
  box.innerHTML = "";
  const add = (k, v, cls, status, tip) => {
    const c = el("span", "chip" + (cls ? " " + cls : "") + (status ? " link" : ""));
    c.innerHTML = `${k} <b>${v}</b>`;
    if (tip) c.title = tip;
    if (status) {
      c.dataset.stat = status;
      c.onclick = () => setStatusFilter(status);
    }
    box.appendChild(c);
    return c;
  };
  add("句", st.speech || 0, "", null, "语音行数（不含句间标签）");
  add("字", st.chars || 0, "", null, "全部语音行的字数");
  // 状态分开算：已生成 / 需重生成 / 未生成 / 失败，互不重叠
  add("已生成", st.done || 0, st.done ? "ok" : "", "done",
    "音频与当前内容一致，可直接用");
  if (st.stale) {
    add("需重生成", st.stale, "warn", "stale",
      "有音频，但文本或参数改过 → 建议重跑");
  }
  const pending = st.pending != null ? st.pending : Math.max(0, (st.speech || 0) - (st.done || 0) - (st.stale || 0) - (st.error || 0));
  if (pending) add("未生成", pending, "", "pending", "还没有音频");
  if (st.error) add("失败", st.error, "err", "error", "生成报错，点开看原因");
  const inlineN = ((SCRIPT && SCRIPT.lines) || []).reduce((n, l) => n + (l.inline || []).length, 0);
  if (st.tags || inlineN) add("标签", `${st.tags || 0}/${inlineN}`, "", "tag",
    "句间标签 / 句中标签");
  if (st.audio_dur) add("音频", fmtDur(st.audio_dur), "", null, "已生成音频的总时长");
  const allDone = (st.speech || 0) > 0 && !st.pending && !st.error
    && (st.done || 0) + (st.stale || 0) >= (st.speech || 0);
  add(allDone ? "全篇时长" : "全篇预估", (allDone ? "" : "≈") + fmtDur(est), "", null,
    `已生成部分按实测时长累加${allDone ? "" : "，未生成部分按语速估"}`
    + `（含停顿与标签留白${st.rate ? `，实测语速 ${st.rate} 字/秒` : ""}）`);
  updateChipOn();
  updateChangedCount();
  updateSelInfo();
  updateVisInfo();
}

/* 顶栏统计 chip 点一下 = 按这个状态筛选，再点回到全部 */
function setStatusFilter(status) {
  const cur = $("fStatus").value;
  const next = cur === status ? "" : status;
  $("fStatus").value = next;
  FILTER.status = next;
  FILTER.tagOnly = false;
  $("fTagOnly").checked = false;
  renderCenter();
  updateVisInfo();
  updateChipOn();
}

function updateChipOn() {
  const box = $("statChips");
  if (!box) return;
  [...box.children].forEach((c) => {
    c.classList.toggle("on", !!c.dataset.stat && c.dataset.stat === FILTER.status);
  });
}

/* 「改动 N」按钮：只看和生成时不一样的句子 */
function updateChangedCount() {
  const btn = $("btnChanged");
  const n = ((SCRIPT && SCRIPT.lines) || []).filter((l) => (l.changes || []).length).length;
  if (!n && FILTER.changed) {
    // 改动被撤回/重生成后自动退出「只看改动」，避免列表空着让人以为丢了句子
    FILTER.changed = false;
  }
  if (!btn) return;
  const b = btn.querySelector("b");
  if (b) b.textContent = String(n);
  btn.disabled = !n;
  btn.classList.toggle("on", !!FILTER.changed);
  btn.title = n
    ? `有 ${n} 句改过内容或属性（和生成时不一样）。点一下只看这些句子。`
    : "没有改动过的句子";
}

/* ------------------------------ 筛选 ------------------------------ */
function effOf(line) {
  const d = (SCRIPT && SCRIPT.defaults) || {};
  return Object.assign({}, d, line.ov || {});
}

function visibleEntries() {
  const f = FILTER;
  const q = (f.q || "").trim().toLowerCase();
  const out = [];
  (SCRIPT.lines || []).forEach((line, i) => {
    const isTag = line.kind === "tag";
    if (f.tagOnly && !isTag) return;
    if (f.changed && !(line.changes || []).length) return;
    if (f.status) {
      if (f.status === "tag") { if (!isTag) return; }
      else if (isTag) return;
      else if (f.status === "inline") { if (!(line.inline || []).length) return; }
      else if (f.status === "inline0") { if ((line.inline || []).length) return; }
      else if (f.status === "done" && line.status !== "done") return;
      else if (f.status === "pending" && line.status !== "pending") return;
      else if (f.status === "stale" && line.status !== "stale") return;
      else if (f.status === "error" && line.status !== "error") return;
    }
    if (f.ref && !isTag && (effOf(line).ref || "") !== f.ref) return;
    if (f.emo !== "" && !isTag && String(effOf(line).emo_mode == null ? 0 : effOf(line).emo_mode) !== String(f.emo)) return;
    if (q) {
      const hay = ((isTag ? line.tag : line.text) || "") + " " +
        (line.inline || []).map((x) => x.tag).join(" ");
      if (!hay.toLowerCase().includes(q)) return;
    }
    out.push({ line, idx: i + 1 });
  });
  return out;
}

function updateVisInfo() {
  if (!SCRIPT) { $("visInfo").textContent = ""; return; }
  const total = (SCRIPT.lines || []).length;
  const n = visibleEntries().length;
  $("visInfo").textContent = n === total ? `共 ${total} 行` : `显示 ${n} / ${total} 行`;
}

function initFilters() {
  $("fStatus").onchange = () => {
    FILTER.status = $("fStatus").value; FILTER.tagOnly = false; $("fTagOnly").checked = false;
    if ($("btnFindInline")) $("btnFindInline").classList.toggle("on", FILTER.status === "inline");
    renderCenter(); updateVisInfo(); updateChipOn();
  };
  $("fRef").onchange = () => { FILTER.ref = $("fRef").value; renderCenter(); updateVisInfo(); };
  $("fEmo").onchange = () => { FILTER.emo = $("fEmo").value; renderCenter(); updateVisInfo(); };
  $("fTagOnly").onchange = () => { FILTER.tagOnly = $("fTagOnly").checked; renderCenter(); updateVisInfo(); };
  let qt = null;
  $("fQ").oninput = () => {
    clearTimeout(qt);
    qt = setTimeout(() => { FILTER.q = $("fQ").value; renderCenter(); updateVisInfo(); }, 200);
  };
  const btnIn = $("btnFindInline");
  if (btnIn) btnIn.onclick = () => {
    FILTER.status = FILTER.status === "inline" ? "" : "inline";
    $("fStatus").value = FILTER.status;
    btnIn.classList.toggle("on", FILTER.status === "inline");
    renderCenter();
    updateVisInfo();
    updateChipOn();
    toast(FILTER.status === "inline" ? "只显示有句中标签的句子" : "已显示全部句子");
  };
  const btnCh = $("btnChanged");
  if (btnCh) btnCh.onclick = () => {
    FILTER.changed = !FILTER.changed;
    btnCh.classList.toggle("on", FILTER.changed);
    renderCenter();
    updateVisInfo();
    toast(FILTER.changed ? "只看改动过的句子（再点一次取消）" : "已显示全部句子");
  };
  $("btnClearFilter").onclick = () => {
    FILTER = { status: "", ref: "", emo: "", q: "", tagOnly: false, changed: false };
    $("fStatus").value = ""; $("fRef").value = ""; $("fEmo").value = "";
    $("fQ").value = ""; $("fTagOnly").checked = false;
    if (btnCh) btnCh.classList.remove("on");
    if (btnIn) btnIn.classList.remove("on");
    renderCenter(); updateVisInfo(); updateChipOn();
  };
}

/* ------------------------------ 状态 ------------------------------ */
function statusInfo(line) {
  if (line.kind === "tag") return { cls: "tag", txt: "句间" };
  const s = line.status || "pending";
  if (s === "done") return { cls: "done", txt: "完成" };
  if (s === "running") return { cls: "running", txt: "生成中" };
  if (s === "queued") return { cls: "queued", txt: "排队" };
  if (s === "stale") return { cls: "stale", txt: "需重生成" };
  if (s === "error") return { cls: "error", txt: "失败" };
  if (s === "skipped") return { cls: "skipped", txt: "空行" };
  return { cls: "", txt: "未生成" };
}

function changeText(line) {
  return (line.changes || []).map((c) => {
    if (c.field === "text") {
      if (c.kind === "插入") return `文本【插入】“${c.insert}”`;
      if (c.kind === "删除") return `文本【删除】“${c.delete}”`;
      if (c.kind === "替换") return `文本【替换】“${c.old}” → “${c.new}”`;
      return `文本：${c.from} → ${c.to}`;
    }
    if (c.field === "emo_vec") return "情感向量已改";
    if (c.field === "sampling") return "采样参数已改";
    return `${c.label}：${c.from} → ${c.to}`;
  }).join("\n");
}

function changeChip(line) {
  const n = (line.changes || []).length;
  const names = (line.changes || []).map((c) => c.label).join("、");
  const chip = el("span", "chgchip", "改 " + n);
  chip.title = "和生成时相比，改了：" + names + "\n\n" + changeText(line);
  return chip;
}

async function revertLine(line) {
  const detail = changeText(line);
  if (!confirm(`撤回这一行的修改？\n\n${detail}\n\n恢复后这一行会变回「完成」，音频继续可用。`)) return;
  try {
    const r = await api(`/scripts/${SCRIPT.id}/lines/${line.uid}/revert`, { method: "POST" });
    SCRIPT = r.script;
    STATS = r.stats;
    renderCenter(); renderStats(); renderBatchStats();
    toast("已撤回修改，这一行恢复为「完成」");
  } catch (e) {
    toast("撤回失败：" + e.message, true);
  }
}

function badgeFor(line) {
  const st = statusInfo(line);
  const b = el("span", "stbadge " + st.cls, st.txt);
  b.dataset.badge = line.uid;
  if (line.err) b.title = line.err;
  return b;
}

function effPause(line) {
  if (line.pause != null) return line.pause;
  const d = (SCRIPT && SCRIPT.defaults) || {};
  return d.pause == null ? 200 : d.pause;
}

/* ------------------------------ 视图切换（同一句保持在顶部） ------------------------------ */
function viewBox() { return view === "edit" ? $("rows") : $("board"); }
function viewItemSel() { return view === "edit" ? ".row" : ".bcard"; }

function firstVisibleUid() {
  const box = viewBox();
  if (!box) return null;
  const top = box.getBoundingClientRect().top;
  for (const n of box.querySelectorAll(viewItemSel())) {
    if (n.getBoundingClientRect().bottom > top + 4) return n.dataset.uid;
  }
  return null;
}

function scrollToUid(uid_) {
  const box = viewBox();
  if (!box) return;
  const n = box.querySelector(`[data-uid="${uid_}"]`);
  if (!n) return;
  const delta = n.getBoundingClientRect().top - box.getBoundingClientRect().top;
  box.scrollTop += delta;
}

function setView(v) {
  if (v === view) return;
  const anchor = firstVisibleUid();
  view = v;
  document.querySelectorAll("#viewSeg button").forEach((b) => b.classList.toggle("cur", b.dataset.view === v));
  $("rows").hidden = v !== "edit";
  $("board").hidden = v !== "board";
  document.querySelector(".edithint").hidden = v !== "edit";
  renderCenter();
  if (anchor) scrollToUid(anchor);
  localStorage.setItem("lf.view", v);
}

function renderCenter() {
  if (!SCRIPT) return;
  if (view === "edit") renderEditRows(); else renderBoard();
  updateVisInfo();
}

/* ------------------------------ 编辑视图 ------------------------------ */
function renderEditRows() {
  const box = $("rows");
  const top = box.scrollTop;
  box.innerHTML = "";
  const entries = visibleEntries();
  if (!entries.length) box.appendChild(el("div", "empty", "没有符合筛选条件的行"));
  entries.forEach(({ line, idx }, k) => {
    if (k > 0) box.appendChild(gapEl(entries[k - 1].line));
    box.appendChild(editRow(line, idx));
  });
  if (entries.length && !FILTER.status && !FILTER.q && !FILTER.tagOnly) {
    box.appendChild(gapEl(entries[entries.length - 1].line));
  }
  box.querySelectorAll(".txt").forEach(autoGrow);
  box.scrollTop = top;
}

function gapEl(afterLine) {
  const g = el("div", "gap");
  // 触发区只占中间一半宽度：鼠标扫过行首/行尾不会误触发
  const zone = el("div", "gapzone");
  const b = el("button", "gapbtn", "＋ 句间标签");
  b.type = "button";
  b.onclick = () => openTagPicker(afterLine ? afterLine.uid : null);
  zone.appendChild(b);
  g.appendChild(zone);
  zone.addEventListener("mouseenter", () => g.classList.add("hov"));
  zone.addEventListener("mouseleave", () => g.classList.remove("hov"));
  // 按钮跟着鼠标在这半段里横向走
  zone.addEventListener("mousemove", (e) => {
    const r = zone.getBoundingClientRect();
    const half = (b.offsetWidth || 76) / 2 + 2;
    const x = Math.max(half, Math.min(r.width - half, e.clientX - r.left));
    b.style.left = x.toFixed(1) + "px";
  });
  return g;
}

function editRow(line, idx) {
  const isTag = line.kind === "tag";
  const st = statusInfo(line);
  const row = el("div", "row" + (SEL.has(line.uid) ? " sel" : "") + (isTag ? " tagrow" : "") +
    (st.cls ? " " + st.cls : "") + (RENDER && RENDER.cur_uid === line.uid ? " running" : ""));
  row.dataset.uid = line.uid;
  row.oncontextmenu = (e) => { e.preventDefault(); openLineCtx(line, e.clientX, e.clientY); };

  const cbw = el("div", "cbwrap");
  const cb = document.createElement("input");
  cb.type = "checkbox"; cb.checked = SEL.has(line.uid);
  cb.onchange = () => { if (cb.checked) SEL.add(line.uid); else SEL.delete(line.uid); lastClickUid = line.uid; refreshSelClasses(); };
  cbw.appendChild(cb);

  const idxEl = el("div", "idx", String(idx));
  idxEl.title = "点击选中/取消；Shift+点击 选一段";
  idxEl.onclick = (e) => handleRangeClick(line.uid, e);
  row.appendChild(cbw); row.appendChild(idxEl);

  if (isTag) {
    const body = el("div", "tagbody");
    const name = el("span", "tagname", "〔" + (line.tag || "标签") + "〕");
    name.title = "点击修改标签 / 留白";
    name.onclick = () => openTagEdit(line);
    body.appendChild(name);
    body.appendChild(el("span", "hint", line.hold ? `留白 ${line.hold}ms` : "无留白"));
    body.appendChild(sfxChipEl(line));
    body.appendChild(badgeFor(line));
    row.appendChild(body);
    row.appendChild(el("div", "rmeta"));
    const side = el("div", "rside");
    const del = el("button", "iconbtn", "✕");
    del.title = "删除这个句间标签";
    del.onclick = () => deleteLine(line);
    side.appendChild(del);
    row.appendChild(side);
    return row;
  }

  const addInline = el("button", "addchip", "＋");
  addInline.type = "button";
  addInline.title = "插入句中标签";
  addInline.onclick = () => openInlinePicker(line, null, 0);
  row.appendChild(addInline);

  const body = el("div");
  body.appendChild(makeTextarea(line));
  body.appendChild(inlineBar(line));
  row.appendChild(body);

  const meta = el("div", "rmeta");
  // 智能导入带过来的分组 / 附属备注 / 慢语速 / 出现时间，行上直接看得到，点一下能改
  if (line.group) {
    const g = el("span", "grpchip", "▤ " + line.group);
    g.title = "分组：" + line.group + "（= 批量任务名）· 点击修改";
    g.onclick = (e) => { e.stopPropagation(); openLineProps(line); };
    meta.appendChild(g);
  }
  if (line.note) {
    const n = el("span", "notechip", "✎ " + line.note);
    n.title = "附属备注（不朗读，会写进映射 CSV）· 点击修改\n" + line.note;
    n.onclick = (e) => { e.stopPropagation(); openLineProps(line); };
    meta.appendChild(n);
  } else {
    // 没有备注时给一个很淡的「＋备注」，不用翻右键菜单
    const add = el("span", "notechip add", "＋备注");
    add.title = "给这一句加附属备注（不朗读）";
    add.onclick = (e) => { e.stopPropagation(); openLineProps(line); };
    meta.appendChild(add);
  }
  if (line.slow) {
    const sp = el("span", "grpchip slow", "慢");
    sp.title = "慢语速偏好";
    meta.appendChild(sp);
  }
  if (line.t0 != null) {
    const tc = el("span", "timechip", "⏱ " + fmtDur(line.t0));
    tc.title = `出现时间 ${fmtDur(line.t0)}`
      + (line.t1 != null ? ` → ${fmtDur(line.t1)}` : "")
      + "（来自字幕时间码，只做对轴，不朗读）";
    meta.appendChild(tc);
  }
  meta.appendChild(el("span", "rmeta-txt",
    `${(line.text || "").length} 字 · ${durLabel(line)}`));
  if (hasRealDur(line)) meta.lastChild.title = "这一句已经有音频，显示的是实测时长";
  if (line.changes && line.changes.length) meta.appendChild(changeChip(line));
  row.appendChild(meta);

  const side = el("div", "rside");
  side.appendChild(badgeFor(line));
  const rv = el("button", "iconbtn revert", "↩");
  rv.title = "撤回修改：把这行恢复成生成时的文本与参数，标签会变回「完成」\n"
    + changeText(line);
  rv.hidden = !line.can_revert;
  rv.onclick = () => revertLine(line);
  side.appendChild(rv);
  const isDone = line.status === "done" || line.status === "stale";
  const play = el("button", "iconbtn play", "▶");
  play.title = "试听（Alt+空格）";
  play.onclick = () => playLine(line.uid);
  const regen = el("button", "iconbtn", "⟳");
  regen.title = isDone ? "重新生成这一行" : "生成这一行";
  regen.onclick = () => startRender("uids", [line.uid]);
  const dl = el("button", "iconbtn", "⤓");
  dl.title = "导出这一句";
  dl.onclick = () => exportLine(line);
  const more = el("button", "iconbtn", "⋯");
  more.title = "属性 / 复制 / 全选前后 / 删除";
  more.onclick = (e) => { e.stopPropagation(); openLineCtx(line, e.clientX, e.clientY); };
  [play, regen, dl, more].forEach((b) => side.appendChild(b));
  side.appendChild(pauseInput(line));
  // 完全空白（没文字、没音频、没句中标签）的行，直接给一个删除键，不用进 ⋯ 菜单
  const bdel = el("button", "iconbtn blankdel", "✕");
  bdel.title = "删除这个空行";
  bdel.hidden = !isBlankLine(line);
  bdel.onclick = () => deleteLine(line);
  side.appendChild(bdel);
  row.appendChild(side);
  return row;
}

function makeTextarea(line) {
  const ta = document.createElement("textarea");
  ta.className = "txt"; ta.rows = 1; ta.spellcheck = false;
  ta.value = line.text || "";
  ta.dataset.uid = line.uid;
  ta.addEventListener("input", () => {
    line.text = ta.value;
    if (line.status === "done" || line.status === "error") line.status = "stale";
    else if (line.status !== "stale") line.status = "pending";
    line.inline = (line.inline || []).map((it) => ({ tag: it.tag, pos: Math.min(it.pos, ta.value.length) }));
    autoGrow(ta);
    const row = ta.closest(".row, .bcard");
    const mtxt = row && row.querySelector(".rmeta-txt");
    if (mtxt) mtxt.textContent = `${ta.value.length} 字 · ${durLabel(line)}`;
    const b = document.querySelector(`.stbadge[data-badge="${line.uid}"]`);
    if (b) { const s = statusInfo(line); b.className = "stbadge " + s.cls; b.textContent = s.txt; }
    const bd = row && row.querySelector(".blankdel");
    if (bd) bd.hidden = !(!ta.value.trim() && !line.out && !(line.inline || []).length);
    dirty = true; queueSave(); scheduleSnapshot();
  });
  ta.addEventListener("keydown", (e) => onRowKey(e, line, ta));
  ta.addEventListener("focus", () => { lastFocusUid = line.uid; });
  return ta;
}

/* 句中标签条：没有标签时完全不占高度 */
function inlineBar(line) {
  const bar = el("div", "inlinebar");
  const list = (line.inline || []).slice().sort((a, b) => a.pos - b.pos);
  bar.dataset.inlineFor = line.uid;
  if (!list.length) { bar.hidden = true; return bar; }
  list.forEach((it) => {
    const chip = el("span", "ichip");
    const sf = it.sfx && sfxById(it.sfx.mid);
    const name = el("b", "icname",
      `〔${it.tag}〕@${it.pos}${sf ? " 🔔" : ""}${Number(it.hold) ? ` +${Math.round(it.hold)}ms` : ""}`);
    name.title = "点击编辑这个句中标签（名字 / 位置 / 延迟 / 音效）"
      + (sf ? `\n已挂音效：${sf.name}` : "");
    name.onclick = (e) => { e.stopPropagation(); openInlineEdit(line, it); };
    const x = el("i", "icx", "✕");
    x.title = "删除";
    x.onclick = (e) => {
      e.stopPropagation();
      line.inline = (line.inline || []).filter((o) => o !== it);
      commitSnapshot("删除句中标签");
      dirty = true; renderCenter(); queueSave();
    };
    chip.appendChild(name); chip.appendChild(x);
    bar.appendChild(chip);
  });
  return bar;
}

function pauseInput(line) {
  const pw = el("div", "pausewrap");
  const pi = document.createElement("input");
  pi.type = "number"; pi.min = "0"; pi.max = "30000"; pi.step = "10";
  pi.value = line.pause == null ? "" : line.pause;
  pi.placeholder = String(effPause(line));
  pi.title = "这一行之后的停顿（毫秒），留空继承默认";
  pi.onchange = () => {
    const v = pi.value.trim();
    line.pause = v === "" ? null : Math.max(0, Math.min(30000, parseInt(v, 10) || 0));
    pi.value = line.pause == null ? "" : line.pause;
    pi.placeholder = String(effPause(line));
    dirty = true; queueSave(); scheduleSnapshot();
  };
  pw.appendChild(pi); pw.appendChild(el("span", null, "ms"));
  return pw;
}

function autoGrow(ta) {
  ta.style.height = "auto";
  ta.style.height = Math.max(24, ta.scrollHeight) + "px";
}

/* ------------------------------ 工作台 ------------------------------ */
function renderBoard() {
  const box = $("board");
  const top = box.scrollTop;
  box.innerHTML = "";
  const entries = visibleEntries();
  if (!entries.length) box.appendChild(el("div", "empty", "没有符合筛选条件的行"));
  entries.forEach(({ line, idx }, k) => {
    if (k > 0) box.appendChild(gapEl(entries[k - 1].line));
    box.appendChild(boardCard(line, idx));
  });
  if (entries.length && !FILTER.status && !FILTER.q && !FILTER.tagOnly) {
    box.appendChild(gapEl(entries[entries.length - 1].line));
  }
  box.querySelectorAll(".txt").forEach(autoGrow);
  box.scrollTop = top;
}

function boardCard(line, idx) {
  const isTag = line.kind === "tag";
  const card = el("div", "bcard" + (isTag ? " tag" : "") + (SEL.has(line.uid) ? " sel" : "") +
    (RENDER && RENDER.cur_uid === line.uid ? " running" : ""));
  card.dataset.uid = line.uid;
  card.oncontextmenu = (e) => { e.preventDefault(); openLineCtx(line, e.clientX, e.clientY); };

  const head = el("div", "bhead");
  const cb = document.createElement("input");
  cb.type = "checkbox"; cb.checked = SEL.has(line.uid);
  cb.onchange = () => { if (cb.checked) SEL.add(line.uid); else SEL.delete(line.uid); card.classList.toggle("sel", cb.checked); refreshSelClasses(); };
  head.appendChild(cb);
  const idxEl = el("span", "bidx", "#" + idx);
  idxEl.onclick = (e) => handleRangeClick(line.uid, e);
  head.appendChild(idxEl);
  head.appendChild(badgeFor(line));

  if (isTag) {
    head.appendChild(el("span", "tagname", "〔" + (line.tag || "标签") + "〕"));
    if (line.hold) head.appendChild(el("span", "hint", `留白 ${line.hold}ms`));
    head.appendChild(sfxChipEl(line));
    head.appendChild(el("div", "spacer"));
    const e1 = el("button", "btn mini", "修改");
    e1.onclick = () => openTagEdit(line);
    const e2 = el("button", "btn mini ghost", "删除");
    e2.onclick = () => deleteLine(line);
    head.appendChild(e1); head.appendChild(e2);
    card.appendChild(head);
    return card;
  }

  const p = effOf(line);
  if (line.group) {
    const g = el("span", "grpchip", "▤ " + line.group);
    g.title = "分组：" + line.group;
    head.appendChild(g);
  }
  if (line.note) {
    const n = el("span", "notechip", "✎ " + line.note);
    n.title = line.note;
    head.appendChild(n);
  }
  if (line.slow) head.appendChild(el("span", "grpchip slow", "慢"));
  const info = el("span", "hint bmeta");
  const bits = [];
  if (p.ref) bits.push("音色 " + refName(p.ref));
  bits.push("情感 " + (EMO_MODE_NAMES[Number(p.emo_mode || 0)] || "-") + " " + (p.emo_weight ?? ""));
  bits.push("停顿 " + effPause(line) + "ms");
  if (line.dur) bits.push(`音频 ${Number(line.dur).toFixed(1)}s`);
  if (line.elapsed) bits.push(`耗时 ${line.elapsed}s`);
  info.textContent = bits.join(" · ");
  head.appendChild(info);
  if ((line.changes || []).length) head.appendChild(changeChip(line));
  head.appendChild(el("div", "spacer"));

  const play = el("button", "btn mini", "▶ 试听");
  play.onclick = () => playLine(line.uid);
  const isDone = line.status === "done" || line.status === "stale";
  const regen = el("button", "btn mini", isDone ? "⟳ 重生成" : "▶ 生成");
  regen.disabled = line.status === "running" || line.status === "queued";
  regen.onclick = () => startRender("uids", [line.uid]);
  const props = el("button", "btn mini", "属性");
  props.onclick = () => openLineProps(line);
  const rv = el("button", "btn mini ghost revert", "↩ 撤回");
  rv.title = "撤回修改：恢复成生成时的文本与参数\n" + changeText(line);
  rv.hidden = !line.can_revert;
  rv.onclick = () => revertLine(line);
  const dl = el("button", "btn mini", "导出本句");
  dl.onclick = () => exportLine(line);
  const del = el("button", "btn mini ghost", "删除");
  del.onclick = () => deleteLine(line);
  [play, regen, props, rv, dl, del].forEach((b) => head.appendChild(b));
  card.appendChild(head);

  const body = el("div", "bbody");
  const top2 = el("div", "bbody-top");
  const addInline = el("button", "addchip", "＋");
  addInline.title = "插入句中标签";
  addInline.onclick = () => openInlinePicker(line, null, 0);
  top2.appendChild(addInline);
  top2.appendChild(makeTextarea(line));
  body.appendChild(top2);
  body.appendChild(inlineBar(line));
  card.appendChild(body);
  return card;
}

/* ------------------------------ 选中 ------------------------------ */
let selBtn = null, selBtnSet = new Set();

/* 批量统计里的「选中已覆盖 / 未覆盖 / 重叠」：点一次选中，再点一次取消 */
function applySel(btn, uids, emptyMsg) {
  const want = new Set(uids);
  if (!want.size) { toast(emptyMsg || "没有符合条件的行"); return; }
  const same = want.size === SEL.size && [...want].every((u) => SEL.has(u));
  SEL.clear();
  if (selBtn) selBtn.classList.remove("on");
  selBtn = null; selBtnSet = new Set();
  if (same) {
    refreshSelClasses();
    toast("已取消选择");
    return;
  }
  want.forEach((u) => SEL.add(u));
  if (want.size && btn) {
    selBtn = btn; selBtnSet = new Set(want);
    btn.classList.add("on");
  }
  refreshSelClasses();
  toast(`已选中 ${SEL.size} 行`);
}

/* 手工改动选中后，按钮的高亮要跟着失效 */
function syncSelBtn() {
  if (!selBtn) return;
  const same = selBtnSet.size === SEL.size && [...selBtnSet].every((u) => SEL.has(u));
  if (!same) { selBtn.classList.remove("on"); selBtn = null; selBtnSet = new Set(); }
}

function refreshSelClasses() {
  document.querySelectorAll("#rows .row, #board .bcard").forEach((n) => {
    const on = SEL.has(n.dataset.uid);
    n.classList.toggle("sel", on);
    const cb = n.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = on;
  });
  syncSelBtn();
  updateSelInfo();
}

function updateSelInfo() {
  const n = SEL.size;
  $("selInfo").textContent = n ? `已选 ${n} 行` : "未选中";
  const total = ((SCRIPT && SCRIPT.lines) || []).length;
  $("selAll").checked = n > 0 && n === total;
}

function handleRangeClick(uid_, e) {
  if (e.shiftKey && lastClickUid) {
    const lines = SCRIPT.lines;
    const a = lines.findIndex((l) => l.uid === lastClickUid);
    const b = lines.findIndex((l) => l.uid === uid_);
    if (a >= 0 && b >= 0) {
      const [x, y] = a < b ? [a, b] : [b, a];
      for (let i = x; i <= y; i++) SEL.add(lines[i].uid);
      lastClickUid = uid_;
      refreshSelClasses();
      return;
    }
  }
  if (SEL.has(uid_)) SEL.delete(uid_); else SEL.add(uid_);
  lastClickUid = uid_;
  refreshSelClasses();
}

function parseRange(spec) {
  const lines = SCRIPT.lines || [];
  const out = new Set();
  spec.split(/[,，\s]+/).filter(Boolean).forEach((tok) => {
    const m = tok.match(/^(\d+)?-(\d+)?$/) || tok.match(/^(\d+)$/);
    if (!m) return;
    let a, b;
    if (m.length === 3) {
      a = m[1] ? parseInt(m[1], 10) : 1;
      b = m[2] ? parseInt(m[2], 10) : lines.length;
    } else {
      a = b = parseInt(m[1], 10);
    }
    for (let i = Math.max(1, a); i <= Math.min(lines.length, b); i++) out.add(lines[i - 1].uid);
  });
  return out;
}

/* ------------------------------ 编辑操作 ------------------------------ */
function onRowKey(e, line, ta) {
  if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    const a = ta.selectionStart, b = ta.selectionEnd;
    if (b > a) deleteSelectedText(line, a, b);
    const text = line.text || "";
    // 句中 → 切成两句；句末（或空行）→ 下方新建一行空句
    if (a >= text.length) insertLineAfter(line);
    else splitLine(line, a);
  } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    startRender("uids", [line.uid]);
  } else if (e.key === "Backspace" && ta.selectionStart === 0 && ta.selectionEnd === 0) {
    e.preventDefault();
    mergePrev(line);
  } else if (e.key === "Delete" && ta.selectionStart === (line.text || "").length &&
    ta.selectionEnd === ta.selectionStart) {
    e.preventDefault();
    mergeNext(line);
  } else if (e.key === "ArrowUp" && ta.selectionStart === 0) {
    e.preventDefault();
    focusSibling(line, -1, ta.selectionStart);
  } else if (e.key === "ArrowDown" && ta.selectionStart === (line.text || "").length) {
    e.preventDefault();
    const now = Date.now();
    if (lastDownUid === line.uid && now - lastDownAt < 550) {
      lastDownAt = 0; lastDownUid = "";
      addTailLine();
      return;
    }
    lastDownAt = now; lastDownUid = line.uid;
    focusSibling(line, 1, ta.selectionStart);
  } else if (e.key === " " && e.altKey) {
    e.preventDefault();
    playLine(line.uid);
  } else if (e.key === "Escape") {
    ta.blur();
  }
}

/* 回车切分 / 合并时会先删掉选中的字，标签位置也要跟着挪 */
function deleteSelectedText(line, a, b) {
  const text = line.text || "";
  if (b <= a) return;
  line.text = text.slice(0, a) + text.slice(b);
  line.inline = (line.inline || []).map((it) => {
    if (it.pos <= a) return it;
    if (it.pos >= b) return { tag: it.tag, pos: it.pos - (b - a) };
    return { tag: it.tag, pos: a };
  });
  if (line.status === "done" || line.status === "error") line.status = "stale";
}

function splitLine(line, caret) {
  const at = idxOf(line);
  const text = line.text || "";
  const left = text.slice(0, caret).replace(/\s+$/, "");
  const right = text.slice(caret).replace(/^\s+/, "");
  if (!right) { insertLineAfter(line); return; }
  line.text = left;
  const keep = [], move = [];
  (line.inline || []).forEach((it) => {
    if (it.pos <= left.length) keep.push(it);
    else move.push({ tag: it.tag, pos: it.pos - left.length });
  });
  line.inline = keep;
  if (line.status === "done" || line.status === "error") line.status = "stale";
  const i = SCRIPT.lines.indexOf(line);
  const nl = {
    uid: uid(), kind: "speech", text: right, pause: null, tag: null, hold: null,
    ov: deepCopy(line.ov || {}), inline: move, status: "pending",
    out: null, dur: null, elapsed: null, err: null, capped: false, sig: null,
  };
  SCRIPT.lines.splice(i + 1, 0, nl);
  commitSnapshot("切分第 " + at + " 行");
  dirty = true; renderCenter(); queueSave();
  focusLine(nl.uid, 0);
}

/* 在当前句下面插入一行空句（回车到底 / 右键「在下方插入」都用它） */
function insertLineAfter(line) {
  const nl = {
    uid: uid(), kind: "speech", text: "", pause: null, tag: null, hold: null,
    ov: deepCopy((line && line.ov) || {}), inline: [], status: "pending",
    out: null, dur: null, elapsed: null, err: null, capped: false, sig: null,
  };
  const i = line ? SCRIPT.lines.indexOf(line) : -1;
  if (i >= 0) SCRIPT.lines.splice(i + 1, 0, nl);
  else SCRIPT.lines.push(nl);
  commitSnapshot("插入空行");
  dirty = true; renderCenter(); queueSave();
  focusLine(nl.uid, 0);
  return nl;
}

/* 复制一行（含行级参数、句中标签），插在它下面 */
function duplicateLine(line) {
  if (!line || line.kind === "tag") { toast("标签行没有可复制的句子", true); return; }
  const i = SCRIPT.lines.indexOf(line);
  const nl = deepCopy(line);
  nl.uid = uid();
  nl.status = line.out ? "stale" : "pending";
  nl.out = null; nl.dur = null; nl.elapsed = null; nl.err = null; nl.sig = null;
  nl.gen = null; nl.changes = []; nl.can_revert = false;
  SCRIPT.lines.splice(i + 1, 0, nl);
  commitSnapshot("复制第 " + (i + 1) + " 行");
  dirty = true; renderCenter(); queueSave();
  focusLine(nl.uid, (nl.text || "").length);
  toast("已复制这一句（音频需要重新生成）");
}

/* -------------------------- 复制 / 粘贴句子 --------------------------
   剪贴板放在内存里（不碰系统剪贴板，免得和文本复制打架），
   带的是「整行」：文本、句中标签、行级参数（音色/情感/停顿/分组/备注/慢语速），
   以及已经生成好的音频（粘贴时在服务端把 wav 复制成新行名，两行不共用文件）。 */
let LINECLIP = null;          // { lines: [...], at: ts }

function copyLines(ids) {
  const want = (ids && ids.length) ? new Set(ids) : new Set(SEL);
  if (!want.size) {
    const a = anchorUid();
    if (a) want.add(a);
  }
  const picked = ((SCRIPT && SCRIPT.lines) || []).filter((l) => want.has(l.uid));
  if (!picked.length) { toast("先选中要复制的句子", true); return; }
  LINECLIP = {
    at: Date.now(),
    lines: picked.map((l) => {
      const cp = deepCopy(l);
      delete cp.uid;
      return cp;
    }),
  };
  const withAudio = picked.filter((l) => hasRealDur(l)).length;
  toast(`已复制 ${picked.length} 句`
    + (withAudio ? `（含 ${withAudio} 段已生成的音频，粘贴时一并带过去）` : ""));
  updatePasteBtn();
}

function clipSummary() {
  if (!LINECLIP || !LINECLIP.lines.length) return "";
  const n = LINECLIP.lines.length;
  const a = LINECLIP.lines.filter((l) => l.out && Number(l.dur) > 0).length;
  return `${n} 句${a ? `（含 ${a} 段音频）` : ""}`;
}

/* 工具栏「粘贴」按钮跟着剪贴板状态走 */
function updatePasteBtn() {
  const b = $("btnPasteLines");
  if (!b) return;
  const s = clipSummary();
  b.disabled = !s;
  b.textContent = s ? `粘贴 ${LINECLIP.lines.length} 句` : "粘贴";
  b.title = s
    ? `把剪贴板里的 ${s} 粘到「光标所在句」后面（含已生成的音频 + 句中标签 + 行属性）`
    : "剪贴板是空的：先选中句子点「复制选中」";
}

/* 粘贴到 afterUid 后面；不给就用「光标所在句 → 最后点过的句」 */
async function pasteLines(afterUid) {
  if (!LINECLIP || !LINECLIP.lines.length) { toast("剪贴板是空的：先选中句子点「复制选中」", true); return; }
  const anchor = afterUid || lastFocusUid || lastClickUid || null;
  const base = anchor ? byUid(anchor) : null;
  const at = base ? (SCRIPT.lines.indexOf(base) + 1) : SCRIPT.lines.length;
  const made = [];
  LINECLIP.lines.forEach((src, k) => {
    const nu = uid();
    const nl = {
      uid: nu, kind: src.kind === "tag" ? "tag" : "speech",
      text: src.text || "",
      inline: deepCopy(src.inline || []),
      tag: src.tag || null, hold: src.hold == null ? null : src.hold,
      sfx: src.sfx ? deepCopy(src.sfx) : null,
      pause: src.pause == null ? null : src.pause,
      ov: deepCopy(src.ov || {}),
      group: src.group || null, note: src.note || null, slow: !!src.slow,
      t0: src.t0 == null ? null : src.t0, t1: src.t1 == null ? null : src.t1,
      status: src.kind === "tag" ? "tag" : "pending",
      out: null, dur: null, elapsed: null, err: null, capped: false,
      sig: null, gen: src.gen ? deepCopy(src.gen) : null,
      changes: [], can_revert: false,
      _pasteFrom: src.out || null,
    };
    SCRIPT.lines.splice(at + k, 0, nl);
    made.push(nl);
  });
  commitSnapshot(`粘贴 ${made.length} 句`);
  dirty = true; renderCenter();

  // 有音频的行：把源 wav 复制成新行名，状态保持「完成」
  const withAudio = made.filter((l) => l._pasteFrom);
  if (withAudio.length) {
    const res = await Promise.all(withAudio.map((l) => api(`/scripts/${SCRIPT.id}/audio/copy`, {
      method: "POST", body: { from: l._pasteFrom, to: l.uid + ".wav" },
    }).catch(() => ({ ok: false }))));
    withAudio.forEach((l, i) => {
      const r = res[i] || {};
      if (r.ok) {
        l.out = r.out || (l.uid + ".wav");
        l.dur = r.dur != null ? r.dur : l.dur;
        l.status = "done";
        l.can_revert = false;
      }
      delete l._pasteFrom;
    });
    dirty = true; renderCenter(); renderStats();
  }
  made.forEach((l) => delete l._pasteFrom);
  SEL.clear();
  made.forEach((l) => SEL.add(l.uid));
  lastClickUid = made[made.length - 1].uid;
  refreshSelClasses();
  queueSave();
  const audioN = made.filter((l) => l.out).length;
  toast(`已粘贴 ${made.length} 句` + (audioN ? `（带过来 ${audioN} 段音频）` : "（音频需要重新生成）"));
  const first = made.find((l) => l.kind !== "tag") || made[0];
  if (first && (first.text || "").length) focusLine(first.uid, 0);
}

function mergePrev(line) {
  const i = SCRIPT.lines.indexOf(line);
  if (i <= 0) { toast("已经是第一行"); return; }
  const prev = SCRIPT.lines[i - 1];
  if (prev.kind === "tag") { toast("上一行是标签，不能合并"); return; }
  const at = (prev.text || "").length;
  prev.text = (prev.text || "") + (line.text || "");
  prev.inline = (prev.inline || []).concat((line.inline || []).map((it) => ({ tag: it.tag, pos: at + it.pos })));
  if (prev.status === "done" || prev.status === "error") prev.status = "stale";
  SCRIPT.lines.splice(i, 1);
  SEL.delete(line.uid);
  commitSnapshot("合并第 " + i + "/" + (i + 1) + " 行");
  dirty = true; renderCenter(); queueSave();
  focusLine(prev.uid, at);
}

function mergeNext(line) {
  const i = SCRIPT.lines.indexOf(line);
  if (i >= SCRIPT.lines.length - 1) { toast("已经是最后一行"); return; }
  const next = SCRIPT.lines[i + 1];
  if (next.kind === "tag") { toast("下一行是标签，不能合并"); return; }
  const at = (line.text || "").length;
  line.text = (line.text || "") + (next.text || "");
  line.inline = (line.inline || []).concat((next.inline || []).map((it) => ({ tag: it.tag, pos: at + it.pos })));
  if (line.status === "done" || line.status === "error") line.status = "stale";
  SCRIPT.lines.splice(i + 1, 1);
  SEL.delete(next.uid);
  commitSnapshot("合并第 " + (i + 1) + "/" + (i + 2) + " 行");
  dirty = true; renderCenter(); queueSave();
  focusLine(line.uid, at);
}

function focusSibling(line, dir, col) {
  const entries = visibleEntries();
  const at = entries.findIndex((x) => x.line.uid === line.uid);
  const target = entries[at + dir];
  if (!target) return;
  focusLine(target.line.uid, dir < 0 ? Math.min(col, (target.line.text || "").length) : 0);
}

function focusLine(uid_, caret) {
  const box = (view === "edit" ? $("rows") : $("board")) || document;
  const row = box.querySelector(`[data-uid="${uid_}"]`);
  if (!row) return;
  const ta = row.querySelector(".txt");
  if (!ta) return;
  ta.focus();
  const pos = caret === undefined ? (ta.value || "").length : caret;
  const p = Math.max(0, Math.min(ta.value.length, pos));
  ta.setSelectionRange(p, p);
  row.scrollIntoView({ block: "nearest" });
  lastFocusUid = uid_;
}

function isBlankLine(line) {
  if (!line || line.kind === "tag") return false;
  return !(line.text || "").trim() && !line.out && !(line.inline || []).length;
}

function deleteLine(line) {
  const at = idxOf(line);
  const i = SCRIPT.lines.indexOf(line);
  if (i < 0) return;
  SCRIPT.lines.splice(i, 1);
  SEL.delete(line.uid);
  (SCRIPT.batches || []).forEach((b) => { b.uids = (b.uids || []).filter((u) => u !== line.uid); });
  commitSnapshot("删除第 " + at + " 行");
  dirty = true; renderCenter(); queueSave(); renderBatchList(); renderBatchStats();
  toast("已删除");
}

function addTailLine() {
  const nl = {
    uid: uid(), kind: "speech", text: "", pause: null, tag: null, hold: null,
    ov: {}, inline: [], status: "pending", out: null, dur: null,
    elapsed: null, err: null, capped: false, sig: null,
  };
  SCRIPT.lines.push(nl);
  commitSnapshot("末尾加行");
  dirty = true; renderCenter(); queueSave();
  focusLine(nl.uid, 0);
}

/* ------------------------------ 标签 ------------------------------ */
function allTags() {
  const custom = (SCRIPT && SCRIPT.tag_presets) || [];
  const base = (META && META.tags) || [];
  return Array.from(new Set([...base, ...custom]));
}

function tagChips(box, onPick) {
  let picked = allTags()[0] || "音效1";
  allTags().forEach((t) => {
    const b = el("button", "vchip" + (t === picked ? " on" : ""), t);
    b.type = "button";
    b.onclick = () => {
      picked = t;
      box.querySelectorAll(".vchip").forEach((x) => x.classList.toggle("on", x.textContent === t));
      onPick(t);
    };
    box.appendChild(b);
  });
  return () => picked;
}

function rememberTag(name) {
  const presets = new Set(SCRIPT.tag_presets || []);
  if (!allTags().includes(name)) presets.add(name);
  SCRIPT.tag_presets = Array.from(presets);
}

/* ============================ 标签面板公共件 ============================
   句中 / 句间两种标签共用同一套「位置 / 延迟 / 音效」控件，保证两边手感一致。 */
const INLINE_HOLD_DEF = 500;      // 句中标签默认 500ms 延迟：别和上一句末尾的句间标签撞在同一时刻

/* 音效挂载行：选库里的音效 / 音量 / 试听 / 移除。返回 {get()} */
function mkSfxRow(host, cur, hintText) {
  const row = el("div", "tagrow3");
  const sel = document.createElement("select");
  sel.className = "sel grow";
  sel.innerHTML = '<option value="">— 不挂音效 —</option>'
    + (SFX.items || []).map((it) => `<option value="${it.id}">${it.name}（${matDur(it.dur)}）</option>`).join("");
  sel.value = (cur && cur.mid) || "";

  const gain = document.createElement("input");
  gain.type = "range"; gain.min = "0"; gain.max = "2"; gain.step = "0.05";
  gain.value = String((cur && cur.gain) || 1);
  gain.className = "grow";
  gain.title = "音效音量（相对原音量）";
  const gOut = el("span", "mono gtag", Number(gain.value).toFixed(2));
  gain.oninput = () => { gOut.textContent = Number(gain.value).toFixed(2); };

  /* 试听按钮要能「再点一下暂停」：以前只有播放，点完就没法停 */
  const play = el("button", "btn mini ghost", "▶ 试听");
  play.type = "button";
  const aud = regPlayer(new Audio());
  let playing = false;
  const setPlayIcon = () => { play.textContent = playing ? "⏸ 暂停" : "▶ 试听"; };
  aud.addEventListener("play", () => { playing = true; setPlayIcon(); });
  aud.addEventListener("pause", () => { playing = false; setPlayIcon(); });
  aud.addEventListener("ended", () => { playing = false; setPlayIcon(); });
  play.onclick = () => {
    const mid = sel.value;
    if (!mid) { toast("先选一个音效", true); return; }
    if (playing) { aud.pause(); return; }
    const src = `${API}/sfx/${encodeURIComponent(mid)}/audio?t=${Date.now()}`;
    if (aud.dataset.mid !== mid || aud.ended || !aud.src) {
      aud.src = src;
      aud.dataset.mid = mid;
    }
    aud.volume = Math.min(1, Number(gain.value) || 1);
    aud.play().catch(() => toast("读不出来", true));
  };

  const wrapSel = el("div", "tagsfxline");
  wrapSel.appendChild(sel); wrapSel.appendChild(play);
  row.appendChild(wrapSel);
  const wrapGain = el("div", "tagsfxline");
  wrapGain.appendChild(el("span", "hint", "音量"));
  wrapGain.appendChild(gain); wrapGain.appendChild(gOut);
  row.appendChild(wrapGain);
  host.appendChild(row);
  if (hintText) host.appendChild(el("div", "hint", hintText));

  return {
    get() {
      const mid = sel.value;
      if (!mid) return null;
      return { mid, gain: Math.round((Number(gain.value) || 1) * 100) / 100 };
    },
    refresh() {
      sel.innerHTML = '<option value="">— 不挂音效 —</option>'
        + (SFX.items || []).map((it) => `<option value="${it.id}">${it.name}（${matDur(it.dur)}）</option>`).join("");
      sel.value = (cur && cur.mid) || "";
    },
  };
}

/* 位置行：数字输入 + 拖动条，两者按「字数 → 预估时间」联动。返回 {get()} */
function mkPosRow(host, line, pos0) {
  const len = Math.max(1, (line.text || "").length);
  const box = el("div", "tagposbox");
  const top = el("div", "tagposline");
  const rng = document.createElement("input");
  rng.type = "range"; rng.min = "0"; rng.max = String(len); rng.step = "1";
  rng.className = "tagposrange grow";
  const num = document.createElement("input");
  num.type = "number"; num.min = "0"; num.max = String(len); num.step = "1";
  num.className = "inp tiny tagposnum";
  const out = el("div", "tagposout hint");
  let pos = Math.max(0, Math.min(len, Number(pos0) || 0));
  const draw = () => {
    const ratio = pos / len;
    const sec = estSec(line);
    out.textContent = `第 ${pos}/${len} 字 · 句中约 ${(ratio * sec).toFixed(2)}s（整句约 ${sec.toFixed(1)}s）`;
  };
  const set = (v) => {
    pos = Math.max(0, Math.min(len, Math.round(Number(v) || 0)));
    rng.value = String(pos); num.value = String(pos); draw();
  };
  rng.oninput = () => set(rng.value);
  num.onchange = () => set(num.value);
  top.appendChild(el("span", "hint", "位置"));
  top.appendChild(rng); top.appendChild(num);
  box.appendChild(top); box.appendChild(out);
  host.appendChild(box);
  set(pos);
  return { get: () => pos, set };
}

/* 延迟（毫秒）：句中标签默认 500，句间标签的「留白」也用它 */
function mkHoldRow(host, val, label, tip) {
  const row = el("div", "tagrow3");
  const inp = document.createElement("input");
  inp.className = "inp"; inp.type = "number"; inp.min = "0"; inp.max = "30000"; inp.step = "50";
  inp.value = String(val == null ? 0 : val);
  const rng = document.createElement("input");
  rng.type = "range"; rng.min = "0"; rng.max = "2000"; rng.step = "50";
  rng.className = "grow";
  rng.value = String(Math.min(2000, Number(inp.value) || 0));
  const sync = (v) => {
    inp.value = String(v);
    rng.value = String(Math.min(2000, v));
    if (api.onchange) api.onchange();
  };
  inp.onchange = () => sync(Math.max(0, Math.min(30000, parseInt(inp.value, 10) || 0)));
  rng.oninput = () => sync(parseInt(rng.value, 10) || 0);
  row.appendChild(el("span", "hint", label || "延迟"));
  row.appendChild(rng);
  row.appendChild(inp);
  row.appendChild(el("span", "hint", "ms"));
  host.appendChild(row);
  if (tip) host.appendChild(el("div", "hint", tip));
  const api = {
    onchange: null,
    get: () => Math.max(0, Math.min(30000, parseInt(inp.value, 10) || 0)),
    set: (v) => sync(Math.max(0, Math.min(30000, Number(v) || 0))),
  };
  return api;
}

/* 插入句间标签（标签行）：名字 / 留白 / 音效 */
function openTagPicker(afterUid) {
  const wrap = el("div", "tagpanel");
  const chips = el("div", "vecchips");
  wrap.appendChild(el("div", "fl", "选择标签"));
  wrap.appendChild(chips);
  const inp = document.createElement("input");
  inp.className = "inp"; inp.placeholder = "或输入自定义标签";
  wrap.appendChild(el("div", "fl", "标签名"));
  wrap.appendChild(inp);
  const hold = mkHoldRow(wrap, 0, "留白", "留白会在合并 WAV 时插入等长静音，后期正好在这个位置放音效。");
  wrap.appendChild(el("div", "fl", "挂载音效（可选）"));
  const sfx = mkSfxRow(wrap, null,
    "音效会在「标签时间 + 留白」处响起；在时间轴上可以直接看到并拖动这段素材。");
  const getPicked = tagChips(chips, (t) => { inp.value = ""; inp.placeholder = t; });

  modal("插入句间标签", wrap, async () => {
    const name = (inp.value.trim() || getPicked() || "").trim();
    if (!name) { toast("标签名不能为空", true); return false; }
    rememberTag(name);
    const tagLine = {
      uid: uid(), kind: "tag", text: "", tag: name, hold: hold.get(),
      pause: null, ov: {}, inline: [], status: "tag", out: null, dur: null,
      elapsed: null, err: null, sig: null, sfx: sfx.get(),
    };
    if (afterUid) {
      const i = SCRIPT.lines.findIndex((l) => l.uid === afterUid);
      SCRIPT.lines.splice(i + 1, 0, tagLine);
    } else {
      SCRIPT.lines.push(tagLine);
    }
    commitSnapshot("插入句间标签 " + name);
    dirty = true; renderCenter(); queueSave();
    toast(`已插入〔${name}〕`);
  }, "插入");
}

function openInlinePicker(line, ta, forcePos) {
  let pos = (line.text || "").length;
  if (forcePos != null) pos = forcePos;
  else if (ta && document.activeElement === ta) pos = ta.selectionStart;
  const wrap = el("div", "tagpanel");
  const chips = el("div", "vecchips");
  wrap.appendChild(el("div", "fl", "选择标签"));
  wrap.appendChild(chips);
  const inp = document.createElement("input");
  inp.className = "inp"; inp.placeholder = "或输入自定义标签";
  wrap.appendChild(el("div", "fl", "标签名"));
  wrap.appendChild(inp);
  wrap.appendChild(el("div", "fl", "位置（拖一下就能找位置）"));
  const posCtl = mkPosRow(wrap, line, pos);
  const hold = mkHoldRow(wrap, INLINE_HOLD_DEF, "延迟",
    `默认 ${INLINE_HOLD_DEF}ms：句中标签多半落在句子中后段，加一点延迟就不会和上一句末尾的句间标签挤在同一时刻。`);
  wrap.appendChild(el("div", "fl", "挂载音效（可选）"));
  const sfx = mkSfxRow(wrap, null,
    "句中标签本身不出声，只标位置；挂了音效就会在「句中时间 + 延迟」处响起，并在时间轴上生成对应素材（不会改变这一句的音频）。");
  const getPicked = tagChips(chips, (t) => { inp.value = ""; inp.placeholder = t; });

  modal("插入句中标签", wrap, async () => {
    const name = (inp.value.trim() || getPicked() || "").trim();
    if (!name) { toast("标签名不能为空", true); return false; }
    rememberTag(name);
    const p = posCtl.get();
    line.inline = (line.inline || []).concat([{
      pos: p, tag: name, hold: hold.get(), sfx: sfx.get(),
    }]);
    line.inline.sort((a, b) => a.pos - b.pos);
    commitSnapshot("插入句中标签 " + name);
    dirty = true; renderCenter(); queueSave();
    toast(`已在第 ${p} 字后插入〔${name}〕`);
  }, "插入");
}

function openInlineEdit(line, it) {
  const wrap = el("div", "tagpanel");
  const inp = document.createElement("input");
  inp.className = "inp"; inp.value = it.tag || "";
  inp.placeholder = "句中标签名字（例如 音效1 / 呼吸 / 关门）";
  wrap.appendChild(el("div", "fl", "标签名"));
  wrap.appendChild(inp);
  wrap.appendChild(el("div", "fl", "位置"));
  const posCtl = mkPosRow(wrap, line, it.pos);
  const hold = mkHoldRow(wrap, it.hold == null ? INLINE_HOLD_DEF : it.hold, "延迟",
    "音效实际响起的时刻 = 句中位置估时 + 这个延迟。");
  wrap.appendChild(el("div", "fl", "挂载音效"));
  const sfx = mkSfxRow(wrap, it.sfx || null, "");
  const abs = lineStartSec(line);
  wrap.appendChild(el("div", "hint",
    `这一句从 ≈${abs.toFixed(2)}s 开始；标签落点 ≈${(abs + (posCtl.get() / Math.max(1, (line.text || "").length)) * estSec(line) + hold.get() / 1000).toFixed(2)}s（按当前字数估）`));

  modal("编辑句中标签", wrap, async () => {
    it.tag = inp.value.trim() || it.tag;
    it.pos = posCtl.get();
    it.hold = hold.get();
    const s = sfx.get();
    if (s) it.sfx = s; else delete it.sfx;
    line.inline.sort((a, b) => a.pos - b.pos);
    commitSnapshot("修改句中标签");
    dirty = true; renderCenter(); queueSave();
  }, "保存");
}

/* 标签行上的「🔔 音效」小按钮：显示已挂的音效，点一下挑/换 */
function sfxChipEl(line) {
  const sf = line.sfx && sfxById(line.sfx.mid);
  const btn = el("button", "sfxchip" + (sf ? " on" : ""), sf ? `🔔 ${sf.name}` : "＋ 音效");
  btn.type = "button";
  if (sf) {
    btn.title = `音效在「标签时间 + ${line.hold || 0}ms」处响起（留白就是延迟）；点击更换`;
  } else if (line.sfx) {
    btn.title = "挂的音效已被删除，点击换一个";
    btn.classList.add("missing");
  } else {
    btn.title = "给这个标签挂一个音效（进时间轴会自动放到素材轨）";
  }
  btn.onclick = (e) => { e.stopPropagation(); openSfxPicker(line); };
  return btn;
}

function openTagEdit(line) {
  const wrap = el("div", "tagpanel");
  const inp = document.createElement("input");
  inp.className = "inp"; inp.value = line.tag || "";
  inp.placeholder = "标签名（例如 音效1 / 停顿 / 转场）";
  wrap.appendChild(el("div", "fl", "标签名"));
  wrap.appendChild(inp);

  const hold = mkHoldRow(wrap, line.hold || 0, "留白",
    "留白会在合并 WAV 时插入等长静音；标签音效就在「标签时间 + 留白」处响起。");

  wrap.appendChild(el("div", "fl", "挂载音效"));
  const sfx = mkSfxRow(wrap, line.sfx || null, "");
  const abs = lineStartSec(line);
  const now = el("div", "hint", "");
  const drawNow = () => {
    now.textContent = `这个标签在 ≈${(abs + hold.get() / 1000).toFixed(2)}s 处；`
      + (sfx.get() ? "音效会在这里响" : "还没挂音效");
  };
  wrap.appendChild(now);
  drawNow();

  const pick = el("button", "btn mini ghost", "从音效库挑…");
  pick.type = "button";
  pick.onclick = () => { closeModal(); openSfxPicker(line); };
  wrap.appendChild(el("div", "btnrow")).appendChild(pick);
  wrap.appendChild(el("div", "hint",
    "「从音效库挑…」会换成素材库里的另一段（带预览）；上面的下拉只在本库里选。"));
  hold.onchange = drawNow;

  modal("修改句间标签", wrap, async () => {
    pushPropUndo("修改句间标签", [line.uid]);
    line.tag = inp.value.trim() || line.tag;
    line.hold = hold.get();
    line.sfx = sfx.get();
    commitSnapshot("修改标签");
    dirty = true; renderCenter(); renderStats(); queueSave();
  }, "保存");
}

/* ------------------------------ 行属性 / 菜单 ------------------------------ */
function openLineProps(line) {
  if (line.kind === "tag") { openTagEdit(line); return; }
  const p = effOf(line);
  const wrap = el("div");

  const refSel = document.createElement("select");
  refSel.className = "sel";
  refSel.innerHTML = '<option value="">— 跟随默认 —</option>';
  const groups = {};
  refOptions().forEach((r) => (groups[r.group] = groups[r.group] || []).push(r));
  Object.keys(groups).forEach((g) => {
    const o = document.createElement("optgroup");
    o.label = g;
    groups[g].forEach((r) => {
      const opt = el("option", null, r.name + (r.dur ? `（${r.dur}s）` : ""));
      opt.value = r.id;
      o.appendChild(opt);
    });
    refSel.appendChild(o);
  });
  refSel.value = (line.ov && line.ov.ref) || "";
  wrap.appendChild(el("div", "fl", "音色（留空 = 跟随默认：" + refName((SCRIPT.defaults || {}).ref) + "）"));
  wrap.appendChild(refSel);

  /* 情感：模式 / 参考音频 / 向量 / 描述 / 权重 —— 与主界面同一套字段，
     用共用组件渲染（web/emoctl.js），时间轴那边也是它，保证两边不缺项。 */
  const dfltEmo = SCRIPT.defaults || {};
  const emoHost = el("div");
  wrap.appendChild(el("div", "fl", "情感"));
  wrap.appendChild(emoHost);
  const emo = EmoCtl.mount(emoHost, {
    mode: line.ov && line.ov.emo_mode != null ? line.ov.emo_mode : null,
    weight: p.emo_weight == null ? 0.65 : p.emo_weight,
    vec: (line.ov && line.ov.emo_vec) || p.emo_vec || [],
    text: (line.ov && line.ov.emo_text) || "",
    emoRef: (line.ov && line.ov.emo_ref) || "",
    refs: refOptions(),
    follow: true,
    defaultMode: Number(dfltEmo.emo_mode || 0),
    defaultRef: dfltEmo.emo_ref || "",
    defaultName: refName(dfltEmo.emo_ref || ""),
    api: API,
    toast,
    onUploaded: async (ref) => {
      await loadMeta();
      const list = refOptions();
      if (list.some((x) => x.id === ref.id)) return list;
      return list.concat([{ ...ref, group: "我的音色", editable: true, uses: ["emo"] }]);
    },
  });

  const pause = document.createElement("input");
  pause.className = "inp"; pause.type = "number"; pause.min = "0"; pause.max = "30000"; pause.step = "10";
  pause.value = line.pause == null ? "" : line.pause;
  pause.placeholder = String(effPause(line));
  wrap.appendChild(el("div", "fl", "这一行之后的停顿（留空跟随默认）"));
  wrap.appendChild(pause);

  /* 分组 / 附属备注 / 慢语速：智能导入会写进来，但以前只能看不能改。
     备注不参与朗读，只做记录（导出的映射 CSV 里会带上）。 */
  const groupInp = document.createElement("input");
  groupInp.className = "inp";
  groupInp.placeholder = "分组名（= 批量任务名，留空 = 不分组）";
  groupInp.value = line.group || "";
  const gl = el("div", "fl", "分组");
  wrap.appendChild(gl); wrap.appendChild(groupInp);
  if ((SCRIPT.batches || []).length) {
    const jump = el("div", "btnrow");
    const b = el("button", "btn mini ghost", "从已有分组里选…");
    b.type = "button";
    b.onclick = () => {
      const names = (SCRIPT.batches || []).map((x) => x.name);
      const n = prompt("填一个已有分组名：\n" + names.join(" / "), groupInp.value || names[0] || "");
      if (n !== null) groupInp.value = n.trim();
    };
    jump.appendChild(b);
    wrap.appendChild(jump);
  }

  const noteInp = document.createElement("textarea");
  noteInp.className = "inp noteedit"; noteInp.rows = 2;
  noteInp.placeholder = "附属备注：动作 / 镜头 / 时间码…（不朗读）";
  noteInp.value = line.note || "";
  wrap.appendChild(el("div", "fl", "附属备注（不朗读）"));
  wrap.appendChild(noteInp);

  const slowRow = el("label", "chkrow");
  const slowCb = document.createElement("input");
  slowCb.type = "checkbox"; slowCb.checked = !!line.slow;
  slowRow.appendChild(slowCb);
  slowRow.appendChild(el("span", null, "标记为慢语速偏好（导出/后期能读到）"));
  wrap.appendChild(slowRow);

  if (line.t0 != null) {
    wrap.appendChild(el("div", "hint",
      `出现时间：${fmtDur(line.t0)}${line.t1 != null ? " → " + fmtDur(line.t1) : ""}（来自字幕时间码，只做对轴，不朗读）`));
  }

  modal("第 " + idxOf(line) + " 行属性", wrap, async () => {
    const at = idxOf(line);
    const em0 = emo.read();
    if (em0.emo_mode === 1 && !em0.emo_ref) {
      toast("情感模式是「情感音频」，但还没选音频：先从音色库挑一段，或点「＋ 加入」", true);
      return false;
    }
    if (em0.emo_mode === 2 && !(em0.emo_vec || []).some((x) => x > 0)) {
      toast("情感模式是「情感向量」，但 8 个轴都是 0：点一个快捷填充或推一下滑杆", true);
      return false;
    }
    pushPropUndo("修改第 " + at + " 行属性", [line.uid]);
    line.ov = line.ov || {};
    if (refSel.value) line.ov.ref = refSel.value; else delete line.ov.ref;
    const em = emo.read();
    if (em.emo_mode == null) delete line.ov.emo_mode; else line.ov.emo_mode = em.emo_mode;
    line.ov.emo_weight = em.emo_weight;
    if (em.emo_vec && em.emo_vec.some((x) => x > 0)) line.ov.emo_vec = em.emo_vec;
    else delete line.ov.emo_vec;
    if (em.emo_text) line.ov.emo_text = em.emo_text; else delete line.ov.emo_text;
    if (em.emo_ref) line.ov.emo_ref = em.emo_ref; else delete line.ov.emo_ref;
    const pv = pause.value.trim();
    line.pause = pv === "" ? null : Math.max(0, Math.min(30000, parseInt(pv, 10) || 0));
    line.group = groupInp.value.trim() || null;
    line.note = noteInp.value.trim() || null;
    line.slow = slowCb.checked;
    if (line.status === "done") line.status = "stale";
    commitSnapshot("修改第 " + at + " 行属性");
    dirty = true; renderCenter(); queueSave();
  }, "保存");
}

/* ------------------------------ 批量修改属性 ------------------------------ */
/* 对「选中的句子」批量改音色 / 情感 / 停顿。每个项目左边有独立的勾选框，
   只有勾了的才写进去 —— 不勾就保留各行原来的值。 */
function openBulkProps() {
  const uids = [...SEL];
  if (!uids.length) { toast("先在列表里选中要改的句子或标签（可用「↑ 往前全选 / ↓ 往后全选」）", true); return; }
  const targets = SCRIPT.lines.filter((l) => SEL.has(l.uid) && l.kind !== "tag");
  const tagTargets = SCRIPT.lines.filter((l) => SEL.has(l.uid) && l.kind === "tag");
  if (!targets.length && !tagTargets.length) { toast("选中的内容没有可改的属性", true); return; }

  const wrap = el("div");
  wrap.appendChild(el("div", "hint",
    (targets.length ? `将作用于选中的 ${targets.length} 句语音` : "已选中 " + tagTargets.length + " 个句间标签") +
    (targets.length && tagTargets.length ? ` + ${tagTargets.length} 个句间标签` : "") +
    "；只改左边打勾的项目，其余保持原样。"));

  // 语音属性的字段放在一个容器里：只选了标签时把这一整块藏起来
  const speechWrap = el("div");
  speechWrap.hidden = !targets.length;
  wrap.appendChild(speechWrap);

  const mkRow = (label, node, into, wide) => {
    const box = el("div", "bulkrow" + (wide ? " wide" : ""));
    const chk = document.createElement("input");
    chk.type = "checkbox";
    const lab = el("label", "mini-chk bulkchk");
    lab.appendChild(chk);
    lab.appendChild(el("span", null, label));
    box.appendChild(lab);
    const body = el("div", "bulkbody");
    if (node) body.appendChild(node);
    box.appendChild(body);
    (into || speechWrap).appendChild(box);
    return { chk, body };
  };

  // 音色
  const refSel = document.createElement("select");
  refSel.className = "sel grow";
  refSel.innerHTML = '<option value="">跟随全局默认</option>';
  const groups = {};
  refOptions().forEach((r) => (groups[r.group] = groups[r.group] || []).push(r));
  Object.keys(groups).forEach((g) => {
    const o = document.createElement("optgroup");
    o.label = g;
    groups[g].forEach((r) => {
      const opt = el("option", null, r.name + (r.dur ? `（${r.dur}s）` : ""));
      opt.value = r.id;
      o.appendChild(opt);
    });
    refSel.appendChild(o);
  });
  const rowRef = mkRow("音色", refSel);

  // 情感模式
  const modeSel = document.createElement("select");
  modeSel.className = "sel grow";
  modeSel.innerHTML = '<option value="">跟随全局默认</option>' +
    EMO_MODE_NAMES.map((n, i) => `<option value="${i}">${i} ${n}</option>`).join("");
  const rowMode = mkRow("情感模式", modeSel);

  // 情感参考音频（模式 1 用）：和单行属性同一套选择器，也能从外部导入
  const emoAudioHost = el("div", "grow");
  const emoAudio = EmoCtl.audio(emoAudioHost, {
    api: API, refs: refOptions(), value: "", toast,
    onUploaded: async (ref) => {
      await loadMeta();
      const list = refOptions();
      if (list.some((x) => x.id === ref.id)) return list;
      return list.concat([{ ...ref, group: "我的音色", editable: true, uses: ["emo"] }]);
    },
  });
  const rowEmoRef = mkRow("情感参考音频", emoAudioHost, null, true);

  // 情感权重
  const weight = document.createElement("input");
  weight.type = "range"; weight.min = "0"; weight.max = "1"; weight.step = "0.01";
  weight.value = (SCRIPT.defaults || {}).emo_weight ?? 0.65;
  const wOut = el("span", "mono", Number(weight.value).toFixed(2));
  weight.oninput = () => { wOut.textContent = Number(weight.value).toFixed(2); };
  const wWrap = el("div", "row2 grow");
  wWrap.appendChild(weight); wWrap.appendChild(wOut);
  const rowWeight = mkRow("情感权重", wWrap);

  // 情感向量：8 轴（滑杆 + −/＋）+ 快捷填充，与单行属性、主界面一致
  const vecHost = el("div", "grow");
  const vecCtl = EmoCtl.vector(vecHost, { value: [] });
  const rowVec = mkRow("情感向量", vecHost, null, true);

  // 情感描述
  const emoTxt = document.createElement("input");
  emoTxt.className = "inp grow";
  emoTxt.placeholder = "情感描述文本（模式 3 用），留空 = 清除";
  const rowEmoTxt = mkRow("情感描述", emoTxt);

  // 停顿
  const pauseInp = document.createElement("input");
  pauseInp.className = "inp grow";
  pauseInp.type = "number"; pauseInp.min = "0"; pauseInp.max = "30000"; pauseInp.step = "10";
  pauseInp.placeholder = "毫秒；留空 = 跟随全局默认";
  const rowPause = mkRow("行后停顿", pauseInp);

  // 追加句中标签
  const tagInp = document.createElement("input");
  tagInp.className = "inp grow";
  tagInp.placeholder = "标签名，例如 音效1（追加到句末）";
  const rowTag = mkRow("追加句中标签", tagInp);

  // 清除行级覆盖
  const clearRow = mkRow("清除行级覆盖",
    el("span", "hint", "音色 / 情感 / 停顿全部回到「全局默认参数」"));

  // ---- 句间标签：标签名 / 留白 / 音效 ----
  let tagNameRow = null, tagHoldRow = null, tagSfxRow = null;
  if (tagTargets.length) {
    const sec = el("div", "sec-h");
    sec.style.marginTop = "14px";
    sec.textContent = `句间标签（${tagTargets.length} 个）`;
    wrap.appendChild(sec);

    const nameInp = document.createElement("input");
    nameInp.className = "inp grow";
    nameInp.placeholder = "留空 = 不改标签名";
    tagNameRow = mkRow("标签名", nameInp, wrap);

    const holdInp = document.createElement("input");
    holdInp.className = "inp grow";
    holdInp.type = "number"; holdInp.min = "0"; holdInp.max = "30000"; holdInp.step = "100";
    holdInp.placeholder = "毫秒；同时决定音效延迟";
    tagHoldRow = mkRow("留白", holdInp, wrap);

    const sfxSel = document.createElement("select");
    sfxSel.className = "sel grow";
    sfxSel.innerHTML = '<option value="">— 不改 —</option><option value="__none">移除音效</option>' +
      (SFX.items || []).map((it) => `<option value="${it.id}">${it.name}（${matDur(it.dur)}）</option>`).join("");
    tagSfxRow = mkRow("音效", sfxSel, wrap);

    wrap.appendChild(el("div", "hint",
      "音效位置 = 标签时间 + 留白。批量设留白时，挂在这些标签上的音效会一起平移。"));
  }

  wrap.appendChild(el("div", "hint",
    "改完的句子如果本来已生成，会标成「需重生成」，音频先保留，重跑后才替换。"));

  const totalLabel = `${targets.length} 句` + (tagTargets.length ? ` + ${tagTargets.length} 标签` : "");
  modal(`批量修改属性（${totalLabel}）`, wrap, async () => {
    const picked = [rowRef, rowMode, rowWeight, rowVec, rowEmoTxt, rowEmoRef, rowPause, rowTag,
      clearRow, tagNameRow, tagHoldRow, tagSfxRow].filter((r) => r && r.chk.checked);
    if (!picked.length) { toast("至少勾选一项要修改的属性", true); return false; }
    pushPropUndo(`批量改属性（${targets.length} 句${tagTargets.length ? ` / ${tagTargets.length} 标签` : ""}）`,
      [...targets, ...tagTargets].map((l) => l.uid));
    let n = 0;
    targets.forEach((l) => {
      l.ov = l.ov || {};
      if (clearRow.chk.checked) { l.ov = {}; l.pause = null; }
      if (rowRef.chk.checked) {
        if (refSel.value) l.ov.ref = refSel.value; else delete l.ov.ref;
      }
      if (rowMode.chk.checked) {
        if (modeSel.value !== "") l.ov.emo_mode = parseInt(modeSel.value, 10); else delete l.ov.emo_mode;
      }
      if (rowWeight.chk.checked) l.ov.emo_weight = Number(weight.value);
      if (rowVec.chk.checked) {
        const v = vecCtl.get();
        if (v.some((x) => x > 0)) l.ov.emo_vec = v.slice(); else delete l.ov.emo_vec;
      }
      if (rowEmoRef.chk.checked) {
        const r = emoAudio.get();
        if (r) l.ov.emo_ref = r; else delete l.ov.emo_ref;
      }
      if (rowEmoTxt.chk.checked) {
        const v = emoTxt.value.trim();
        if (v) l.ov.emo_text = v; else delete l.ov.emo_text;
      }
      if (rowPause.chk.checked) {
        const v = pauseInp.value.trim();
        l.pause = v === "" ? null : Math.max(0, Math.min(30000, parseInt(v, 10) || 0));
      }
      if (rowTag.chk.checked && tagInp.value.trim()) {
        const name = tagInp.value.trim();
        rememberTag(name);
        l.inline = (l.inline || []).concat([{
          pos: (l.text || "").length, tag: name, hold: INLINE_HOLD_DEF,
        }]);
      }
      if (l.status === "done" || l.status === "error") l.status = "stale";
      n++;
    });
    // 标签行：标签名 / 留白 / 音效
    let tn = 0;
    const tName = tagNameRow && tagNameRow.chk.checked
      ? (tagNameRow.body.querySelector("input").value || "").trim() : "";
    const tHold = tagHoldRow && tagHoldRow.chk.checked
      ? tagHoldRow.body.querySelector("input").value.trim() : "";
    const tSfx = tagSfxRow && tagSfxRow.chk.checked
      ? tagSfxRow.body.querySelector("select").value : null;
    tagTargets.forEach((l) => {
      if (tName) l.tag = tName;
      if (tHold !== "") l.hold = Math.max(0, Math.min(30000, parseInt(tHold, 10) || 0));
      if (tSfx !== null) {
        if (tSfx === "__none" || tSfx === "") l.sfx = null;
        else l.sfx = { mid: tSfx, gain: (l.sfx && l.sfx.gain) || 1 };
      }
      tn++;
    });

    commitSnapshot(`批量修改属性（${n} 句${tn ? ` / ${tn} 标签` : ""}）`);
    dirty = true;
    renderCenter(); renderStats(); renderBatchStats();
    await saveNow();
    toast(`已改 ${n} 句${tn ? `、${tn} 个标签` : ""}` +
      (SCRIPT.lines.some((l) => l.status === "stale") ? "，记得重生成" : ""));
  }, "应用");
}

/* ------------------------------ 通用右键菜单 ------------------------------ */
function buildCtx(items, wide) {
  const menu = $("ctxMenu");
  menu.innerHTML = "";
  menu.classList.toggle("wide", !!wide);
  items.forEach((it) => {
    if (it === "-") { menu.appendChild(el("div", "ctxsep")); return; }
    if (it.head) { menu.appendChild(el("div", "ctxsub", it.head)); return; }
    const b = el("button", "ctxitem" + (it.danger ? " danger" : ""), it.label || "");
    if (it.key) b.appendChild(el("span", "kb", it.key));
    if (it.disabled) { b.disabled = true; }
    b.onclick = async (e) => {
      e.stopPropagation();
      hideCtx();
      try { await it.fn(); } catch (err) { toast(String(err.message || err), true); }
    };
    menu.appendChild(b);
  });
  return menu;
}

function showCtxAt(x, y) {
  const menu = $("ctxMenu");
  menu.hidden = false;
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.min(x, window.innerWidth - w - 8) + "px";
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + "px";
}

async function copyText(s) {
  s = s || "";
  if (!s) { toast("这一句是空的", true); return; }
  try {
    await navigator.clipboard.writeText(s);
    toast("已复制到剪贴板");
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = s;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); toast("已复制到剪贴板"); }
    catch (e2) { toast("复制失败，请手动选中复制", true); }
    ta.remove();
  }
}

/* 当前「锚点」句子：光标所在行 → 最后点过的行 → 第一行 */
function anchorUid() {
  if (lastFocusUid) return lastFocusUid;
  if (lastClickUid) return lastClickUid;
  const e = visibleEntries()[0];
  return e ? e.line.uid : null;
}

/* 从某句往前 / 往后全选（只选当前筛选后看得见的行，避免选到隐藏行） */
function selectThrough(uid, dir) {
  const entries = visibleEntries();
  const at = entries.findIndex((x) => x.line.uid === uid);
  if (at < 0) { toast("这一行被筛掉了，先清除筛选", true); return; }
  SEL.clear();
  const from = dir < 0 ? 0 : at;
  const to = dir < 0 ? at : entries.length - 1;
  for (let k = from; k <= to; k++) SEL.add(entries[k].line.uid);
  lastClickUid = uid;
  refreshSelClasses();
  toast(`已选中第 ${from + 1}–${to + 1} 行，共 ${to - from + 1} 行`);
}

function selectOnly(uid) {
  SEL.clear();
  SEL.add(uid);
  lastClickUid = uid;
  refreshSelClasses();
}

/* 行右键菜单：属性 / 复制 / 删除 / 前后全选 …（编辑视图与工作台共用） */
function openLineCtx(line, x, y) {
  const at = idxOf(line);
  const isTag = line.kind === "tag";
  const items = [{ head: isTag ? `第 ${at} 行 · 句间标签` : `第 ${at} 行 · ${(line.text || "").length} 字` }];

  if (isTag) {
    items.push({ label: "修改标签 / 留白…", fn: () => openTagEdit(line) });
    items.push({ label: line.sfx ? "🔔 更换音效…" : "🔔 挂载音效…", fn: () => openSfxPicker(line) });
    if (line.sfx) {
      items.push({ label: "▶ 试听挂的音效", fn: () => playSfxById(line.sfx.mid) });
      items.push({ label: "✕ 移除音效", fn: () => removeTagSfx(line) });
    }
    items.push("-");
    items.push({ label: "选中这个标签", fn: () => selectOnly(line.uid) });
    items.push({ label: "↑ 从这里往前全选", fn: () => selectThrough(line.uid, -1) });
    items.push({ label: "↓ 从这里往后全选", fn: () => selectThrough(line.uid, 1) });
    items.push("-");
    items.push({ label: "删除这个标签", danger: true, fn: () => deleteLine(line) });
    buildCtx(items, true);
    showCtxAt(x, y);
    return;
  }

  items.push({ label: "编辑属性（音色 / 情感 / 停顿 / 备注）…", fn: () => openLineProps(line) });
  items.push({
    label: line.note ? "✎ 改备注…" : "✎ 加备注…",
    fn: () => openLineProps(line),
  });
  if (line.group) items.push({ label: "▤ 改分组…", fn: () => openLineProps(line) });
  items.push("-");
  items.push({ label: "复制文本", fn: () => copyText(line.text) });
  items.push({ label: "复制这一句（在下方插入副本）", fn: () => duplicateLine(line) });
  items.push("-");
  /* 多选时的整段复制 / 粘贴：音频也会跟着复制过去 */
  items.push({ label: "复制这一句（含音频 / 属性）", fn: () => copyLines([line.uid]) });
  const selN = SEL.size;
  if (selN > 1) {
    items.push({ label: `复制选中的 ${selN} 句（含音频 / 属性）`, fn: () => copyLines([...SEL]) });
  }
  if (LINECLIP && LINECLIP.lines.length) {
    items.push({
      label: `粘贴 ${LINECLIP.lines.length} 句到这一句后面`,
      key: "Ctrl+Alt+V",
      fn: () => pasteLines(line.uid),
    });
  }
  items.push("-");
  items.push({ label: "只选这一句", fn: () => selectOnly(line.uid) });
  items.push({ label: "↑ 从这一句往前全选", fn: () => selectThrough(line.uid, -1) });
  items.push({ label: "↓ 从这一句往后全选", fn: () => selectThrough(line.uid, 1) });
  items.push("-");
  items.push({ label: "在下方插入空行", fn: () => insertLineAfter(line) });
  items.push({ label: "插入句中标签…", fn: () => openInlinePicker(line, null, 0) });
  items.push({ label: "在下面插入句间标签…", fn: () => openTagPicker(line.uid) });
  items.push("-");
  items.push({ label: "▶ 试听这一句", fn: () => playLine(line.uid) });
  items.push({
    label: line.status === "done" || line.status === "stale" ? "⟳ 重新生成这一句" : "▶ 生成这一句",
    fn: () => startRender("uids", [line.uid]),
  });
  items.push({ label: "⤓ 导出这一句", disabled: line.status !== "done" || !line.out, fn: () => exportLine(line) });
  if ((line.changes || []).length) {
    items.push("-");
    items.push({ label: "↩ 撤回修改（恢复成生成时）", fn: () => revertLine(line) });
  }
  items.push("-");
  items.push({ label: "删除这一行", danger: true, fn: () => deleteLine(line) });
  buildCtx(items, true);
  showCtxAt(x, y);
}

function openLineMenu(line) { openLineCtx(line, window.innerWidth / 2, 120); }

/* ------------------------------ 智能分行 ------------------------------ */
function openSmartSplit() {
  const wrap = el("div");
  const modeRow = el("div", "radios");
  modeRow.innerHTML = '<label><input type="radio" name="spMode" value="sentence" checked> 按标点分句（一句一行）</label>' +
    '<label><input type="radio" name="spMode" value="packed"> 按长度合并（短句并到接近上限）</label>';
  wrap.appendChild(el("div", "fl", "分行方式"));
  wrap.appendChild(modeRow);

  const lenRow = el("div", "row2");
  lenRow.style.marginTop = "8px";
  const num = document.createElement("input");
  num.className = "inp"; num.type = "number"; num.min = "10"; num.max = "400"; num.step = "5"; num.value = "70";
  lenRow.appendChild(el("span", "hint", "每行字数上限"));
  lenRow.appendChild(num);
  wrap.appendChild(lenRow);

  const scopeRow = el("div", "radios");
  scopeRow.style.marginTop = "10px";
  scopeRow.innerHTML = '<label><input type="radio" name="spScope" value="pending" checked> 只处理未生成 / 需重生成的行</label>' +
    '<label><input type="radio" name="spScope" value="all"> 全篇（已生成的行会变「需重生成」）</label>';
  wrap.appendChild(el("div", "fl", "处理范围"));
  wrap.appendChild(scopeRow);
  wrap.appendChild(el("div", "hint", "按标点分句严格在 。！？；…—— 处切断；按长度合并会把短句并成一段，减少行数。"));

  modal("智能分行", wrap, async () => {
    const mode = document.querySelector('input[name="spMode"]:checked').value;
    const scope = document.querySelector('input[name="spScope"]:checked').value;
    const maxChars = Math.max(10, Math.min(400, parseInt(num.value, 10) || 70));
    closeModal();
    await doSmartSplit(mode, scope, maxChars);
  }, "开始分行");
}

async function doSmartSplit(mode, scope, maxChars) {
  const next = [];
  let added = 0, touchedDone = 0;
  (SCRIPT.lines || []).forEach((l) => {
    const eligible = l.kind !== "tag" && (l.text || "").trim() &&
      (scope === "all" || l.status !== "done");
    if (!eligible) { next.push(l); return; }
    const parts = splitTextJS(l.text, maxChars, mode);
    if (parts.length <= 1) { next.push(l); return; }
    if (l.status === "done") touchedDone++;
    added += parts.length - 1;
    parts.forEach((p, i) => {
      const keepUid = scope !== "all" && i === 0;
      next.push(Object.assign({}, l, {
        uid: keepUid ? l.uid : uid(),
        text: p,
        inline: keepUid ? (l.inline || []).filter((it) => it.pos <= p.length) : [],
        status: "pending",
        out: keepUid ? l.out : null,
        dur: keepUid ? l.dur : null,
        elapsed: null, err: null, sig: null,
      }));
    });
  });
  if (!added) { toast("没有需要分行的内容"); return; }
  SCRIPT.lines = next;
  (SCRIPT.batches || []).forEach((b) => { b.uids = (b.uids || []).filter((u) => next.some((l) => l.uid === u)); });
  commitSnapshot("智能分行（" + (scope === "all" ? "全篇" : "未生成") + "）");
  SEL.clear();
  dirty = true; renderCenter(); renderStats(); renderBatchList(); renderBatchStats();
  await saveNow();
  toast(`新增 ${added} 行` + (touchedDone ? `，${touchedDone} 行已生成的需重跑` : ""));
}

/* ------------------------------ 历史 ------------------------------ */
function snapshotKey() {
  return JSON.stringify((SCRIPT.lines || []).map(
    (l) => [l.uid, l.kind, l.text, l.tag, l.hold, l.pause, l.ov, l.inline, l.sfx]));
}

function commitSnapshot(label, merge) {
  if (!SCRIPT) return;
  const key = snapshotKey();
  const top = UNDO[UNDO.length - 1];
  if (top && top.key === key) return;
  if (merge && top && top.label === "编辑文本" && Date.now() - top.time < 8000) {
    top.lines = deepCopy(SCRIPT.lines);
    top.key = key;
    top.time = Date.now();
    REDO = [];
    updateUndoButtons();
  } else {
    UNDO.push({ label: label || "编辑", time: Date.now(), lines: deepCopy(SCRIPT.lines), key });
    if (UNDO.length > MAX_HISTORY) UNDO.shift();
    REDO = [];
    updateUndoButtons();
  }
  pushHistoryToDisk(label);
}

function pushHistoryToDisk(label) {
  if (!SCRIPT || label === "打开台本") return;
  const now = Date.now();
  if (label === "编辑文本" && now - lastDiskAt < 15000) return;
  lastDiskAt = now;
  api(`/scripts/${SCRIPT.id}/history`, {
    method: "POST", body: JSON.stringify({ label: label || "编辑" }),
  }).catch(() => { /* 落盘失败不影响编辑 */ });
}

function scheduleSnapshot() {
  clearTimeout(snapTimer);
  snapTimer = setTimeout(() => commitSnapshot("编辑文本", true), 1300);
}

function updateUndoButtons() {
  $("btnUndo").disabled = UNDO.length < 2;
  $("btnRedo").disabled = !REDO.length;
}

/* ---------------- 属性撤回（只回退属性，不动文本） ----------------
   改音色 / 情感 / 停顿 / 标签 / 全局默认时先存一份「改之前」的快照；
   「↩ 撤回属性」只把这些字段写回去 —— 文本、句中标签位置、已生成的音频都不动，
   所以不会出现「想撤回音色结果把文本也吞了」。 */
const PROP_UNDO = [];
function snapPropLine(l) {
  return {
    ov: deepCopy(l.ov || {}), pause: l.pause, group: l.group, note: l.note,
    slow: l.slow, tag: l.tag, hold: l.hold,
    sfx: l.sfx ? deepCopy(l.sfx) : null, status: l.status,
  };
}
function pushPropUndo(label, uids) {
  const before = {};
  (uids || []).forEach((u) => { const l = byUid(u); if (l) before[u] = snapPropLine(l); });
  if (!Object.keys(before).length) return;
  PROP_UNDO.push({ kind: "lines", label, time: Date.now(), before });
  if (PROP_UNDO.length > 50) PROP_UNDO.shift();
  updatePropUndoBtn();
}
function pushDefaultsUndo(label) {
  if (!SCRIPT) return;
  PROP_UNDO.push({
    kind: "defaults", label, time: Date.now(),
    defaults: deepCopy(SCRIPT.defaults || {}), sampling: deepCopy(SCRIPT.sampling || {}),
  });
  if (PROP_UNDO.length > 50) PROP_UNDO.shift();
  updatePropUndoBtn();
}
function updatePropUndoBtn() {
  const b = $("btnPropUndo");
  if (!b) return;
  const last = PROP_UNDO[PROP_UNDO.length - 1];
  b.disabled = !last;
  b.textContent = last ? `↩ 撤回属性（${PROP_UNDO.length}）` : "↩ 撤回属性";
  b.title = last
    ? `撤回：${last.label}（${new Date(last.time).toLocaleTimeString()}）`
      + (PROP_UNDO.length > 1
        ? "\n再往前：" + PROP_UNDO.slice(-6, -1).reverse().map((x) => x.label).join(" / ")
        : "")
      + "\n只回退属性，不改文本、不动已生成的音频"
    : "还没有改过属性";
}
async function undoLastProp() {
  const it = PROP_UNDO.pop();
  if (!it) { toast("还没有改过属性", true); updatePropUndoBtn(); return; }
  if (it.kind === "defaults") {
    SCRIPT.defaults = it.defaults || {};
    SCRIPT.sampling = it.sampling || {};
    syncDefaultPanel();
  } else {
    Object.keys(it.before).forEach((u) => {
      const l = byUid(u);
      if (!l) return;
      const b = it.before[u];
      l.ov = deepCopy(b.ov || {});
      l.pause = b.pause; l.group = b.group; l.note = b.note; l.slow = b.slow;
      if (l.kind === "tag") {
        l.tag = b.tag; l.hold = b.hold;
        l.sfx = b.sfx ? deepCopy(b.sfx) : null;
      }
      if (b.status) l.status = b.status;
    });
  }
  commitSnapshot("撤回属性：" + it.label);
  dirty = true; renderCenter(); renderStats(); queueSave();
  updatePropUndoBtn();
  toast(`已撤回属性：${it.label}`);
}

async function undo() {
  if (UNDO.length < 2) { toast("没有可撤销的操作"); return; }
  try {
    if (dirty) await saveNow();
    const cur = UNDO.pop();
    REDO.push(cur);
    SCRIPT.lines = deepCopy(UNDO[UNDO.length - 1].lines);
    SEL.clear();
    updateUndoButtons();
    renderCenter(); renderStats();
    await saveNow();
    toast("已撤销：" + cur.label);
  } finally {
    updateUndoButtons();
  }
}

async function redo() {
  if (!REDO.length) { toast("没有可重做的操作"); return; }
  try {
    if (dirty) await saveNow();
    const snap = REDO.pop();
    UNDO.push(snap);
    SCRIPT.lines = deepCopy(snap.lines);
    SEL.clear();
    updateUndoButtons();
    renderCenter(); renderStats();
    await saveNow();
    toast("已重做：" + snap.label);
  } finally {
    updateUndoButtons();
  }
}

function runHist(fn) {
  histChain = histChain.then(fn).catch((e) => console.error(e));
  return histChain;
}

async function openHistory() {
  const wrap = el("div");
  wrap.appendChild(el("div", "fl", "磁盘副本（换会话也在，保留最近 20 份）"));
  const list = el("div", "histlist");
  list.appendChild(el("div", "hint", "读取中…"));
  wrap.appendChild(list);
  wrap.appendChild(el("div", "fl", "本次会话（未落盘，退出即失效）"));
  const sess = el("div", "histlist");
  wrap.appendChild(sess);

  const renderSess = () => {
    sess.innerHTML = "";
    if (UNDO.length <= 1) { sess.appendChild(el("div", "hint", "没有会话内快照")); return; }
    UNDO.slice().reverse().forEach((s) => {
      const row = el("div", "histitem");
      row.appendChild(el("span", "mono", new Date(s.time).toLocaleTimeString()));
      row.appendChild(el("span", "grow", s.label));
      row.appendChild(el("span", "hint", `${s.lines.length} 行`));
      const b = el("button", "btn mini", "回到这里");
      b.onclick = async () => {
        closeModal();
        if (dirty) await saveNow();
        while (UNDO.length > 1 && UNDO[UNDO.length - 1] !== s) REDO.push(UNDO.pop());
        SCRIPT.lines = deepCopy(s.lines);
        SEL.clear();
        renderCenter(); renderStats();
        await saveNow();
        updateUndoButtons();
        toast("已回到：" + s.label);
      };
      row.appendChild(b);
      sess.appendChild(row);
    });
  };
  renderSess();
  modal("历史副本", wrap, async () => true, "关闭");

  try {
    const r = await api(`/scripts/${SCRIPT.id}/history`);
    list.innerHTML = "";
    if (!r.items.length) {
      list.appendChild(el("div", "hint", "还没有磁盘副本。编辑一会儿或点「保存」后会自动生成。"));
      return;
    }
    r.items.forEach((it) => {
      const row = el("div", "histitem");
      row.appendChild(el("span", "mono", it.time ? new Date(it.time * 1000).toLocaleString() : "—"));
      row.appendChild(el("span", "grow", it.label || "编辑"));
      row.appendChild(el("span", "hint", `${it.lines || 0} 行`));
      const b1 = el("button", "btn mini", "恢复");
      b1.onclick = async () => {
        if (!confirm("恢复到这份副本？（当前状态会先自动存一份，可反悔）")) return;
        closeModal();
        try {
          const res = await api(`/scripts/${SCRIPT.id}/history/${encodeURIComponent(it.name)}/restore`,
            { method: "POST", body: "{}" });
          SCRIPT = res.script; STATS = res.stats;
          SEL.clear();
          UNDO = [{ label: "打开台本", time: Date.now(), lines: deepCopy(SCRIPT.lines), key: snapshotKey() }];
          renderAll(); updateUndoButtons();
          toast("已恢复");
        } catch (e) { toast("恢复失败：" + e.message, true); }
      };
      const b2 = el("button", "btn mini ghost", "✕");
      b2.title = "删除这份副本";
      b2.onclick = async () => {
        try {
          await api(`/scripts/${SCRIPT.id}/history/${encodeURIComponent(it.name)}`, { method: "DELETE" });
          row.remove();
        } catch (e) { toast(e.message, true); }
      };
      row.appendChild(b1); row.appendChild(b2);
      list.appendChild(row);
    });
  } catch (e) {
    list.innerHTML = "";
    list.appendChild(el("div", "hint", "读取失败：" + e.message));
  }
}

/* ------------------------------ 保存 ------------------------------ */
function queueSave() {
  dirty = true;
  $("saveState").textContent = "有未保存改动…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 900);
}

function payloadLines() {
  return (SCRIPT.lines || []).map((l) => {
    const o = {
      uid: l.uid, kind: l.kind || "speech", text: l.text || "", tag: l.tag || null,
      hold: l.hold, pause: l.pause, ov: l.ov || {}, inline: l.inline || [],
      // 分组 / 附属备注 / 慢语速 / 出现时间：以前这三项没带上，保存一次就被清空
      // （智能导入建好的分组和备注会在自动保存后凭空消失）
      group: l.group || null, note: l.note || null, slow: !!l.slow,
      t0: l.t0 == null ? null : l.t0, t1: l.t1 == null ? null : l.t1,
    };
    if (l.kind === "tag") o.sfx = l.sfx || null;
    // 撤销「删除句子」/ 恢复历史副本时，这些行在服务端已经不存在了。
    // 不把音频引用带回去的话，服务端会当成全新行 → 标签变「未生成」而音频还在。
    if (l.out) {
      o.out = l.out;
      o.dur = l.dur;
      o.sig = l.sig;
      o.elapsed = l.elapsed;
    }
    if (l.status === "stale" || l.status === "pending") o.status = l.status;
    return o;
  });
}

/* 保存也串行：两处同时触发（防抖 + 轮询结束时）时，PATCH 乱序会让旧内容盖掉新内容。 */
let SAVE_CHAIN = Promise.resolve();

function saveNow() {
  clearTimeout(saveTimer);
  if (!SCRIPT) return Promise.resolve();
  const sid = SCRIPT.id;
  // 快照：真正发出去的是「按下保存那一刻」的内容，之后继续编辑不会改变这次请求
  const body = JSON.stringify({
    title: SCRIPT.title, defaults: SCRIPT.defaults, sampling: SCRIPT.sampling,
    tag_presets: SCRIPT.tag_presets || [], batches: SCRIPT.batches || [],
    lines: payloadLines(),
  });
  SAVE_CHAIN = SAVE_CHAIN.then(() => doSave(sid, body)).catch(() => {});
  return SAVE_CHAIN;
}

async function doSave(sid, body) {
  try {
    const r = await api(`/scripts/${sid}`, { method: "PATCH", body });
    // 已经切到别的台本：只落盘，不动界面上的状态（那是新台本的）
    if (!SCRIPT || SCRIPT.id !== sid) return;
    STATS = r.stats;
    // 服务端顺手回了「每行改了什么」和最新状态：就地更新标注，
    // 不用整页重渲染（否则正在输入的 textarea 会丢焦点）。
    applyLineMeta(r);
    dirty = false;
    $("saveState").textContent = "已保存 " + new Date().toLocaleTimeString();
    renderStats();
  } catch (e) {
    $("saveState").textContent = "保存失败";
    toast("保存失败：" + e.message, true);
  }
}

/* 把服务端回传的 changes / statuses 落到当前 SCRIPT.lines 上 */
function applyLineMeta(r) {
  if (!r) return;
  const ch = r.changes || {};
  const st = r.statuses || {};
  SCRIPT.lines.forEach((l) => {
    if (l.kind === "tag") return;
    l.changes = ch[l.uid] || [];
    // 有差异才可能撤回：文本/参数一致时后端不给 changes
    l.can_revert = l.changes.length > 0 && !!l.gen;
    if (st[l.uid] && l.status !== "running" && l.status !== "queued") l.status = st[l.uid];
  });
  patchLineMeta();
  patchBadges();
  updateChangedCount();
  refreshHistoryRuntime();
}

/* 只改 DOM：把「改 N」小标签和撤回按钮同步到最新，不动文本输入框 */
function patchLineMeta() {
  SCRIPT.lines.forEach((l) => {
    // 编辑视图和工作台可能同时在 DOM 里（一个 hidden），两边都要更新
    document.querySelectorAll(`[data-uid="${l.uid}"]`).forEach((node) => {
      const rv = node.querySelector(".revert");
      if (rv) rv.hidden = !l.can_revert;
      const box = node.querySelector(".rmeta") || node.querySelector(".bhead");
      if (!box) return;
      const old = box.querySelector(".chgchip");
      if ((l.changes || []).length) {
        const fresh = changeChip(l);
        if (old) old.replaceWith(fresh); else box.appendChild(fresh);
      } else if (old) {
        old.remove();
      }
      const t = box.querySelector(".rmeta-txt");
      if (t) t.textContent = `${(l.text || "").length} 字 · ${durLabel(l)}`;
    });
  });
}

/* ------------------------------ 左侧「更多」菜单 ------------------------------ */
// 「我的台本」标题右侧的下拉菜单：把散落在顶栏/卡片上的常用操作集中起来。
let HIDE_PROJECTS = localStorage.getItem("lf.hideProjects") === "1";

function openSideMenu(anchor) {
  const menu = $("ctxMenu");
  menu.innerHTML = "";
  menu.classList.remove("wide");
  const add = (label, fn, flag) => {
    const b = el("button", "ctxitem", label);
    if (flag) b.style.color = "var(--primary)";
    b.onclick = async (e) => { e.stopPropagation(); hideCtx(); await fn(); };
    menu.appendChild(b);
  };
  const sep = () => menu.appendChild(el("div", "ctxsep"));
  const sub = (t) => menu.appendChild(el("div", "ctxsub", t));

  sub("台本");
  add("新建台本", () => $("btnNew").click());
  add("导入台本（追加到当前台本）", () => $("btnImport").click());
  add("🧠 智能导入（txt/docx/srt/csv/fountain）", () => openSmartImport());
  add("刷新列表", () => loadScripts());

  sep();
  sub("当前台本");
  if (SCRIPT) {
    add("新建副本（含已生成音频）", async () => {
      try {
        const r = await api(`/scripts/${SCRIPT.id}/duplicate`, { method: "POST", body: "{}" });
        toast("已创建副本");
        await switchScript(r.id);
      } catch (e) { toast("复制失败：" + e.message, true); }
    });
    add("导出 Markdown", async () => {
      await api(`/scripts/${SCRIPT.id}/export/script`, { method: "POST", body: JSON.stringify({ format: "md" }) });
      toast("已生成 Markdown"); switchPane("export");
    });
    add("导出纯文本", async () => {
      await api(`/scripts/${SCRIPT.id}/export/script`, { method: "POST", body: JSON.stringify({ format: "txt" }) });
      toast("已生成纯文本"); switchPane("export");
    });
    add("回到导出面板", () => switchPane("export"));
  } else {
    add("（先打开一个台本）", () => {}, false);
  }

  sep();
  sub("显示");
  add(HIDE_PROJECTS ? "✓ 已隐藏「工程」副本（点此显示）" : "隐藏「工程」副本", async () => {
    HIDE_PROJECTS = !HIDE_PROJECTS;
    localStorage.setItem("lf.hideProjects", HIDE_PROJECTS ? "1" : "0");
    await loadScripts();
    toast(HIDE_PROJECTS ? "已隐藏工程副本" : "已显示工程副本");
  }, HIDE_PROJECTS);
  add("台本统计", async () => {
    const list = await loadScripts();
    const src = list.filter((x) => !x.is_project);
    const prj = list.filter((x) => x.is_project);
    const chars = src.reduce((a, x) => a + (x.chars || 0), 0);
    const speech = src.reduce((a, x) => a + (x.speech || 0), 0);
    const done = src.reduce((a, x) => a + (x.done || 0), 0);
    toast(`源台本 ${src.length} 个（${speech} 句 / ${chars} 字，已完成 ${done} 句）· 工程 ${prj.length} 个`, false);
  });

  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.min(r.left, window.innerWidth - w - 8) + "px";
  menu.style.top = Math.min(r.bottom + 4, window.innerHeight - h - 8) + "px";
}

/* ------------------------------ 台本菜单 ------------------------------ */
/* -------------------- 台本批量操作（多选后） -------------------- */
function ssTargets(selfId) {
  // 右键点在「已多选」的卡片上 → 整批；否则只这一份
  return (SSEL.size > 1 && SSEL.has(selfId)) ? Array.from(SSEL) : [selfId];
}

async function ssDelete(ids) {
  if (!ids.length) return;
  const names = ids.map((id) => {
    const c = document.querySelector(`#scriptsList .scard[data-sid="${id}"] .t`);
    return c ? c.textContent.trim() : id;
  });
  const head = ids.length === 1
    ? `删除「${names[0]}」？`
    : `删除这 ${ids.length} 份？\n\n` + names.slice(0, 8).map((n) => "· " + n).join("\n")
      + (names.length > 8 ? `\n… 还有 ${names.length - 8} 份` : "");
  if (!confirm(head + "\n\n音频文件会一起删除（回收站里能找到），台本列表不可恢复。")) return;
  const curId = SCRIPT ? SCRIPT.id : null;
  let n = 0, fail = 0;
  for (const id of ids) {
    try {
      await api(`/scripts/${id}`, { method: "DELETE" });
      n++;
    } catch (e) { fail++; }
  }
  ssClear();
  const list = await loadScripts();
  if (curId && ids.includes(curId)) {
    if (list.length) await switchScript(list[0].id);
    else { SCRIPT = null; $("rows").innerHTML = '<div class="empty">还没有台本</div>'; }
  }
  toast(`已删除 ${n} 份${fail ? `，${fail} 份失败` : ""}`, !!fail);
}

async function ssDuplicate(ids) {
  if (!ids.length) return;
  let n = 0, fail = 0, last = null;
  for (const id of ids) {
    try {
      const r = await api(`/scripts/${id}/duplicate`, { method: "POST", body: "{}" });
      last = r.id; n++;
    } catch (e) { fail++; }
  }
  await loadScripts();
  toast(`已复制 ${n} 份${fail ? `，${fail} 份失败` : ""}（副本在各自的「工程 / 台本」里）`, !!fail);
  if (n === 1 && last) await switchScript(last);
}

function openScriptMenu(s, x, y) {
  const menu = $("ctxMenu");
  menu.innerHTML = "";
  menu.classList.remove("wide");
  const batch = ssTargets(s.id);
  const many = batch.length > 1;
  const item = (label, fn, disabled) => {
    const b = el("button", "ctxitem", label);
    b.onclick = async (e) => { e.stopPropagation(); hideCtx(); await fn(); };
    if (disabled) { b.disabled = true; b.style.opacity = ".45"; }
    menu.appendChild(b);
  };
  item(many ? `重命名（只对「${s.title || s.id}」有效）` : "重命名", async () => {
    const wrap = el("div");
    const inp = document.createElement("input");
    inp.className = "inp"; inp.value = s.title || "";
    wrap.appendChild(el("div", "fl", "台本名称"));
    wrap.appendChild(inp);
    modal("重命名台本", wrap, async () => {
      const name = inp.value.trim();
      if (!name) { toast("名称不能为空", true); return false; }
      await api(`/scripts/${s.id}`, { method: "PATCH", body: JSON.stringify({ title: name }) });
      if (SCRIPT && SCRIPT.id === s.id) SCRIPT.title = name;
      await loadScripts();
      document.title = ((SCRIPT && SCRIPT.title) || name) + " · 全能音声工作台";
      toast("已重命名");
    }, "保存");
  });
  item(many ? `新建副本（${batch.length} 份）` : "新建副本", async () => {
    if (many) { await ssDuplicate(batch); return; }
    try {
      const r = await api(`/scripts/${s.id}/duplicate`, { method: "POST", body: "{}" });
      toast("已创建副本（含已生成音频）");
      await switchScript(r.id);
    } catch (e) { toast("复制失败：" + e.message, true); }
  });
  item("导出 Markdown", async () => {
    await api(`/scripts/${s.id}/export/script`, { method: "POST", body: JSON.stringify({ format: "md" }) });
    toast("已生成 Markdown（在导出面板下载）");
    switchPane("export");
  });
  item("导出纯文本", async () => {
    await api(`/scripts/${s.id}/export/script`, { method: "POST", body: JSON.stringify({ format: "txt" }) });
    toast("已生成纯文本（在导出面板下载）");
    switchPane("export");
  });
  item(many ? `删除这 ${batch.length} 份` : "删除台本", async () => {
    await ssDelete(batch);
  });
  menu.hidden = false;
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.min(x, window.innerWidth - w - 8) + "px";
  menu.style.top = Math.min(y, window.innerHeight - h - 8) + "px";
}

function hideCtx() { $("ctxMenu").hidden = true; }

/* ------------------------------ 批量任务 ------------------------------ */
function batchCoverage() {
  const cnt = new Map();
  (SCRIPT.batches || []).forEach((b) => {
    (b.uids || []).forEach((u) => {
      if (!cnt.has(u)) cnt.set(u, []);
      cnt.get(u).push(b.name);
    });
  });
  const speech = speechLines();
  const uncovered = speech.filter((l) => !cnt.has(l.uid));
  const overlap = speech.filter((l) => (cnt.get(l.uid) || []).length > 1);
  return { total: speech.length, covered: speech.length - uncovered.length, uncovered, overlap, cnt };
}

function batchSummary(b) {
  const p = b.params || {};
  const bits = [];
  bits.push(p.ref ? refName(p.ref) : "跟随默认音色");
  bits.push(EMO_MODE_NAMES[Number(p.emo_mode || 0)] || "-");
  if (Number(p.emo_mode) !== 2 && p.emo_weight != null) bits.push("权重 " + p.emo_weight);
  if (Number(p.emo_mode) === 2 && Array.isArray(p.emo_vec)) {
    const hit = p.emo_vec.map((v, i) => (v > 0 ? EMO_NAMES[i] + v : null)).filter(Boolean);
    if (hit.length) bits.push(hit.join("+"));
  }
  if (p.pause != null) bits.push("停顿 " + p.pause + "ms");
  return bits.join(" · ");
}

function renderBatchList() {
  const box = $("batchList");
  if (!box) return;
  box.innerHTML = "";
  const list = SCRIPT.batches || [];
  if (!list.length) {
    box.appendChild(el("div", "hint", "还没有分组。选中一批句子后点下面「＋ 新建分组」，把句子 + 一套音色参数存成一组。"));
    return;
  }
  list.forEach((b) => {
    const item = el("div", "batchitem");
    const head = el("div", "batch-head");
    head.appendChild(el("b", null, b.name));
    head.appendChild(el("span", "hint", `${(b.uids || []).length} 句`));
    const del = el("button", "iconbtn", "✕");
    del.title = "删除任务（不会删除句子）";
    del.onclick = () => deleteBatch(b.id);
    head.appendChild(del);
    item.appendChild(head);
    item.appendChild(el("div", "batch-sub", batchSummary(b)));
    const act = el("div", "batch-act");
    // 「选中本组」= 这个分组里的全部句子。原来的「选中已覆盖 / 选中未覆盖」其实是同一件事
    // 的两种说法（任务本身就把这些句子覆盖了），语义绕，这里直接简化成一个动作。
    const mine = (b.uids || []).filter((u) => SCRIPT.lines.some((l) => l.uid === u && l.kind !== "tag"));
    const bSel = el("button", "btn mini grow", `选中本组 ${mine.length}`);
    bSel.title = "选中这个分组里的全部句子（再点一次取消选中）";
    bSel.disabled = !mine.length;
    bSel.onclick = () => applySel(bSel, mine, "这个分组里没有句子了");
    const bRun = el("button", "btn mini", "生成");
    bRun.onclick = () => startRender("batches", null, [b.id]);
    const bEdit = el("button", "btn mini ghost", "编辑");
    bEdit.onclick = () => openBatchDialog(b);
    act.appendChild(bSel); act.appendChild(bRun); act.appendChild(bEdit);
    item.appendChild(act);
    box.appendChild(item);
  });
}

function renderBatchStats() {
  const box = $("batchStats");
  if (!box) return;
  const cov = batchCoverage();
  box.innerHTML = "";
  if (!cov.total) { box.appendChild(el("div", "hint", "还没有语音行")); return; }
  const row = el("div", "bstat-row");
  row.appendChild(el("span", null, `语音行 ${cov.total}`));
  row.appendChild(el("span", "ok", `已分组 ${cov.covered}`));
  row.appendChild(el("span", cov.uncovered.length ? "warn" : "", `未分组 ${cov.uncovered.length}`));
  box.appendChild(row);
  const bar = el("div", "bar");
  const i = el("i");
  i.style.width = ((cov.covered / cov.total) * 100).toFixed(1) + "%";
  bar.appendChild(i);
  box.appendChild(bar);
  if (cov.overlap.length) {
    const names = new Set();
    cov.overlap.forEach((l) => (cov.cnt.get(l.uid) || []).forEach((n) => names.add(n)));
    box.appendChild(el("div", "hint",
      `被多个分组同时包含 ${cov.overlap.length} 句（${Array.from(names).join(" ∩ ")}），生成时只跑一次`));
  }
  if (cov.uncovered.length) {
    const idxs = cov.uncovered.slice(0, 12).map((l) => idxOf(l)).join("、");
    box.appendChild(el("div", "hint", `还没分组的行：${idxs}${cov.uncovered.length > 12 ? "…" : ""}`));
  }
}

function batchParamControls(existing) {
  const wrap = el("div");
  const p = (existing && existing.params) || {};

  const refSel = document.createElement("select");
  refSel.className = "sel";
  refSel.innerHTML = '<option value="">— 跟随默认音色 —</option>';
  const groups = {};
  refOptions().forEach((r) => (groups[r.group] = groups[r.group] || []).push(r));
  Object.keys(groups).forEach((g) => {
    const o = document.createElement("optgroup");
    o.label = g;
    groups[g].forEach((r) => {
      const opt = el("option", null, r.name + (r.dur ? `（${r.dur}s）` : ""));
      opt.value = r.id;
      o.appendChild(opt);
    });
    refSel.appendChild(o);
  });
  refSel.value = p.ref || "";
  wrap.appendChild(el("div", "fl", "音色"));
  wrap.appendChild(refSel);

  const modeSel = document.createElement("select");
  modeSel.className = "sel";
  modeSel.innerHTML = EMO_MODE_NAMES.map((n, i) => `<option value="${i}">${i} ${n}</option>`).join("");
  modeSel.value = String(p.emo_mode ?? 0);
  wrap.appendChild(el("div", "fl", "情感模式"));
  wrap.appendChild(modeSel);

  const weight = document.createElement("input");
  weight.type = "range"; weight.min = "0"; weight.max = "1"; weight.step = "0.01";
  weight.value = p.emo_weight ?? 0.65;
  const wlab = el("div", "fl", "情感权重 " + Number(weight.value).toFixed(2));
  weight.oninput = () => { wlab.textContent = "情感权重 " + Number(weight.value).toFixed(2); };
  wrap.appendChild(wlab); wrap.appendChild(weight);

  // 情感参考音频（模式 1 用）
  const emoAudioHost = el("div");
  const emoAudio = EmoCtl.audio(emoAudioHost, {
    api: API, refs: refOptions(), value: p.emo_ref || "", toast,
    onUploaded: async (ref) => {
      await loadMeta();
      const list = refOptions();
      if (list.some((x) => x.id === ref.id)) return list;
      return list.concat([{ ...ref, group: "我的音色", editable: true, uses: ["emo"] }]);
    },
  });
  wrap.appendChild(el("div", "fl", "情感参考音频（模式 1 生效）"));
  wrap.appendChild(emoAudioHost);

  const vecHost = el("div");
  const vecCtl = EmoCtl.vector(vecHost, { value: p.emo_vec || [] });
  wrap.appendChild(el("div", "fl", "情感向量（模式 2 生效）"));
  wrap.appendChild(vecHost);

  const pauseInp = document.createElement("input");
  pauseInp.className = "inp"; pauseInp.type = "number"; pauseInp.min = "0";
  pauseInp.max = "30000"; pauseInp.step = "10";
  pauseInp.value = p.pause ?? ""; pauseInp.placeholder = "留空 = 跟随默认";
  wrap.appendChild(el("div", "fl", "行间停顿（毫秒）"));
  wrap.appendChild(pauseInp);

  return {
    node: wrap,
    read() {
      const params = {
        ref: refSel.value || "",
        emo_mode: parseInt(modeSel.value, 10) || 0,
        emo_weight: Number(weight.value),
        emo_ref: emoAudio.get() || "",
        pause: pauseInp.value.trim() === "" ? null
          : Math.max(0, Math.min(30000, parseInt(pauseInp.value, 10) || 0)),
      };
      const v = vecCtl.get();
      if (params.emo_mode === 2 && v.some((x) => x > 0)) params.emo_vec = v.slice();
      return params;
    },
  };
}

function openBatchDialog(existing) {
  const wrap = el("div");
  const nameInp = document.createElement("input");
  nameInp.className = "inp";
  nameInp.placeholder = "任务名，如：旁白 / 角色A";
  nameInp.value = existing ? existing.name : "";
  wrap.appendChild(el("div", "fl", "任务名"));
  wrap.appendChild(nameInp);

  const params = batchParamControls(existing);
  wrap.appendChild(params.node);

  if (!existing) {
    const cov = batchCoverage();
    const scopeRow = el("div", "radios");
    scopeRow.style.marginTop = "10px";
    scopeRow.innerHTML =
      `<label><input type="radio" name="bScope" value="sel" checked> 用当前选中的行（${SEL.size} 行）</label>` +
      `<label><input type="radio" name="bScope" value="uncovered"> 所有未分组的行（${cov.uncovered.length} 行）</label>` +
      `<label><input type="radio" name="bScope" value="range"> 按编号区间：</label>`;
    wrap.appendChild(el("div", "fl", "作用范围"));
    wrap.appendChild(scopeRow);
    const rInp = document.createElement("input");
    rInp.className = "inp";
    rInp.placeholder = "如 1-50,60,80-";
    rInp.style.display = "none";
    wrap.appendChild(rInp);
    scopeRow.addEventListener("change", () => {
      rInp.style.display = scopeRow.querySelector('input[name="bScope"]:checked').value === "range" ? "" : "none";
    });
    wrap.appendChild(el("div", "hint", "创建后参数会写入这些行的行级覆盖值，并记住这一组句子。"));

    modal("新建分组 / 批量任务", wrap, async () => {
      const name = nameInp.value.trim();
      if (!name) { toast("任务名不能为空", true); return false; }
      const scope = scopeRow.querySelector('input[name="bScope"]:checked').value;
      let uids;
      if (scope === "sel") uids = [...SEL];
      else if (scope === "uncovered") uids = cov.uncovered.map((l) => l.uid);
      else uids = [...parseRange(rInp.value)];
      if (!uids.length) { toast(scope === "sel" ? "还没有选中任何行" : "这个范围里没有句子", true); return false; }
      const batch = { id: uid(), name, uids, params: params.read(), created: Date.now() / 1000 };
      SCRIPT.batches = (SCRIPT.batches || []).concat([batch]);
      applyBatchParams(batch);
      commitSnapshot("新建分组 " + name);
      dirty = true;
      renderBatchList(); renderBatchStats(); renderRenderBatches(); renderCenter();
      await saveNow();
      toast(`分组「${name}」已创建，包含 ${uids.length} 行`);
    }, "创建");
    return;
  }

  wrap.appendChild(el("div", "hint", `当前包含 ${(existing.uids || []).length} 句；保存会把参数重新写入这些行。`));
  modal("编辑分组 / 批量任务", wrap, async () => {
    const name = nameInp.value.trim();
    if (!name) { toast("任务名不能为空", true); return false; }
    existing.name = name;
    existing.params = params.read();
    applyBatchParams(existing);
    commitSnapshot("编辑分组 " + name);
    dirty = true;
    renderBatchList(); renderBatchStats(); renderRenderBatches(); renderCenter();
    await saveNow();
    toast("已更新并重新应用到 " + (existing.uids || []).length + " 行");
  }, "保存");
}

function applyBatchParams(batch) {
  const p = batch.params || {};
  const set = new Set(batch.uids || []);
  const patch = {};
  ["ref", "emo_mode", "emo_weight", "emo_vec", "emo_ref"].forEach((k) => {
    if (p[k] !== undefined && p[k] !== null && p[k] !== "") patch[k] = p[k];
  });
  let stale = 0;
  SCRIPT.lines.forEach((l) => {
    if (!set.has(l.uid) || l.kind === "tag") return;
    l.ov = Object.assign({}, l.ov || {}, patch);
    if (p.pause !== undefined && p.pause !== null) l.pause = p.pause;
    if (l.status === "done") { l.status = "stale"; stale++; }
  });
  return stale;
}

async function deleteBatch(id) {
  const b = (SCRIPT.batches || []).find((x) => x.id === id);
  if (!b) return;
  if (!confirm(`删除分组「${b.name}」？（句子和已生成音频都保留）`)) return;
  SCRIPT.batches = (SCRIPT.batches || []).filter((x) => x.id !== id);
  commitSnapshot("删除分组 " + b.name);
  dirty = true;
  renderBatchList(); renderBatchStats(); renderRenderBatches();
  await saveNow();
  toast("已删除任务");
}

function renderRenderBatches() {
  const box = $("rBatchList");
  if (!box) return;
  box.innerHTML = "";
  const list = SCRIPT.batches || [];
  if (!list.length) {
    box.appendChild(el("div", "hint", "还没有分组，先去「批量」页建一个。"));
    return;
  }
  list.forEach((b) => {
    const row = el("label", "batchpick-row");
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.value = b.id;
    cb.onchange = () => paintRender();
    row.appendChild(cb);
    row.appendChild(el("span", "grow", b.name));
    row.appendChild(el("span", "hint", `${(b.uids || []).length} 句`));
    box.appendChild(row);
  });
}

function selectedBatchIds() {
  const box = $("rBatchList");
  return box ? [...box.querySelectorAll("input:checked")].map((cb) => cb.value) : [];
}

/* ------------------------------ 默认面板 ------------------------------ */
/* 全局默认里的情感音频 / 向量：共用组件（面板在 HTML 里只留了两个容器） */
let dEmoAudio = null, dEmoVec = null;
function ensureDefaultEmo() {
  if (!SCRIPT) return null;
  const d = SCRIPT.defaults || {};
  if (!dEmoAudio) {
    dEmoAudio = EmoCtl.audio($("dEmoRefHost"), {
      api: API, refs: refOptions(), value: d.emo_ref || "", toast,
      follow: false, emptyLabel: "— 不指定（模式 1 的行会报错）—",
      onChange: () => bindDefaultEmo(),
      onUploaded: async (ref) => {
        await loadMeta();
        const list = refOptions();
        if (list.some((x) => x.id === ref.id)) return list;
        return list.concat([{ ...ref, group: "我的音色", editable: true, uses: ["emo"] }]);
      },
    });
    dEmoVec = EmoCtl.vector($("dEmoVecHost"), { value: d.emo_vec || [], onChange: bindDefaultEmo });
  }
  return { audio: dEmoAudio, vec: dEmoVec };
}

function bindDefaultEmo() {
  if (!SCRIPT) return;
  const want = {};
  if (dEmoAudio) {
    const r = dEmoAudio.get();
    if (r) want.emo_ref = r;
  }
  if (dEmoVec) {
    const v = dEmoVec.get();
    if (v.some((x) => x > 0)) want.emo_vec = v.slice();
  }
  const cur = SCRIPT.defaults || {};
  const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
  if (same(want.emo_ref, cur.emo_ref) && same(want.emo_vec, cur.emo_vec)) return;
  guardDefaultChange("默认情感（音频 / 向量）", () => {
    SCRIPT.defaults = SCRIPT.defaults || {};
    if (want.emo_ref) SCRIPT.defaults.emo_ref = want.emo_ref;
    else delete SCRIPT.defaults.emo_ref;
    if (want.emo_vec) SCRIPT.defaults.emo_vec = want.emo_vec;
    else delete SCRIPT.defaults.emo_vec;
  }, () => syncDefaultPanel());
}

function syncDefaultPanel() {
  if (!SCRIPT) return;
  const d = SCRIPT.defaults || {};
  const em = ensureDefaultEmo();
  if (em) {
    em.audio.refreshRefs(refOptions());
    em.audio.set(d.emo_ref || "");
    em.vec.set(d.emo_vec || []);
  }
  $("dRef").value = d.ref || "";
  $("dEmoMode").value = String(d.emo_mode ?? 0);
  $("dWeight").value = d.emo_weight ?? 0.65;
  $("dWeightOut").textContent = Number($("dWeight").value).toFixed(2);
  $("dPause").value = d.pause ?? 200;
  $("dSeg").value = d.seg_tokens ?? 120;
  const s = SCRIPT.sampling || {};
  $("sTemp").value = s.temperature ?? 0.8; $("sTempOut").textContent = Number($("sTemp").value).toFixed(2);
  $("sTopP").value = s.top_p ?? 0.8; $("sTopPOut").textContent = Number($("sTopP").value).toFixed(2);
  $("sTopK").value = s.top_k ?? 30;
  $("sBeams").value = s.num_beams ?? 3;
  $("sRep").value = s.repetition_penalty ?? 10;
  $("sMaxMel").value = s.max_mel_tokens ?? 1500;
}

function initDefaultPanel() {
  /* 每一项都单独走一遍「确认 → 应用」：控件先回读旧值，确认后才写进 SCRIPT.defaults，
     取消/关弹窗都不会留下改了一半的状态。 */
  const guardField = (id, key, label, parse, liveLabel) => {
    const node = $(id);
    if (!node) { if (liveLabel) liveLabel(); return; }
    if (liveLabel) node.oninput = () => liveLabel();
    node.onchange = () => {
      if (!SCRIPT) return;
      if (liveLabel) liveLabel();
      const v = parse(node.value);
      const cur = (SCRIPT.defaults || {})[key];
      if (v === cur) return;
      guardDefaultChange(label, () => {
        SCRIPT.defaults = SCRIPT.defaults || {};
        SCRIPT.defaults[key] = v;
      }, () => syncDefaultPanel());
    };
  };
  guardField("dRef", "ref", "默认音色", (v) => v || "");
  guardField("dEmoMode", "emo_mode", "默认情感模式", (v) => parseInt(v, 10) || 0);
  guardField("dWeight", "emo_weight", "默认情感权重", (v) => +v,
    () => { $("dWeightOut").textContent = Number($("dWeight").value).toFixed(2); });
  guardField("dPause", "pause", "默认停顿",
    (v) => Math.max(0, Math.min(30000, parseInt(v, 10) || 0)));
  guardField("dSeg", "seg_tokens", "默认分段长度",
    (v) => Math.max(20, Math.min(600, parseInt(v, 10) || 120)));
  const bindS = () => {
    if (!SCRIPT) return;
    SCRIPT.sampling = SCRIPT.sampling || {};
    SCRIPT.sampling.temperature = +$("sTemp").value;
    SCRIPT.sampling.top_p = +$("sTopP").value;
    SCRIPT.sampling.top_k = parseInt($("sTopK").value, 10) || 30;
    SCRIPT.sampling.num_beams = parseInt($("sBeams").value, 10) || 3;
    SCRIPT.sampling.repetition_penalty = +$("sRep").value || 10;
    SCRIPT.sampling.max_mel_tokens = parseInt($("sMaxMel").value, 10) || 1500;
    dirty = true; queueSave();
  };
  $("sTemp").oninput = () => { $("sTempOut").textContent = Number($("sTemp").value).toFixed(2); bindS(); };
  $("sTopP").oninput = () => { $("sTopPOut").textContent = Number($("sTopP").value).toFixed(2); bindS(); };
  ["sTopK", "sBeams", "sRep", "sMaxMel"].forEach((id) => ($(id).onchange = bindS));
  $("btnSaveDefault").onclick = async () => { await saveNow(); toast("全局默认参数已保存"); };
}

/* ------------------------------ 分句工具 ------------------------------ */
function splitLongJS(frag, maxChars) {
  if (frag.length <= maxChars) return [frag];
  const out = [];
  let rest = frag;
  const floor = Math.max(6, Math.floor(maxChars * 0.5));
  while (rest.length > maxChars) {
    let cut = 0;
    for (let i = maxChars - 1; i >= floor; i--) {
      if (SOFT_PUNCT.includes(rest[i])) { cut = i + 1; break; }
    }
    if (!cut) cut = maxChars;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest);
  if (out.length >= 2 && out[out.length - 1].length <= 4) out[out.length - 2] += out.pop();
  return out;
}

function splitTextJS(text, maxChars, mode) {
  const frags = [];
  let buf = "";
  for (const ch of (text || "")) {
    if (ch === "—" && buf.trim()) {
      buf += ch;
      frags.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
    if (SENT_END.includes(ch)) { frags.push(buf); buf = ""; }
  }
  if (buf.trim()) frags.push(buf);
  if (mode === "sentence") {
    const out = [];
    frags.forEach((f) => splitLongJS(f, maxChars).forEach((p) => { if (p.trim()) out.push(p.trim()); }));
    return out;
  }
  const out = [];
  let cur = "";
  frags.forEach((f) => {
    splitLongJS(f, maxChars).forEach((piece) => {
      if (!cur) cur = piece;
      else if ((cur + piece).length <= maxChars) cur += piece;
      else { out.push(cur); cur = piece; }
    });
  });
  if (cur.trim()) out.push(cur);
  return out;
}

/* ------------------------------ 渲染 ------------------------------ */
function initRenderPanel() {
  applyProgStyle(PROG_STYLE);
  const seg = $("progSeg");
  if (seg) {
    seg.querySelectorAll("button").forEach((b) => {
      b.onclick = () => { applyProgStyle(b.dataset.ps); };
    });
  }
  document.querySelectorAll('input[name="rMode"]').forEach((r) => {
    r.onchange = () => {
      $("rBatchBox").hidden = document.querySelector('input[name="rMode"]:checked').value !== "batches";
      paintRender();
    };
  });
  $("btnRender").onclick = () => {
    const mode = document.querySelector('input[name="rMode"]:checked').value;
    if (mode === "sel" && !SEL.size) { toast("先在左侧选中要生成的行", true); return; }
    if (mode === "batches") {
      const ids = selectedBatchIds();
      if (!ids.length) { toast("先勾选要跑的组", true); return; }
      startRender("batches", null, ids);
      return;
    }
    /* 「选中行」必须把 uid 列表一起送过去：这里以前传的是 mode="sel"、
       startRender 里的 body 只保留 mode、uids 被丢掉，服务端不认识 "sel"
       就落到「全部行」分支 —— 选 2 句却整篇 5 句都在跑，就是这么来的。 */
    if (mode === "sel") { startRender("uids", [...SEL]); return; }
    startRender(mode, null);
  };
  $("btnStop").onclick = async () => {
    try {
      const r = await api(`/scripts/${SCRIPT.id}/render/stop`, { method: "POST" });
      RENDER = r.render; paintRender();
      logLine("已请求停止，当前行结束后停下");
    } catch (e) { toast(e.message, true); }
  };
}

async function startRender(mode, uids, batches) {
  if (!SCRIPT) return;
  const sid = SCRIPT.id;              // 记住是给哪份台本点的
  if (dirty) await saveNow();
  if (!SCRIPT || SCRIPT.id !== sid) return;   // 等保存的这段时间切了台本，别再发
  try {
    let body;
    /* "sel" 也走 uids 协议（老调用点 / 外部脚本可能还传 sel）：
       绝不能让「选中行」在没有 uid 列表的情况下发出去，服务端会当成全部行。 */
    if (mode === "uids" || mode === "sel") {
      const list = (uids || []).filter(Boolean);
      if (!list.length) { toast("先在左侧选中要生成的行", true); return; }
      body = { mode: "uids", uids: list };
    } else if (mode === "batches") body = { mode: "batches", batches };
    else body = { mode };
    const r = await api(`/scripts/${sid}/render`, { method: "POST", body: JSON.stringify(body) });
    // 请求还没回来就切走了：状态属于上一份台本，别写进新台本的界面
    if (!SCRIPT || SCRIPT.id !== sid) return;
    RENDER = r.render;
    paintRender(); startPolling();
    toast(`开始生成 ${RENDER.total} 句`);
    logLine(`开始生成：共 ${RENDER.total} 句`);
    switchPane("render");
  } catch (e) { toast("启动失败：" + e.message, true); }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollRender, 1200);
  pollRender();
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  $("btnStop").disabled = true;
}

async function pollRender() {
  if (!SCRIPT) return;
  const sid = SCRIPT.id;
  try {
    const r = await api(`/scripts/${sid}/render`);
    /* 请求发出去到回来之间可能已经切了台本：这份状态属于上一个台本，
       写进去会让新台本显示「正在生成 xx%」、甚至提前把轮询停掉。 */
    if (!SCRIPT || SCRIPT.id !== sid) return;
    RENDER = r.render; STATS = r.stats;
    if (r.model) MODEL = r.model;
    if (r.statuses) {
      SCRIPT.lines.forEach((l) => {
        const s = r.statuses[l.uid];
        if (!s) return;
        // 自己刚改过、还没保存的行保持 stale，别被服务端旧状态冲掉
        if (l.status === "stale" && dirty) return;
        l.status = s.status;
        if (s.dur != null) l.dur = s.dur;
        l.err = s.err;
      });
    }
    patchBadges();
    paintRender();
    renderStats();
    if (RENDER && RENDER.cur_uid && $("rAutoScroll").checked) {
      const row = document.querySelector(`[data-uid="${RENDER.cur_uid}"]`);
      if (row) row.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    if (!RENDER || ["done", "stopped", "error"].includes(RENDER.state)) {
      stopPolling();
      if (RENDER) {
        const msg = RENDER.state === "done" ? "全部生成完成"
          : RENDER.state === "stopped" ? "已停止"
            : ("出错中止：" + (RENDER.message || ""));
        logLine(msg);
        toast(msg, RENDER.state === "error");
        dirty = true;
        await saveNow();
        // 关键：重跑完要跟服务端对一次账。之前只更新 status，行上的
        // 「改了什么 / 撤回」仍是旧的，于是一行明明生成好了还挂着「需重生成」。
        await syncScriptMeta();
        renderCenter();
        renderStats();
      }
    }
  } catch (e) {
    stopPolling();
  }
}

/* 重新拉一次台本，把服务端算好的 changes / gen / status 全量对齐 */
async function syncScriptMeta() {
  if (!SCRIPT) return;
  try {
    const r = await api(`/scripts/${SCRIPT.id}`);
    if (!r.script || r.script.id !== SCRIPT.id) return;
    const byUid = new Map(r.script.lines.map((l) => [l.uid, l]));
    SCRIPT.lines.forEach((l) => {
      const s = byUid.get(l.uid);
      if (!s) return;
      if (s.status) l.status = s.status;
      l.out = s.out; l.dur = s.dur; l.elapsed = s.elapsed; l.err = s.err;
      l.sig = s.sig; l.gen = s.gen;
      l.changes = s.changes || [];
      l.can_revert = !!s.can_revert;
    });
    STATS = r.stats;
    RENDER = r.render || RENDER;
    refreshHistoryRuntime();
    patchBadges();
    patchLineMeta();
    renderStats();
  } catch (e) { /* 忽略：下次保存还会对齐 */ }
}

/* 历史快照里的「运行态」要跟着刷新：
   否则重生成之后再删除、撤销，恢复的是「生成之前」的旧指纹，
   服务端一看指纹对不上，就会把明明有音频的行标成「需重生成」。
   只同步 out/dur/sig/gen/status（音频属于这一行，不属于某个文本版本），
   文本内容照旧按快照恢复。 */
function refreshHistoryRuntime() {
  if (!SCRIPT) return;
  const by = new Map(SCRIPT.lines.map((l) => [l.uid, l]));
  [UNDO, REDO].forEach((stack) => (stack || []).forEach((snap) => {
    (snap.lines || []).forEach((l) => {
      const cur = by.get(l.uid);
      if (!cur) return;
      l.out = cur.out;
      l.dur = cur.dur;
      l.sig = cur.sig;
      l.elapsed = cur.elapsed;
      l.gen = cur.gen;
      l.err = cur.err;
      l.status = cur.status;
    });
  }));
}

function patchBadges() {
  SCRIPT.lines.forEach((l) => {
    const st = statusInfo(l);
    document.querySelectorAll(`.stbadge[data-badge="${l.uid}"]`).forEach((b) => {
      b.className = "stbadge " + st.cls;
      b.textContent = st.txt;
      if (l.err) b.title = l.err;
      const row = b.closest(".row, .bcard");
      if (row) row.classList.toggle("running", !!(RENDER && RENDER.cur_uid === l.uid));
    });
  });
}

function paintRender() {
  const badge = $("rState");
  const modeEl = document.querySelector('input[name="rMode"]:checked');
  const isBatchMode = modeEl && modeEl.value === "batches";
  $("rBatchBox").hidden = !isBatchMode;
  paintModelState();

  if (!RENDER) {
    badge.textContent = "空闲"; badge.className = "badge";
    $("btnRender").disabled = false; $("btnStop").disabled = true;
    $("rCount").textContent = "—";
    $("rBar").style.width = "0%"; $("rBarLine").style.width = "0%";
    $("rPct").textContent = "0%";
    $("rBarBox").classList.remove("indet");
    $("rText").textContent = ""; $("rTime").textContent = ""; $("rMsg").textContent = "";
    $("rSpeed").textContent = "";
    setStage("");
    if (isBatchMode) {
      const ids = selectedBatchIds();
      const n = ids.reduce((s, id) => {
        const b = (SCRIPT.batches || []).find((x) => x.id === id);
        return s + ((b && b.uids) || []).length;
      }, 0);
      $("rNow").textContent = `已选 ${ids.length} 个任务，涉及 ${n} 句（重叠只跑一次）`;
    } else {
      $("rNow").textContent = "还没开始。选好范围后点「开始生成」。";
    }
    return;
  }
  const running = RENDER.state === "running" || RENDER.state === "stopping";
  /* 空闲时把进度块收成「一行提示」：这块现在常驻面板顶部，
     一直摆着空进度条太占地方，但状态/提示要一直看得见。 */
  const pw = $("progWrap");
  if (pw) pw.classList.toggle("idle", !running && !RENDER.total);
  const map = { running: "生成中", stopping: "正在停止", done: "已完成", stopped: "已停止", error: "出错" };
  badge.textContent = map[RENDER.state] || RENDER.state;
  badge.className = "badge " + (RENDER.state === "error" ? "warn" : RENDER.state === "done" ? "ok" : "");
  $("btnRender").disabled = running;
  $("btnStop").disabled = !running || RENDER.state === "stopping";

  const total = RENDER.total || 0;
  const done = RENDER.done || 0;
  const lineProg = RENDER.line_progress || 0;
  const phase = (MODEL && MODEL.phase) || "unloaded";
  // 一句都还没跑完、模型又没就绪 → 现在其实在加载模型，进度条用「不确定」形态
  const loading = running && done === 0 && phase !== "ready" && phase !== "error";
  const smooth = total ? Math.min(100, ((done + (loading ? 0 : lineProg)) / total) * 100) : 0;

  $("rBarBox").classList.toggle("indet", loading);
  $("rBar").style.width = (loading ? 32 : smooth).toFixed(1) + "%";
  $("rBarLine").style.width = (loading ? 0 : lineProg * 100).toFixed(1) + "%";
  $("rPct").textContent = loading ? "加载中" : Math.round(RENDER.state === "done" ? 100 : smooth) + "%";
  $("rCount").textContent = `已完成 ${done} / ${total} 句` + (loading ? "（等模型加载）" : "");

  setStage(loading ? "model" : RENDER.state === "done" ? "done" : running ? "gen" : "");

  const elapsed = RENDER.elapsed || 0;
  if (running && done > 0 && elapsed > 1) {
    const per = elapsed / done;
    $("rSpeed").textContent = `≈${(60 / per).toFixed(1)} 句/分 · 每句 ${per.toFixed(1)}s`;
  } else if (!running) {
    $("rSpeed").textContent = done && elapsed ? `平均 ${(elapsed / done).toFixed(1)}s/句` : "";
  } else {
    $("rSpeed").textContent = "";
  }

  if (running && RENDER.cur_pos) {
    $("rNow").textContent = `正在生成：台本第 ${RENDER.cur_pos} 行（第 ${RENDER.cur_index} / ${total} 句）`;
    $("rText").textContent = RENDER.cur_text ? `“${RENDER.cur_text}…”` : "";
  } else if (running && loading) {
    $("rNow").textContent = "正在加载 TTS 模型（首次生成通常要 30~60 秒，之后会快很多）";
    $("rText").textContent = "";
  } else if (!running) {
    $("rNow").textContent = RENDER.message || "";
    $("rText").textContent = "";
  }
  const parts = [];
  if (RENDER.elapsed) parts.push("已用 " + fmtDur(RENDER.elapsed));
  if (RENDER.eta) parts.push("预计剩余 " + fmtDur(RENDER.eta));
  $("rTime").textContent = parts.join(" · ");
  $("rMsg").textContent = (RENDER.errors && RENDER.errors.length)
    ? `本次已失败 ${RENDER.errors.length} 次（看日志）` : "";
}

const MODEL_PHASE = {
  unloaded: ["模型未加载（生成时自动加载）", ""],
  loading: ["模型加载中…", "loading"],
  ready: ["模型已就绪", "ready"],
  error: ["模型加载失败", "error"],
  unloading: ["模型卸载中…", "loading"],
  reloading: ["模型重载中…", "loading"],
};

function paintModelState() {
  const ph = (MODEL && MODEL.phase) || "unloaded";
  const [txt, cls] = MODEL_PHASE[ph] || [ph, ""];
  const dot = $("rModelDot"), label = $("rModelPhase");
  if (dot) dot.className = "mdot " + cls;
  if (!label) return;
  const bits = [txt];
  if (ph === "ready" && MODEL.diffusion_steps) bits.push(`steps ${MODEL.diffusion_steps}`);
  if (ph === "ready" && MODEL.fp16) bits.push("fp16");
  label.textContent = bits.join(" · ");
  label.title = "模型状态由服务端实时回报；首次生成会先加载模型，这段时间进度条是「不确定」形态";
  // 顶部状态条（永远可见，不跟着页签切换）
  const td = $("tsTtsDot"), tv = $("tsTts");
  if (td) td.className = "tsdot " + cls;
  if (tv) {
    tv.textContent = txt.replace("（生成时自动加载）", "");
    tv.title = label.title;
  }
}

/* 顶部状态条：模型 / ffmpeg / 人声分离（demucs）一眼看到能不能用 */
async function refreshTopStatus(force) {
  try {
    const caps = await api("/media/capabilities");
    const ff = caps && caps.ffmpeg;
    const dm = (caps && caps.demucs) || {};
    const setDot = (id, on, warn) => {
      const d = $(id);
      if (d) d.className = "tsdot " + (on ? "ready" : (warn ? "error" : ""));
    };
    setDot("tsFfDot", !!ff, false);
    const ffe = $("tsFf");
    if (ffe) {
      ffe.textContent = ff ? "可用" : "未加载";
      ffe.title = ff ? (caps.ffmpeg_path || "已就绪") : "视频抽音频不可用；去「📥 素材导入台」里上传或指定";
    }
    const okDm = !!dm.available;
    setDot("tsSepDot", okDm, false);
    const se = $("tsSep");
    if (se) {
      se.textContent = okDm
        ? `Demucs（${dm.device || "cpu"}${dm.offline ? " · 离线权重" : " · 需联网" }）`
        : "只有 DSP 中置提取";
      se.title = okDm ? "高精度人声分离可用" : ("Demucs 不可用：" + (dm.reason || "vendor2 缺失"));
    }
    if (force) toast("已重新检测模型与依赖");
  } catch (e) {
    const ffe = $("tsFf");
    if (ffe) ffe.textContent = "检测失败";
  }
}

function setStage(which) {
  const order = ["model", "gen", "done"];
  const idx = order.indexOf(which);
  document.querySelectorAll("#rStages .stage").forEach((s) => {
    const i = order.indexOf(s.dataset.stage);
    s.classList.toggle("cur", s.dataset.stage === which);
    s.classList.toggle("done", idx >= 0 && i >= 0 && i < idx);
  });
}

function applyProgStyle(ps) {
  PROG_STYLE = ps || "bar";
  try { localStorage.setItem("lf.progStyle", PROG_STYLE); } catch (e) { /* 忽略 */ }
  const w = $("progWrap");
  if (w) {
    // 注意：不能直接写 className —— 会把 idle 之类的状态类一起清掉
    ["ps-bar", "ps-glow", "ps-seg", "ps-stripe"].forEach((c) => w.classList.remove(c));
    w.classList.add("ps-" + PROG_STYLE);
  }
  document.querySelectorAll("#progSeg button").forEach((b) => {
    b.classList.toggle("cur", b.dataset.ps === PROG_STYLE);
  });
}

function logLine(s) {
  const box = $("rLog");
  box.textContent += `[${new Date().toLocaleTimeString()}] ${s}\n`;
  box.scrollTop = box.scrollHeight;
}

/* ------------------------------ 导出 ------------------------------ */
function initExportPanel() {
  $("btnExport").onclick = doMergeExport;
  $("btnExportZipSel").onclick = () => doZipExport([...SEL]);
  $("btnExportZipAll").onclick = () => doZipExport(null);
  $("btnExportMd").onclick = () => doScriptExport("md");
  $("btnExportTxt").onclick = () => doScriptExport("txt");
  $("btnExRefresh").onclick = refreshExports;

  // 导出选项 → 实时重算体积预估
  syncExQuality();
  $("exFmt").onchange = () => { syncExQuality(); refreshExEstimate(); };
  [[("qFmt"), "fmt"], [("qQual"), "qual"], [("qRate"), "rate"],
   [("qCh"), "ch"], [("qRange"), "range"], [("qGap"), "gap"]].forEach(([id, key]) => {
    const b = $(id);
    if (b) b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); showExHelp(key); };
  });
  ["exQuality", "exCh", "exRate", "exFrom", "exTo", "exGap"].forEach((id) => {
    const n = $(id);
    if (n) { n.onchange = refreshExEstimate; n.oninput = refreshExEstimate; }
  });
  document.querySelectorAll('input[name="exScope"]').forEach((r) => {
    r.onchange = () => { refreshExEstimate(); refreshSelExportState(); };
  });
  $("exRangeAll").onclick = () => {
    $("exFrom").value = ""; $("exTo").value = ""; refreshExEstimate();
  };
  $("exRangeSel").onclick = () => {
    if (!SEL.size) { toast("先在列表里选中要导出的行", true); return; }
    const r = selTimeRange();
    if (!r) { toast("选中的行里还没有生成好的语音", true); return; }
    $("exFrom").value = r[0].toFixed(2);
    $("exTo").value = r[1].toFixed(2);
    refreshExEstimate();
  };
  refreshExports();
}

// 勾了「仅选中行」时才让时段按钮有效，避免误操作
function refreshSelExportState() {
  const sel = document.querySelector('input[name="exScope"]:checked');
  const on = sel && sel.value === "sel";
  $("exRangeSel").disabled = !on;
  $("exRangeSel").title = on ? "把时段填成选中行的首尾" : "先选「仅选中行」";
}

function exportUrl(sid, name) {
  return `/api/v1/lf/scripts/${sid}/export/${encodeURIComponent(name)}`;
}

function exportLine(line) {
  if (line.kind === "tag") { toast("标签行没有音频", true); return; }
  if (line.status !== "done" || !line.out) { toast("这一行还没有生成音频", true); return; }
  const idx = idxOf(line);
  const guess = `${String(idx).padStart(4, "0")}_${(line.text || "").slice(0, 12)}`;
  const wrap = el("div");
  const inp = document.createElement("input");
  inp.className = "inp"; inp.value = guess;
  wrap.appendChild(el("div", "fl", "文件名（扩展名按格式自动加）"));
  wrap.appendChild(inp);

  // 和「拼接导出」同一套选项：格式 / 位深或质量 / 采样率 / 声道
  const opts = exOptControls({
    format: $("exFmt") ? $("exFmt").value : "wav",
    sample_rate: 44100, channels: 2, duration: line.dur || 0,
  });
  wrap.appendChild(opts.node);

  modal("导出第 " + idx + " 句", wrap, async () => {
    const name = inp.value.trim() || guess;
    const o = opts.read();
    const qs = new URLSearchParams({
      download: "1", name,
      format: o.format, bit_depth: String(o.bit_depth), quality: o.quality,
      sample_rate: String(o.sample_rate), channels: String(o.channels),
    });
    download(`${API}/scripts/${SCRIPT.id}/audio/${line.uid}?${qs.toString()}`);
    toast(`已导出 ${o.format.toUpperCase()}：${name}.${o.format}`);
  }, "下载");
}

/* 单句 / 批量共用的导出选项控件（格式 / 音质 / 采样率 / 声道） */
const EX_RATES = [16000, 22050, 32000, 44100, 48000, 96000];

function exEstimateBytes(sec, fmt, bd, ch, sr, q) {
  sec = Math.max(0, Number(sec) || 0);
  const c = Number(ch) <= 1 ? 1 : 2;
  sr = Number(sr) || 44100;
  if (fmt === "wav") return Math.round(sec * sr * c * ((Number(bd) || 16) / 8)) + 44;
  if (fmt === "flac") return Math.round(sec * sr * c * 2 * (Number(bd) >= 24 ? 0.8 : 0.62)) + 8192;
  const kbps = (({ mp3: { high: 48, standard: 36, small: 30 }, ogg: { high: 32, standard: 28, small: 25 } }[fmt] || {})[q] || 36);
  return Math.round(sec * kbps * 1000 / 8 * Math.pow(Math.max(0.6, Math.min(1.6, sr / 44100)), 0.5)) + 4096;
}

function exOptControls(opt) {
  opt = opt || {};
  const wrap = el("div");
  const mk = (label) => { const d = el("div", "fl", label); wrap.appendChild(d); return d; };
  const row = (a, b) => { const r = el("div", "row2"); if (a) r.appendChild(a); if (b) r.appendChild(b); wrap.appendChild(r); return r; };

  const fmt = document.createElement("select");
  fmt.className = "sel";
  fmt.innerHTML = [["wav", "WAV — 无损，最通用（推荐）"], ["flac", "FLAC — 无损压缩"],
    ["mp3", "MP3 — 体积小"], ["ogg", "OGG — 体积小"]]
    .map(([v, t]) => `<option value="${v}">${t}</option>`).join("");
  fmt.value = opt.format || "wav";
  mk("格式"); row(fmt);

  const qual = document.createElement("select");
  qual.className = "sel";
  const fillQual = () => {
    const keep = qual.value;
    qual.innerHTML = (EX_QUALITY[fmt.value] || EX_QUALITY.wav)
      .map(([v, t]) => `<option value="${v}">${t}</option>`).join("");
    if ([...qual.options].some((o) => o.value === keep)) qual.value = keep;
  };
  fillQual();
  mk("音质 / 位深"); row(qual);

  const rate = document.createElement("select");
  rate.className = "sel";
  rate.innerHTML = EX_RATES.map((v) => `<option value="${v}">${v} Hz</option>`).join("");
  rate.value = String(opt.sample_rate || 44100);
  const ch = document.createElement("select");
  ch.className = "sel";
  ch.innerHTML = '<option value="1">单声道</option><option value="2">立体声</option>';
  ch.value = String(opt.channels || 2);
  mk("采样率 / 声道"); row(rate, ch);

  const info = el("div", "hint");
  wrap.appendChild(info);
  const refresh = () => {
    if (opt.duration) {
      info.textContent = `这一句 ${Number(opt.duration).toFixed(1)}s，预计 ${fmtBytes(
        exEstimateBytes(opt.duration, fmt.value, qual.value, ch.value, rate.value, qual.value))}`;
    }
  };
  fmt.onchange = () => { fillQual(); refresh(); };
  [qual, rate, ch].forEach((n) => (n.onchange = refresh));
  refresh();

  return {
    node: wrap,
    read() {
      const isBit = fmt.value === "wav" || fmt.value === "flac";
      return {
        format: fmt.value,
        bit_depth: isBit ? parseInt(qual.value, 10) : 16,
        quality: isBit ? "standard" : qual.value,
        sample_rate: parseInt(rate.value, 10),
        channels: parseInt(ch.value, 10),
      };
    },
  };
}

// ---- 导出面板：格式 / 音质 / 时段 / 体积预估 --------------------------------
// 本机没有 ffmpeg，压缩格式走 libsndfile 内置编码器，所以 MP3/OGG 的「质量档」
// 对应编码器 compression_level，括号里的码率是实测值，仅供体积参考。
const EX_QUALITY = {
  wav: [["16", "16 bit（默认，通用）"], ["24", "24 bit（更高动态）"], ["32", "32 bit 浮点（后期用）"]],
  flac: [["16", "16 bit"], ["24", "24 bit"]],
  mp3: [["high", "高质量 ≈48kbps"], ["standard", "标准 ≈36kbps"], ["small", "精简 ≈30kbps"]],
  ogg: [["high", "高质量 ≈32kbps"], ["standard", "标准 ≈28kbps"], ["small", "精简 ≈25kbps"]],
};

function syncExQuality() {
  const fmt = $("exFmt").value;
  const sel = $("exQuality");
  const keep = sel.value;
  sel.innerHTML = "";
  (EX_QUALITY[fmt] || EX_QUALITY.wav).forEach(([v, label]) => {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    sel.appendChild(o);
  });
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

function readExOpts() {
  const fmt = $("exFmt").value;
  const q = $("exQuality").value || "16";
  const isBit = fmt === "wav" || fmt === "flac";
  const scope = document.querySelector('input[name="exScope"]:checked').value;
  if (scope === "sel" && !SEL.size) throw new Error("先在列表里选中要导出的行");
  const gap = $("exGap").value.trim();
  const num = (id) => {
    const v = $(id).value.trim();
    if (v === "") return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  };
  const from = num("exFrom"), to = num("exTo");
  if (from != null && to != null && to <= from) throw new Error("结束时间要大于开始时间");
  const body = {
    gap: gap === "" ? "" : parseInt(gap, 10),
    format: fmt,
    bit_depth: isBit ? parseInt(q, 10) : 16,
    quality: isBit ? "standard" : q,
    channels: parseInt($("exCh").value, 10) || 2,
    sample_rate: parseInt($("exRate").value, 10) || 44100,
    range_start: from,
    range_end: to,
  };
  if (scope === "sel") body.uids = [...SEL];
  return body;
}

// 每个导出选项的「?」说明：功能 + 对声音的实际影响
const EX_HELP = {
  fmt: {
    t: "格式：选什么容器",
    p: [
      "<b>WAV</b> — 无损、未压缩，所有软件/平台都认。体积最大（44.1k 16bit 单声道约 5MB/分钟）。",
      "<b>FLAC</b> — 无损压缩，音质与 WAV 完全一致，体积约小 35~40%。适合存档、投稿。",
      "<b>MP3 / OGG</b> — 有损压缩，体积小很多。本机没有 ffmpeg/lame，用的是内置编码器，码率上限较低（MP3≈48kbps、OGG≈31kbps），人声能听懂但高频会发闷；<b>需要交付音质请选 WAV/FLAC</b>。",
      "换格式不会改变时间轴、停顿、音色，只是压缩方式不同。",
    ],
  },
  qual: {
    t: "音质 / 位深：动态范围与噪声底",
    p: [
      "<b>16 bit</b> — CD 标准，噪声底约 -96dB，人声足够。体积基准。",
      "<b>24 bit</b> — 噪声底约 -144dB，给后期留余量（多轨叠加、压缩、EQ 之后不易露底噪）。体积比 16bit 大 50%。",
      "<b>32 bit 浮点</b> — 不会削波，适合继续在 DAW 里做处理；体积是 16bit 的 2 倍。",
      "MP3/OGG 没有位深概念，这里对应编码器的质量档：档位越高，保留的细节越多、体积越大。",
    ],
  },
  rate: {
    t: "采样率：每秒采多少个点",
    p: [
      "决定能记录的最高频率（上限 ≈ 采样率的一半）。<b>22050Hz</b> 能到 11kHz，人声齿音刚好在边缘；<b>44100Hz</b> 能到 22kHz，覆盖全部人耳范围。",
      "<b>22050 Hz</b> — 与 TTS 模型原始输出一致，<b>不重采样、体积最小</b>，做语音/训练集最划算。",
      "<b>44100 Hz</b> — CD 与绝大多数播放器的标准，通用推荐。",
      "<b>48000 Hz</b> — 视频工程（PR / 达芬奇 / 剪辑）的标准，混进视频时间线不会二次重采样。",
      "<b>16000 Hz</b> — 语音识别、AI 训练常用；高频会被切掉，人声略闷。",
      "<b>96000 Hz</b> — 母版级，体积巨大，对 TTS 音源没有实际提升。",
      "从高到低是<b>降采样</b>（会滤掉高频，信息不可逆）；从低到高是补点，不会增加细节。",
    ],
  },
  ch: {
    t: "声道：单声道 / 立体声",
    p: [
      "<b>单声道</b> — 一条波形，体积减半。TTS 生成的是单声道，这个选项不损失信息，语音类交付推荐。",
      "<b>立体声</b> — 左右两路：拼接导出会把同一条波形复制到双声道（体积翻倍）；时间轴混音则会保留每个片段的声像（左右位置）。",
      "如果后面要做立体声效果（背景乐、音效摆位），选立体声；纯人声交付选单声道更省空间。",
    ],
  },
  range: {
    t: "导出时段：只导其中一段",
    p: [
      "填「开始/结束」秒数就只渲染这一段，用于抽检、试听、交片段；留空 = 整条。",
      "时间以拼接后的成品时间轴为准（第 1 句从 0 秒开始）。",
      "导出的 .srt 字幕时间会以所选时段的起点为 0 重新计算，方便单独配这一段。",
      "「选中行范围」会按选中行的首尾自动填好起止秒。",
    ],
  },
  gap: {
    t: "统一停顿覆盖：句子之间留多长空白",
    p: [
      "留空 = 用每行自己的停顿值（台本里逐行设的 ms）。",
      "填数字 = 所有行之间强制用这个停顿（毫秒），方便整体加速/放慢节奏。",
      "标签行（句间/句中标签）的留白只服从它自己的 hold，不受这里影响。",
      "停顿变长 → 成品变长、文件变大；变短 → 更紧凑。",
    ],
  },
};

function showExHelp(key) {
  const h = EX_HELP[key];
  if (!h) return;
  const wrap = el("div", "exhelp");
  h.p.forEach((t) => {
    const p = document.createElement("p");
    p.innerHTML = t;
    wrap.appendChild(p);
  });
  modal(h.t, wrap, async () => true, "知道了");
}

let exEstTimer = null;
function refreshExEstimate() {
  clearTimeout(exEstTimer);
  exEstTimer = setTimeout(async () => {
    if (!SCRIPT) return;
    let body;
    try { body = readExOpts(); } catch (e) { $("exEst").textContent = "⚠ " + e.message; return; }
    $("exEst").textContent = "正在估算…";
    try {
      const r = await api(`/scripts/${SCRIPT.id}/export/estimate`, { method: "POST", body });
      const clipped = Math.abs(r.span_duration - r.total_duration) > 0.05;
      $("exEst").innerHTML =
        `预计：内容总长 <b>${fmtDur(r.total_duration)}</b>` +
        (clipped ? `，本次导出 <b>${fmtDur(r.span_duration)}</b>` : "") +
        `，${r.lines} 句，${(r.sample_rate || 44100) / 1000}kHz` +
        `${(parseInt($("exCh").value, 10) || 2) === 1 ? " 单声道" : " 立体声"}` +
        `，文件约 <b>${fmtBytes(r.est_bytes)}</b>` +
        (r.missing_count ? `　<span style="color:var(--warn)">${r.missing_count} 行未生成，不会包含</span>` : "");
    } catch (e) {
      $("exEst").textContent = "估算失败：" + e.message;
    }
  }, 260);
}

function selTimeRange() {
  // 用选中行的 dur / pause 粗算首尾（与后端同一套累加规则，误差 < 1 句）
  let cur = 0, first = null, last = null;
  const defPause = Number((SCRIPT.defaults || {}).pause || 0);
  for (const l of SCRIPT.lines || []) {
    if (l.kind === "tag") { cur += Number(l.hold || 0) / 1000; continue; }
    if (!(l.text || "").trim()) continue;
    if (!l.out) continue;
    const d = Number(l.dur || 0);
    if (SEL.has(l.uid)) {
      if (first == null) first = cur;
      last = cur + d;
    }
    const p = l.pause != null ? Number(l.pause) : defPause;
    cur += d + p / 1000;
  }
  return first == null ? null : [first, last];
}

async function doMergeExport() {
  if (!SCRIPT) return;
  if (dirty) await saveNow();
  let body;
  try { body = readExOpts(); } catch (e) { toast(e.message, true); return; }
  $("btnExport").disabled = true;
  $("exResult").textContent = "正在拼接…";
  try {
    const r = await api(`/scripts/${SCRIPT.id}/export`, { method: "POST", body });
    $("exResult").innerHTML = "";
    const line = el("div");
    line.innerHTML = `已导出 <b>${r.written}</b> 句，时长 <b>${fmtDur(r.duration)}</b>` +
      `，文件 <b>${fmtBytes(r.size || 0)}</b>（${(r.fmt || "wav").toUpperCase()}` +
      (r.kbps ? ` ${r.kbps}kbps` : "") + `）` +
      (r.missing_count ? `，<span style="color:var(--danger)">${r.missing_count} 行未包含</span>` : "");
    $("exResult").appendChild(line);
    const box = el("div", "exp");
    box.appendChild(el("div", "n", r.file || r.wav));
    const rr = el("div", "r");
    [["音频", r.file || r.wav], ["SRT", r.srt], ["时间轴", r.timeline]].forEach(([label, name]) => {
      if (!name) return;
      const a = el("a", null, "下载 " + label);
      a.href = exportUrl(SCRIPT.id, name);
      a.download = name;
      rr.appendChild(a);
    });
    box.appendChild(rr);
    $("exResult").appendChild(box);
    refreshExEstimate();
    refreshExports();
  } catch (e) {
    $("exResult").textContent = "导出失败：" + e.message;
  } finally {
    $("btnExport").disabled = false;
  }
}

async function doZipExport(uids) {
  if (!SCRIPT) return;
  if (uids && !uids.length) { toast("先选中要导出的行", true); return; }
  if (dirty) await saveNow();
  const naming = $("exNaming").value;
  const prefix = $("exPrefix").value.trim();
  // 单句批量导出沿用上面的格式设置
  const fmt = $("exFmt").value;
  const isBit = fmt === "wav" || fmt === "flac";
  const opt = {
    format: fmt,
    bit_depth: isBit ? parseInt($("exQuality").value, 10) || 16 : 16,
    quality: isBit ? "standard" : ($("exQuality").value || "standard"),
    sample_rate: parseInt($("exRate").value, 10) || 44100,
    channels: parseInt($("exCh").value, 10) || 2,
  };
  $("exZipResult").textContent = `正在打包（${fmt.toUpperCase()}）…`;
  try {
    const r = await api(`/scripts/${SCRIPT.id}/export/lines`, {
      method: "POST",
      body: JSON.stringify({ uids: uids || null, naming, prefix, ...opt }),
    });
    $("exZipResult").innerHTML = "";
    $("exZipResult").appendChild(el("div", null,
      `已打包 ${r.count} 个 ${(r.format || fmt).toUpperCase()} 文件` +
      (r.skipped ? `，跳过 ${r.skipped} 行（未生成）` : "")));
    const box = el("div", "exp");
    box.appendChild(el("div", "n", r.zip));
    const rr = el("div", "r");
    const a = el("a", null, "下载 ZIP");
    a.href = exportUrl(SCRIPT.id, r.zip);
    a.download = r.zip;
    rr.appendChild(a);
    box.appendChild(rr);
    $("exZipResult").appendChild(box);
    refreshExports();
  } catch (e) {
    $("exZipResult").textContent = "打包失败：" + e.message;
  }
}

async function doScriptExport(fmt) {
  if (!SCRIPT) return;
  if (dirty) await saveNow();
  $("exMdResult").textContent = "正在生成…";
  try {
    const r = await api(`/scripts/${SCRIPT.id}/export/script`, {
      method: "POST",
      body: JSON.stringify({
        format: fmt,
        timestamps: $("txTs").checked,
        meta: $("txMeta").checked,
        tags: $("txTags").checked,
      }),
    });
    $("exMdResult").innerHTML = "";
    $("exMdResult").appendChild(el("div", null, `已生成，时长 ${fmtDur(r.duration)}`));
    const box = el("div", "exp");
    box.appendChild(el("div", "n", r.file));
    const rr = el("div", "r");
    const a = el("a", null, "下载 " + (fmt === "md" ? "Markdown" : "纯文本"));
    a.href = exportUrl(SCRIPT.id, r.file);
    a.download = r.file;
    rr.appendChild(a);
    box.appendChild(rr);
    $("exMdResult").appendChild(box);
    refreshExports();
  } catch (e) {
    $("exMdResult").textContent = "生成失败：" + e.message;
  }
}

async function refreshExports() {
  if (!SCRIPT) return;
  try {
    const r = await api(`/scripts/${SCRIPT.id}/export`);
    const box = $("exList");
    box.innerHTML = "";
    if (!r.files.length) { box.appendChild(el("div", "hint", "还没有导出过")); return; }
    r.files.slice(0, 40).forEach((f) => {
      const d = el("div", "exp");
      d.appendChild(el("div", "n", `${f.name} · ${fmtBytes(f.size)}`));
      const rr = el("div", "r");
      const a = el("a", null, "下载");
      a.href = exportUrl(SCRIPT.id, f.name);
      a.download = f.name;
      rr.appendChild(a);
      d.appendChild(rr);
      box.appendChild(d);
    });
  } catch (e) { /* 忽略 */ }
}

/* ------------------------------ 音色 / 预设 ------------------------------ */
function initRefsPanel() {
  const fi = $("fileRefs");
  if (fi) {
    fi.onchange = async () => {
      const files = Array.from(fi.files || []);
      fi.value = "";
      if (files.length) await uploadRefFiles(files);
    };
  }
  const go = $("btnGoMedia");
  if (go) go.onclick = () => openDrawer("media", "ref");
  const rf = $("btnRefRefresh");
  if (rf) rf.onclick = async () => { await loadMeta(); renderRefList(); toast("音色列表已刷新"); };
  const seg = $("refViewSeg");
  if (seg) {
    seg.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("cur", b.dataset.rv === REFV.view);
      b.onclick = () => {
        REFV.view = b.dataset.rv;
        try { localStorage.setItem("lf.refView", REFV.view); } catch (e) { /* 忽略 */ }
        renderRefList();
      };
    });
  }
  const sq = $("refSearch");
  if (sq) sq.oninput = () => { REFV.q = sq.value; renderRefList(); };
  $("btnSavePreset").onclick = savePreset;
  const ps = $("presetSearch");
  if (ps) ps.oninput = () => { PRESET_Q = ps.value; renderPresets(); };
  const pr = $("btnPresetRefresh");
  if (pr) pr.onclick = () => { loadPresets(); toast("预设列表已刷新"); };
  loadPresets();
}

async function uploadRefFiles(files) {
  let okCount = 0;
  for (const f of files) {
    const fd = new FormData();
    fd.append("file", f);
    fd.append("name", f.name.replace(/\.[^.]+$/, ""));
    try {
      const r = await api("/refs", { method: "POST", body: fd });
      okCount++;
      if (r && r.long) {
        toast(`「${f.name}」有点长（${r.ref.dur}s）：音色只用前 5–15 秒最稳，可以在素材库裁一段`, true);
      }
    } catch (e) { toast(`「${f.name}」上传失败：${e.message}`, true); }
  }
  if (okCount) {
    await loadMeta();
    renderRefList();
    renderCenter();
    toast(`已导入 ${okCount} 个音色`);
  }
}

function refVisible(r) {
  const q = (REFV.q || "").trim().toLowerCase();
  if (!q) return true;
  return ((r.name || "") + " " + (r.group || "") + " " + (r.id || "")).toLowerCase().includes(q);
}

function refPlayBtn(r) {
  const play = el("button", "iconbtn refplay", playingRefId === r.id ? "⏸" : "▶");
  play.dataset.rid = r.id;
  play.title = "试听 / 暂停";
  play.onclick = (e) => { e.stopPropagation(); toggleRefPlay(r, play); };
  return play;
}

function refActions(r, compact) {
  const acts = el("div", compact ? "rt-act" : "racts");
  acts.appendChild(refPlayBtn(r));
  if (r.editable) {
    const use = el("button", "iconbtn", "✓");
    use.title = "设为全局默认音色（之后新建的行都用它）";
    use.onclick = (e) => { e.stopPropagation(); setDefaultRef(r); };
    acts.appendChild(use);
    const ren = el("button", "iconbtn", "✎");
    ren.title = "重命名";
    ren.onclick = (e) => { e.stopPropagation(); renameRef(r, ...xyOf(e)); };
    acts.appendChild(ren);
    const del = el("button", "iconbtn", "✕");
    del.title = "从音色库删除（不影响已生成音频）";
    del.onclick = (e) => { e.stopPropagation(); deleteRef(r); };
    acts.appendChild(del);
  }
  return acts;
}

function renderRefList() {
  const box = $("refList");
  if (!box) return;
  box.className = "reflist liblist mode-" + REFV.view;
  box.innerHTML = "";
  if ($("refSearch") && $("refSearch").value !== REFV.q) $("refSearch").value = REFV.q;
  const all = refOptions();
  const refs = all.filter(refVisible);
  const mine = all.filter((r) => r.editable);
  const dflt = (SCRIPT && SCRIPT.defaults && SCRIPT.defaults.ref) || "";
  if ($("refCount")) {
    $("refCount").textContent = refs.length === all.length ? `${all.length} 个` : `${refs.length} / ${all.length} 个`;
  }
  $("refHint").textContent = mine.length
    ? `我的音色 ${mine.length} 个 · 点名字改名 · ✓ 设为默认 · ▶ 试听 · 右键更多`
    : "还没有音色。可以上传音频，或去「素材导入台」把视频/歌曲处理成人声再存入音色库。";
  if (!refs.length) {
    box.appendChild(el("div", "hint", all.length ? "没有匹配的音色（换个关键词）" : "音色库是空的"));
    return;
  }
  const groups = {};
  refs.forEach((r) => (groups[r.group || "其它"] = groups[r.group || "其它"] || []).push(r));
  Object.keys(groups).forEach((g) => {
    box.appendChild(el("div", "side-head", g));
    groups[g].forEach((r) => {
      const isDefault = dflt && r.id === dflt;
      if (REFV.view === "list") {
        const item = el("div", "refitem" + (isDefault ? " cur" : ""));
        const name = el("span", "refname", r.name);
        name.title = r.editable ? "点击重命名（右键更多）" : "内置音色";
        if (r.editable) name.onclick = (e) => renameRef(r, ...xyOf(e));
        item.appendChild(name);
        if (isDefault) item.appendChild(el("span", "rt-def", "默认"));
        if ((r.uses || []).includes("emo")) item.appendChild(el("span", "rt-def emo", "情感"));
        item.appendChild(el("span", "hint", r.dur ? `${r.dur}s` : ""));
        if (r.editable) {
          const use = el("button", "iconbtn", "✓");
          use.title = "设为全局默认音色";
          use.onclick = () => setDefaultRef(r);
          item.appendChild(use);
        }
        item.appendChild(refPlayBtn(r));
        if (r.editable) {
          const ren = el("button", "iconbtn", "✎");
          ren.title = "重命名";
          ren.onclick = () => renameRef(r);
          const del = el("button", "iconbtn", "✕");
          del.title = "从音色库删除（不影响已生成音频）";
          del.onclick = () => deleteRef(r);
          item.appendChild(ren); item.appendChild(del);
        }
        item.oncontextmenu = (e) => { e.preventDefault(); openRefCtx(r, e.clientX, e.clientY); };
        box.appendChild(item);
      } else {
        const tile = el("div", "reftile" + (isDefault ? " default" : ""));
        const top = el("div", "rt-top");
        const name = el("span", "rt-name", r.name);
        name.title = r.editable ? "点击重命名（右键更多）" : "内置音色";
        if (r.editable) name.onclick = (e) => renameRef(r, ...xyOf(e));
        top.appendChild(name);
        if (isDefault) top.appendChild(el("span", "rt-def", "默认"));
        if ((r.uses || []).includes("emo")) top.appendChild(el("span", "rt-def emo", "情感"));
        if (!r.editable) top.appendChild(el("span", "mtag", "内置"));
        tile.appendChild(top);
        const bits = [];
        if (r.dur) bits.push(`${r.dur}s`);
        bits.push(r.group || "音色");
        tile.appendChild(el("div", "rt-meta", bits.join(" · ")));
        tile.appendChild(refActions(r, true));
        tile.oncontextmenu = (e) => { e.preventDefault(); openRefCtx(r, e.clientX, e.clientY); };
        box.appendChild(tile);
      }
    });
  });
}

/* 音色卡片右键菜单 */
function openRefCtx(r, x, y) {
  const items = [{ head: r.name + (r.dur ? ` · ${r.dur}s` : "") }];
  const playing = playingRefId === r.id;
  items.push({ label: playing ? "⏸ 停止试听" : "▶ 试听", fn: () => toggleRefPlay(r, null) });
  items.push({
    label: "✓ 设为全局默认音色",
    fn: () => setDefaultRef(r),
  });
  if (SEL.size) {
    items.push({
      label: `套用到选中的 ${SEL.size} 行`,
      fn: () => applyRefToSelection(r),
    });
  }
  items.push({ label: "ℹ 属性（格式 / 采样率 / 时长…）", fn: () => showAudioProps("ref", r.id) });
  items.push("-");
  items.push({ label: "⧉ 复制名称", fn: () => copyText(r.name) });
  if (r.editable) {
    items.push({ label: "✎ 重命名…", fn: () => renameRef(r, x, y) });
    items.push({ label: "✎ 拷进导入台重新裁…", fn: () => refToInbox(r) });
  }
  items.push("-");
  items.push({
    label: "选中引用它的句子",
    fn: () => {
      const uids = ((SCRIPT && SCRIPT.lines) || []).filter((l) => l.kind !== "tag"
        && ((l.ov && l.ov.ref) || (SCRIPT.defaults || {}).ref) === r.id).map((l) => l.uid);
      if (!uids.length) { toast("没有句子在用这个音色", true); return; }
      applySel(null, uids, "没有句子在用这个音色");
    },
  });
  if (r.editable) {
    items.push("-");
    items.push({ label: "删除这个音色", danger: true, fn: () => deleteRef(r) });
  }
  buildCtx(items, true);
  showCtxAt(x, y);
}

/* 把某个音色套到选中的行（行级覆盖） */
async function applyRefToSelection(r) {
  let n = 0;
  (SCRIPT.lines || []).forEach((l) => {
    if (!SEL.has(l.uid) || l.kind === "tag") return;
    l.ov = l.ov || {};
    l.ov.ref = r.id;
    if (l.status === "done" || l.status === "error") l.status = "stale";
    n++;
  });
  if (!n) { toast("先选中要套用的句子", true); return; }
  commitSnapshot(`套用音色「${r.name}」`);
  dirty = true;
  renderCenter(); renderStats();
  await saveNow();
  toast(`已把「${r.name}」套用到 ${n} 句（需要重生成）`);
}

function toggleRefPlay(r, btn) {
  if (playingRefId === r.id) {
    refAudio.pause();
    playingRefId = null;
    syncRefPlayBtns();
    return;
  }
  pauseOthers(refAudio);
  refAudio.src = `${API}/refs/${encodeURIComponent(r.id)}/audio?t=${Date.now()}`;
  refAudio.play().then(() => {
    playingRefId = r.id;
    syncRefPlayBtns();
  }).catch(() => toast("这个音色文件读不出来", true));
}
function syncRefPlayBtns() {
  document.querySelectorAll(".refplay").forEach((b) => {
    b.textContent = b.dataset.rid === playingRefId ? "⏸" : "▶";
  });
}
refAudio.onended = () => {
  playingRefId = null;
  syncRefPlayBtns();
};

async function setDefaultRef(r) {
  if (!SCRIPT) { toast("先打开一个台本", true); return; }
  SCRIPT.defaults.ref = r.id;
  dirty = true;
  syncDefaultPanel();
  renderRefList();
  try { await saveNow(); toast(`全局默认音色已设为「${r.name}」`); }
  catch (e) { toast("保存失败：" + e.message, true); }
}

function renameRef(r, x, y) {
  promptAt("重命名音色", r.name, x, y, async (val) => {
    const name = (val || "").trim();
    if (!name) { toast("名称不能为空", true); return; }
    try {
      await api(`/refs/${encodeURIComponent(r.id)}`, { method: "PATCH", body: JSON.stringify({ name }) });
      await loadMeta();
      renderRefList(); renderCenter();
      toast("已重命名");
    } catch (e) { toast(e.message, true); }
  }, { hint: "同时改磁盘文件名；已生成音频不受影响" });
}

function deleteRef(r) {
  const wrap = el("div");
  wrap.appendChild(el("div", null, `确定从音色库删除「${r.name}」？`));
  wrap.appendChild(el("div", "hint", "已生成的音频不受影响；引用它的行会提示找不到音色。"));
  modal("删除音色", wrap, async () => {
    try {
      await api(`/refs/${encodeURIComponent(r.id)}`, { method: "DELETE" });
      await loadMeta(); renderRefList();
      toast("已删除");
    } catch (e) { toast(e.message, true); }
  }, "删除");
}

async function loadPresets() {
  try {
    const r = await api("/presets");
    PRESETS = r.presets || [];
    renderPresets();
  } catch (e) { /* 忽略 */ }
}

let PRESET_Q = "";

function renderPresets() {
  const box = $("presetList");
  if (!box) return;
  box.innerHTML = "";
  if ($("presetSearch") && $("presetSearch").value !== PRESET_Q) $("presetSearch").value = PRESET_Q;
  const kw = (PRESET_Q || "").trim().toLowerCase();
  const shown = kw ? PRESETS.filter((p) => (p.name || "").toLowerCase().includes(kw)) : PRESETS;
  if ($("presetCount")) {
    $("presetCount").textContent = shown.length === PRESETS.length
      ? `${PRESETS.length} 个` : `${shown.length} / ${PRESETS.length} 个`;
  }
  if ($("presetHint")) {
    const cur = (SCRIPT && SCRIPT.defaults && SCRIPT.defaults.ref) || "";
    $("presetHint").textContent = PRESETS.length
      ? `当前默认音色：${cur ? refName(cur) : "跟随内置"} · 点名字直接应用`
      : "还没有预设。调好「全局默认参数」后，在上面填个名字点「保存当前默认」。";
  }
  if (!PRESETS.length) {
    box.appendChild(el("div", "hint", "还没有预设"));
    return;
  }
  if (!shown.length) {
    box.appendChild(el("div", "hint", "没有匹配的预设（换个关键词）"));
    return;
  }
  shown.forEach((p) => {
    const item = el("div", "refitem");
    const name = el("span", "refname", p.name);
    name.title = "点击应用（写入「全局默认参数」）";
    name.onclick = () => applyPreset(p);
    item.appendChild(name);
    const refId = (p.params || {}).ref;
    item.appendChild(el("span", "hint", refId ? refName(refId).slice(0, 10) : "无音色"));
    const apply = el("button", "iconbtn", "✓");
    apply.title = "应用为默认";
    apply.onclick = () => applyPreset(p);
    const ren = el("button", "iconbtn", "✎");
    ren.title = "重命名预设";
    ren.onclick = (e) => renamePreset(p, ...xyOf(e));
    const del = el("button", "iconbtn", "✕");
    del.title = "删除预设";
    del.onclick = () => deletePreset(p);
    item.appendChild(apply); item.appendChild(ren); item.appendChild(del);
    box.appendChild(item);
  });
}

async function savePreset() {
  if (!SCRIPT) return;
  const name = ($("presetName").value || "").trim() || `预设 ${new Date().toLocaleString()}`;
  try {
    const r = await api("/presets", {
      method: "POST",
      body: JSON.stringify({ name, params: SCRIPT.defaults, sampling: SCRIPT.sampling }),
    });
    PRESETS.unshift(r.preset);
    $("presetName").value = "";
    renderPresets();
    toast("预设已保存");
  } catch (e) { toast("保存失败：" + e.message, true); }
}

/* 改全局默认前先问一句：这会把没有单独覆盖的句子全打成「需重生成」，
   历史上就有人手滑改到默认音色，结果整篇都要重跑。 */
function guardDefaultChange(label, apply, rollback) {
  if (!SCRIPT) return;
  const n = speechLines().length;
  const doneN = speechLines().filter((l) => l.out).length;
  const wrap = el("div");
  wrap.appendChild(el("div", "hint", `要改的是：${label}`));
  wrap.appendChild(el("div", "hint",
    `影响范围：${n} 句里**没有单独覆盖**的句子都会跟着变；`
    + `其中 ${doneN} 句已经有音频，改完会标成「需重生成」（音频先留着，重跑才替换）。`));
  wrap.appendChild(el("div", "hint", "文本、句中标签、句间标签都不会动；改错了点工具栏「↩ 撤回属性」就能退回。"));
  const row = el("label", "chkrow");
  const cb = document.createElement("input");
  cb.type = "checkbox"; cb.checked = true;
  row.appendChild(cb);
  row.appendChild(el("span", null, "我确认要修改全局默认参数"));
  wrap.appendChild(row);

  const cancelBtn = $("modalCancel");
  const prev = cancelBtn ? cancelBtn.onclick : null;
  const restore = () => { if (cancelBtn) cancelBtn.onclick = prev; };
  if (cancelBtn) {
    cancelBtn.onclick = () => { restore(); if (rollback) rollback(); if (prev) prev(); };
  }
  modal("确认修改全局默认参数", wrap, async () => {
    if (!cb.checked) { toast("请先勾选「我确认」", true); return false; }
    restore();
    pushDefaultsUndo(label);
    apply();
    dirty = true; syncDefaultPanel(); queueSave(); renderCenter(); renderStats();
    toast("已修改全局默认：" + label);
  }, "确认修改");
}

async function applyPreset(p) {
  if (!SCRIPT) return;
  guardDefaultChange(`应用预设「${p.name}」`, () => {
    SCRIPT.defaults = Object.assign({}, SCRIPT.defaults, p.params || {});
    SCRIPT.sampling = Object.assign({}, SCRIPT.sampling, p.sampling || {});
    commitSnapshot("应用预设 " + p.name);
    saveNow();
    renderCenter();
    toast(`已应用预设「${p.name}」`);
  });
}

function renamePreset(p, x, y) {
  promptAt("重命名预设", p.name, x, y, async (val) => {
    const name = (val || "").trim();
    if (!name) return;
    try {
      const r = await api(`/presets/${p.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
      const i = PRESETS.findIndex((x2) => x2.id === p.id);
      if (i >= 0) PRESETS[i] = r.preset;
      renderPresets();
      toast("已重命名");
    } catch (e) { toast(e.message, true); }
  });
}

async function deletePreset(p) {
  if (!confirm(`删除预设「${p.name}」？`)) return;
  try {
    await api(`/presets/${p.id}`, { method: "DELETE" });
    PRESETS = PRESETS.filter((x) => x.id !== p.id);
    renderPresets();
  } catch (e) { toast(e.message, true); }
}

async function uploadRef(afterFn) {
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = "audio/*,.wav,.mp3,.flac,.ogg,.m4a";
  inp.multiple = true;
  inp.onchange = async () => {
    const files = Array.from(inp.files || []);
    if (!files.length) return;
    let last = null, ok = 0;
    for (const f of files) {
      const fd = new FormData();
      fd.append("file", f);
      fd.append("name", f.name.replace(/\.[^.]+$/, ""));
      try {
        const r = await api("/refs", { method: "POST", body: fd });
        last = r.ref; ok++;
      } catch (e) { toast(`「${f.name}」上传失败：${e.message}`, true); }
    }
    if (ok) {
      await loadMeta();
      if (afterFn) afterFn(last);
      toast(`已导入 ${ok} 个音色`);
    }
  };
  inp.click();
}

/* ------------------------------ 素材库 / 预处理 ------------------------------ */
const MAT = { items: [], sel: new Set(), caps: null, audio: null, playId: null,
              busy: false, bound: false, q: "", type: "",
              // 导入台是中转站：上传一律进 materials；target 只决定「存入哪个库」
              target: localStorage.getItem("lf.matTarget") || "ref",
              view: localStorage.getItem("lf.matView") || "list" };

/* 音效素材库：与音色素材同一套整理方式（上传 / 试听 / 改名 / 复制粘贴 / 预处理） */
const SFX = {
  items: [], audio: null, playId: null, clip: null, q: "", bound: false,
  view: localStorage.getItem("lf.sfxView") || "list",
};

/* 导入台永远只读写 /media（中转目录），不再随作用域切换 —— 
   以前切换作用域会让同一个面板显示另一个库的内容，看着像文件混了。 */
const matApi = () => "/media";
const matTargetName = () => (MAT.target === "sfx" ? "音效库" : "音色库");

const matDur = (s) => {
  s = Number(s) || 0;
  if (s >= 60) return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  return s.toFixed(1) + "s";
};

/* 按「存入哪个库」切换：处理卡片、快捷预设、按钮文案、说明 */
function applyMatTarget() {
  const sfxMode = MAT.target === "sfx";
  try { localStorage.setItem("lf.matTarget", MAT.target); } catch (e) { /* 忽略 */ }
  const seg = $("matTargetSeg");
  if (seg) seg.querySelectorAll("button").forEach((b) => b.classList.toggle("cur", b.dataset.mt === MAT.target));
  if ($("matTargetHint")) {
    $("matTargetHint").textContent = sfxMode
      ? "音效保留原声道；处理完进「🔔 音效素材库」"
      : "音色会统一转 22.05k 单声道（模型只认这个）";
  }
  if ($("matOpsVoice")) $("matOpsVoice").hidden = sfxMode;
  if ($("matOpsSfx")) $("matOpsSfx").hidden = !sfxMode;
  if ($("qpVoiceRow")) $("qpVoiceRow").hidden = sfxMode;
  if ($("qpSfxRow")) $("qpSfxRow").hidden = !sfxMode;
  const run = $("btnMatRun");
  if (run && !MAT.busy) run.textContent = `处理并存入${matTargetName()}`;
  const dtitle = $("drawerTitle");
  const mpane = document.querySelector('#drawer .ppane[data-pane="media"]');
  if (dtitle && mpane && mpane.classList.contains("cur")) {
    dtitle.textContent = `素材导入台 · 存入${matTargetName()}`;
  }
  if ($("matFormats")) {
    $("matFormats").textContent = "音频 wav/mp3/flac/ogg/m4a · 视频 mp4/mov/mkv …（视频只取音轨，导入台统一转成 44.1k WAV）";
  }
  // 「存入后清理源文件」的勾选由用户控制，切换去向不覆盖他的选择
}

async function initMediaPanel(target) {
  if (target === "sfx" || target === "ref") MAT.target = target;
  applyMatTarget();
  if (!MAT.audio) {
    MAT.audio = regPlayer(new Audio(), () => { MAT.playId = null; renderMatList(); });
    MAT.audio.onended = () => { MAT.playId = null; renderMatList(); };
  }
  if (!MAT.bound) { bindMediaEvents(); MAT.bound = true; }
  MAT.sel.clear();
  /* 「能力检测 / ffmpeg 状态」都只是面板上的附加信息：不 await，
     否则素材列表要等能力探测（含 demucs 探测、ffmpeg -version）跑完才出现。 */
  loadMatCaps().catch(() => {});
  refreshFfmpeg(true).catch(() => {});
  await loadMaterials();
}

/* ---------------- ffmpeg：视频抽音频的前提 ----------------
   补丁包不带 ffmpeg（几十兆、还得跟平台匹配），以前只找 bin/ 和 PATH，
   所以换台电脑「拖视频进去没反应」。现在给三种补救：上传 exe、填路径、重新探测。 */
let FF = null;

async function refreshFfmpeg(silent) {
  const bar = $("matFfmpegBar"), st = $("matFfState"), dot = $("matFfDot");
  if (!bar) return;
  try {
    FF = await api("/ffmpeg");
  } catch (e) {
    if (st) st.textContent = "ffmpeg 状态读取失败：" + e.message;
    bar.classList.add("bad"); bar.classList.remove("ok");
    return;
  }
  const on = !!FF.ok;
  bar.classList.toggle("ok", on);
  bar.classList.toggle("bad", !on);
  if (st) {
    st.innerHTML = on
      ? `ffmpeg 已就绪：<b>${(FF.version || "").replace("ffmpeg version ", "").split(" Copyright")[0]}</b>`
        + `<br><span style="opacity:.75">${FF.path}</span>`
      : `<b>没有可用的 ffmpeg</b>：视频抽音频用不了（普通音频导入不受影响）。`
        + `上传一个 ffmpeg.exe，或填它的完整路径。`;
    st.title = (FF.candidates || []).map((c) => `${c.exists ? "✓" : "·"} ${c.from}：${c.path}`).join("\n");
  }
  if (dot) dot.title = (FF.candidates || []).map((c) => `${c.exists ? "✓" : "·"} ${c.from}`).join("\n");
  if (!silent) {
    toast(on ? "ffmpeg 可用：视频可以抽音频了" : "还没找到 ffmpeg：可以用下面的按钮指定", !on);
  }
  // 「其它能力」那行也顺手更新一下，别一边说没有一边说能用
  const capEl = $("matCap");
  if (capEl && MAT.caps) {
    MAT.caps.ffmpeg = on;
    capEl.textContent = `ffmpeg ${on ? "✓ 视频可导入" : "✗ 仅音频"} · 分离：中置提取`
      + ` · 重采样 ${MAT.caps.resample} · 单个 ≤ ${MAT.caps.max_mb}MB`;
  }
}

function bindFfmpegBar() {
  const up = $("btnFfUpload"), file = $("fileFf"), path = $("btnFfPath"), probe = $("btnFfProbe");
  if (up && file) {
    up.onclick = () => file.click();
    file.onchange = async () => {
      const f = file.files && file.files[0];
      file.value = "";
      if (!f) return;
      if (f.size > 220 * 1024 * 1024) { toast("文件太大（ffmpeg 一般 30~90MB）", true); return; }
      const st = $("matFfState");
      if (st) st.textContent = `正在上传 ${f.name}（${(f.size / 1048576).toFixed(0)}MB）…`;
      const fd = new FormData();
      fd.append("file", f);
      try {
        await api("/ffmpeg/upload", { method: "POST", body: fd });
        await refreshFfmpeg(true);
        toast("ffmpeg 已装进包里，视频现在可以抽音频了");
      } catch (e) {
        toast("上传失败：" + e.message, true);
        await refreshFfmpeg(true);
      }
    };
  }
  if (path) {
    path.onclick = async () => {
      const cur = (FF && FF.path) || "";
      const v = prompt("填 ffmpeg.exe 的完整路径（也可以填所在文件夹）：", cur);
      if (v == null) return;
      try {
        await api("/ffmpeg/path", { method: "POST", body: { path: v.trim() } });
        await refreshFfmpeg(true);
        toast("已指定 ffmpeg");
      } catch (e) { toast("设置失败：" + e.message, true); }
    };
  }
  if (probe) {
    probe.onclick = async () => {
      try { await api("/ffmpeg/probe", { method: "POST", body: {} }); } catch (e) { /* 忽略 */ }
      await refreshFfmpeg(false);
    };
  }
}

async function loadMatCaps() {
  try { MAT.caps = await api("/media/capabilities"); } catch (e) { MAT.caps = null; }
  const c = MAT.caps;
  const capEl = $("matCap"), fmtEl = $("matFormats");
  if (capEl) {
    capEl.textContent = c
      ? `ffmpeg ${c.ffmpeg ? "✓ 视频可导入" : "✗ 仅音频"} · 分离：中置提取 · 重采样 ${c.resample} · 单个 ≤ ${c.max_mb}MB`
      : "能力检测失败（不影响音频导入）";
  }
  if (fmtEl) {
    fmtEl.textContent = c
      ? `音频 ${c.audio_formats.slice(0, 9).join(" / ")}` +
        (c.video ? `　视频 ${c.video_formats.slice(0, 8).join(" / ")}` : "　视频需 ffmpeg")
      : "";
  }
  applyDemucsCap(c && c.demucs);
}

/* Demucs 是否可用 → 引擎下拉的可用状态与说明 */
function applyDemucsCap(dm) {
  const ok = !!(dm && dm.available);
  const dev = (dm && dm.device) === "cuda" ? "显卡" : "CPU";
  [["opVocalEngine", "vocalEngineHint", "vocalDspOpts"],
   ["opSSepEngine", "sepEngineHint", "sepDspOpts"]].forEach(([selId, hintId, dspId]) => {
    const sel = $(selId);
    if (!sel) return;
    const opt = [...sel.options].find((o) => o.value === "demucs");
    if (opt) {
      opt.disabled = !ok;
      opt.textContent = ok ? `Demucs 高精度（${dev}）` : "Demucs（未安装）";
    }
    if (!ok && sel.value === "demucs") sel.value = "dsp";
    syncSepEngine(selId, hintId, dspId);
  });
}

function syncSepEngine(selId, hintId, dspId) {
  const sel = $(selId), hint = $(hintId), dsp = $(dspId);
  if (!sel) return;
  const demucs = sel.value === "demucs";
  if (dsp) dsp.hidden = demucs;
  if (hint) {
    hint.textContent = demucs
      ? "Demucs（htdemucs）：按「人声 / 鼓 / 贝斯 / 其它」分离，伴奏居中也能分开；"
        + "首次使用要下载 80MB 模型，之后 30 秒素材约 2 秒（显卡）。比中置提取慢但干净得多。"
      : "中置提取：人声居中、伴奏铺得宽时效果最好；伴奏也居中会残留。需要立体声素材。";
  }
}

async function loadMaterials() {
  try {
    const r = await api(matApi());
    MAT.items = r.items || [];
  } catch (e) { MAT.items = []; }
  // 丢掉已经不存在的选中项
  const ids = new Set(MAT.items.map((x) => x.id));
  [...MAT.sel].forEach((id) => { if (!ids.has(id)) MAT.sel.delete(id); });
  renderMatList();
}

function matVisible() {
  const q = (MAT.q || "").trim().toLowerCase();
  const t = MAT.type || "";
  return MAT.items.filter((it) => {
    if (t && it.kind !== t) return false;
    if (!q) return true;
    return ((it.name || "") + " " + (it.source || "") + " " + (it.op || "")).toLowerCase().includes(q);
  });
}

function matTags(it) {
  const tags = [];
  if (it.kind === "video") tags.push(["video", "视频抽取"]);
  if (it.kind === "derived") tags.push(["derived", "处理结果"]);
  if (it.op) tags.push(["op", it.op]);
  return tags;
}

function matMeta(it) {
  return `${matDur(it.dur)} · ${((it.sr || 44100) / 1000).toFixed(1)}k · ${it.ch === 2 ? "立体声" : "单声道"} · ${fmtBytes(it.size || 0)}`;
}

function matPlayBtn(it) {
  const play = el("button", "iconbtn", MAT.playId === it.id ? "⏸" : "▶");
  play.title = "试听 / 暂停";
  play.dataset.mid = it.id;
  play.onclick = (e) => { e.stopPropagation(); toggleMatPlay(it, play); };
  return play;
}

function matCheck(it, onToggle) {
  const cb = document.createElement("input");
  cb.type = "checkbox"; cb.checked = MAT.sel.has(it.id);
  cb.onchange = () => {
    if (cb.checked) MAT.sel.add(it.id); else MAT.sel.delete(it.id);
    if (onToggle) onToggle(cb.checked); else renderMatList();
    updateMatSelHint();
  };
  return cb;
}

function renderMatList() {
  const box = $("matList");
  if (!box) return;
  box.className = "matlist mode-" + (MAT.view || "list");
  box.innerHTML = "";
  const shown = matVisible();
  if (!MAT.items.length) {
    box.appendChild(el("div", "empty",
      "导入台是空的。上传音频或视频（可多选/拖拽），处理完点「处理并存入」变成音色或音效。"));
  } else if (!shown.length) {
    box.appendChild(el("div", "empty", "没有匹配的内容（换个关键词或筛选条件）"));
  }
  const seg = $("matViewSeg");
  if (seg) seg.querySelectorAll("button").forEach((b) => b.classList.toggle("cur", b.dataset.mv === MAT.view));

  shown.forEach((it) => {
    if (it.kind === undefined) it.kind = "audio";
    if (MAT.view === "list") {
      const row = el("div", "matitem" + (MAT.sel.has(it.id) ? " sel" : ""));
      row.appendChild(matCheck(it, (on) => row.classList.toggle("sel", on)));
      const name = el("span", "mname", it.name || it.file);
      name.title = `${it.name}\n来源：${it.source || "—"}\n文件：${it.file}\n右键更多`;
      name.onclick = (e) => renameMat(it, ...xyOf(e));
      row.appendChild(name);
      matTags(it).forEach(([cls, txt]) => row.appendChild(el("span", "mtag " + cls, txt)));
      row.appendChild(el("span", "mmeta", matMeta(it)));
      row.appendChild(matPlayBtn(it));
      const quick = el("button", "iconbtn", MAT.target === "sfx" ? "🔔" : "🎙");
      quick.title = `直接存入${matTargetName()}（不做处理）`;
      quick.onclick = (e) => { e.stopPropagation(); directStore(it); };
      row.appendChild(quick);
      const ren = el("button", "iconbtn", "✎");
      ren.title = "重命名";
      ren.onclick = (e) => renameMat(it, ...xyOf(e));
      row.appendChild(ren);
      const del = el("button", "iconbtn", "✕");
      del.title = "删除素材";
      del.onclick = () => deleteMat(it);
      row.appendChild(del);
      row.oncontextmenu = (e) => { e.preventDefault(); openMatCtx(it, e.clientX, e.clientY); };
      box.appendChild(row);
      return;
    }

    const tile = el("div", "mattile" + (MAT.sel.has(it.id) ? " sel" : ""));
    const top = el("div", "mt-top");
    top.appendChild(matCheck(it, (on) => tile.classList.toggle("sel", on)));
    const name = el("span", "mt-name", it.name || it.file);
    name.title = `${it.name}\n来源：${it.source || "—"}\n文件：${it.file}\n右键更多`;
    name.onclick = (e) => renameMat(it, ...xyOf(e));
    top.appendChild(name);
    tile.appendChild(top);
    const tags = matTags(it);
    if (tags.length) {
      const tg = el("div", "mt-tags");
      tags.forEach(([cls, txt]) => tg.appendChild(el("span", "mtag " + cls, txt)));
      tile.appendChild(tg);
    }
    tile.appendChild(el("div", "mt-meta", matMeta(it)));
    const acts = el("div", "mt-act");
    acts.appendChild(matPlayBtn(it));
    const quick2 = el("button", "iconbtn", MAT.target === "sfx" ? "🔔" : "🎙");
    quick2.title = `直接存入${matTargetName()}`;
    quick2.onclick = (e) => { e.stopPropagation(); directStore(it); };
    acts.appendChild(quick2);
    const ren = el("button", "iconbtn", "✎");
    ren.title = "重命名";
    ren.onclick = (e) => { e.stopPropagation(); renameMat(it, ...xyOf(e)); };
    acts.appendChild(ren);
    const del = el("button", "iconbtn", "✕");
    del.title = "删除素材";
    del.onclick = (e) => { e.stopPropagation(); deleteMat(it); };
    acts.appendChild(del);
    tile.appendChild(acts);
    tile.oncontextmenu = (e) => { e.preventDefault(); openMatCtx(it, e.clientX, e.clientY); };
    box.appendChild(tile);
  });
  if ($("matCount")) {
    $("matCount").textContent = shown.length === MAT.items.length
      ? `${MAT.items.length} 个素材`
      : `${shown.length} / ${MAT.items.length} 个素材`;
  }
  updateMatSelHint();
}

/* 素材右键菜单：试听 / 设为音色 / 一键预处理 / 删除 */
function openMatCtx(it, x, y) {
  const items = [{ head: (it.name || it.file) + ` · ${matDur(it.dur)}` }];
  const playing = MAT.playId === it.id;
  items.push({ label: playing ? "⏸ 停止试听" : "▶ 试听", fn: () => toggleMatPlay(it, null) });
  items.push({ label: "ℹ 属性（声道 / 格式 / 采样率 / 位深…）", fn: () => showAudioProps("media", it.id) });
  items.push({
    label: MAT.sel.has(it.id) ? "取消勾选" : "勾选这个素材",
    fn: () => {
      if (MAT.sel.has(it.id)) MAT.sel.delete(it.id); else MAT.sel.add(it.id);
      renderMatList();
    },
  });
  items.push("-");
  items.push({ label: "🎙 直接存入音色库", fn: () => directStore(it, "ref") });
  items.push({ label: "🔔 直接存入音效库", fn: () => directStore(it, "sfx") });
  items.push("-");
  items.push({ label: "⚡ 只提取人声（去伴奏）", fn: () => runMatPreset(it, "vocals") });
  items.push({ label: "⚡ 净化人声（+降噪/去静音/标准化）", fn: () => runMatPreset(it, "clean") });
  items.push({ label: "⚡ 做成音色（裁前 15s + 单声道）", fn: () => runMatPreset(it, "ref") });
  items.push("-");
  items.push({ label: "✎ 重命名…", fn: () => renameMat(it, x, y) });
  items.push({ label: "⧉ 复制名称", fn: () => copyText(it.name || it.file) });
  items.push({ label: "从导入台移除（移进回收站）", danger: true, fn: () => deleteMat(it) });
  buildCtx(items, true);
  showCtxAt(x, y);
}

/* 音频属性弹窗：声道 / 格式 / 采样率 / 位深 / 码率 / 大小…（导入台、音效库、音色库通用） */
async function showAudioProps(kind, id) {
  const url = kind === "sfx" ? `/sfx/${encodeURIComponent(id)}/info`
    : kind === "ref" ? `/refs/${encodeURIComponent(id)}/info`
      : `/media/${encodeURIComponent(id)}/info`;
  let info;
  try {
    const r = await api(url);
    info = r.info || {};
  } catch (e) {
    toast("读不到属性：" + e.message, true);
    return;
  }
  const fmtDur2 = (v) => (v >= 60
    ? `${Math.floor(v / 60)} 分 ${Math.round(v % 60)} 秒`
    : `${Number(v || 0).toFixed(2)} 秒`);
  const rows = [
    ["名称", info.name || "—"],
    ["文件", info.file || "—"],
    ["容器 / 编码", `${info.format || "—"}${info.subtype ? " · " + info.subtype : ""}`],
    ["位深", info.bit_depth ? `${info.bit_depth} bit` : "—"],
    ["采样率", info.sample_rate ? `${info.sample_rate} Hz（${(info.sample_rate / 1000).toFixed(1)} kHz）` : "—"],
    ["声道", `${info.layout || "—"}（${info.channels || "?"} 声道）`],
    ["时长", fmtDur2(info.dur)],
    ["码率", info.bitrate_kbps ? `${info.bitrate_kbps} kbps` : "—"],
    ["大小", fmtBytes(info.size || 0)],
    ["来源", info.source || "—"],
    ["处理", info.op || "（原样导入）"],
    ["创建时间", info.created ? new Date(info.created * 1000).toLocaleString() : "—"],
  ];
  const wrap = el("div", "props");
  const tb = el("table");
  rows.forEach(([k, v]) => {
    const tr = el("tr");
    tr.appendChild(el("th", null, k));
    tr.appendChild(el("td", null, String(v)));
    tb.appendChild(tr);
  });
  wrap.appendChild(tb);
  if (kind === "ref") {
    wrap.appendChild(el("div", "hint", "音色固定为 22.05kHz 单声道 WAV —— 模型只吃这一种，所以上传时就已经转好了；想换声道就重新裁一段再存入。"));
  } else if (kind === "sfx") {
    wrap.appendChild(el("div", "hint", "音效保留原声道（立体声不会被压成单声道），只是统一存成 44.1kHz WAV。"));
  } else {
    wrap.appendChild(el("div", "hint", "这是导入台里的中转文件（44.1kHz WAV）。处理并存入后，音色会转成 22.05k 单声道，音效保持原声道。"));
  }
  modal("音频属性", wrap, async () => true, "关闭");
}

/* 不做任何处理，直接把导入台里的文件收进目标库 */
async function directStore(it, target) {
  if (MAT.busy) { toast("正在处理别的素材，稍等", true); return; }
  const t = target === "sfx" || target === "ref" ? target : MAT.target;
  const name = t === "sfx" ? "音效库" : "音色库";
  MAT.busy = true;
  try {
    const r = await storeMat(it, {}, { target: t, remove: false });
    await loadMaterials();
    const out = $("matResult");
    if (out) out.innerHTML = `已存入<b>${name}</b>：${r.name}`;
    toast(`已存入${name}：${r.name}`);
  } catch (e) {
    toast(`存入失败：${e.message}`, true);
  } finally {
    MAT.busy = false;
  }
}

/* 导入台回收站：列出可恢复的文件，一键还原 */
async function openMatTrash() {
  let items = [];
  try {
    const r = await api("/media/trash");
    items = r.items || [];
  } catch (e) { toast("读不到回收站：" + e.message, true); return; }
  const wrap = el("div");
  wrap.appendChild(el("div", "hint",
    items.length
      ? `回收站里有 ${items.length} 个中转文件（删除/清空导入台时会移到这里）。恢复后回到导入台，参数原样保留。`
      : "回收站是空的。"));
  const list = el("div", "trashlist");
  const picked = new Set();
  items.slice(0, 200).forEach((it) => {
    const row = el("div", "trashrow");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.onchange = () => { if (cb.checked) picked.add(it.trash_file); else picked.delete(it.trash_file); };
    row.appendChild(cb);
    row.appendChild(el("span", "tname", it.name || it.orig_file || it.trash_file));
    row.appendChild(el("span", "tmeta",
      `${matDur(it.dur)} · ${((it.sr || 44100) / 1000).toFixed(1)}k · ${it.ch === 2 ? "立体声" : "单声道"}`));
    const when = it.trashed_at ? new Date(it.trashed_at * 1000).toLocaleString() : "";
    row.appendChild(el("span", "twhen", when));
    const one = el("button", "btn mini ghost", "恢复");
    one.onclick = async () => {
      try {
        const r = await api("/media/restore", {
          method: "POST", body: JSON.stringify({ ids: [it.trash_file] }),
        });
        toast(`已恢复 ${r.restored} 个`);
        closeModal();
        await loadMaterials();
        openMatTrash();
      } catch (e) { toast(e.message, true); }
    };
    row.appendChild(one);
    list.appendChild(row);
  });
  wrap.appendChild(list);
  const btns = el("div", "row2");
  const allBtn = el("button", "btn mini", "恢复全部");
  allBtn.onclick = async () => {
    try {
      const r = await api("/media/restore", { method: "POST", body: JSON.stringify({ all: true }) });
      toast(`已恢复 ${r.restored} 个`);
      closeModal();
      await loadMaterials();
    } catch (e) { toast(e.message, true); }
  };
  const selBtn = el("button", "btn mini", "恢复勾选的");
  selBtn.onclick = async () => {
    if (!picked.size) { toast("先勾选要恢复的", true); return; }
    try {
      const r = await api("/media/restore", {
        method: "POST", body: JSON.stringify({ ids: [...picked] }),
      });
      toast(`已恢复 ${r.restored} 个`);
      closeModal();
      await loadMaterials();
      openMatTrash();
    } catch (e) { toast(e.message, true); }
  };
  if (items.length) { btns.appendChild(selBtn); btns.appendChild(allBtn); }
  wrap.appendChild(btns);
  modal("导入台回收站", wrap, async () => true, "关闭");
}

/* 清空导入台（勾了就只清勾选的） */
async function clearMatDesk() {
  const ids = [...MAT.sel];
  const n = ids.length || MAT.items.length;
  if (!n) { toast("导入台已经是空的", true); return; }
  const wrap = el("div");
  wrap.appendChild(el("div", null,
    ids.length ? `把勾选的 ${ids.length} 个素材移进回收站？` : `把导入台里 ${MAT.items.length} 个素材全部移进回收站？`));
  wrap.appendChild(el("div", "hint", "不会真删，文件在 longform/materials/.trash 里；已入库的音色 / 音效不受影响。"));
  modal("清空导入台", wrap, async () => {
    try {
      const r = await api("/media/clear", {
        method: "POST", body: JSON.stringify({ ids, all: ids.length === 0 }),
      });
      MAT.sel.clear();
      await loadMaterials();
      toast(`已清理 ${r.removed} 个中转文件（在「♻ 回收站」里可恢复）`);
    } catch (e) { toast(e.message, true); }
  }, "移进回收站");
}

/* 快捷处理预设：右键菜单和面板上的按钮共用同一套参数 */
function matPresetOps(kind) {
  if (kind === "vocals") return { separate: { mode: "vocals", strength: 0.65 } };
  const ops = {
    separate: { mode: "vocals", strength: 0.65 },
    denoise: 0.5,
    trim_silence: { threshold_db: -45, pad: 0.06 },
    normalize: { mode: "peak", target_db: -1 },
  };
  if (kind === "ref") {
    ops.trim = { start: 0, end: 15 };
    ops.convert = { sr: null, channels: 1 };
  }
  return ops;
}

async function runMatPreset(it, kind) {
  if (MAT.busy) { toast("正在处理别的素材，稍等", true); return; }
  const ops = matPresetOps(kind);
  if (it.ch !== 2 && ops.separate && (ops.separate.engine || "dsp") !== "demucs") {
    delete ops.separate;
    if (kind === "vocals") {
      toast("单声道素材分不开人声：请上传立体声原文件（视频抽出来的通常是立体声）", true);
      return;
    }
    toast("单声道素材分不开人声，这次只做降噪 / 标准化", true);
  }
  // 「做成音色」这个快捷动作本身就说明要去音色库，其它预设跟着当前去向
  const target = kind === "ref" ? "ref" : MAT.target;
  const label = kind === "vocals" ? "只留人声" : kind === "ref" ? "做成音色" : "净化人声";
  MAT.busy = true;
  const out = $("matResult");
  if (out) out.textContent = `正在处理「${it.name}」：${label}…（长音频要几秒到几十秒）`;
  try {
    const r = await storeMat(it, ops, { target, remove: false });
    if (out) out.innerHTML = `已存入${target === "sfx" ? "音效库" : "音色库"}：<b>${r.name}</b>`;
    toast(`已存入${target === "sfx" ? "音效库" : "音色库"}：${r.name}`);
  } catch (e) {
    if (out) out.textContent = "";
    toast(`「${it.name}」处理失败：${e.message}`, true);
  } finally {
    MAT.busy = false;
  }
}

/* 导入台 → 目标库：唯一出口。ops 为空 = 只做格式归一（直接存入）。 */
async function storeMat(it, ops, opt) {
  opt = opt || {};
  const target = opt.target === "sfx" ? "sfx" : (opt.target === "ref" ? "ref" : MAT.target);
  const body = {
    target, ops: ops || {},
    remove_source: opt.remove === true,
    name: opt.name || undefined,
  };
  const r = await api(`/media/${encodeURIComponent(it.id)}/store`, {
    method: "POST", body: JSON.stringify(body),
  });
  if (target === "ref") {
    await loadMeta();
    renderRefList();
    renderCenter();
  } else {
    await loadSfx();
  }
  // 时间轴内嵌了这个导入台时，通知外面刷新素材列表，不用手动按刷新
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: "lf-stored", target, name: (r.item || {}).name || "" }, "*");
    }
  } catch (e) { /* 忽略 */ }
  return r;
}

function updateMatSelHint() {
  const n = MAT.sel.size;
  const h = $("matSelHint");
  if (h) h.textContent = n ? `已选 ${n} 个` : "先勾选素材";
  const b = $("btnMatRun");
  if (b && !MAT.busy) {
    b.textContent = `处理并存入${matTargetName()}` + (n > 1 ? `（${n} 个）` : "");
  }
}

function toggleMatPlay(it, btn) {
  if (MAT.playId === it.id) {
    MAT.audio.pause(); MAT.playId = null; renderMatList(); return;
  }
  pauseOthers(MAT.audio);
  MAT.audio.src = `${API}${matApi()}/${encodeURIComponent(it.id)}/audio?t=${Date.now()}`;
  MAT.audio.play().then(() => {
    MAT.playId = it.id;
    renderMatList();
  }).catch(() => toast("这个素材读不出来", true));
}

async function uploadMaterials(files) {
  if (!files.length) return;
  const out = $("matResult");
  let ok = 0, fail = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (out) out.textContent = `正在导入 ${i + 1}/${files.length}：${f.name}`;
    const fd = new FormData();
    fd.append("file", f);
    try {
      const r = await api(`${matApi()}/upload`, { method: "POST", body: fd });
      MAT.sel.add(r.item.id);
      ok++;
    } catch (e) {
      fail++;
      toast(`「${f.name}」导入失败：${e.message}`, true);
    }
  }
  await loadMaterials();
  if (out) out.textContent = `已导入 ${ok} 个素材` + (fail ? `，${fail} 个失败` : "") + "。勾选后可批量处理。";
  toast(`导入完成：成功 ${ok}${fail ? `，失败 ${fail}` : ""}`);
}

function collectMatOps() {
  return MAT.target === "sfx" ? collectSfxOps() : collectVoiceOps();
}

/* 音效处理：按「短音效」的思路——去静音、淡入淡出、响度、变速变调、滤波、反向 */
function collectSfxOps() {
  const ops = {};
  if ($("opSTrim").checked) {
    const a = $("opSTrimStart").value.trim(), b = $("opSTrimEnd").value.trim();
    if (a !== "" || b !== "") ops.trim = { start: a === "" ? 0 : parseFloat(a), end: b === "" ? null : parseFloat(b) };
  }
  if ($("opSSil").checked) ops.trim_silence = { threshold_db: parseFloat($("opSSilDb").value), pad: 0.02 };
  if ($("opSDn").checked) ops.denoise = parseFloat($("opSDnAmt").value);
  const fi = parseFloat($("opSFadeIn").value || 0), fo = parseFloat($("opSFadeOut").value || 0);
  if ($("opSFade").checked && (fi > 0 || fo > 0)) ops.fade = { in: fi, out: fo };
  if ($("opSNorm").checked) {
    ops.normalize = { mode: $("opSNormMode").value, target_db: parseFloat($("opSNormDb").value) };
    const g = parseFloat($("opSGain").value || 0);
    if (g) ops.gain_db = g;
  }
  if ($("opSSpeed").checked) {
    const v = parseFloat($("opSSpeedVal").value);
    if (Math.abs(v - 1) > 0.01) ops.speed = v;
  }
  if ($("opSPitch").checked) {
    const v = parseFloat($("opSPitchVal").value);
    if (Math.abs(v) > 0.1) ops.pitch = v;
  }
  if ($("opSFilter").checked) {
    const hp = parseFloat($("opSHp").value || 0), lp = parseFloat($("opSLp").value || 0);
    if (hp > 0 || lp > 0) ops.filter = { hp: hp || null, lp: lp || null };
  }
  if ($("opSReverse").checked) ops.reverse = true;
  if ($("opSSep").checked) {
    ops.separate = {
      mode: $("opSSepMode").value,
      strength: parseFloat($("opSSepStrength").value),
      engine: ($("opSSepEngine") && $("opSSepEngine").value) === "demucs" ? "demucs" : "dsp",
    };
  }
  if ($("opSConv").checked) {
    const sr = $("opSSr").value, ch = $("opSCh").value;
    if (sr || ch) ops.convert = { sr: sr ? parseInt(sr, 10) : null, channels: ch ? parseInt(ch, 10) : null };
  }
  return ops;
}

function collectVoiceOps() {
  const ops = {};
  if ($("opVocal").checked) {
    ops.separate = {
      mode: $("opVocalMode").value,
      strength: parseFloat($("opVocalStrength").value),
      engine: ($("opVocalEngine") && $("opVocalEngine").value) === "demucs" ? "demucs" : "dsp",
    };
  }
  if ($("opDenoise").checked) ops.denoise = parseFloat($("opDenoiseAmt").value);
  if ($("opTrimSil").checked) {
    ops.trim_silence = { threshold_db: parseFloat($("opSilDb").value), pad: 0.06 };
  }
  if ($("opNorm").checked) {
    ops.normalize = { mode: $("opNormMode").value, target_db: parseFloat($("opNormDb").value) };
  }
  if ($("opTrim").checked) {
    const a = $("opTrimStart").value.trim(), b = $("opTrimEnd").value.trim();
    if (a !== "" || b !== "") ops.trim = { start: a === "" ? 0 : parseFloat(a), end: b === "" ? null : parseFloat(b) };
  }
  if ($("opFade").checked) {
    const fi = parseFloat($("opFadeIn").value || 0), fo = parseFloat($("opFadeOut").value || 0);
    if (fi > 0 || fo > 0) ops.fade = { in: fi, out: fo };
  }
  if ($("opConv").checked) {
    const sr = $("opSr").value, ch = $("opCh").value;
    if (sr || ch) ops.convert = { sr: sr ? parseInt(sr, 10) : null, channels: ch ? parseInt(ch, 10) : null };
  }
  return ops;
}

async function runMatOps(opt) {
  if (MAT.busy) return;
  opt = opt || {};
  const ids = [...MAT.sel];
  if (!ids.length) { toast("先勾选要处理的素材（可以全选）", true); return; }
  const target = opt.target === "sfx" || opt.target === "ref" ? opt.target : MAT.target;
  const label = target === "sfx" ? "音效库" : "音色库";
  const ops = opt.ops !== undefined ? opt.ops : collectMatOps();
  if (opt.ops === undefined && !Object.keys(ops).length) {
    toast("至少勾一项处理；只想原样入库请用「直接存入」", true); return;
  }
  if (ops.separate && (ops.separate.engine || "dsp") !== "demucs") {
    const mono = MAT.items.filter((x) => ids.includes(x.id) && x.ch !== 2);
    if (mono.length) toast(`有 ${mono.length} 个单声道素材无法分离，会跳过分离只做其它处理`, true);
  }
  /* 勾选框现在是「保留原素材」：默认勾上，也就是**默认不删**。
     以前是反的（勾上=删源），所以处理一次导入台就少一个文件。 */
  try {
    const keepBox = $("matKeepSrc");
    if (keepBox && localStorage.getItem("lf.matkeep") === "0") keepBox.checked = false;
    if (keepBox) keepBox.onchange = () => {
      try { localStorage.setItem("lf.matkeep", keepBox.checked ? "1" : "0"); } catch (e) { /* 忽略 */ }
    };
  } catch (e) { /* 忽略 */ }
  const remove = $("matKeepSrc") ? !$("matKeepSrc").checked : false;
  MAT.busy = true;
  const btn = $("btnMatRun"), out = $("matResult");
  const old = btn.textContent;
  btn.disabled = true;
  const made = [];
  let fail = 0;
  for (let i = 0; i < ids.length; i++) {
    const it = MAT.items.find((x) => x.id === ids[i]);
    if (!it) continue;
    if (out) out.textContent = `正在处理 ${i + 1}/${ids.length}：${it.name} → ${label}…`;
    btn.textContent = `处理中 ${i + 1}/${ids.length}`;
    try {
      const r = await storeMat(it, ops, { target, remove });
      made.push(r);
    } catch (e) {
      fail++;
      toast(`「${it.name}」失败：${e.message}`, true);
    }
  }
  btn.disabled = false;
  btn.textContent = old;
  MAT.busy = false;
  MAT.sel.clear();
  await loadMaterials();
  if (out) {
    if (made.length) {
      const first = made[0];
      out.innerHTML = `已存入<b>${label}</b> ${made.length} 个：` +
        made.slice(0, 4).map((x) => x.name).join("、") + (made.length > 4 ? " …" : "") +
        `　<span class="hint">（${first.target === "ref" ? "22.05k 单声道" : `${(first.sr || 44100) / 1000}k ${first.ch === 2 ? "立体声" : "单声道"}`}）</span>` +
        (fail ? `　<span style="color:var(--danger)">${fail} 个失败</span>` : "");
    } else {
      out.textContent = `处理失败${fail ? `（${fail} 个）` : ""}`;
    }
  }
  toast(made.length ? `已存入${label} ${made.length} 个` : "处理失败", !made.length);
  updateMatSelHint();
}

function renameMat(it, x, y) {
  promptAt("重命名素材", it.name || it.file, x, y, async (val) => {
    const name = (val || "").trim();
    if (!name) { toast("名称不能为空", true); return; }
    try {
      await api(`${matApi()}/${encodeURIComponent(it.id)}`, { method: "PATCH", body: JSON.stringify({ name }) });
      await loadMaterials();
      toast("已重命名");
    } catch (e) { toast(e.message, true); }
  }, { hint: "磁盘文件名也一起改" });
}

function deleteMat(it) {
  const wrap = el("div");
  wrap.appendChild(el("div", null, `删除素材「${it.name}」？`));
  wrap.appendChild(el("div", "hint", "只是从素材库移除（会移入 materials/.trash），已设为音色的不受影响。"));
  modal("删除素材", wrap, async () => {
    try {
      await api(`${matApi()}/${encodeURIComponent(it.id)}`, { method: "DELETE" });
      MAT.sel.delete(it.id);
      await loadMaterials();
      toast("已删除");
    } catch (e) { toast(e.message, true); }
  }, "删除");
}

/* 兼容旧入口：这两个动作现在都走 directStore（导入台 → 目标库） */
function matToSfx(it) { return directStore(it, "sfx"); }
function matAsRef(it) { return directStore(it, "ref"); }

function bindMediaEvents() {
  bindFfmpegBar();
  const inp = $("fileMat");
  if (inp) {
    inp.onchange = async () => {
      const files = Array.from(inp.files || []);
      inp.value = "";
      await uploadMaterials(files);
    };
  }
  const dz = $("matDrop");
  if (dz) {
    ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => {
      e.preventDefault(); dz.classList.add("over");
    }));
    ["dragleave", "dragend"].forEach((ev) => dz.addEventListener(ev, () => dz.classList.remove("over")));
    dz.addEventListener("drop", async (e) => {
      e.preventDefault(); dz.classList.remove("over");
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length) await uploadMaterials(files);
    });
  }
  const sq = $("matSearch");
  if (sq) sq.oninput = () => { MAT.q = sq.value; renderMatList(); };
  const fl = $("matFilter");
  if (fl) fl.onchange = () => { MAT.type = fl.value; renderMatList(); };

  const mv = $("matViewSeg");
  if (mv) mv.querySelectorAll("button").forEach((b) => {
    b.onclick = () => {
      MAT.view = b.dataset.mv;
      try { localStorage.setItem("lf.matView", MAT.view); } catch (e) { /* 忽略 */ }
      renderMatList();
    };
  });

  const vs = $("opVocalStrength");
  if (vs) vs.oninput = () => { $("vVocal").textContent = parseFloat(vs.value).toFixed(2); };
  ["opVocalEngine", "opSSepEngine"].forEach((id) => {
    const sel = $(id);
    if (!sel) return;
    sel.onchange = () => {
      if (id === "opVocalEngine") syncSepEngine("opVocalEngine", "vocalEngineHint", "vocalDspOpts");
      else syncSepEngine("opSSepEngine", "sepEngineHint", "sepDspOpts");
    };
  });
  const vd = $("opDenoiseAmt");
  if (vd) vd.oninput = () => { $("vDenoise").textContent = parseFloat(vd.value).toFixed(2); };

  // 音效处理卡的滑块数值
  const vs2 = $("opSSpeedVal");
  if (vs2) vs2.oninput = () => { $("vSpeed").textContent = parseFloat(vs2.value).toFixed(2) + "×"; };
  const vp = $("opSPitchVal");
  if (vp) vp.oninput = () => {
    const v = parseInt(vp.value, 10) || 0;
    $("vPitch").textContent = (v > 0 ? "+" : "") + v;
  };
  const vdn = $("opSDnAmt");
  if (vdn) vdn.oninput = () => { $("vSdn").textContent = parseFloat(vdn.value).toFixed(2); };
  const vsep = $("opSSepStrength");
  if (vsep) vsep.oninput = () => { $("vSep").textContent = parseFloat(vsep.value).toFixed(2); };

  // 音效快捷预设：只负责勾好参数，点「开始处理」才执行
  const chk = (id, v) => { const n = $(id); if (n) n.checked = v; };
  const qs1 = $("qpSfxShort");
  if (qs1) qs1.onclick = () => {
    ["opSTrim", "opSSpeed", "opSPitch", "opSFilter", "opSReverse", "opSSep", "opSConv", "opSDn"].forEach((i) => chk(i, false));
    chk("opSSil", true); chk("opSFade", true); chk("opSNorm", true);
    $("opSFadeIn").value = "0.01"; $("opSFadeOut").value = "0.08";
    $("opSNormMode").value = "peak"; $("opSNormDb").value = "-1"; $("opSGain").value = "0";
    toast("已按「短音效」勾好：去首尾静音 + 10/80ms 淡入淡出 + 峰值 -1dB");
  };
  const qs2 = $("qpSfxAmb");
  if (qs2) qs2.onclick = () => {
    ["opSTrim", "opSSpeed", "opSPitch", "opSReverse", "opSSep", "opSConv", "opSSil"].forEach((i) => chk(i, false));
    chk("opSFilter", true); chk("opSDn", true); chk("opSFade", true); chk("opSNorm", true);
    $("opSHp").value = "80"; $("opSLp").value = "0";
    $("opSDnAmt").value = "0.4"; $("vSdn").textContent = "0.40";
    $("opSFadeIn").value = "0.3"; $("opSFadeOut").value = "0.3";
    $("opSNormMode").value = "rms"; $("opSNormDb").value = "-18"; $("opSGain").value = "0";
    toast("已按「环境音」勾好：低切 80Hz + 轻降噪 + 300ms 淡入淡出 + RMS -18dB");
  };
  const qs3 = $("qpSfxVoice");
  if (qs3) qs3.onclick = () => {
    ["opSTrim", "opSSpeed", "opSPitch", "opSFilter", "opSReverse", "opSConv", "opSFade"].forEach((i) => chk(i, false));
    chk("opSSep", true); chk("opSDn", true); chk("opSSil", true); chk("opSNorm", true);
    $("opSSepMode").value = "vocals"; $("opSSepStrength").value = "0.65"; $("vSep").textContent = "0.65";
    $("opSDnAmt").value = "0.5"; $("vSdn").textContent = "0.50";
    $("opSNormMode").value = "peak"; $("opSNormDb").value = "-1"; $("opSGain").value = "0";
    toast("已按「人声提示」勾好：提取人声 + 降噪 + 去静音 + 峰值 -1dB（需要立体声素材）");
  };

  const qc = $("qpClean");
  if (qc) qc.onclick = () => {
    $("opVocal").checked = true;
    $("opDenoise").checked = true;
    $("opTrimSil").checked = true;
    $("opNorm").checked = true;
    toast("已按「净化人声」勾好：人声分离 + 降噪 + 去静音 + 标准化。点「开始处理」执行。");
  };
  const qr = $("qpRef");
  if (qr) qr.onclick = () => {
    $("opVocal").checked = true;
    $("opDenoise").checked = true;
    $("opTrimSil").checked = true;
    $("opNorm").checked = true;
    $("opTrim").checked = true;
    $("opTrimStart").value = "0";
    $("opTrimEnd").value = "15";
    $("opConv").checked = true;
    $("opSr").value = "";
    $("opCh").value = "1";
    toast("已按「做成音色」勾好：人声 + 降噪 + 去静音 + 标准化 + 裁前 15s + 单声道。");
  };

  const tseg = $("matTargetSeg");
  if (tseg) tseg.querySelectorAll("button").forEach((b) => {
    b.onclick = () => {
      MAT.target = b.dataset.mt === "sfx" ? "sfx" : "ref";
      applyMatTarget();
      renderMatList();
      updateMatSelHint();
    };
  });
  const ks = $("matKeepSrc");
  if (ks) ks.onchange = () => { MAT.targetTouched = true; };
  const clr = $("btnMatClear");
  if (clr) clr.onclick = () => clearMatDesk();
  const trb = $("btnMatTrash");
  if (trb) trb.onclick = () => openMatTrash();
  const dir = $("btnMatDirect");
  if (dir) dir.onclick = () => runMatOps({ ops: {} });

  const rf = $("btnMatRefresh");
  if (rf) rf.onclick = () => loadMaterials();
  const all = $("btnMatAll");
  if (all) all.onclick = () => {
    if (MAT.sel.size === MAT.items.length) MAT.sel.clear();
    else MAT.items.forEach((x) => MAT.sel.add(x.id));
    renderMatList();
  };
  const run = $("btnMatRun");
  if (run) run.onclick = () => runMatOps();
}

/* ------------------------------ 音效素材库 ------------------------------ */
function sfxById(mid) {
  if (!mid) return null;
  return (SFX.items || []).find((x) => x.id === mid) || null;
}
function sfxNameOf(mid) {
  const it = sfxById(mid);
  return it ? it.name : "";
}

async function initSfxPanel() {
  if (!SFX.audio) {
    SFX.audio = regPlayer(new Audio(), () => { SFX.playId = null; renderSfxList(); });
    SFX.audio.onended = () => { SFX.playId = null; renderSfxList(); };
  }
  bindSfxEvents();
  await loadSfx();
}

function bindSfxEvents() {
  if (SFX.bound) return;
  SFX.bound = true;
  const fi = $("fileSfx");
  if (fi) fi.onchange = async () => {
    const files = Array.from(fi.files || []);
    fi.value = "";
    await uploadSfxFiles(files);
  };
  const seg = $("sfxViewSeg");
  if (seg) seg.querySelectorAll("button").forEach((b) => {
    b.onclick = () => {
      SFX.view = b.dataset.sv;
      try { localStorage.setItem("lf.sfxView", SFX.view); } catch (e) { /* 忽略 */ }
      renderSfxList();
    };
  });
  const sq = $("sfxSearch");
  if (sq) sq.oninput = () => { SFX.q = sq.value; renderSfxList(); };
  const paste = $("btnSfxPaste");
  if (paste) paste.onclick = () => pasteSfx();
  const pre = $("btnSfxPreprocess");
  if (pre) pre.onclick = () => openDrawer("media", "sfx");
  const rsf = $("btnSfxRefresh");
  if (rsf) rsf.onclick = async () => { await loadSfx(); toast("音效列表已刷新"); };
  const list = $("sfxList");
  if (list) {
    ["dragenter", "dragover"].forEach((ev) => list.addEventListener(ev, (e) => {
      e.preventDefault(); list.classList.add("over");
    }));
    ["dragleave", "dragend"].forEach((ev) => list.addEventListener(ev, () => list.classList.remove("over")));
    list.addEventListener("drop", async (e) => {
      e.preventDefault(); list.classList.remove("over");
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length) await uploadSfxFiles(files);
    });
  }
}

async function uploadSfxFiles(files) {
  if (!files || !files.length) return;
  let ok = 0, fail = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if ($("sfxHint")) $("sfxHint").textContent = `正在导入 ${i + 1}/${files.length}：${f.name}`;
    const fd = new FormData();
    fd.append("file", f);
    try {
      const r = await api("/sfx/upload", { method: "POST", body: fd });
      ok++;
      if (r && r.item && r.item.dur > 60) {
        toast(`「${r.item.name}」有 ${Math.round(r.item.dur)} 秒，挂到标签上会盖住后面的语音，建议先裁剪成短音效`, true);
      }
    } catch (e) {
      fail++;
      toast(`「${f.name}」导入失败：${e.message}`, true);
    }
  }
  await loadSfx();
  toast(`导入完成：成功 ${ok}${fail ? `，失败 ${fail}` : ""}`);
}

async function loadSfx() {
  try {
    const r = await api("/sfx");
    SFX.items = r.items || [];
  } catch (e) { SFX.items = []; }
  renderSfxList();
  updateSfxPaste();
}

function sfxVisible() {
  const q = (SFX.q || "").trim().toLowerCase();
  return (SFX.items || []).filter((it) => !q
    || ((it.name || "") + " " + (it.source || "") + " " + (it.op || "")).toLowerCase().includes(q));
}

function sfxPlayBtn(it) {
  const b = el("button", "iconbtn", SFX.playId === it.id ? "⏸" : "▶");
  b.dataset.sid = it.id;
  b.title = "试听 / 暂停";
  b.onclick = (e) => { e.stopPropagation(); toggleSfxPlay(it); };
  return b;
}

function renderSfxList() {
  const box = $("sfxList");
  if (!box) return;
  box.className = "matlist liblist mode-" + (SFX.view || "list");
  box.innerHTML = "";
  const shown = sfxVisible();
  const seg = $("sfxViewSeg");
  if (seg) seg.querySelectorAll("button").forEach((b) => b.classList.toggle("cur", b.dataset.sv === SFX.view));
  if ($("sfxCount")) {
    $("sfxCount").textContent = shown.length === SFX.items.length
      ? `${SFX.items.length} 个` : `${shown.length} / ${SFX.items.length} 个`;
  }
  if ($("sfxHint")) {
    const used = ((SCRIPT && SCRIPT.lines) || []).filter((l) => l.kind === "tag" && l.sfx && l.sfx.mid).length;
    $("sfxHint").textContent = SFX.items.length
      ? (used ? `当前台本有 ${used} 个标签挂了音效` : "还没有标签挂音效：在标签行点 🔔")
      : "音效库是空的，先上传，或从「处理结果」里右键「收进音效库」。";
  }
  if (!SFX.items.length) {
    box.appendChild(el("div", "empty", "还没有音效。点上面「＋ 上传音效」，或去「素材导入台」把视频/长音频裁成音效再存入。"));
    updateSfxPaste();
    return;
  }
  if (!shown.length) box.appendChild(el("div", "empty", "没有匹配的音效（换个关键词）"));

  shown.forEach((it) => {
    if (SFX.view === "list") {
      /* 两行式：第一行名字 + 来源标签，第二行处理链 + 参数。
         一行塞「名字 + 2 个标签 + 时长 + 按钮」会把名字挤成「34070595460-1-192·去…」，
         而且处理链一长就和参数粘在一起，读不出来。 */
      const row = el("div", "matitem");
      const main = el("div", "mmain");
      const l1 = el("div", "ml1");
      const name = el("span", "mname", it.name || it.file);
      name.title = `${it.name}\n来源：${it.source || "—"}\n文件：${it.file}\n右键更多`;
      name.onclick = (e) => renameSfx(it, ...xyOf(e));
      l1.appendChild(name);
      if (it.kind === "video") l1.appendChild(el("span", "mtag video", "视频抽取"));
      if (it.kind === "derived") l1.appendChild(el("span", "mtag derived", "处理结果"));
      main.appendChild(l1);
      const l2 = el("div", "ml2");
      if (it.op) {
        const op = el("span", "mtag op", it.op);
        op.title = it.op;
        l2.appendChild(op);
      }
      l2.appendChild(el("span", "mm", matMeta(it)));
      main.appendChild(l2);
      row.appendChild(main);
      row.appendChild(sfxPlayBtn(it));
      const cp = el("button", "iconbtn", "⧉");
      cp.title = "复制（之后可「粘贴副本」）";
      cp.onclick = (e) => { e.stopPropagation(); copySfx(it); };
      row.appendChild(cp);
      const del = el("button", "iconbtn", "✕");
      del.title = "删除音效";
      del.onclick = (e) => { e.stopPropagation(); deleteSfx(it); };
      row.appendChild(del);
      row.oncontextmenu = (e) => { e.preventDefault(); openSfxCtx(it, e.clientX, e.clientY); };
      box.appendChild(row);
      return;
    }
    const tile = el("div", "mattile");
    const top = el("div", "mt-top");
    const name = el("span", "mt-name", it.name || it.file);
    name.title = `${it.name}\n来源：${it.source || "—"}\n右键更多`;
    name.onclick = (e) => renameSfx(it, ...xyOf(e));
    top.appendChild(name);
    tile.appendChild(top);
    const tags = [];
    if (it.kind === "video") tags.push(["video", "视频抽取"]);
    if (it.kind === "derived") tags.push(["derived", "处理结果"]);
    if (it.op) tags.push(["op", it.op]);
    if (tags.length) {
      const tg = el("div", "mt-tags");
      tags.forEach(([cls, txt]) => tg.appendChild(el("span", "mtag " + cls, txt)));
      tile.appendChild(tg);
    }
    tile.appendChild(el("div", "mt-meta", matMeta(it)));
    const acts = el("div", "mt-act");
    acts.appendChild(sfxPlayBtn(it));
    const cp = el("button", "iconbtn", "⧉");
    cp.title = "复制";
    cp.onclick = (e) => { e.stopPropagation(); copySfx(it); };
    acts.appendChild(cp);
    const del = el("button", "iconbtn", "✕");
    del.title = "删除";
    del.onclick = (e) => { e.stopPropagation(); deleteSfx(it); };
    acts.appendChild(del);
    tile.appendChild(acts);
    tile.oncontextmenu = (e) => { e.preventDefault(); openSfxCtx(it, e.clientX, e.clientY); };
    box.appendChild(tile);
  });
  updateSfxPaste();
}

function toggleSfxPlay(it) {
  if (SFX.playId === it.id) {
    SFX.audio.pause();
    SFX.playId = null;
    renderSfxList();
    return;
  }
  pauseOthers(SFX.audio);
  SFX.audio.src = `${API}/sfx/${encodeURIComponent(it.id)}/audio?t=${Date.now()}`;
  SFX.audio.play().then(() => { SFX.playId = it.id; renderSfxList(); })
    .catch(() => toast("这个音效读不出来", true));
}

/* 右键菜单：试听 / 挂到标签 / 复制 / 粘贴 / 重命名 / 删除 */
function openSfxCtx(it, x, y) {
  const items = [{ head: (it.name || it.file) + ` · ${matDur(it.dur)}` }];
  items.push({ label: SFX.playId === it.id ? "⏸ 停止试听" : "▶ 试听", fn: () => { toggleSfxPlay(it); } });
  const tagCount = selectedTagLines().length;
  items.push({
    label: tagCount ? `🔔 挂到选中的 ${tagCount} 个标签` : "🔔 挂到当前标签",
    fn: () => attachSfxToTags(it),
  });
  items.push({ label: "ℹ 属性（声道 / 格式 / 采样率 / 位深…）", fn: () => showAudioProps("sfx", it.id) });
  items.push("-");
  items.push({ label: "⧉ 复制", fn: () => copySfx(it) });
  items.push({ label: "📋 粘贴副本", disabled: !SFX.clip, fn: () => pasteSfx(x, y) });
  items.push({ label: "✎ 重命名…", fn: () => renameSfx(it, x, y) });
  items.push({ label: "✎ 拷进导入台改一改", fn: () => preprocessSfx(it) });
  items.push("-");
  items.push({ label: "删除音效", danger: true, fn: () => deleteSfx(it) });
  buildCtx(items, true);
  showCtxAt(x, y);
}

function copySfx(it) {
  SFX.clip = it;
  updateSfxPaste();
  toast(`已复制「${it.name}」，右键或点「粘贴副本」新建一份`);
}

function updateSfxPaste() {
  const b = $("btnSfxPaste");
  if (!b) return;
  b.disabled = !SFX.clip;
  b.textContent = SFX.clip ? `粘贴副本（${(SFX.clip.name || "").slice(0, 6)}）` : "粘贴副本";
}

async function pasteSfx(x, y) {
  if (!SFX.clip) { toast("先右键一个音效选「复制」", true); return; }
  try {
    const r = await api(`/sfx/${encodeURIComponent(SFX.clip.id)}/duplicate`, {
      method: "POST", body: JSON.stringify({}),
    });
    await loadSfx();
    toast(`已粘贴：${r.item.name}`);
  } catch (e) { toast("粘贴失败：" + e.message, true); }
}

function renameSfx(it, x, y) {
  promptAt("重命名音效", it.name || it.file, x, y, async (val) => {
    const name = (val || "").trim();
    if (!name) { toast("名称不能为空", true); return; }
    try {
      await api(`/sfx/${encodeURIComponent(it.id)}`, { method: "PATCH", body: JSON.stringify({ name }) });
      await loadSfx();
      renderCenter();
      toast("已重命名");
    } catch (e) { toast(e.message, true); }
  }, { hint: "磁盘文件名一起改；已挂到标签的地方会按新名字显示" });
}

async function deleteSfx(it) {
  const used = ((SCRIPT && SCRIPT.lines) || []).filter((l) => l.kind === "tag" && l.sfx && l.sfx.mid === it.id);
  const okDel = confirm(`删除音效「${it.name}」？`
    + (used.length ? `\n\n有 ${used.length} 个标签在用这个音效，删除后它们会显示「音效已删除」。` : ""));
  if (!okDel) return;
  try {
    await api(`/sfx/${encodeURIComponent(it.id)}`, { method: "DELETE" });
    if (SFX.clip && SFX.clip.id === it.id) SFX.clip = null;
    await loadSfx();
    renderCenter();
    toast("已删除");
  } catch (e) { toast(e.message, true); }
}

/* 「在导入台里改」：把音效拷一份到导入台（原点留在音效库，改坏了也不影响） */
async function preprocessSfx(it) {
  try {
    const r = await api("/media/from-sfx", {
      method: "POST", body: JSON.stringify({ mid: it.id }),
    });
    openDrawer("media", "sfx");
    await loadMaterials();
    MAT.sel.clear();
    MAT.sel.add(r.item.id);
    renderMatList();
    updateMatSelHint();
    const out = $("matResult");
    if (out) out.innerHTML = `「${it.name}」已拷进导入台，改完点「处理并存入音效库」就是新音效。`;
    toast("已拷进导入台");
  } catch (e) { toast("拷进导入台失败：" + e.message, true); }
}

/* 音色同理：想重新裁一段就拷进导入台 */
async function refToInbox(r) {
  try {
    const res = await api("/media/from-ref", {
      method: "POST", body: JSON.stringify({ rid: r.id }),
    });
    openDrawer("media", "ref");
    await loadMaterials();
    MAT.sel.clear();
    MAT.sel.add(res.item.id);
    renderMatList();
    updateMatSelHint();
    toast("已拷进导入台，改完点「处理并存入音色库」");
  } catch (e) { toast("拷进导入台失败：" + e.message, true); }
}

/* 把音效挂到标签：优先用选中的标签，否则用光标所在的那一行 */
function selectedTagLines() {
  const lines = (SCRIPT && SCRIPT.lines) || [];
  let tags = lines.filter((l) => l.kind === "tag" && SEL.has(l.uid));
  if (!tags.length) {
    const cur = lines.find((l) => l.uid === lastFocusUid);
    if (cur && cur.kind === "tag") tags = [cur];
  }
  return tags;
}

function attachSfxToTags(it) {
  const tags = selectedTagLines();
  if (!tags.length) {
    toast("先在台本里点一下某个句间标签（或勾选它），再挂音效", true);
    return;
  }
  if ((it.dur || 0) > 30) {
    toast(`这个音效 ${Math.round(it.dur)} 秒，会盖住标签后面的语音；建议先在「素材导入台」里裁短`, true);
  }
  tags.forEach((l) => { l.sfx = { mid: it.id, gain: (l.sfx && l.sfx.gain) || 1 }; });
  commitSnapshot(`挂音效「${it.name}」到 ${tags.length} 个标签`);
  dirty = true;
  renderCenter(); renderStats(); queueSave();
  toast(tags.length > 1 ? `已挂到 ${tags.length} 个标签` : `已给〔${tags[0].tag || "标签"}〕挂上「${it.name}」`);
}

/* 标签侧的音效选择器 */
function openSfxPicker(line) {
  const wrap = el("div");
  const bar = el("div", "row2");
  const q = document.createElement("input");
  q.className = "inp grow"; q.placeholder = "搜音效名…";
  const up = el("button", "btn mini", "📥 去导入台");
  up.onclick = () => { closeModal(); openDrawer("media", "sfx"); };
  bar.appendChild(q); bar.appendChild(up);
  wrap.appendChild(bar);

  const list = el("div", "sfxpick");
  wrap.appendChild(list);
  let playingId = null;
  const preview = regPlayer(new Audio(), () => { playingId = null; });

  const apply = (it) => {
    line.sfx = it ? { mid: it.id, gain: (line.sfx && line.sfx.gain) || 1 }
      : null;
    commitSnapshot(it ? `给标签挂音效「${it.name}」` : "移除标签音效");
    dirty = true;
    renderCenter(); renderStats(); queueSave();
    if (it && (it.dur || 0) > 30) {
      toast(`「${it.name}」有 ${Math.round(it.dur)} 秒，比留白长很多，可能会盖住后面的语音`, true);
    }
    toast(it ? `已挂上「${it.name}」（留白 ${Math.round(line.hold || 0)}ms 后响起）` : "已移除音效");
    closeModal();
  };

  const draw = () => {
    list.innerHTML = "";
    const kw = (q.value || "").trim().toLowerCase();
    const items = (SFX.items || []).filter((it) => !kw
      || ((it.name || "") + " " + (it.source || "")).toLowerCase().includes(kw));
    if (!items.length) {
      list.appendChild(el("div", "hint", SFX.items.length
        ? "没有匹配的音效" : "音效库还是空的：点上面「📥 去导入台」上传/处理一段，存进音效库就能挑了"));
      return;
    }
    items.forEach((it) => {
      const on = line.sfx && line.sfx.mid === it.id;
      const row = el("div", "sfxpick-row" + (on ? " cur" : ""));
      const nm = el("b", "sfxpick-name", it.name || it.file);
      row.appendChild(nm);
      row.appendChild(el("span", "hint", matDur(it.dur)));
      if (it.op) row.appendChild(el("span", "mtag op", it.op));
      const play = el("button", "iconbtn", playingId === it.id ? "⏸" : "▶");
      play.title = "试听";
      play.onclick = (e) => {
        e.stopPropagation();
        if (playingId === it.id) { preview.pause(); playingId = null; draw(); return; }
        preview.src = `${API}/sfx/${encodeURIComponent(it.id)}/audio?t=${Date.now()}`;
        preview.play().then(() => { playingId = it.id; draw(); }).catch(() => toast("读不出来", true));
      };
      preview.onended = () => { playingId = null; draw(); };
      const use = el("button", "btn mini " + (on ? "" : "primary"), on ? "已挂载" : "用这个");
      use.onclick = (e) => { e.stopPropagation(); apply(it); };
      row.appendChild(play); row.appendChild(use);
      row.onclick = () => apply(it);
      list.appendChild(row);
    });
  };
  q.oninput = draw;
  draw();

  if (line.sfx) {
    const rm = el("button", "btn mini ghost", "移除这个标签的音效");
    rm.style.marginTop = "8px";
    rm.onclick = () => apply(null);
    wrap.appendChild(rm);
  }
  wrap.appendChild(el("div", "hint",
    "音效响起位置 = 标签时间 + 留白（在标签上点「修改」可以调留白）。进时间轴后会固定在素材轨同一位置。"));

  modal(`给〔${line.tag || "标签"}〕挂音效`, wrap, async () => true, "关闭");
}

function playSfxById(mid) {
  if (!mid) return;
  if (!SFX.audio) SFX.audio = new Audio();
  SFX.audio.src = `${API}/sfx/${encodeURIComponent(mid)}/audio?t=${Date.now()}`;
  SFX.audio.play().catch(() => toast("音效读不出来（可能已被删除）", true));
}

function removeTagSfx(line) {
  if (!line || !line.sfx) return;
  line.sfx = null;
  commitSnapshot("移除标签音效");
  dirty = true;
  renderCenter(); renderStats(); queueSave();
  toast("已移除这个标签的音效");
}

/* ------------------------------ 播放 ------------------------------ */
function playLine(uid_) {
  if (playingUid === uid_) { audio.pause(); playingUid = null; updatePlayBtns(); return; }
  pauseOthers(audio);
  audio.src = `${API}/scripts/${SCRIPT.id}/audio/${uid_}?t=${Date.now()}`;
  audio.play().then(() => { playingUid = uid_; updatePlayBtns(); })
    .catch(() => toast("这一行还没有音频", true));
}
audio.onended = () => { playingUid = null; updatePlayBtns(); };
function updatePlayBtns() {
  document.querySelectorAll(".iconbtn.play").forEach((b) => {
    const row = b.closest("[data-uid]");
    b.textContent = row && row.dataset.uid === playingUid ? "⏸" : "▶";
  });
}

/* ------------------------------ 弹窗 / 抽屉 ------------------------------ */
function modal(title, bodyNode, onOk, okText) {
  $("modalTitle").textContent = title;
  const cancelBtn = $("modalCancel");
  if (cancelBtn) cancelBtn.hidden = false;
  const body = $("modalBody");
  body.innerHTML = "";
  body.appendChild(bodyNode);
  $("modal").hidden = false;
  $("modalOk").textContent = okText || "确定";
  $("modalOk").onclick = async () => {
    const ok = await onOk();
    if (ok !== false) closeModal();
  };
}
function closeModal() {
  $("modal").hidden = true;
  stopAllAudio();   // 在弹窗里试听的音色/音效，关掉弹窗就别继续响了
}

/* ============================ 存储清理 ============================
   为什么能清出这么多：同一份音频在「音效库 / 素材库 / 工程 media」各存一份，
   导出产物（混音、工程 zip）留在工程里，删除只进回收站，打包导出还会留下
   .trash_* 暂存目录。这里按分类列出来，体积条形图一眼看出谁占地方。 */
function fmtSize(n) {
  n = Number(n) || 0;
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + " GB";
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + " MB";
  if (n >= 1024) return Math.round(n / 1024) + " KB";
  return n + " B";
}
const STORE_COLOR = {
  trash: "#d2372e", exports: "#c07d10", history: "#6b4fa8", peaks: "#1f5fe0",
  import: "#1e9e5a", outputs: "#8a8a8a", logs: "#8a8a8a", orphan: "#b26a00",
  dupes: "#b26a00",
};
/* 让本机服务在资源管理器里打开某个目录（浏览器没权限开本地路径）。
   传相对路径就是相对整合包根目录。 */
async function openLocalPath(path) {
  try {
    const r = await api("/storage/open", { method: "POST", body: { path: path || "" } });
    toast("已打开：" + (r.rel || r.path || path || "整合包目录"));
  } catch (e) {
    toast("打不开这个目录：" + e.message, true);
  }
}

function openStorage() {
  const body = document.createElement("div");
  body.className = "storebody";
  body.innerHTML = '<div class="hint">正在扫描…</div>';
  let data = null;
  const repaint = () => {
    body.innerHTML = "";
    if (!data) { body.innerHTML = '<div class="hint">扫描失败</div>'; return; }
    const head = document.createElement("div");
    head.className = "storehead";
    head.innerHTML = `<b>可清理 ${fmtSize(data.total)}</b>`
      + `<span>磁盘剩余 ${fmtSize(data.free)} / 共 ${fmtSize(data.capacity)}</span>`
      + `<span class="storepath" title="${data.root}">${data.root}</span>`;
    const bRoot = document.createElement("button");
    bRoot.type = "button";
    bRoot.className = "btn mini ghost storeopen";
    bRoot.textContent = "📂 打开数据目录";
    bRoot.title = "在资源管理器里打开 " + data.root;
    bRoot.onclick = () => openLocalPath("");
    head.appendChild(bRoot);
    body.appendChild(head);

    const max = Math.max(1, ...data.items.map((x) => x.size));
    const list = document.createElement("div");
    list.className = "storelist";
    data.items.forEach((it) => {
      const row = document.createElement("label");
      row.className = "storerow" + (it.size ? "" : " empty");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!it.default && it.size > 0;
      cb.disabled = !it.size || it.safe === false;
      cb.dataset.key = it.key;
      const main = document.createElement("div");
      main.className = "storemain";
      const top = document.createElement("div");
      top.className = "storetop";
      top.innerHTML = `<b>${it.label}</b>`
        + `<i>${it.count} 个文件</i><u>${fmtSize(it.size)}</u>`;
      const bar = document.createElement("div");
      bar.className = "storebar";
      const fill = document.createElement("i");
      fill.style.width = Math.max(it.size ? 2 : 0, (it.size / max) * 100) + "%";
      fill.style.background = STORE_COLOR[it.key] || "#888";
      bar.appendChild(fill);
      const desc = document.createElement("div");
      desc.className = "storedesc";
      desc.textContent = it.desc + (it.safe === false ? "（默认不勾：可能影响工程）" : "");
      main.appendChild(top);
      main.appendChild(bar);
      main.appendChild(desc);
      row.appendChild(cb);
      row.appendChild(main);
      // 每一类都能直接去看：删之前先确认里面是什么
      if (it.dir) {
        const bOpen = document.createElement("button");
        bOpen.type = "button";
        bOpen.className = "storeopen2";
        bOpen.textContent = "📂";
        bOpen.title = "打开 " + it.dir;
        bOpen.onclick = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          openLocalPath(it.dir);
        };
        row.appendChild(bOpen);
      }
      list.appendChild(row);
    });
    body.appendChild(list);

    if (data.big && data.big.length) {
      const bigBox = document.createElement("div");
      bigBox.className = "storebig";
      bigBox.innerHTML = "<b>最大的文件</b>";
      data.big.slice(0, 8).forEach((b) => {
        const line = document.createElement("div");
        line.className = "storebigrow";
        line.innerHTML = `<span>${fmtSize(b.size)}</span>`
          + `<i title="${b.path}（点一下在文件夹里定位）">`
          + `${b.path.split("/").slice(-2).join("/")}</i>`;
        line.onclick = () => openLocalPath(b.path);
        bigBox.appendChild(line);
      });
      body.appendChild(bigBox);
    }
    const tip = document.createElement("div");
    tip.className = "storenote";
    tip.textContent = "勾选后点「清理」；路径都在整合包内，删完会告诉你释放了多少。"
      + "拿不准的可以先点 📂 看一眼再决定。";
    body.appendChild(tip);
  };

  const load = async () => {
    try {
      data = await api("/storage/scan");
      repaint();
    } catch (e) {
      body.innerHTML = `<div class="hint">扫描失败：${e.message}</div>`;
    }
  };
  load();
  modal("🧹 存储清理", body, async () => {
    const keys = [...body.querySelectorAll('input[type=checkbox]:checked')]
      .map((x) => x.dataset.key);
    if (!keys.length) { toast("先勾几项", true); return false; }
    const names = (data.items || []).filter((x) => keys.includes(x.key))
      .map((x) => `${x.label}（${fmtSize(x.size)}）`).join("、");
    if (!confirm(`要清理这些吗？\n\n${names}\n\n删掉后无法从应用里恢复（回收站里的也会一起清空）。`)) {
      return false;
    }
    const btn = $("modalOk");
    btn.disabled = true;
    btn.textContent = "清理中…";
    try {
      const r = await api("/storage/clean", { method: "POST", body: { keys, budget: 6 } });
      toast(`已释放 ${fmtSize(r.freed)}（${r.removed} 个文件）` + (r.left ? `，还有 ${r.left} 项未删完，再点一次` : ""));
      await load();
      return r.left ? false : true;
    } catch (e) {
      toast("清理失败：" + e.message, true);
      return false;
    } finally {
      btn.disabled = false;
      btn.textContent = "确定";
    }
  }, "清理");
}

/* ------------------------------ 跟随鼠标的输入卡 ------------------------------ */
/* 抽屉（z-index 120）里再弹居中的大 modal，会被压在抽屉下面，看起来像"跑到工作台上"。
   重命名这种一步操作改用小卡片：浮在最上层、贴着鼠标出现、回车即保存。 */
let POP = { ok: null, cancel: null };

/* 取事件坐标；程序化 click / 键盘触发时用元素位置兜底（避免卡片飘到左上角） */
function xyOf(e) {
  if (e && (e.clientX || e.clientY)) return [e.clientX, e.clientY];
  const t = e && e.target;
  if (t && t.getBoundingClientRect) {
    const r = t.getBoundingClientRect();
    return [r.left + 8, r.top + Math.min(r.height, 28) / 2];
  }
  return [null, null];
}

function promptAt(title, value, x, y, onOk, opt) {
  opt = opt || {};
  const box = $("popcard");
  if (!box) return;
  $("popTitle").textContent = title || "重命名";
  const inp = $("popInput");
  inp.value = value == null ? "" : String(value);
  inp.placeholder = opt.placeholder || "";
  const hint = $("popHint");
  hint.textContent = opt.hint || "";
  hint.hidden = !opt.hint;
  POP.ok = onOk;
  POP.cancel = opt.onCancel || null;
  box.hidden = false;
  const w = box.offsetWidth || 272, h = box.offsetHeight || 120;
  const cx = x == null ? window.innerWidth / 2 : x;
  const cy = y == null ? 90 : y;
  let left = Math.min(Math.max(8, cx + 10), window.innerWidth - w - 8);
  let top = cy + 12;
  if (top + h > window.innerHeight - 8) top = Math.max(8, cy - h - 12);  // 靠近底部时翻到上方
  box.style.left = left + "px";
  box.style.top = top + "px";
  setTimeout(() => { inp.focus(); inp.select(); }, 0);
}

function closePop(apply) {
  const box = $("popcard");
  if (!box || box.hidden) return;
  box.hidden = true;
  const val = $("popInput").value;
  const fn = apply ? POP.ok : POP.cancel;
  POP.ok = null; POP.cancel = null;
  if (typeof fn === "function") fn(apply ? val : undefined);
}

function initPopcard() {
  const box = $("popcard");
  if (!box) return;
  $("popOk").onclick = () => closePop(true);
  $("popCancel").onclick = () => closePop(false);
  $("popInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); closePop(true); }
    else if (e.key === "Escape") { e.preventDefault(); closePop(false); }
    e.stopPropagation();
  });
  document.addEventListener("mousedown", (e) => {
    if (!box.hidden && !e.target.closest("#popcard")) closePop(false);
  }, true);
}

const DRAWER_TITLES = {
  default: "全局默认参数",
  voice: "🎙 音色素材库",
  sfx: "🔔 音效素材库",
  media: "📥 素材导入台",
  presets: "参数预设",
};

// 抽屉副标题：一句话说清「这个库是干什么的、文件从哪来、存到哪去」，
// 面板里就不用再放一遍大标题了。
const DRAWER_SUBS = {
  default: "整份台本的默认音色 / 情感 / 停顿 / 采样，没有单独覆盖的行都继承这里",
  voice: "参考音频 → 喂给模型生成语音（导入台存进来，固定 22.05k 单声道）",
  sfx: "给句间标签挂的音效素材（导入台存进来，44.1k 保留声道）",
  presets: "音色 + 情感 + 停顿 + 采样打包成一套，一键套用",
};

function openDrawer(pane, opt) {
  const target = pane === "media" ? (opt === "sfx" ? "sfx" : opt === "ref" ? "ref" : null) : null;
  $("drawerTitle").textContent = pane === "media"
    ? `📥 素材导入台 · 存入${(target || MAT.target) === "sfx" ? "音效库" : "音色库"}`
    : (DRAWER_TITLES[pane] || "音色素材库");
  const sub = $("drawerSub");
  if (sub) {
    sub.textContent = pane === "media"
      ? "中转站：上传的音频/视频先落在这里，处理完才成为音色或音效"
      : (DRAWER_SUBS[pane] || "");
  }
  document.querySelectorAll("#drawer .ppane").forEach((p) => p.classList.toggle("cur", p.dataset.pane === pane));
  const wide = pane === "voice" || pane === "media" || pane === "sfx" || pane === "presets";
  const box = document.querySelector("#drawer .drawer-box");
  if (box) box.classList.toggle("wide", wide);
  $("drawer").hidden = false;
  if (pane === "voice") { renderRefList(); }
  if (pane === "sfx") { initSfxPanel(); }
  if (pane === "media") { initMediaPanel(target || MAT.target); }
  if (pane === "presets") { loadPresets(); }
  if (pane === "default") syncDefaultPanel();
}
function closeDrawer() {
  stopAllAudio();   // 关掉素材库，正在试听的也一起停
  if (EMBED) {
    // 内嵌时「关闭」= 让父窗口把整个抽屉收起来，自己不能变空白
    try { window.parent.postMessage({ type: "lf-desk-close" }, "*"); } catch (e) { /* 忽略 */ }
    return;
  }
  $("drawer").hidden = true;
}

/* ------------------------------ 面板宽度 ------------------------------ */
function initResizers() {
  const main = $("lfMain");
  try {
    const saved = JSON.parse(localStorage.getItem("lf.widths") || "{}");
    if (saved.left) main.style.setProperty("--w-left", saved.left + "px");
    if (saved.right) main.style.setProperty("--w-right", saved.right + "px");
  } catch (e) { /* 忽略 */ }

  const drag = (handleId, side, min, max) => {
    const h = $(handleId);
    h.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const pane = side === "left" ? $("sidePane") : $("panelPane");
      const startW = pane.getBoundingClientRect().width;
      document.body.classList.add("resizing");
      const move = (ev) => {
        const dx = side === "left" ? ev.clientX - startX : startX - ev.clientX;
        const w = Math.max(min, Math.min(max, startW + dx));
        main.style.setProperty(side === "left" ? "--w-left" : "--w-right", w + "px");
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        document.body.classList.remove("resizing");
        try {
          localStorage.setItem("lf.widths", JSON.stringify({
            left: Math.round($("sidePane").getBoundingClientRect().width),
            right: Math.round($("panelPane").getBoundingClientRect().width),
          }));
        } catch (e2) { /* 忽略 */ }
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  };
  drag("rzLeft", "left", 140, 420);
  drag("rzRight", "right", 300, 660);
}

/* ------------------------------ 顶部 ------------------------------ */
/* ------------------------------ 主题 ------------------------------ */
// 浅色/夜间共用 localStorage["lf.theme"]，时间轴页读同一个键，切了就一起变。
function applyLfTheme(t) {
  const dark = t === "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const b = $("btnLfTheme");
  if (b) {
    b.textContent = dark ? "☀ 日间" : "🌙 夜间";
    b.classList.toggle("on", dark);
  }
}

function initLfTheme() {
  applyLfTheme(localStorage.getItem("lf.theme") === "dark" ? "dark" : "light");
  const b = $("btnLfTheme");
  if (b) {
    b.onclick = () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      localStorage.setItem("lf.theme", next);
      applyLfTheme(next);
    };
  }
  window.addEventListener("storage", (e) => {
    if (e.key === "lf.theme") applyLfTheme(e.newValue === "dark" ? "dark" : "light");
  });
}

function initHeader() {
  // 顶栏两行，高度随内容变：把真实高度写给 sticky 工具栏，避免遮住第一行
  const head = document.querySelector(".lf-head");
  if (head) {
    const setHeadH = () => document.documentElement.style.setProperty("--head-h", head.offsetHeight + "px");
    setHeadH();
    if (window.ResizeObserver) new ResizeObserver(setHeadH).observe(head);
    window.addEventListener("resize", setHeadH);
  }
  /* 「第一次用？」：教程是独立页面（新标签打开），不干扰正在编辑的台本 */
  const bg = $("btnGuide");
  if (bg) bg.onclick = () => window.open("/guide", "_blank");

  const deskBtn = $("btnImportDesk");
  if (deskBtn) deskBtn.onclick = () => openDrawer("media", MAT.target);
  $("btnDefaults").onclick = () => openDrawer("default");
  $("btnVoiceLib").onclick = () => openDrawer("voice");
  const bs = $("btnSfxLib");
  if (bs) bs.onclick = () => openDrawer("sfx");
  $("btnPresets").onclick = () => openDrawer("presets");
  const jr = $("btnJumpRef");
  if (jr) jr.onclick = () => openDrawer("voice");
  const js = $("btnJumpSfx");
  if (js) js.onclick = () => openDrawer("sfx");
  $("drawerClose").onclick = closeDrawer;
  $("drawer").addEventListener("click", (e) => {
    if (EMBED) return;
    if (e.target.id === "drawer") closeDrawer();
  });
  initLfTheme();
  const moreBtn = $("btnScriptsMore");
  if (moreBtn) moreBtn.onclick = (e) => { e.stopPropagation(); openSideMenu(moreBtn); };
  /* 台本多选条：全选 / 复制 / 删除 / 取消 */
  const ssAll = $("btnSsAll"), ssDupB = $("btnSsDup"), ssDelB = $("btnSsDel"), ssClr = $("btnSsClear");
  if (ssAll) ssAll.onclick = () => {
    SORDER.forEach((id) => SSEL.add(id));
    if (SORDER.length && !SANC) SANC = SORDER[0];
    ssUpdateBar();
    toast(`已选中 ${SORDER.length} 份`);
  };
  if (ssDupB) ssDupB.onclick = () => ssDuplicate(Array.from(SSEL));
  if (ssDelB) ssDelB.onclick = () => ssDelete(Array.from(SSEL));
  if (ssClr) ssClr.onclick = ssClear;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && SSEL.size) { ssClear(); }
  });

  $("btnNew").onclick = () => {
    const wrap = el("div");
    const title = document.createElement("input");
    title.className = "inp"; title.value = "台本 " + new Date().toLocaleDateString();
    wrap.appendChild(el("div", "fl", "标题"));
    wrap.appendChild(title);
    const ta = document.createElement("textarea");
    ta.placeholder = "把整篇台本粘进来…";
    wrap.appendChild(el("div", "fl", "文本"));
    wrap.appendChild(ta);
    const row = el("div", "row2");
    row.style.marginTop = "8px";
    const num = document.createElement("input");
    num.className = "inp"; num.type = "number"; num.min = "10"; num.max = "400"; num.step = "5"; num.value = "70";
    const modeSel = document.createElement("select");
    modeSel.className = "sel";
    modeSel.innerHTML = '<option value="packed">按长度合并</option><option value="sentence">一句一行</option>';
    row.appendChild(el("span", "hint", "每行字数"));
    row.appendChild(num); row.appendChild(modeSel);
    wrap.appendChild(row);
    wrap.appendChild(el("div", "hint", "「一句一行」严格按句号/问号/感叹号/分号/省略号/破折号切。"));

    modal("新建台本", wrap, async () => {
      const text = ta.value.trim();
      if (!text) { toast("台本内容是空的", true); return false; }
      try {
        const r = await api("/scripts", {
          method: "POST",
          body: JSON.stringify({
            title: title.value, text, max_chars: parseInt(num.value, 10) || 70, mode: modeSel.value,
          }),
        });
        SCRIPT = r.script;
        STATS = { lines: r.script.lines.length, speech: r.script.lines.length, chars: text.length, done: 0, tags: 0 };
        SEL.clear(); REDO = [];
        UNDO = [{ label: "新建台本", time: Date.now(), lines: deepCopy(SCRIPT.lines), key: snapshotKey() }];
        updateUndoButtons();
        fillRefSelects(); syncDefaultPanel(); renderAll();
        localStorage.setItem("lf.last", SCRIPT.id);
        toast(`已切出 ${r.script.lines.length} 行`);
      } catch (e) { toast(e.message, true); return false; }
    }, "创建");
  };

  $("btnImport").onclick = () => {
    if (!SCRIPT) return;
    const wrap = el("div");
    const ta = document.createElement("textarea");
    ta.placeholder = "粘贴要追加的文本…";
    wrap.appendChild(ta);
    const row = el("div", "row2");
    row.style.marginTop = "8px";
    const num = document.createElement("input");
    num.className = "inp"; num.type = "number"; num.min = "10"; num.max = "400"; num.step = "5"; num.value = "70";
    const modeSel = document.createElement("select");
    modeSel.className = "sel";
    modeSel.innerHTML = '<option value="packed">按长度合并</option><option value="sentence">一句一行</option>';
    const posSel = document.createElement("select");
    posSel.className = "sel";
    posSel.innerHTML = '<option value="end">追加到末尾</option>' +
      (lastFocusUid ? '<option value="after">插到当前行之后</option>' : '');
    row.appendChild(num); row.appendChild(modeSel); row.appendChild(posSel);
    wrap.appendChild(row);
    modal("导入文本", wrap, async () => {
      const text = ta.value.trim();
      if (!text) return false;
      const at = posSel.value === "after" && lastFocusUid
        ? SCRIPT.lines.findIndex((l) => l.uid === lastFocusUid) + 1 : null;
      try {
        const r = await api(`/scripts/${SCRIPT.id}/import`, {
          method: "POST",
          body: JSON.stringify({ text, max_chars: parseInt(num.value, 10) || 70, mode: modeSel.value, at }),
        });
        await switchScript(SCRIPT.id);
        toast(`已导入 ${r.added} 行`);
      } catch (e) { toast(e.message, true); return false; }
    }, "导入");
  };

  $("btnExportMap").onclick = async () => {
    if (!SCRIPT) return;
    if (dirty) await saveNow();
    const box = $("exMapResult");
    box.textContent = "正在生成…";
    try {
      const r = await api(`/scripts/${SCRIPT.id}/export/map`);
      box.innerHTML = "";
      const d = el("div", "exp");
      d.appendChild(el("div", "n", `${r.file} · ${r.rows} 行`));
      const rr = el("div", "r");
      const a = el("a", null, "下载 CSV");
      a.href = exportUrl(SCRIPT.id, r.file);
      a.download = r.file;
      rr.appendChild(a);
      d.appendChild(rr);
      box.appendChild(d);
      refreshExports();
      toast("映射 CSV 已生成");
    } catch (e) { box.textContent = "生成失败：" + e.message; }
  };

  $("btnSave").onclick = async () => { await saveNow(); toast("已保存"); };
  $("scriptSel").onchange = () => switchScript($("scriptSel").value);
  $("selAll").onchange = () => {
    SEL.clear();
    if ($("selAll").checked) visibleEntries().forEach((x) => SEL.add(x.line.uid));
    refreshSelClasses();
  };
  $("btnSelRange").onclick = () => {
    const set = parseRange($("rangeInput").value);
    if (!set.size) { toast("区间写法不对，例如 1-20,25,30-", true); return; }
    set.forEach((u) => SEL.add(u));
    refreshSelClasses();
  };
  $("btnSelMissing").onclick = () => {
    SEL.clear();
    SCRIPT.lines.forEach((l) => { if (l.kind !== "tag" && l.status !== "done") SEL.add(l.uid); });
    refreshSelClasses();
  };
  $("btnSelNone").onclick = () => { SEL.clear(); refreshSelClasses(); };
  $("btnSelHead").onclick = () => {
    const u = anchorUid();
    if (!u) { toast("先点一下某一句，再往前全选", true); return; }
    selectThrough(u, -1);
  };
  $("btnSelTail").onclick = () => {
    const u = anchorUid();
    if (!u) { toast("先点一下某一句，再往后全选", true); return; }
    selectThrough(u, 1);
  };
  const bp1 = $("btnBulkProps"), bp2 = $("btnBulkProps2");
  if (bp1) bp1.onclick = openBulkProps;
  if (bp2) bp2.onclick = openBulkProps;
  const bcs = $("btnCopySel"), bps = $("btnPasteLines");
  if (bcs) bcs.onclick = () => copyLines();
  if (bps) bps.onclick = () => pasteLines();
  const bpu = $("btnPropUndo");
  if (bpu) bpu.onclick = () => undoLastProp();
  updatePasteBtn();
  updatePropUndoBtn();
  $("btnAddTail").onclick = addTailLine;
  $("btnAddTag").onclick = () => openTagPicker(lastFocusUid || null);
  $("btnSmartSplit").onclick = openSmartSplit;
  $("btnUndo").onclick = () => runHist(undo);
  $("btnRedo").onclick = () => runHist(redo);
  $("btnHistory").onclick = openHistory;
  $("btnTimeline").onclick = async () => {
    if (!SCRIPT) { toast("先打开一个台本", true); return; }
    if (dirty) await saveNow();
    // 已经是工程：直接进；否则先复制一份工程副本，原台本留作初始样本
    if (SCRIPT.project) {
      window.open(`/timeline?sid=${SCRIPT.id}`, "_blank");
      return;
    }
    const okGo = confirm(
      "进入时间轴编辑会新建一份「工程副本」：\n\n"
      + "· 原台本保持不动，作为初始样本\n"
      + "· 副本里的改动（重生成、改文本）不影响原台本\n"
      + "· 随时可以在顶栏「回到初始样本」退回进入时的状态\n\n继续？");
    if (!okGo) return;
    try {
      const r = await api(`/scripts/${SCRIPT.id}/project`, { method: "POST", body: {} });
      toast("已创建工程：" + (r.script && r.script.title || ""));
      await loadScripts();
      await switchScript(r.id);
      window.open(`/timeline?sid=${r.id}`, "_blank");
    } catch (e) {
      toast("创建工程失败：" + e.message, true);
    }
  };

  $("btnInitial").onclick = async () => {
    if (!SCRIPT || !SCRIPT.project) return;
    if (!confirm("回到初始样本？\n\n当前这份工程里的台本内容会被替换成进入时间轴时的状态（改动前会自动存一份历史副本）。\n音频文件不会被删除。")) return;
    try {
      const r = await api(`/scripts/${SCRIPT.id}/restore-initial`, { method: "POST", body: {} });
      SCRIPT = r.script; STATS = r.stats;
      SEL.clear(); REDO = [];
      UNDO = [{ label: "恢复初始样本", time: Date.now(), lines: deepCopy(SCRIPT.lines), key: snapshotKey() }];
      renderAll();
      toast("已回到初始样本");
    } catch (e) {
      toast("恢复失败：" + e.message, true);
    }
  };
  /* ---------------- 与时间轴同步 ----------------
     两边操作的是同一份 script.json（进时间轴时台本页已经切到工程副本），
     所以在窗口重新拿到焦点时比一下 updated 就够，不需要额外推消息。
     有未保存的本地改动就不同步，免得把用户正在打字的东西冲掉。 */
  let syncBusy = false;
  async function syncFromTimeline() {
    if (!SCRIPT || !SCRIPT.id || dirty || syncBusy || document.hidden) return;
    syncBusy = true;
    try {
      const r = await api(`/scripts/${SCRIPT.id}`);
      const cur = r.script || {};
      if (String(cur.updated) !== String(SCRIPT.updated)) {
        SCRIPT = cur;
        STATS = r.stats;
        RENDER = r.render || RENDER;
        SEL.clear();
        renderAll();
        paintRender();
        toast("已同步时间轴里的改动");
      }
      // 时间轴点了「改属性并重生成」→ 这边跟着显示进度
      if (r.render && ["running", "queued", "stopping"].includes(r.render.state) && !pollTimer) {
        startPolling();
      }
    } catch (e) { /* 网络抖动就算了，不打扰 */ }
    finally { syncBusy = false; }
  }
  window.addEventListener("focus", syncFromTimeline);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) syncFromTimeline(); });

  $("btnNewBatch").onclick = () => openBatchDialog(null);
  $("btnSelUncovered").onclick = () => {
    const cov = batchCoverage();
    applySel($("btnSelUncovered"), cov.uncovered.map((l) => l.uid), "所有句子都已经分组");
  };
  $("btnSelOverlap").onclick = () => {
    const cov = batchCoverage();
    applySel($("btnSelOverlap"), cov.overlap.map((l) => l.uid), "没有同时属于多个分组的句子");
  };
  document.querySelectorAll("#viewSeg button").forEach((b) => (b.onclick = () => setView(b.dataset.view)));
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#ctxMenu")) hideCtx();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    hideCtx(); stopAllAudio();
    if (EMBED) {
      try { window.parent.postMessage({ type: "lf-desk-close" }, "*"); } catch (err) { /* 忽略 */ }
      return;
    }
    closeDrawer();
  });
}

function switchPane(name) {
  document.querySelectorAll(".ptab").forEach((b) => b.classList.toggle("cur", b.dataset.tab === name));
  document.querySelectorAll(".lf-panel .ppane").forEach((p) => p.classList.toggle("cur", p.dataset.pane === name));
  if (name === "export") {
    refreshSelExportState();
    refreshExEstimate();
    refreshExports();
  }
  if (name === "batch") { renderBatchList(); renderBatchStats(); }
  if (name === "render") renderRenderBatches();
}

/* ------------------------------ 启动 ------------------------------ */
/* ============================ 智能导入向导 ============================
   三步：选文件 → 自动判断类别（5 类，可手改 + 调选项）→ 预览（可人工拆分/合并/改分组）→ 导入。

   数据流：
     文件 → /import/inspect（服务端解析成中间源，返回 token）
         → /import/plan（带模板 + 选项，返回 groups/segments/issues）
         → 用户在前端改 groups（本对象就是最终 payload）
         → /import/commit（建台本 + 每个分组一个批量任务）
   所有自动规则都只是「建议」，预览里的每个分段都能改。
*/
const IMP = {
  step: 1,
  src: null,          // inspect 返回体
  classes: [],        // 5 个类别（时间轴 / 剧本 / 小说 / 指令 / 纯文本）
  meta: null,
  clsId: "",          // 当前选中的类别
  det: null,          // /import/detect 的结果（分数 + 证据）
  opts: {},           // 用户改过的选项（没改过就用类别默认）
  title: "",
  groups: [],
  issues: [],
  stats: null,
  busy: false,
  caret: null,
};

async function impLoadMeta() {
  if (IMP.classes.length) return;
  const d = await api("/import/classes");
  IMP.classes = d.classes || [];
  IMP.meta = { labels: d.group_labels || {}, max: d.max_seg_chars || 300 };
}

function impEl(tag, cls, text) { return el(tag, cls, text); }

function impMask() {
  let m = $("impMask");
  if (m) return m;
  m = document.createElement("div");
  m.className = "mask imp";
  m.id = "impMask";
  const box = impEl("div", "impbox");
  const head = impEl("div", "imphead");
  head.appendChild(impEl("b", null, "🧠 智能导入"));
  const steps = impEl("div", "impsteps");
  steps.id = "impSteps";
  head.appendChild(steps);
  head.appendChild(impEl("span", "spacer"));
  const close = impEl("button", "iconbtn", "✕");
  close.title = "关闭";
  close.onclick = impClose;
  head.appendChild(close);
  box.appendChild(head);
  const body = impEl("div", "impbody");
  body.id = "impBody";
  box.appendChild(body);
  const foot = impEl("div", "impfoot");
  foot.id = "impFoot";
  box.appendChild(foot);
  m.appendChild(box);
  m.addEventListener("mousedown", (e) => { if (e.target === m) impClose(); });
  document.body.appendChild(m);
  return m;
}

function impClose() {
  const m = $("impMask");
  if (m) m.remove();
  IMP.step = 1; IMP.src = null; IMP.groups = []; IMP.issues = []; IMP.stats = null;
}

function impPaintSteps() {
  const box = $("impSteps");
  if (!box) return;
  box.innerHTML = "";
  const names = ["① 选文件", "② 识别类别", "③ 预览编辑"];
  names.forEach((n, i) => {
    const it = impEl("i", i + 1 === IMP.step ? "cur" : (i + 1 < IMP.step ? "done" : ""), n);
    box.appendChild(it);
  });
}

function impGo(step) {
  const same = step === IMP.step;
  const keep = same ? (IMP.scrollTop || 0) : 0;
  IMP.step = step;
  impPaintSteps();
  const body = $("impBody"), foot = $("impFoot");
  body.innerHTML = ""; foot.innerHTML = "";
  if (step === 1) impStep1(body, foot);
  else if (step === 2) impStep2(body, foot);
  else impStep3(body, foot);
  // 同一步内重绘（拆分 / 合并 / 删除）保持滚动位置，否则每点一下都跳回顶部
  body.scrollTop = keep;
  body.onscroll = () => { IMP.scrollTop = body.scrollTop; };
}

async function openSmartImport() {
  try { await impLoadMeta(); } catch (e) { toast("模板加载失败：" + e.message, true); return; }
  impMask();
  impGo(1);
}

/* ------------------------------ 步骤 1 ------------------------------ */
function impStep1(body, foot) {
  const drop = impEl("label", "impdrop");
  drop.innerHTML = '<b>把文件拖到这里，或点击选择</b>' +
    '<span>支持 txt / md / docx / srt 字幕 / csv / fountain 剧本（.fountain）· 最大 40MB</span>';
  const fi = document.createElement("input");
  fi.type = "file";
  fi.accept = ".txt,.md,.docx,.srt,.csv,.tsv,.fountain,text/plain,text/csv";
  fi.onchange = () => { const f = fi.files && fi.files[0]; if (f) impUpload(f); };
  drop.appendChild(fi);
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.add("over");
  }));
  ["dragleave", "dragend"].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove("over")));
  drop.addEventListener("drop", (e) => {
    e.preventDefault(); drop.classList.remove("over");
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) impUpload(f);
  });
  body.appendChild(drop);

  const or = impEl("div", "impor", "或者直接粘贴文本");
  body.appendChild(or);

  const ta = document.createElement("textarea");
  ta.className = "impraw";
  ta.placeholder = "粘贴剧本 / 字幕 / 讲稿正文（会按你选的模板识别）…";
  ta.value = IMP.rawText || "";
  ta.oninput = () => { IMP.rawText = ta.value; };
  body.appendChild(ta);

  const row = impEl("div", "impselrow");
  const btn = impEl("button", "btn", "识别这段文本");
  btn.onclick = () => {
    const text = ta.value.trim();
    if (text.length < 4) { toast("先粘一段文本", true); return; }
    impInspectText(text);
  };
  const sample = impEl("button", "btn mini ghost", "看个示例");
  sample.onclick = async () => {
    try {
      const d = await api("/import/sample/fountain");
      ta.value = d.text || "";
      toast("已填入示例剧本，点「识别这段文本」试试");
    } catch (e) { toast(e.message, true); }
  };
  row.appendChild(btn);
  row.appendChild(sample);
  body.appendChild(row);

  if (IMP.src && IMP.src.token) {
    const info = impEl("div", "impfileinfo");
    info.appendChild(impEl("span", null, "已解析："));
    info.appendChild(impEl("b", null, IMP.src.filename || "文本"));
    info.appendChild(impEl("span", null,
      `· ${IMP.src.kind} · ${IMP.src.chars} 字${IMP.src.meta && IMP.src.meta.cues ? ` · ${IMP.src.meta.cues} 条字幕` : ""}`));
    body.appendChild(info);
    const pv = impEl("div", "hint");
    pv.style.whiteSpace = "pre-wrap";
    pv.style.maxHeight = "150px";
    pv.style.overflow = "auto";
    pv.style.marginTop = "8px";
    pv.textContent = (IMP.src.preview || "").slice(0, 800);
    body.appendChild(pv);
  }

  const cancel = impEl("button", "btn ghost", "取消");
  cancel.onclick = impClose;
  const next = impEl("button", "btn primary", "下一步：识别类别");
  next.disabled = !(IMP.src && IMP.src.token);
  next.textContent = "下一步：识别类别";
  next.onclick = async () => {
    next.disabled = true;
    try { await impDetect(); } catch (e) { toast("特征分析失败：" + e.message, true); }
    next.disabled = false;
    impGo(2);
  };
  foot.appendChild(impEl("span", "hint", IMP.src ? "" : "先选文件或粘贴文本，解析后才能继续"));
  foot.appendChild(impEl("span", "spacer"));
  foot.appendChild(cancel);
  foot.appendChild(next);
}

async function impUpload(file) {
  const fd = new FormData();
  fd.append("file", file);
  try {
    toast("正在解析文件…");
    const d = await api("/import/inspect", { method: "POST", body: fd });
    IMP.src = d;
    IMP.groups = []; IMP.issues = []; IMP.stats = null;
    IMP.det = null; IMP.clsId = ""; IMP.opts = {};
    if (!IMP.title) IMP.title = (file.name || "").replace(/\.[^.]+$/, "");
    impGo(1);
    toast(`已解析：${d.filename}（${d.kind}，${d.chars} 字）`);
  } catch (e) { toast("解析失败：" + e.message, true); }
}

async function impInspectText(text) {
  try {
    toast("正在解析文本…");
    const d = await api("/import/text", { method: "POST", body: JSON.stringify({ text }) });
    IMP.src = d;
    IMP.rawText = text;
    IMP.groups = []; IMP.issues = []; IMP.stats = null;
    IMP.det = null; IMP.clsId = ""; IMP.opts = {};
    if (!IMP.title) IMP.title = "智能导入 " + new Date().toLocaleDateString();
    impGo(1);
  } catch (e) { toast("解析失败：" + e.message, true); }
}

/* 模板说明 / 标准格式示例窗口：
   每个目标都有一份「长什么样、会被识别成什么」的标准格式，能直接复制去改写；
   也能一键把示例塞进粘贴框，走一遍完整流程看效果。 */
function impTemplateDetail(tpl) {
  if (!tpl || !tpl.id) { toast("类别还没加载完", true); return; }
  const wrap = el("div", "impdetailbox");
  if (tpl.detail) {
    // 说明里用 **粗体** 标重点：这里做一次极简渲染（只有粗体，别的一律当纯文本）
    const rich = (txt) => {
      const box = el("div", "impdetail");
      (txt || "").split("\n").forEach((ln) => {
        const row = el("div");
        ln.split("**").forEach((seg, i) => {
          if (!seg) return;
          if (i % 2) row.appendChild(el("b", null, seg));
          else row.appendChild(document.createTextNode(seg));
        });
        box.appendChild(row);
      });
      return box;
    };
    wrap.appendChild(rich(tpl.detail));
  }
  const meta = el("div", "impmeta");
  if (tpl.formats) meta.appendChild(el("span", "tag", `支持格式：${tpl.formats.join(" / ")}`));
  const gb = tpl.default_group || tpl.group_by;
  meta.appendChild(el("span", "tag", `默认分组：${(IMP.meta.labels || {})[gb] || gb || "不分组"}`));
  meta.appendChild(el("span", "tag", `单段上限：${tpl.default_max || tpl.max_chars || 70} 字`));
  const sc = impScoreOf(tpl.id);
  if (sc > 0) meta.appendChild(el("span", "tag", `本文匹配度：${Math.round(sc * 100)}%`));
  wrap.appendChild(meta);

  const rules = tpl.rules || tpl.hints || [];
  if (rules.length) {
    const rl = el("div", "imprules");
    rules.forEach((r) => rl.appendChild(el("span", "rule", "✓ " + r)));
    wrap.appendChild(rl);
  }
  if ((tpl.presets || []).length) {
    const pl = el("div", "imppresets detail");
    pl.appendChild(el("span", "lab", "预设："));
    tpl.presets.forEach((p) => {
      const b = el("span", "rule", p.name);
      b.title = "套用这组选项";
      b.onclick = () => {
        closeModal();
        IMP.clsId = tpl.id;
        IMP.opts = Object.assign({}, p.opts || {});
        if (IMP.step === 2) impGo(2);
      };
      pl.appendChild(b);
    });
    wrap.appendChild(pl);
  }

  wrap.appendChild(el("div", "fl", "标准格式示例（可以直接复制去改写）"));
  const pre = el("pre", "impsample");
  pre.textContent = tpl.sample || "（这个类别没有示例）";
  wrap.appendChild(pre);

  const bar = el("div", "btnrow");
  const cp = el("button", "btn mini", "⧉ 复制示例");
  cp.type = "button";
  cp.onclick = async () => {
    await copyText(tpl.sample || "");
    toast("示例已复制");
  };
  const tryIt = el("button", "btn mini primary", "用这份示例试一遍");
  tryIt.type = "button";
  tryIt.onclick = () => {
    closeModal();
    impClose();          // 关掉当前向导，重新开一次，把示例填进粘贴框
    IMP.rawText = tpl.sample || "";
    IMP.clsId = "";
    openSmartImport().then(() => {
      const ta = document.querySelector("textarea.impraw");
      if (ta) { ta.value = IMP.rawText; }
      toast("示例已填入，点「识别这段文本」试试");
    });
  };
  bar.appendChild(cp);
  bar.appendChild(tryIt);
  wrap.appendChild(bar);

  modal(`${tpl.icon || ""} ${tpl.name || ""}`, wrap, () => true, "关闭");
  // 这个窗口只是「看 + 复制」，留一个「关闭」就够了，别再摆个「取消」
  const cancelBtn = $("modalCancel");
  if (cancelBtn) cancelBtn.hidden = true;
}

/* ------------------------------ 步骤 2：识别类别 + 选项 ------------------------------ */
function impCls() {
  return (IMP.classes || []).find((c) => c.id === IMP.clsId) || (IMP.classes || [])[0] || {};
}

// 「这个选项现在是什么值」：用户改过的优先，否则用类别默认
function impVal(desc) {
  if (IMP.opts[desc.k] !== undefined) return IMP.opts[desc.k];
  return desc.def;
}

/* 拉一次特征检测（每个文件只做一次），返回 detect 结果 */
async function impDetect() {
  if (!IMP.src || !IMP.src.token) return null;
  if (IMP.det && IMP.det._token === IMP.src.token) return IMP.det;
  const d = await api("/import/detect", { method: "POST", body: JSON.stringify({ token: IMP.src.token }) });
  d._token = IMP.src.token;
  IMP.det = d;
  if (!IMP.clsId) IMP.clsId = d.cls;
  return d;
}

function impScoreOf(cid) {
  const r = ((IMP.det || {}).ranked || []).find((x) => x.cls === cid);
  return r ? r.score : 0;
}

function impStep2(body, foot) {
  if (!IMP.det || IMP.det._token !== (IMP.src || {}).token) {
    // 还没检测过：先显示占位，拿到结果再重绘这一步
    body.appendChild(impEl("div", "impempty", "正在分析文本特征…"));
    impDetect().then(() => impGo(2)).catch((e) => toast("特征分析失败：" + e.message, true));
    foot.appendChild(impEl("span", "spacer"));
    const back0 = impEl("button", "btn ghost", "上一步");
    back0.onclick = () => impGo(1);
    foot.appendChild(back0);
    return;
  }

  const det = IMP.det;
  const cls = impCls();

  /* ---- ① 识别结果：这一类是怎么判出来的 ---- */
  const res = impEl("div", "impdetect");
  const head = impEl("div", "dhead");
  head.appendChild(impEl("span", "dicon", det.cls_info ? "" : ""));
  head.appendChild(impEl("b", null, `识别为：${cls.icon || ""} ${cls.name || ""}`));
  const conf = { high: "把握很大", mid: "比较像", low: "不太确定" }[det.confidence] || "";
  head.appendChild(impEl("span", "dconf " + (det.confidence || ""), conf));
  res.appendChild(head);
  const uls = impEl("ul", "dev");
  (det.evidence || []).forEach((x) => uls.appendChild(impEl("li", null, x)));
  res.appendChild(uls);
  const others = (det.ranked || []).filter((r) => r.cls !== cls.id && r.score >= 0.35);
  if (others.length) {
    const line = impEl("div", "dother");
    line.appendChild(impEl("span", "hint", "也可以按："));
    others.slice(0, 3).forEach((r) => {
      const b = impEl("button", "btn mini ghost", `${r.icon} ${r.name}（${Math.round(r.score * 100)}%）`);
      b.type = "button";
      b.onclick = () => { IMP.clsId = r.cls; IMP.opts = {}; impGo(2); };
      line.appendChild(b);
    });
    res.appendChild(line);
  }
  body.appendChild(res);

  /* ---- ② 5 个类别卡片 ---- */
  const grid = impEl("div", "imptpls impcls");
  (IMP.classes || []).forEach((c) => {
    const b = impEl("button", "imptpl" + (c.id === cls.id ? " cur" : ""));
    b.type = "button";
    const t1 = impEl("div", "t1");
    t1.appendChild(impEl("span", null, c.icon || "🧩"));
    t1.appendChild(impEl("span", null, c.name));
    const sc = impScoreOf(c.id);
    if (sc > 0) t1.appendChild(impEl("i", "tscore" + (c.id === cls.id ? " on" : ""),
      Math.round(sc * 100) + "%"));
    b.appendChild(t1);
    b.appendChild(impEl("div", "t2", c.desc || ""));
    b.onclick = () => { IMP.clsId = c.id; IMP.opts = {}; impGo(2); };
    const info = impEl("span", "tinfo", "?");
    info.title = "看这个类别的说明 / 标准格式示例";
    info.onclick = (e) => { e.stopPropagation(); e.preventDefault(); impTemplateDetail(c); };
    b.appendChild(info);
    grid.appendChild(b);
  });
  body.appendChild(grid);

  /* ---- ③ 当前类别的说明与提示 ---- */
  const tips = impEl("div", "impopts");
  const ttl = impEl("div", "ttl", `${cls.icon || ""} ${cls.name}`);
  const more = impEl("button", "btn mini ghost ttllnk", "📄 说明 / 示例");
  more.type = "button";
  more.onclick = () => impTemplateDetail(cls);
  ttl.appendChild(more);
  tips.appendChild(ttl);
  if ((cls.hints || []).length) {
    const hl = impEl("div", "imphints");
    cls.hints.forEach((h) => hl.appendChild(impEl("span", "rule", "· " + h)));
    tips.appendChild(hl);
  }

  /* ---- ④ 预设（一键套一组选项） ---- */
  if ((cls.presets || []).length) {
    const pr = impEl("div", "impselrow imppresets");
    pr.appendChild(impEl("span", "lab", "预设"));
    cls.presets.forEach((p) => {
      const b = impEl("button", "chipbtn", p.name);
      b.type = "button";
      b.title = "套用这组选项（可以再改）";
      b.onclick = () => {
        IMP.opts = Object.assign({}, p.opts || {});
        impGo(2);
      };
      pr.appendChild(b);
    });
    tips.appendChild(pr);
  }

  /* ---- ⑤ 分组方式 / 单段上限 ---- */
  const selRow = impEl("div", "impselrow");
  selRow.appendChild(impEl("span", "lab", "分组方式"));
  const gsel = document.createElement("select");
  gsel.className = "sel mini";
  (cls.group_opts || [["none", "不分组"]]).forEach(([g, lab]) => {
    const o = document.createElement("option");
    o.value = g;
    o.textContent = lab || (IMP.meta.labels || {})[g] || g;
    gsel.appendChild(o);
  });
  gsel.value = impVal({ k: "group_by", def: cls.default_group || "none" });
  gsel.onchange = () => { IMP.opts.group_by = gsel.value; };
  selRow.appendChild(gsel);

  selRow.appendChild(impEl("span", "lab", "单段上限"));
  const num = document.createElement("input");
  num.className = "inp tiny";
  num.type = "number";
  num.min = "12";
  num.max = String(IMP.meta.max || 300);
  num.step = "5";
  num.value = String(impVal({ k: "max_chars", def: cls.default_max || 70 }));
  num.onchange = () => { IMP.opts.max_chars = parseInt(num.value, 10) || cls.default_max || 70; };
  selRow.appendChild(num);
  selRow.appendChild(impEl("span", "lab", "字"));
  tips.appendChild(selRow);

  /* ---- ⑥ 这一类的选项（按 schema 渲染） ---- */
  const og = impEl("div", "impoptgrid");
  const renderOpt = (d) => {
    const row = impEl("div", "impopt" + (d.type === "bool" ? " bool" : ""));
    const lab = impEl("label", "olab", d.label);
    if (d.type === "bool") {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!impVal(d);
      cb.onchange = () => { IMP.opts[d.k] = cb.checked; };
      cb.dataset.k = d.k;
      lab.insertBefore(cb, lab.firstChild);
      row.appendChild(lab);
    } else if (d.type === "select") {
      row.appendChild(lab);
      const sel = document.createElement("select");
      sel.className = "sel mini";
      (d.values || []).forEach(([v, t]) => {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = t;
        sel.appendChild(o);
      });
      sel.value = String(impVal(d));
      sel.onchange = () => { IMP.opts[d.k] = sel.value; };
      row.appendChild(sel);
    } else if (d.type === "text") {
      /* 自由文本选项（目前用于「自定义时间码格式」）：输入框 + 一个校验按钮，
         校验会真的拿这份文件的正文跑一遍解析，告诉用户能认出多少处。 */
      row.appendChild(lab);
      const inp = document.createElement("input");
      inp.className = "inp tc";
      inp.type = "text";
      inp.placeholder = d.k === "tc_custom"
        ? "例：[00:12]　或　00:12:03,200　或　^\\[(\\d+):(\\d+)\\]"
        : "";
      inp.value = String(impVal(d) == null ? "" : impVal(d));
      inp.oninput = () => { IMP.opts[d.k] = inp.value.trim(); };
      row.appendChild(inp);
      const res = impEl("div", "tccheck");
      let btn = null;
      if (d.k === "tc_custom") {
        btn = impEl("button", "btn mini ghost", "校验");
        btn.type = "button";
        btn.title = "拿当前文件跑一遍，看这个格式能认出多少处时间码";
        btn.onclick = async () => {
          if (!IMP.src || !IMP.src.token) { toast("先选文件", true); return; }
          btn.disabled = true;
          res.className = "tccheck busy";
          res.textContent = "正在校验…";
          try {
            const r = await api("/import/tc/check", {
              method: "POST",
              body: {
                token: IMP.src.token,
                pattern: inp.value.trim(),
                pos: IMP.opts.tc_pos || "auto",
                fps: IMP.opts.tc_fps || 25,
              },
            });
            if (!r || r.ok === false) throw new Error((r && r.error) || "校验失败");
            res.className = "tccheck " + (r.count ? "good" : "bad");
            const modeTxt = r.mode === "auto" ? "内置全格式" : (r.mode === "regex" ? "正则" : "样例");
            const bits = [`${modeTxt} · 认出 ${r.count} 处时间码`];
            if (r.ranges) bits.push(`${r.ranges} 处带区间`);
            if (r.no_tc) bits.push(`${r.no_tc} 段没认到`);
            const lines = [bits.join(" · ")];
            (r.samples || []).slice(0, 3).forEach((s) => {
              lines.push(`　${s.tc}　${s.text}`);
            });
            if (r.warn) lines.push("　" + r.warn);
            res.innerHTML = "";
            lines.forEach((t, i) => res.appendChild(impEl("div", i ? "tcs" : "tcm", t)));
          } catch (e) {
            res.className = "tccheck bad";
            res.textContent = "校验失败：" + e.message;
          } finally {
            btn.disabled = false;
          }
        };
        row.appendChild(btn);
      }
      row.appendChild(res);
    } else {
      row.appendChild(lab);
      const inp = document.createElement("input");
      inp.className = "inp tiny";
      inp.type = "number";
      if (d.min != null) inp.min = String(d.min);
      if (d.max != null) inp.max = String(d.max);
      if (d.step != null) inp.step = String(d.step);
      inp.value = String(impVal(d));
      inp.onchange = () => {
        const v = parseFloat(inp.value);
        IMP.opts[d.k] = isNaN(v) ? d.def : v;
      };
      row.appendChild(inp);
    }
    if (d.hint) row.appendChild(impEl("span", "ohint", d.hint));
    og.appendChild(row);
  };
  (cls.opts || []).forEach(renderOpt);
  tips.appendChild(og);

  /* ---- ⑦ CSV 列映射 ---- */
  if (IMP.src && IMP.src.kind === "csv" && (IMP.src.header || []).length) {
    const map = impEl("div", "impselrow");
    map.appendChild(impEl("span", "lab", "列映射"));
    const cols = IMP.src.header;
    [["text", "正文"], ["role", "角色"], ["tag", "分组"], ["note", "备注"]].forEach(([k, lab]) => {
      const w = impEl("span", "lab", lab + "：");
      const sel = document.createElement("select");
      sel.className = "sel mini";
      const auto = document.createElement("option");
      auto.value = "";
      auto.textContent = "自动";
      sel.appendChild(auto);
      cols.forEach((c) => {
        const o = document.createElement("option");
        o.value = c;
        o.textContent = c || "(空)";
        sel.appendChild(o);
      });
      const cur = (IMP.opts.csv_map || {})[k] || "";
      if (cur) sel.value = cur;
      sel.onchange = () => {
        IMP.opts.csv_map = Object.assign({}, IMP.opts.csv_map || {});
        if (sel.value) IMP.opts.csv_map[k] = sel.value; else delete IMP.opts.csv_map[k];
      };
      map.appendChild(w);
      map.appendChild(sel);
    });
    tips.appendChild(map);
  }
  body.appendChild(tips);

  const prev = impEl("button", "btn ghost", "上一步");
  prev.onclick = () => impGo(1);
  const run = impEl("button", "btn primary", `按「${cls.name}」识别`);
  run.onclick = () => impPlan(true);
  foot.appendChild(impEl("span", "hint", `${IMP.src ? IMP.src.filename : ""} · ${IMP.src ? IMP.src.kind : ""}`));
  foot.appendChild(impEl("span", "spacer"));
  foot.appendChild(prev);
  foot.appendChild(run);
}

async function impPlan(silent) {
  if (!IMP.src || !IMP.src.token) { toast("先选文件", true); return; }
  if (IMP.busy) return;
  IMP.busy = true;
  try {
    const d = await api("/import/plan", {
      method: "POST",
      body: JSON.stringify({ token: IMP.src.token, cls: IMP.clsId, opts: IMP.opts }),
    });
    IMP.groups = (d.groups || []).map((g) => Object.assign({}, g, {
      segments: (g.segments || []).map((s) => Object.assign({}, s)),
    }));
    IMP.issues = d.issues || [];
    IMP.stats = d.stats || null;
    if (d.cls) IMP.clsId = d.cls;
    if (d.detect) IMP.det = Object.assign({}, IMP.det || {}, d.detect, { _token: IMP.src.token });
    impGo(3);
    if (!silent) toast("已重新识别");
  } catch (e) { toast("识别失败：" + e.message, true); }
  finally { IMP.busy = false; }
}

/* ------------------------------ 步骤 3 ------------------------------ */
function impTotalSegs() {
  return IMP.groups.reduce((n, g) => n + (g.segments || []).length, 0);
}

function impSplitSeg(g, i) {
  const s = g.segments[i];
  const txt = s.text || "";
  let cut = -1;
  if (IMP.caret && IMP.caret.g === g.name && IMP.caret.i === i && IMP.caret.pos > 0
      && IMP.caret.pos < txt.length) {
    cut = IMP.caret.pos;
  } else {
    const mid = Math.floor(txt.length / 2);
    for (let k = 0; k < txt.length; k++) {
      if ("。！？；!?;…".indexOf(txt[k]) >= 0
          && (cut < 0 || Math.abs(k - mid) < Math.abs(cut - mid))) cut = k;
    }
    cut = cut >= 0 ? cut + 1 : mid;
  }
  if (cut <= 0 || cut >= txt.length) { toast("这一段没法再拆了", true); return; }
  s.text = txt.slice(0, cut).trim();
  s.over = false;
  g.segments.splice(i + 1, 0, Object.assign({}, s, {
    text: txt.slice(cut).trim(), note: "", over: false,
    // i 取两段之间的小数：拆分不改变「原文出现顺序」
    i: (typeof s.i === "number" ? s.i + 0.01 : undefined),
  }));
  impGo(3);
}

function impMergeSeg(g, i) {
  if (i <= 0) { toast("已经是第一段了", true); return; }
  const prev = g.segments[i - 1];
  const cur = g.segments[i];
  const joined = (prev.text || "").replace(/\s+$/, "") + (cur.text || "");
  prev.text = joined;
  if (cur.note) prev.note = [prev.note, cur.note].filter(Boolean).join("；");
  g.segments.splice(i, 1);
  impGo(3);
}

function impDelSeg(g, i) {
  g.segments.splice(i, 1);
  impGo(3);
}

function impMoveSeg(g, i, d) {
  const j = i + d;
  if (j < 0 || j >= g.segments.length) return;
  const a = g.segments[i], b = g.segments[j];
  const ai = a.i, bi = b.i;
  a.i = bi;                     // 顺序就是 i，交换时连 i 一起换
  b.i = ai;
  g.segments[i] = b;
  g.segments[j] = a;
  impGo(3);
}

function impGroupParams(g, row) {
  // 分组参数：音色 / 情绪 / 停顿 —— 导入时写进每一行的行级覆盖，等于「批量继承」
  const box = impEl("div", "impselrow");
  const refSel = document.createElement("select");
  refSel.className = "sel mini";
  refSel.innerHTML = '<option value="">音色：跟随默认</option>' +
    refOptions().filter((r) => r.editable).map((r) => `<option value="${r.id}">🎙 ${r.name}</option>`).join("");
  refSel.value = (g.params || {}).ref || "";
  refSel.onchange = () => { g.params = g.params || {}; g.params.ref = refSel.value; };

  const emoSel = document.createElement("select");
  emoSel.className = "sel mini";
  emoSel.innerHTML = [0, 1, 2, 3].map((k) => `<option value="${k}">情绪：${EMO_MODE_NAMES[k] || k}</option>`).join("");
  if ((g.params || {}).emo_mode != null) emoSel.value = String(g.params.emo_mode);
  emoSel.onchange = () => { g.params = g.params || {}; g.params.emo_mode = parseInt(emoSel.value, 10) || 0; };

  const wInp = document.createElement("input");
  wInp.className = "inp tiny";
  wInp.type = "number";
  wInp.min = "0"; wInp.max = "1"; wInp.step = "0.05";
  wInp.style.width = "74px";
  wInp.title = "情感权重";
  wInp.value = String((g.params || {}).emo_weight != null ? g.params.emo_weight : 0.65);
  wInp.onchange = () => { g.params = g.params || {}; g.params.emo_weight = Number(wInp.value) || 0.65; };

  const pInp = document.createElement("input");
  pInp.className = "inp tiny";
  pInp.type = "number";
  pInp.min = "0"; pInp.max = "30000"; pInp.step = "10";
  pInp.style.width = "86px";
  pInp.placeholder = "停顿 ms";
  pInp.title = "行后停顿（毫秒）";
  if ((g.params || {}).pause != null) pInp.value = String(g.params.pause);
  pInp.onchange = () => {
    g.params = g.params || {};
    const v = pInp.value.trim();
    if (v === "") delete g.params.pause;
    else g.params.pause = Math.max(0, Math.min(30000, parseInt(v, 10) || 0));
  };

  box.appendChild(impEl("span", "lab", "本组参数"));
  box.appendChild(refSel);
  box.appendChild(emoSel);
  box.appendChild(wInp);
  box.appendChild(pInp);
  row.appendChild(box);
}

function impStep3(body, foot) {
  const st = IMP.stats || {};
  const top = impEl("div", "impstats");
  const ci = impCls();
  if (ci && ci.name) {
    const badge = impEl("span", "clstab", `${ci.icon || ""} ${ci.name}`);
    badge.title = "这一份按「" + ci.name + "」的规则识别；要换类别就点上一步";
    top.appendChild(badge);
  }
  top.appendChild(impEl("span", null, "识别结果："));
  top.appendChild(impEl("b", null, String(IMP.groups.length)));
  top.appendChild(impEl("span", null, "组 ·"));
  top.appendChild(impEl("b", null, String(impTotalSegs())));
  top.appendChild(impEl("span", null, "段 ·"));
  top.appendChild(impEl("b", null, String(IMP.groups.reduce((n, g) => n + (g.chars || 0), 0))));
  top.appendChild(impEl("span", null, `字（上限 ${st.max_chars || "?"} 字/段）`));
  body.appendChild(top);

  const errs = IMP.issues.filter((x) => x.level === "error");
  const warns = IMP.issues.filter((x) => x.level === "warn");
  if (errs.length) {
    const box = impEl("div", "impissues err");
    box.textContent = errs.map((x) => x.msg).join("；");
    body.appendChild(box);
  }
  if (warns.length) {
    const box = impEl("div", "impissues warn");
    box.textContent = `有 ${warns.length} 处需要人工确认：` +
      warns.slice(0, 4).map((x) => x.msg).join("；") + (warns.length > 4 ? "…" : "");
    body.appendChild(box);
  }

  const tools = impEl("div", "imptools");
  const redo = impEl("button", "btn mini ghost", "⟲ 按当前规则重新识别");
  redo.onclick = () => impPlan();
  const back = impEl("button", "btn mini ghost", "← 上一步（改类别 / 选项）");
  back.onclick = () => impGo(2);
  const addG = impEl("button", "btn mini ghost", "＋ 新增分组");
  addG.onclick = () => {
    IMP.groups.push({ name: "新分组", note: "", params: {}, segments: [], chars: 0 });
    impGo(3);
  };
  tools.appendChild(redo); tools.appendChild(back); tools.appendChild(addG);
  body.appendChild(tools);

  if (!IMP.groups.length) {
    body.appendChild(impEl("div", "impempty", "没有识别到内容。可以回上一步换个模板，或直接在下面新增分组手动写。"));
  }

  IMP.groups.forEach((g, gi) => {
    const card = impEl("div", "impgroup");
    const head = impEl("div", "impgh");
    const nameInp = document.createElement("input");
    nameInp.className = "gname";
    nameInp.value = g.name || "正文";
    nameInp.title = "分组名（导入后就是批量任务名，可以改）";
    nameInp.onchange = () => { g.name = nameInp.value.trim() || "正文"; };
    head.appendChild(nameInp);
    head.appendChild(impEl("span", "gmeta", `${(g.segments || []).length} 段 · ${g.chars || 0} 字`));
    head.appendChild(impEl("span", "spacer"));
    const upG = impEl("button", "iconbtn", "↑");
    upG.title = "上移分组";
    upG.onclick = () => {
      if (gi <= 0) return;
      const t = IMP.groups[gi - 1];
      IMP.groups[gi - 1] = g; IMP.groups[gi] = t;
      impGo(3);
    };
    const delG = impEl("button", "iconbtn", "✕");
    delG.title = "删除这个分组";
    delG.onclick = () => {
      if (!confirm(`删除分组「${g.name}」（${(g.segments || []).length} 段）？`)) return;
      IMP.groups.splice(gi, 1);
      impGo(3);
    };
    head.appendChild(upG);
    head.appendChild(delG);
    card.appendChild(head);

    const pr = impEl("div", "impgh");
    impGroupParams(g, pr);
    card.appendChild(pr);

    (g.segments || []).forEach((s, si) => {
      const row = impEl("div", "improw");
      row.appendChild(impEl("span", "ridx", String(si + 1)));
      const rb = impEl("div", "rbody");
      const ta = document.createElement("textarea");
      ta.value = s.text || "";
      ta.rows = 1;
      if (s.over) ta.classList.add("over");
      ta.title = s.over ? "超过单段上限，建议手动拆分（不会自动切在引号里）" : "";
      const grow = () => {
        ta.style.height = "auto";
        ta.style.height = Math.min(220, Math.max(30, ta.scrollHeight)) + "px";
      };
      ta.oninput = () => { s.text = ta.value; grow(); };
      ta.onfocus = () => {
        IMP.caret = { g: g.name, i: si, pos: ta.selectionStart };
      };
      ta.onkeyup = ta.onclick = () => {
        IMP.caret = { g: g.name, i: si, pos: ta.selectionStart };
      };
      rb.appendChild(ta);
      const note = document.createElement("input");
      note.className = "rnote";
      note.placeholder = "附属备注（动作/镜头/时间码，不朗读）";
      note.value = s.note || "";
      note.oninput = () => { s.note = note.value; };
      rb.appendChild(note);
      // 有出现时间或延迟才显示这一行（指令类的「停顿 2 秒」也在这里看得见）
      if (s.t0 != null || s.pause) {
        const bits = [];
        if (s.t0 != null) {
          bits.push(`⏱ ${fmtDur(s.t0)}${s.t1 != null ? " → " + fmtDur(s.t1) : ""}`);
        }
        if (s.pause) bits.push(`停 ${(s.pause / 1000).toFixed(1)}s`);
        rb.appendChild(impEl("div", "rtime", bits.join(" · ")));
      }
      row.appendChild(rb);

      const acts = impEl("div", "racts");
      const bSplit = impEl("button", "iconbtn", "✂");
      bSplit.title = "在光标处拆分（没光标就按句子中间）";
      bSplit.onclick = () => impSplitSeg(g, si);
      const bMerge = impEl("button", "iconbtn", "⇧");
      bMerge.title = "并入上一段";
      bMerge.onclick = () => impMergeSeg(g, si);
      const bUp = impEl("button", "iconbtn", "↑");
      bUp.title = "上移";
      bUp.onclick = () => impMoveSeg(g, si, -1);
      const bDel = impEl("button", "iconbtn", "✕");
      bDel.title = "删除这一段";
      bDel.onclick = () => impDelSeg(g, si);
      if (s.slow) {
        const tag = impEl("span", "mtag", "慢");
        tag.title = "慢语速偏好（导入后可看备注/导出）";
        acts.appendChild(tag);
      }
      acts.appendChild(bSplit); acts.appendChild(bMerge);
      acts.appendChild(bUp); acts.appendChild(bDel);
      row.appendChild(acts);
      card.appendChild(row);
      setTimeout(grow, 0);
    });

    const gf = impEl("div", "impgfoot");
    const addS = impEl("button", "btn mini ghost", "＋ 在这一组末尾加一段");
    addS.onclick = () => {
      const lastI = g.segments.reduce((m, x) => Math.max(m, x.i || 0), 0);
      const maxI = IMP.groups.reduce((m, gg) => gg.segments.reduce(
        (n, x) => Math.max(n, x.i || 0), m), 0);
      g.segments.push({
        text: "", note: "", role: "", slow: false, over: false,
        i: lastI ? lastI + 0.01 : maxI + 1,
      });
      impGo(3);
    };
    const mergeToNext = impEl("button", "btn mini ghost", "与下一组合并");
    mergeToNext.disabled = gi >= IMP.groups.length - 1;
    mergeToNext.onclick = () => {
      const nx = IMP.groups[gi + 1];
      if (!nx) return;
      g.segments = (g.segments || []).concat(nx.segments || []);
      g.chars = g.segments.reduce((n, s) => n + (s.text || "").length, 0);
      IMP.groups.splice(gi + 1, 1);
      impGo(3);
    };
    gf.appendChild(addS);
    gf.appendChild(mergeToNext);
    card.appendChild(gf);
    body.appendChild(card);
  });

  // 底部：标题 + 导入
  const footTitle = document.createElement("input");
  footTitle.className = "inp";
  footTitle.style.width = "260px";
  footTitle.value = IMP.title || "";
  footTitle.placeholder = "新台本标题";
  footTitle.onchange = () => { IMP.title = footTitle.value; };
  foot.appendChild(impEl("span", "hint", "台本标题"));
  foot.appendChild(footTitle);
  foot.appendChild(impEl("span", "spacer"));
  const prev = impEl("button", "btn ghost", "← 上一步");
  prev.title = "回到「识别类别 / 选项」，改完再识别一次（预览里手改的内容会丢）";
  prev.onclick = () => impGo(2);
  const cancel = impEl("button", "btn ghost", "取消");
  cancel.onclick = impClose;
  const ok = impEl("button", "btn primary", `导入并建 ${IMP.groups.length} 个分组`);
  ok.disabled = !impTotalSegs();
  ok.onclick = impCommit;
  foot.appendChild(prev);
  foot.appendChild(cancel);
  foot.appendChild(ok);
}

async function impCommit() {
  if (IMP.busy) return;
  const groups = IMP.groups
    .map((g) => ({
      name: (g.name || "正文").trim() || "正文",
      note: g.note || "",
      params: g.params || {},
      segments: (g.segments || [])
        .filter((s) => (s.text || "").trim())
        .map((s) => ({
          text: s.text.trim(), note: s.note || "", slow: !!s.slow,
          pause: s.pause == null ? null : s.pause,
          i: s.i, t0: s.t0 == null ? null : s.t0, t1: s.t1 == null ? null : s.t1,
        })),
    }))
    .filter((g) => g.segments.length);
  if (!groups.length) { toast("没有可导入的分段", true); return; }
  IMP.busy = true;
  try {
    const d = await api("/import/commit", {
      method: "POST",
      body: JSON.stringify({
        title: IMP.title || "智能导入",
        cls: IMP.clsId,
        detect: IMP.det ? { cls: IMP.det.cls, score: IMP.det.score,
                            evidence: IMP.det.evidence } : null,
        filename: (IMP.src && IMP.src.filename) || "",
        groups,
        make_batches: true,
      }),
    });
    impClose();
    await loadScripts();
    await switchScript(d.id);
    toast(`已导入：${d.lines} 段 / ${d.groups} 个分组，可以直接开始生成`);
  } catch (e) { toast("导入失败：" + e.message, true); }
  finally { IMP.busy = false; }
}

/* 绑定入口（在 initHeader 里调用） */
function initSmartImport() {
  const b = $("btnSmartImport");
  if (b) b.onclick = () => openSmartImport();
}

/* 内嵌模式：时间轴用 iframe 打开「?desk=1&embed=1」，只显示导入台本身，
   不带台本页的顶栏 / 列表 / 侧栏，也不抢父窗口的键盘与滚动。 */
const EMBED = (() => {
  try { return new URLSearchParams(location.search).get("embed") === "1"; } catch (e) { return false; }
})();

async function boot() {
  if (EMBED) document.documentElement.classList.add("embed");
  document.querySelectorAll(".ptab").forEach((b) => (b.onclick = () => switchPane(b.dataset.tab)));
  $("modalCancel").onclick = closeModal;
  initPopcard();
  $("btnStopAudio").onclick = () => {
    stopAllAudio();
    toast("已停止所有播放");
  };
  if ($("btnStorage")) $("btnStorage").onclick = openStorage;
  initHeader();
  initFilters();
  initDefaultPanel();
  initRenderPanel();
  initExportPanel();
  initRefsPanel();
  initSmartImport();
  initResizers();

  document.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    const typing = tag === "textarea" || tag === "input";
    const k = e.key.toLowerCase();
    /* Ctrl+Alt+C / Ctrl+Alt+V：整句复制粘贴（带音频）。用 Alt 是为了不抢
       textarea 自己的 Ctrl+C / Ctrl+V。 */
    if ((e.ctrlKey || e.metaKey) && e.altKey && k === "c") {
      e.preventDefault(); copyLines(); return;
    }
    if ((e.ctrlKey || e.metaKey) && e.altKey && k === "v") {
      e.preventDefault(); pasteLines(); return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !typing) {
      e.preventDefault();
      runHist(e.shiftKey ? redo : undo);
    }
  });
  window.addEventListener("beforeunload", (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ""; }
  });

  const tsBtn = $("tsRefresh");
  if (tsBtn) {
    tsBtn.onclick = async () => {
      try { await loadMeta(); } catch (e) { /* 忽略 */ }
      await refreshTopStatus(true);
    };
  }
  refreshTopStatus(false).catch(() => {});

  try {
    await loadMeta();
    loadSfx().catch(() => {});   // 标签行要显示音效名，先拉一份
    const list = await loadScripts();
    // 支持 /longform?sid=xxx 深链接（时间轴、外部脚本都靠它直接把某个台本/工程打开）
    let wantSid = "";
    try { wantSid = new URLSearchParams(location.search).get("sid") || ""; } catch (e) { /* 忽略 */ }
    const last = wantSid || localStorage.getItem("lf.last");
    const pick = list.find((s) => s.id === last) || list[0];
    if (pick) await switchScript(pick.id);
    else {
      SCRIPT = null;
      $("rows").innerHTML = '<div class="empty">还没有台本，点右上角「新建」粘贴一篇长文本开始。</div>';
    }
    // 从时间轴「📥 导入台」跳过来时直接展开导入台（只在这一处，切台本不会重复弹）
    try {
      const qd = new URLSearchParams(location.search);
      if (qd.get("desk") === "1") {
        setTimeout(() => openDrawer("media", qd.get("target") === "sfx" ? "sfx" : "ref"), 300);
      }
    } catch (e) { /* 忽略 */ }
    const qView = new URLSearchParams(location.search).get("view");
    const want = qView === "board" || (!qView && localStorage.getItem("lf.view") === "board") ? "board" : "edit";
    view = want === "board" ? "board" : "edit";
    document.querySelectorAll("#viewSeg button").forEach((b) => b.classList.toggle("cur", b.dataset.view === view));
    $("rows").hidden = view !== "edit";
    $("board").hidden = view !== "board";
    document.querySelector(".edithint").hidden = view !== "edit";
    renderCenter();
    updateUndoButtons();
  } catch (e) {
    toast("初始化失败：" + e.message, true);
    console.error(e);
  }
}

window.__lfDebug = {
  get undo() { return UNDO.length; },
  get redo() { return REDO.length; },
  get lines() { return ((SCRIPT && SCRIPT.lines) || []).length; },
  get labels() { return UNDO.map((x) => x.label); },
  // 给自动化测试用的只读快照与少量入口（正常使用不会走到这里）
  get script() { return SCRIPT; },
  get sel() { return [...SEL]; },
  get filter() { return Object.assign({}, FILTER); },
  get model() { return MODEL; },
  get render() { return RENDER; },
  get matView() { return MAT.view; },
  get matTarget() { return MAT.target; },
  get matCount() { return MAT.items.length; },
  get imp() { return IMP; },
  get sfxCount() { return SFX.items.length; },
  get refView() { return REFV.view; },
  setRender(r) { RENDER = r; paintRender(); },
  setModel(m) { MODEL = m; paintRender(); },
  repaint() { renderCenter(); renderStats(); paintRender(); },
};

boot();
})();
