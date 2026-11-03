/* 高级音频处理台
   一段音声去掉人声 → 按声音事件切成一堆片段 → 挑一部分入库 / 插进时间轴。

   三步主流程：① 准备素材（分离，慢，只做一次）→ ② 调参切分（快，可反复）→ ③ 挑拣输出。
   为什么要拆成两次请求：分离几十秒到几分钟，切分几毫秒；参数每次动都要重切，
   但绝不能重跑分离。

   编辑器的三条轨：
     原音   —— A/B 对照，只读，可单独静音；
     处理后 —— 可编辑（拖边改起止、拖中间平移、拖空白圈新片段、右键菜单）；
     字幕   —— 只读参考，每句一块，点一下就跳到那句（时间基准是原音，不是中文）。
   两条音轨各有一个 <audio>，同一个播放头带着走，所以能"分别独立静音"对比。 */

const API = "/api/v1/lf";
const $ = (id) => document.getElementById(id);
const PARAM_LIMIT = 900;          // 一次最多渲染多少行（再多应该调大门限，而不是滚 4000 行）
const EDGE_PX = 6;                // 边界判定像素：小于这个距离算"要改起止"

const S = {
  mats: [], matsAll: [], matPath: "", curMid: "", job: "", env: [], envRaw: [], dur: 0, durRaw: 0, sr: 0,
  segs: [], sel: new Set(), curSeg: -1, anchor: -1, seq: 0,
  cues: [], showSrt: true, srtName: "",
  view: { a: 0, b: 0 },
  dup: new Set(), dupGroups: [], projects: [],
  muteRaw: false, muteProc: false, only: "",
  playing: false, stopAt: 0, stopAtStart: 0, loop: false,
  playSeg: null,                 // 正在试听哪一段（列表 / 轨道按钮据此显示 ⏸）
  tool: "select", busy: false, drag: null, undo: [], redo: [], edited: false,
  cueCur: -1, hover: null,
  saveFolder: "", batchFolder: true, plans: [], scrub: null,
  stem: "instrumental",     // instrumental=去人声 / vocals=去伴奏 / none=原样
  mapPlan: null,            // 对位预览结果（只用于显示，写入时重算）
  opsOpen: false,
};

/* ---------------- 小工具 ---------------- */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function mmss(t) {
  t = Math.max(0, Number(t) || 0);
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
function mmssc(t) {                        // 带百分秒：0:12.34
  t = Math.max(0, Number(t) || 0);
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}
function toast(msg, bad) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("bad", !!bad);
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, bad ? 4600 : 2600);
}
async function api(path, opt = {}) {
  const headers = {};
  let body = opt.body;
  if (body !== undefined && body !== null) {
    body = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  const r = await fetch(API + path, { method: opt.method || "GET", body, headers });
  let data = {};
  try { data = await r.json(); } catch (e) { /* 可能是空响应 */ }
  if (!r.ok) throw new Error(data.detail || `HTTP ${r.status}`);
  return data;
}

/* ---------------- 警告窗（替代 confirm，三页风格统一、不被浏览器拦） ---------------- */
function askConfirm(title, bodyHtml, okText) {
  return new Promise((resolve) => {
    const box = $("askPop");
    $("askTitle").textContent = title;
    $("askBody").innerHTML = bodyHtml;
    const ok = $("askOk"), cancel = $("askCancel");
    ok.textContent = okText || "确定";
    const done = (v) => {
      box.hidden = true;
      ok.onclick = null; cancel.onclick = null;
      document.removeEventListener("keydown", onKey, true);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); done(false); }
      if (e.key === "Enter") { e.stopPropagation(); done(true); }
    };
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
    box.hidden = false;
    document.addEventListener("keydown", onKey, true);
    setTimeout(() => ok.focus(), 20);
  });
}

/* ---------------- 处理方案（保存 / 恢复） ----------------
   为什么要有：切分参数是「试出来的」，不是算出来的。调到一个刚好的门限之后，
   再想试下一组就得先记住这一组；而一旦重新切分，手工改过的片段就没了。
   方案把「分离参数 + 切分参数 + 手工片段清单」一起存进 localStorage，
   和作业解耦，所以素材换了也能把参数搬过去。 */
const PLAN_KEY = "sfxb.plans.v1";

function loadPlans() {
  try {
    const raw = JSON.parse(localStorage.getItem(PLAN_KEY) || "[]");
    S.plans = Array.isArray(raw) ? raw.filter((p) => p && p.segs) : [];
  } catch (e) { S.plans = []; }
  renderPlans();
}

function planNameAuto() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  return `方案 ${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function savePlan(name, quiet) {
  if (!S.job) { toast("还没有准备好的素材，没有可保存的方案", true); return; }
  const nm = (name == null ? "" : String(name)).trim() || planNameAuto();
  const plan = {
    id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    name: nm, ts: Date.now(), mid: S.curMid,
    mat: ($("waveHint").textContent || "").split(" · ")[0],
    eng: $("eng").value, stem: $("stem").value || "instrumental",
    quality: $("quality").value, residual: parseFloat($("residual").value || "0"),
    segMode: $("segMode").value,
    minGap: parseFloat($("minGap").value || "0.35"), minLen: parseFloat($("minLen").value || "0.2"),
    thresh: parseFloat($("thresh").value || "10"), pad: parseFloat($("pad").value || "0.03"),
    job: S.job, dur: S.dur,
    segs: S.segs.map((s) => ({ start: s.start, end: s.end, dur: s.dur,
                               name: s.name || "", rms_db: s.rms_db,
                               ops: s.ops || null })),
  };
  S.plans.unshift(plan);
  S.plans = S.plans.slice(0, 20);
  try {
    localStorage.setItem(PLAN_KEY, JSON.stringify(S.plans));
  } catch (e) {
    toast("方案存不下了（浏览器存储满）：删几个旧方案再试", true);
    return;
  }
  renderPlans();
  if (!quiet) toast(`已保存方案「${nm}」（${plan.segs.length} 段）`);
}

function deletePlan(id) {
  S.plans = S.plans.filter((p) => p.id !== id);
  try { localStorage.setItem(PLAN_KEY, JSON.stringify(S.plans)); } catch (e) { /* 忽略 */ }
  renderPlans();
}

async function applyPlan(p) {
  const same = p.job && p.job === S.job;
  if (!same) {
    const ok = await askConfirm("这条方案来自另一个素材",
      `方案「${p.name}」是在 <b>${p.mat || "另一个素材"}</b> 上做的。\n\n`
      + "现在会把它的<b>参数</b>和<b>片段清单</b>恢复过来；但音频对不上，试听和「插进时间轴」"
      + "需要先给当前素材点一次「① 准备素材」。",
      "仍然恢复");
    if (!ok) return;
  }
  $("stem").value = p.stem || (p.eng === "none" ? "none" : "instrumental");
  paintStem();
  $("eng").value = p.eng === "none" ? "demucs" : (p.eng || "demucs");
  $("eng").onchange();
  $("quality").value = p.quality || "std";
  $("residual").value = String(p.residual == null ? 0.15 : p.residual);
  $("vRes").textContent = Math.round(parseFloat($("residual").value || "0") * 100) + "%";
  $("segMode").value = p.segMode || "gap";
  $("minGap").value = p.minGap; $("minLen").value = p.minLen;
  $("thresh").value = p.thresh; $("pad").value = p.pad;
  if (same && S.segs.length) snap();
  S.segs = (p.segs || []).map((s) => ({
    _id: ++S.seq, start: +s.start, end: +s.end, dur: +(s.dur || (s.end - s.start)).toFixed(3),
    name: s.name || "", rms_db: s.rms_db == null ? -60 : s.rms_db, peak: 0,
    ops: s.ops || null,
  }));
  S.sel.clear(); S.curSeg = -1; S.anchor = -1; S.dup.clear(); S.dupGroups = [];
  S.playSeg = null;
  if (p.dur) { S.dur = S.dur || p.dur; }
  $("segStat").textContent = `方案「${p.name}」· ${S.segs.length} 段`;
  $("segHint").textContent = same
    ? "已恢复方案里的片段（含手工改过的起止与名字）。要按参数重切，点「重新切分」。"
    : "已恢复参数与片段清单，但还没有对应音频：先点「① 准备素材」再试听。";
  renderSegs(); redrawAll();
  toast(`已恢复方案「${p.name}」`);
}

function renderPlans() {
  const box = $("planList");
  if (!box) return;
  box.innerHTML = "";
  if (!S.plans.length) {
    box.appendChild(el("div", "hint", "还没有保存的加工方案。"));
    return;
  }
  S.plans.forEach((p) => {
    const row = el("div", "sb-plan");
    const nm = el("span", "pn", p.name);
    nm.title = `${p.name}\n素材：${p.mat || "—"}\n切分：${p.segMode} · 门限 ${p.thresh}dB · 间隔 ${p.minGap}s\n${p.segs.length} 段`;
    row.appendChild(nm);
    row.appendChild(el("span", "pd", `${p.segs.length}段`));
    const use = el("button", "pb", "恢复");
    use.title = "恢复这套参数与片段（当前片段会先进撤销栈）";
    use.onclick = () => applyPlan(p);
    const del = el("button", "pb del", "✕");
    del.title = "删除这条方案（不影响任何音频）";
    del.onclick = () => deletePlan(p.id);
    row.appendChild(use); row.appendChild(del);
    box.appendChild(row);
  });
}

/* ---------------- ① 素材 ---------------- */
async function loadMats() {
  try {
    const r = await api("/media");
    S.mats = (r.items || []).slice();
    S.matsAll = S.mats.slice();
    if (window.LibFolders) {
      try { S.folders = await LibFolders.load("media", true); } catch (e) { S.folders = []; }
    }
  } catch (e) {
    S.mats = [];
    toast("素材列表读不出来：" + e.message, true);
  }
  renderMatFolders();
  renderMats();
  if (typeof paintSaveFolder === "function") paintSaveFolder();
}

/* 素材的目录条：素材一多，只靠搜索很难找（名字还是自动编号的） */
function renderMatFolders() {
  const host = $("matFolders");
  if (!host || !window.LibFolders) return;
  const inTree = LibFolders.inTree;
  const list = S.mats.filter((m) => inTree(m.folder, S.matPath));
  LibFolders.bar(host, {
    kind: "media",
    path: S.matPath,
    items: S.mats,
    folders: S.folders || LibFolders.cache("media"),
    emptyHint: "按场景分文件夹（导入台 / 时间轴共用）",
    onPick: (p) => { S.matPath = p || ""; renderMatFolders(); renderMats(); },
    onChanged: async () => {
      S.folders = await LibFolders.load("media", true);
      await loadMats();
    },
  });
  return list;
}

function renderMats() {
  const box = $("matList");
  const q = ($("matSearch").value || "").trim().toLowerCase();
  box.innerHTML = "";
  const inTree = window.LibFolders ? LibFolders.inTree : () => true;
  const list = S.mats.filter((m) => inTree(m.folder, S.matPath) && (!q
    || ((m.name || "") + " " + (m.source || "")).toLowerCase().includes(q)));
  if (!list.length) {
    box.appendChild(el("div", "hint", S.mats.length ? "这个文件夹里没有匹配的素材" : "导入台是空的，先去导入台拖音频进来"));
  }
  list.slice(0, 200).forEach((m) => {
    const row = el("div", "sb-mat" + (m.id === S.curMid ? " cur" : ""));
    row.appendChild(el("span", "nm", m.name || m.file || m.id));
    if (m.folder) row.appendChild(el("span", "fd", m.folder.split("/").pop()));
    row.appendChild(el("span", "du", m.dur ? mmss(m.dur) : "—"));
    row.title = `${m.name || ""}\n时长 ${mmss(m.dur || 0)}\n文件夹 ${m.folder || "（未归档）"}\n${m.file || ""}`;
    row.onclick = () => {
      S.curMid = m.id;
      renderMats();
      $("btnPrepare").disabled = false;
      $("prepHint").textContent = `已选「${m.name || m.file}」，时长 ${mmss(m.dur || 0)}。点上面按钮开始去人声。`;
    };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      openMatCtx(e.clientX, e.clientY, m);
    };
    box.appendChild(row);
  });
  $("matHint").textContent = S.mats.length
    ? `共 ${S.mats.length} 个素材${list.length < S.mats.length ? `，当前目录 ${list.length} 个` : ""}`
    : "";
  $("btnPrepare").disabled = !S.curMid;
}

/* 直接加入素材：不用回导入台。文件先落进导入台（和其他素材同一条流水线），
   成功之后自动选中，下一步就能处理 —— 少一次跳页。 */
async function addMaterialFiles(files) {
  const list = Array.from(files || []);
  if (!list.length) return;
  const btn = $("btnMatAdd");
  const old = btn.textContent;
  btn.textContent = `导入 ${list.length} 个…`;
  let ok = 0, fail = 0, firstId = "";
  for (const f of list) {
    const fd = new FormData();
    fd.append("file", f);
    fd.append("name", f.name.replace(/\.[^.]+$/, ""));
    try {
      const r = await api("/media/upload", { method: "POST", body: fd });
      ok++;
      if (!firstId && r.item) firstId = r.item.id;
    } catch (e) {
      fail++;
      toast(`「${f.name}」导入失败：${e.message}`, true);
    }
  }
  btn.textContent = old;
  await loadMats();
  if (firstId) {
    S.curMid = firstId;
    renderMats();
    $("btnPrepare").disabled = false;
    const it = S.mats.find((m) => m.id === firstId);
    $("prepHint").textContent = `已加入并选中「${it ? (it.name || it.file) : ""}」，下一步选处理方式。`;
  }
  toast(`已加入 ${ok} 个素材${fail ? `，${fail} 个失败` : ""}（都存进了导入台）`);
}

/* 从工作台台本直接拿字幕时间码：省得再手工导一遍同一个 srt，也不会导错文件 */
async function loadCuesFromScript(sid, quiet) {
  if (!sid) return false;
  try {
    const r = await api(`/scripts/${encodeURIComponent(sid)}/cues`);
    const cues = (r.cues || []).filter((c) => c.t0 != null)
      .map((c) => ({ t0: +c.t0, t1: +(c.t1 == null ? c.t0 + 0.8 : c.t1), text: c.text || "", i: c.i }));
    if (!cues.length) {
      if (!quiet) toast("这个台本没有时间码：它不是从 SRT / 时间码导入的", true);
      return false;
    }
    applySrtCues(cues, `台本「${r.title || sid.slice(0, 6)}」`);
    const warn = cueMismatchText(cues);
    if (warn) toast(warn, true);          // 不同版优先说这件事，它比「载入了 N 条」重要
    else if (!quiet) toast(`已载入 ${cues.length} 条字幕时间码（来自工作台台本）`);
    return true;
  } catch (e) {
    if (!quiet) toast("载入台本时间码失败：" + e.message, true);
    return false;
  }
}

/* ---------------- ② 处理（可选：去人声 / 去伴奏 / 原样） ---------------- */
function sepParams() {
  return {
    mid: S.curMid, engine: $("eng").value,
    stem: $("stem").value || "instrumental",
    quality: $("quality").value,
    residual: parseFloat($("residual").value || "0"),
  };
}

/* 处理方式改了：不分离时引擎/精度/残留抑制都没意义，直接收起来 */
function paintStem() {
  const stem = $("stem").value || "instrumental";
  S.stem = stem;
  const sep = stem !== "none";
  $("engRow").hidden = !sep;
  $("qRow").hidden = !sep;
  $("resRow").hidden = !sep;
  $("btnPrepare").textContent = sep
    ? (stem === "vocals" ? "② 去掉伴奏并载入" : "② 去掉人声并载入")
    : "② 直接载入（不分离）";
  $("prepHint").textContent = sep
    ? "分离只做一次，之后调切分参数不用重跑。"
    : "不做分离，直接在原音上切 —— 本来就是音效的素材用这一档。";
}

async function doPrepare() {
  if (!S.curMid) return toast("先在左边选一个素材", true);
  if (S.busy) return;
  // 重新准备 = 换作业，当前片段会整份消失；和「重新切分」一样先问一句
  if (S.segs.length && (S.edited || S.undo.length)) {
    const ok = await askConfirm("重新准备素材会清空当前片段",
      `现在有 <b>${S.segs.length}</b> 段（含手工改动）。\n\n`
      + "换素材 / 换引擎重新准备会生成新的作业，当前片段与方案之外的改动都会丢。\n"
      + "要保留就先点「处理方案 → 保存」，或点「取消」。",
      "继续准备");
    if (!ok) return;
    if ($("planAuto").checked) savePlan("", true);
  }
  S.busy = true;
  const btn = $("btnPrepare");
  const old = btn.textContent;
  let prepared = false;
  btn.disabled = true;
  btn.textContent = "分离中…（首次加载模型会慢一些）";
  $("prepHint").textContent = "分离中，别关页面。";
  $("sepWarn").hidden = true;
  try {
    const r = await api("/sfxb/prepare", { method: "POST", body: sepParams() });
    S.job = r.job;
    S.jobMid = S.curMid;
    S.jobStem = r.stem || "instrumental";
    S.env = r.env || [];
    S.envRaw = (r.env_raw && r.env_raw.length) ? r.env_raw : [];
    S.dur = r.dur || 0;
    S.durRaw = r.raw_dur || S.dur;
    S.sr = r.sr || 44100;
    S.segs = []; S.sel.clear(); S.curSeg = -1; S.anchor = -1;
    S.dup.clear(); S.dupGroups = []; S.undo = []; S.redo = []; S.cueCur = -1; S.edited = false;
    S.limit = 240;
    S.playSeg = null;
    resetView();
    showEditor(true);
    // 「③ 切成片段」在准备之前是灰的（没有作业可切）。分离成功后必须放出来，
    // 之前忘了这一步，结果是去掉人声之后第 3 块永远点不动。
    $("cardSeg").removeAttribute("disabled");
    loadAudio(r);
    const stemLabel = r.stem_label || (r.engine === "原素材（未分离）" ? "原素材（未分离）" : "");
    $("waveHint").textContent = `${r.name} · ${stemLabel || r.engine}`;
    $("procInfo").textContent = `${stemLabel || r.engine} · ${mmss(S.dur)}`;
    $("rawInfo").textContent = S.envRaw.length ? `${mmss(S.durRaw)}（原始）` : "原音轨不可用";
    $("prepHint").textContent = r.engine === "原素材（未分离）"
      ? "按原样切分（没做分离）。"
      : `已${stemLabel || "处理"}（${r.engine}）${r.note ? "，" + r.note : ""}。`;
    if (r.note) toast(r.note, true);
    showSepWarn(r);
    prepared = true;
  } catch (e) {
    toast("准备失败：" + e.message, true);
    $("prepHint").textContent = "失败原因：" + e.message;
  } finally {
    S.busy = false;
    btn.textContent = old;
    btn.disabled = !S.curMid;
  }
  // 切分要等 busy 放掉再调（doSegment 自己有 busy 保护，放在 try 里会被它自己挡掉）
  if (prepared) await doSegment();
}

function loadAudio(r) {
  const auP = $("auProc"), auR = $("auRaw");
  auP.src = `${API}/sfxb/audio/${encodeURIComponent(S.job)}`;
  if (r && r.raw_url) {
    auR.src = r.raw_url;
    $("btnRawPlay").disabled = false;
    $("btnRawMute").disabled = false;
  } else {
    auR.removeAttribute("src");
    $("btnRawPlay").disabled = true;
    $("btnRawMute").disabled = true;
  }
  applyMute();
  applyRate();
}

/* 分离得干不干净，用「伴奏比原音低多少 dB」判断。
   纯人声素材（整段喘息、舔耳）分离完伴奏是空的，20dB 以下基本没东西可切，
   这时应该直接用「不分离」在原音上切，而不是在空轨上白挑十分钟。 */
function showSepWarn(r) {
  const box = $("sepWarn");
  if (!box) return;
  const db = Number(r.sep_db || 0);
  if (r.engine === "原素材（未分离）" || !db) { box.hidden = true; return; }
  if ((r.stem || "instrumental") === "vocals") {
    // 留人声时这个数说明的是「留下的人声比原音低多少」，低一些是正常的
    box.hidden = false;
    box.className = "sb-warn";
    box.textContent = `人声轨比原音低 ${Math.abs(db).toFixed(1)} dB。如果几乎听不到人声，`
      + "说明这条素材本来就不是以人声为主，换成「伴奏」或「原样」更合适。";
    return;
  }
  if (db <= -20) {
    box.hidden = false;
    box.className = "sb-warn bad";
    box.textContent = `分离后只剩 ${db} dB —— 这条素材几乎全是人声，伴奏轨基本是空的。`
      + "建议把上面的引擎改成「不分离」，直接在原音上切。";
  } else if (db <= -8) {
    box.hidden = false;
    box.className = "sb-warn";
    box.textContent = `分离后 ${db} dB：伴奏偏少，可能大部分内容都在人声轨里，切之前先听一遍。`;
  } else {
    box.hidden = true;
  }
}

/* ---------------- ③ 切分 ---------------- */
function segParams() {
  const mode = $("segMode").value;
  const p = {
    job: S.job, mode,
    min_gap: parseFloat($("minGap").value || "0.35"),
    min_len: parseFloat($("minLen").value || "0.2"),
    thresh_db: parseFloat($("thresh").value || "10"),
    pad: parseFloat($("pad").value || "0.03"),
  };
  if (mode === "srt") p.cues = S.cues.map((c) => [c.t0, c.t1]);
  return p;
}

async function doSegment(opt) {
  opt = opt || {};
  if (!S.job || S.busy) return;
  if ($("segMode").value === "srt" && !S.cues.length) {
    return toast("按字幕切分要先载入 SRT（左边第 4 张卡）", true);
  }
  // 切分 = 把整份片段列表换成新的。手工改过的起止 / 名字 / 删掉的段都会没，
  // 所以先问一句，并留一份可撤销的快照（或按需存成方案）。
  if (S.segs.length && (S.edited || S.undo.length)) {
    const ok = await askConfirm("重新切分会覆盖现在的片段",
      `当前有 <b>${S.segs.length}</b> 段，其中包含手工改动（改过起止 / 名字，或删过段）。\n\n`
      + "继续切分会按参数重新生成整份列表，这些改动会丢。\n"
      + "不想丢就点「取消」，先用下面的「处理方案 → 保存」存一份。",
      "继续切分");
    if (!ok) return;
    if ($("planAuto").checked) savePlan("", true);
  }
  S.busy = true;
  try {
    // 上一次的切分结果进撤销栈：万一新参数切得更差，一键回去
    if (S.segs.length) snap();
    const r = await api("/sfxb/segment", { method: "POST", body: segParams() });
    S.segs = (r.segments || []).map((s) => {
      s._id = ++S.seq;
      s.name = s.name || "";
      return s;
    });
    S.sel.clear();
    S.curSeg = -1;
    S.anchor = -1;
    S.dup.clear(); S.dupGroups = [];
    S.edited = false;
    S.limit = 240;
    S.playSeg = null;
    $("dupHint").hidden = true;
    $("btnDupDel").hidden = true;
    $("segStat").textContent = `切成 ${r.count} 段 · 覆盖 ${mmss(r.covered)} / ${mmss(r.dur)}`;
    if (r.fell_back) {
      $("segHint").textContent = "这一段是稳态声音（减掉背景后什么都没剩），已退回按原信号切。";
    } else if (r.mode === "srt") {
      $("segHint").textContent = r.count
        ? `按字幕取补集：字幕之外的部分切成 ${r.count} 段。`
        : "字幕之间没有够长的空隙：把「最短片段」调小，或确认字幕是不是覆盖了整段。";
    } else {
      $("segHint").textContent = r.count
        ? (r.count > 300 ? "片段很多：调大门限（比如 14）或提高「最短片段」会少很多。" : "点波形上的色块可以试听那一段。")
        : "一段都没切出来：把门限调低试试（比如 6），或换「先减稳态背景再切」。";
    }
    renderSegs();
    redrawAll();
  } catch (e) {
    toast("切分失败：" + e.message, true);
  } finally {
    S.busy = false;
  }
}

/* ---------------- 字幕参考层 ---------------- */
/* 只做时间参考：告诉你原音里"哪里在说话、说了多久"。
   不参与工作台的台本逻辑，也不改任何音频。 */

function parseSRT(text) {
  const out = [];
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const re = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;
  let cur = null;
  const push = () => {
    if (!cur) return;
    const body = cur.body.join(" ").replace(/<[^>]+>/g, "").replace(/\{[^}]+\}/g, "").trim();
    if (cur.t1 > cur.t0) out.push({ i: out.length, t0: cur.t0, t1: cur.t1, text: body });
    cur = null;
  };
  lines.forEach((raw) => {
    const line = raw.trim();
    const m = re.exec(line);
    if (m) {
      push();
      const s = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
      const e = (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]) + (+m[8]) / 1000;
      cur = { t0: s, t1: e, body: [] };
      return;
    }
    if (!cur) return;                                    // 序号行、空行，丢掉
    if (!line) { push(); return; }                       // 空行 = 一条结束
    if (/^\d+$/.test(line) && !cur.body.length) return;   // 纯数字序号
    cur.body.push(line);
  });
  push();
  out.sort((a, b) => a.t0 - b.t0);
  out.forEach((c, i) => { c.i = i; });
  return out;
}

/* 中文 SRT 一大半是 GBK，直接按 UTF-8 读会整篇乱码。
   先试 UTF-8（fatal 模式：解不动就抛），失败再退 GBK。 */
async function readTextSmart(file) {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch (e) {
    for (const enc of ["gbk", "gb18030", "big5"]) {
      try { return new TextDecoder(enc, { fatal: true }).decode(buf); } catch (err) { /* 继续 */ }
    }
    return new TextDecoder("utf-8").decode(buf);
  }
}

async function loadSrtFile(file) {
  if (!file) return;
  try {
    const text = await readTextSmart(file);
    applySrt(text, file.name);
  } catch (e) {
    toast("读不出来：" + e.message, true);
  }
}

function applySrt(text, name) {
  const cues = parseSRT(text);
  if (!cues.length) { toast("没解析到时间轴，确认是 .srt 文件（含 00:00:01,000 --> 00:00:03,000）", true); return; }
  applySrtCues(cues, name);
  const warn = cueMismatchText(cues);
  if (warn) toast(warn, true);
}

/* 字幕条统一入口：文件 / 粘贴 / 工作台台本都走这里 */
function applySrtCues(cues, name) {
  S.cues = cues;
  S.srtName = name || "粘贴的字幕";
  S.cueCur = -1;
  $("srtShow").checked = true;
  S.showSrt = true;
  $("btnSrtNext").disabled = false;
  const cover = cues.reduce((a, c) => a + (c.t1 - c.t0), 0);
  const info = `${S.srtName}：${cues.length} 条 · 覆盖 ${mmss(cover)}`
    + (S.dur ? ` / ${mmss(S.dur)}` : "");
  $("srtHint").textContent = info;
  $("srtInfo").textContent = `${cues.length} 条 · ${mmss(cover)}`;
  $("trkSrt").hidden = false;
  if (!$("segMode").value || $("segMode").value === "gap") {
    $("segMode").value = "srt";
    toast("已切到「按字幕间隔」——字幕之外就是音效候选区");
  }
  redrawAll();
}

/* 字幕和当前素材是不是同一版：末尾差太多就返回一句提醒（没有差异返回 ""）。
   混了会怎样：切分点整体偏（按字幕切原片素材），或者对位整段错（换音色后拿错字幕算第几句）。
   实测 13 句里能错 10 句，所以值得提示一次 —— 但只提示，不拦人。
   单独抽出来是因为调用方要塞进自己的 toast 里：两个 toast 前后脚弹，后一个会盖掉前一个。 */
function cueMismatchText(cues) {
  const raw = S.durRaw || S.dur || 0;
  if (!cues || !cues.length || !raw) return "";
  const end = cues.reduce((a, c) => Math.max(a, c.t1 || 0), 0);
  const tol = Math.max(1, raw * 0.03);
  if (Math.abs(end - raw) <= tol) return "";
  const short = end < raw ? "短" : "长";
  return `注意：这份字幕到 ${mmss(end)}，当前素材 ${mmss(raw)} —— 比素材${short} `
    + `${mmss(Math.abs(raw - end))}，两者不是同一版。`
    + "按它切分会对不上；素材是原片就换原片那份 srt。";
}

function clearSrt() {
  S.cues = []; S.srtName = ""; S.cueCur = -1;
  $("srtHint").textContent = "把原音声的字幕放进来，会多出一条字幕轨：每句一块，点一下就跳到那句。";
  $("srtInfo").textContent = "";
  $("btnSrtNext").disabled = true;
  $("srtFile").value = "";
  $("trkSrt").hidden = true;
  if ($("segMode").value === "srt") $("segMode").value = "gap";
  redrawAll();
}

function cueAfter(t, wrap) {
  for (let i = 0; i < S.cues.length; i++) if (S.cues[i].t0 > t + 0.02) return i;
  return wrap ? (S.cues.length ? 0 : -1) : -1;
}
function cueBefore(t, wrap) {
  for (let i = S.cues.length - 1; i >= 0; i--) if (S.cues[i].t1 < t - 0.02) return i;
  return wrap ? (S.cues.length ? S.cues.length - 1 : -1) : -1;
}
function cueAt(t) {
  return S.cues.findIndex((c) => t >= c.t0 && t <= c.t1);
}

/* ---------------- 视图（缩放 / 平移） ---------------- */
function viewSpan() { return Math.max(0.02, S.view.b - S.view.a); }
function resetView() {
  S.view.a = 0;
  S.view.b = S.dur || 0;
  updateZoomLabel();
}
function clampView() {
  const span = viewSpan();
  if (span >= S.dur) {
    S.view.a = 0; S.view.b = S.dur;
  } else {
    if (S.view.a < 0) { S.view.b -= S.view.a; S.view.a = 0; }
    if (S.view.b > S.dur) { S.view.a -= (S.view.b - S.dur); S.view.b = S.dur; }
    S.view.a = Math.max(0, S.view.a);
  }
  updateZoomLabel();
}
function updateZoomLabel() {
  const d = S.dur || 1;
  const z = Math.round((d / viewSpan()) * 100);
  const lb = $("zoomPct");
  if (lb) lb.textContent = `${z > 1000 ? Math.round(z / 100) * 100 : z}%`;
}
function zoomAt(t, factor) {
  if (!S.dur) return;
  const span = Math.max(0.15, Math.min(S.dur, viewSpan() * factor));
  const ratio = (t - S.view.a) / viewSpan();
  S.view.a = t - ratio * span;
  S.view.b = S.view.a + span;
  clampView();
  redrawAll();
}
function tx(t, W) { return ((t - S.view.a) / viewSpan()) * W; }
function xt(x, W) { return S.view.a + (x / Math.max(1, W)) * viewSpan(); }

/* 时间 ↔ 像素：每条轨用同一个视窗，所以共用一套换算 */
function canvasOf(which) {
  return which === "raw" ? $("waveRaw") : which === "srt" ? $("waveSrt") : $("wave");
}
function ctx2d(cv) {
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 600;
  const H = cv.clientHeight || 100;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
  }
  const c = cv.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);
  return { c, W, H };
}
function pos(e, cv) {
  const r = cv.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
}

/* 画包络：按可视窗口裁剪，块数太多时按像素合并 */
function drawEnv(c, env, total, W, y0, h, color) {
  if (!env.length) return;
  const n = env.length;
  const per = (total || 1) / n;
  const i0 = Math.max(0, Math.floor(S.view.a / per));
  const i1 = Math.min(n, Math.ceil(S.view.b / per));
  const mid = y0 + h / 2;
  c.fillStyle = color;
  for (let i = i0; i < i1; i++) {
    const x = tx(i * per, W);
    const w = Math.max(1, (W / Math.max(1, i1 - i0)) * 0.8);
    const hh = Math.max(1, env[i] * (h - 4));
    c.fillRect(x, mid - hh / 2, w, hh);
  }
}

function drawPlayhead(c, W, H) {
  const t = curTime();
  if (t < S.view.a - 0.01 || t > S.view.b + 0.01) return;
  const x = Math.round(tx(t, W)) + 0.5;
  c.strokeStyle = "#d4537e";
  c.lineWidth = 1.5;
  c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke();
}

function drawRaw() {
  const cv = $("waveRaw");
  if (!cv || !S.envRaw.length) return;
  const { c, W, H } = ctx2d(cv);
  // 原音轨只勾"当前选中"的那几段：全都涂一遍的话整条轨都是橙的，反而看不出选了谁
  S.segs.forEach((s) => {
    if (!S.sel.has(s._id)) return;
    const x0 = tx(s.start, W), x1 = tx(s.end, W);
    if (x1 < 0 || x0 > W) return;
    c.fillStyle = "rgba(200,161,90,.26)";
    c.fillRect(Math.max(0, x0), 0, Math.max(1, Math.min(W, x1) - Math.max(0, x0)), H);
  });
  drawEnv(c, S.envRaw, S.durRaw || S.dur, W, 4, H - 8, sbIsDark() ? "#d0a86a" : "#c8b48c");
  drawPlayhead(c, W, H);
}

function drawProc() {
  const cv = $("wave");
  if (!cv || !S.env.length) return;
  const { c, W, H } = ctx2d(cv);

  // 分段底色
  S.segs.forEach((s, i) => {
    const x0 = tx(s.start, W), x1 = tx(s.end, W);
    if (x1 < 0 || x0 > W) return;
    const on = S.sel.has(s._id);
    c.fillStyle = i === S.curSeg ? "rgba(83,74,183,.30)"
      : on ? "rgba(83,74,183,.18)" : "rgba(83,74,183,.07)";
    c.fillRect(Math.max(-2, x0), 0, Math.max(1, Math.min(W + 2, x1) - Math.max(-2, x0)), H);
  });

  drawEnv(c, S.env, S.dur, W, 6, H - 12, sbIsDark() ? "#8d8880" : "#b9b3a7");

  // 边界线 + 序号：少的时候画，几千条就不画了
  if (S.segs.length <= 400) {
    c.lineWidth = 1;
    S.segs.forEach((s, i) => {
      const x0 = Math.round(tx(s.start, W)) + 0.5;
      const x1 = Math.round(tx(s.end, W)) + 0.5;
      if (x1 < -1 || x0 > W + 1) return;
      c.strokeStyle = S.sel.has(s._id) ? "rgba(83,74,183,.85)" : "rgba(83,74,183,.45)";
      c.beginPath(); c.moveTo(x0, 0); c.lineTo(x0, H); c.stroke();
      c.beginPath(); c.moveTo(x1, 0); c.lineTo(x1, H); c.stroke();
      const wpx = x1 - x0;
      if (wpx > 22) {
        c.fillStyle = "rgba(83,74,183,.75)";
        c.font = "9px ui-monospace, Consolas, monospace";
        c.fillText(String(i + 1), x0 + 3, 10);
      }
    });
  }

  // 圈选预览
  if (S.drag && S.drag.mode === "mark" && S.drag.moved) {
    const a = Math.min(S.drag.t0, S.drag.t1), b = Math.max(S.drag.t0, S.drag.t1);
    const x0 = tx(a, W), x1 = tx(b, W);
    c.fillStyle = "rgba(29,158,117,.18)";
    c.fillRect(x0, 0, Math.max(1, x1 - x0), H);
    c.strokeStyle = "rgba(29,158,117,.85)";
    c.lineWidth = 1;
    c.strokeRect(x0 + 0.5, 0.5, Math.max(1, x1 - x0), H - 1);
  }

  drawPlayhead(c, W, H);
}

function drawSrt() {
  const cv = $("waveSrt");
  if (!cv || $("trkSrt").hidden) return;
  const { c, W, H } = ctx2d(cv);
  c.font = "9px ui-monospace, Consolas, monospace";
  S.cues.forEach((q) => {
    const x0 = tx(q.t0, W), x1 = tx(q.t1, W);
    if (x1 < -2 || x0 > W + 2) return;
    const on = q.i === S.cueCur;
    const w = Math.max(2, x1 - x0);
    c.fillStyle = on ? "rgba(23,146,153,.85)" : "rgba(23,146,153,.55)";
    c.fillRect(Math.max(0, x0), 4, Math.min(W, w), H - 12);
    // 两端的竖线：这是"这句从哪开始、到哪结束"最直接的读法
    c.fillStyle = "rgba(10,90,96,.9)";
    if (x0 >= 0 && x0 <= W) c.fillRect(x0, 2, 1, H - 8);
    if (x1 >= 0 && x1 <= W) c.fillRect(x1 - 1, 2, 1, H - 8);
    if (w > 20) {
      c.fillStyle = "rgba(255,255,255,.92)";
      c.fillText(String(q.i + 1), Math.max(0, x0) + 3, H - 8);
    }
  });
  drawPlayhead(c, W, H);
}

function drawNav() {
  const cv = $("nav");
  if (!cv) return;
  const { c, W, H } = ctx2d(cv);
  const total = S.dur || 1;
  // 全长包络（不跟着视窗裁）
  const env = S.env;
  if (env.length) {
    const n = env.length;
    const step = Math.max(1, Math.floor(n / Math.max(1, W)));
    for (let x = 0; x < W; x++) {
      const i = Math.min(n - 1, Math.floor((x / W) * n));
      const hh = Math.max(1, env[i] * (H - 8));
      c.fillStyle = sbIsDark() ? "rgba(150,145,136,.85)" : "rgba(185,179,167,.85)";
      c.fillRect(x, (H - hh) / 2, 1, hh);
    }
  }
  // 片段刻线
  c.fillStyle = "rgba(83,74,183,.35)";
  S.segs.forEach((s) => {
    const x = (s.start / total) * W;
    c.fillRect(x, 1, 1, H - 2);
  });
  // 视窗方块
  const xa = (S.view.a / total) * W;
  const xb = (S.view.b / total) * W;
  c.strokeStyle = "rgba(83,74,183,.9)";
  c.lineWidth = 1;
  c.strokeRect(xa + 0.5, 0.5, Math.max(2, xb - xa), H - 1);
  c.fillStyle = "rgba(83,74,183,.10)";
  c.fillRect(xa, 0, Math.max(2, xb - xa), H);
  // 播放头
  const px = (curTime() / total) * W;
  if (px >= 0 && px <= W) {
    c.strokeStyle = "#d4537e";
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(px + 0.5, 0); c.lineTo(px + 0.5, H); c.stroke();
  }
  $("navCap").textContent = `${mmss(S.view.a)}–${mmss(S.view.b)} / ${mmss(S.dur)}`;
}

/* 播放头条：刻度 + 片段刻线 + 字幕刻线 + 播放头。
   和时间轴页面不同，这里**不画波形**：波形区已经要处理圈选/拖边界，
   再叠一层「哪都能拖播放头」就会抢手势。 */
const SCRUB_STEPS = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];

function scrubTickStep(span, W) {
  // 每 76px 一个带字的刻度；从"够稀疏"的那一档往上取
  const want = (span / Math.max(1, W)) * 76;
  return SCRUB_STEPS.find((s) => s >= want) || SCRUB_STEPS[SCRUB_STEPS.length - 1];
}

function drawScrub() {
  const cv = $("scrub");
  if (!cv) return;
  const { c, W, H } = ctx2d(cv);
  const span = viewSpan();
  const base = H - 11;

  // 片段：淡淡一条，标出"这一段有内容"，密度一眼可见
  S.segs.forEach((s) => {
    const x0 = tx(s.start, W), x1 = tx(s.end, W);
    if (x1 < 0 || x0 > W) return;
    const on = S.sel.has(s._id);
    c.fillStyle = on ? "rgba(83,74,183,.42)" : "rgba(83,74,183,.18)";
    c.fillRect(Math.max(0, x0), 3, Math.max(1, Math.min(W, x1) - Math.max(0, x0)), 7);
  });
  // 字幕：青色小刻度（参考层，不参与编辑）
  if (!$("trkSrt").hidden) {
    c.fillStyle = "rgba(23,146,153,.55)";
    S.cues.forEach((q) => {
      const x0 = tx(q.t0, W), x1 = tx(q.t1, W);
      if (x1 < 0 || x0 > W) return;
      c.fillRect(Math.max(0, x0), 11, Math.max(1, Math.min(W, x1) - Math.max(0, x0)), 2);
    });
  }

  // 刻度
  const step = scrubTickStep(span, W);
  const t0 = Math.ceil(S.view.a / step) * step;
  c.font = "9px ui-monospace, Consolas, monospace";
  c.textBaseline = "alphabetic";
  let lastEnd = -99;
  for (let t = t0; t <= S.view.b + 1e-6; t += step) {
    const x = Math.round(tx(t, W)) + 0.5;
    if (x < 0 || x > W) continue;
    c.strokeStyle = "rgba(120,115,105,.38)";
    c.beginPath(); c.moveTo(x, base); c.lineTo(x, base + 4); c.stroke();
    const label = step < 1 ? mmssc(t) : mmss(t);
    const w = c.measureText(label).width;
    // 右端会被夹到边界上：和上一个标签挨着就跳过，免得两条数字叠成一团
    const lx = Math.min(W - w - 1, Math.max(0, x + 2));
    if (lx > lastEnd + 4) {
      c.fillStyle = "rgba(120,115,105,.9)";
      c.fillText(label, lx, H - 1);
      lastEnd = lx + w;
    }
  }
  // 细分刻度（每档 5 份）
  c.strokeStyle = "rgba(120,115,105,.18)";
  for (let t = S.view.a; t <= S.view.b; t += step / 5) {
    const x = Math.round(tx(t, W)) + 0.5;
    c.beginPath(); c.moveTo(x, base); c.lineTo(x, base + 2); c.stroke();
  }

  // 播放头：竖线 + 顶部抓手（抓手是"这条能拖"的唯一提示，必须有）
  const t = curTime();
  if (t >= S.view.a - 0.01 && t <= S.view.b + 0.01) {
    const x = Math.round(tx(t, W)) + 0.5;
    c.strokeStyle = "#d4537e";
    c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(x, 1); c.lineTo(x, H - 1); c.stroke();
    c.fillStyle = "#d4537e";
    c.beginPath();
    c.moveTo(x - 5, 1); c.lineTo(x + 5, 1); c.lineTo(x, 9); c.closePath();
    c.fill();
    c.lineWidth = 1;
  }
}

/* ---------------- 主题（和工作台共用 lf.theme） ---------------- */
function sbIsDark() { return document.documentElement.dataset.theme === "dark"; }

function paintSbTheme() {
  const b = document.getElementById("btnSbTheme");
  if (!b) return;
  const dark = sbIsDark();
  b.textContent = dark ? "☀ 日间" : "🌙 夜间";
  b.classList.toggle("on", dark);
}

function initSbTheme() {
  paintSbTheme();
  const b = document.getElementById("btnSbTheme");
  if (b) {
    b.onclick = () => {
      const next = sbIsDark() ? "light" : "dark";
      try { localStorage.setItem("lf.theme", next); } catch (e) { /* ignore */ }
      document.documentElement.dataset.theme = next;
      paintSbTheme();
      sbOnThemeChanged();
    };
  }
  window.__sbThemeChanged = () => { paintSbTheme(); sbOnThemeChanged(); };
}

/* 换主题后波形/导航条要按新配色重画（canvas 颜色是画上去的，不重画就还是旧的） */
function sbOnThemeChanged() {
  try { redrawAll(); } catch (e) { /* 还没载入素材 */ }
}

function redrawAll() {
  if ($("editor").hidden) return;
  drawNav(); drawScrub(); drawRaw(); drawProc(); drawSrt();
}
function drawWave() { redrawAll(); }      // 旧名字保留：外部/测试还在用

/* ---------------- 播放 ---------------- */
function curTime() {
  const p = $("auProc");
  if (p && p.src) return p.currentTime || 0;
  const r = $("auRaw");
  return r && r.src ? r.currentTime || 0 : 0;
}
function applyMute() {
  const p = $("auProc"), r = $("auRaw");
  if (p) p.muted = S.muteProc || S.only === "raw";
  if (r) r.muted = S.muteRaw || S.only === "proc";
  const bm = $("btnProcMute"), rm = $("btnRawMute");
  if (bm) { bm.textContent = (S.muteProc || S.only === "proc") ? "🔇" : "🔊"; bm.classList.toggle("on", S.muteProc); }
  if (rm) { rm.textContent = (S.muteRaw || S.only === "raw") ? "🔇" : "🔊"; rm.classList.toggle("on", S.muteRaw); }
  paintPlayStates();
}
function applyRate() {
  const v = parseFloat($("speed").value || "1");
  [$("auProc"), $("auRaw")].forEach((a) => { if (a) a.playbackRate = v; });
}
function applyVol() {
  const p = $("auProc"), r = $("auRaw");
  if (p) p.volume = Math.max(0, Math.min(1, (parseFloat($("volProc").value || "100")) / 100));
  if (r) r.volume = Math.max(0, Math.min(1, (parseFloat($("volRaw").value || "100")) / 100));
}

function seekAll(t) {
  t = Math.max(0, Number(t) || 0);
  const p = $("auProc"), r = $("auRaw");
  try { if (p && p.src) p.currentTime = Math.min(t, p.duration || t); } catch (e) { /* 未就绪 */ }
  try { if (r && r.src) r.currentTime = Math.min(t, r.duration || t); } catch (e) { /* 未就绪 */ }
}

/* 定位到某处再播。必须等 loadedmetadata —— 音频还没加载好时直接写 currentTime
   会被忽略（表现为「点了没反应、从头播」），这是最容易踩的一个坑。 */
function seekAndPlay(start, endAt, only, segId) {
  hideTip();
  const p = $("auProc");
  const r = $("auRaw");
  const ready = (p && p.src && p.readyState >= 1) || (r && r.src && r.readyState >= 1);
  const go = () => {
    seekAll(Math.max(0, start || 0));
    S.stopAt = endAt || 0;
    S.stopAtStart = Math.max(0, start || 0);
    S.only = only || "";
    S.playSeg = segId == null ? null : segId;
    applyMute();
    S.playing = true;
    paintPlayBtn();
    [p, r].forEach((a) => {
      if (!a || !a.src) return;
      const pr = a.play();
      if (pr && pr.catch) pr.catch(() => {});
    });
  };
  if (ready) go();
  else {
    const a = (p && p.src) ? p : r;
    if (!a) return;
    a.addEventListener("loadedmetadata", go, { once: true });
  }
}

function paintPlayBtn() {
  $("btnPlayAll").textContent = S.playing ? "⏸ 暂停" : "▶ 播放";
  paintPlayStates();
}

/* 播放状态统一在这里刷：主按钮、播放头条、两条轨道的按钮 + 状态胶囊、
   以及列表里每一行的 ▶/⏸。散在各处改文字是最容易漏的（漏了就会出现
   "点了暂停但按钮还写着暂停"）。 */
function paintPlayStates() {
  const procPlaying = S.playing && S.only !== "raw";
  const rawPlaying = S.playing && (S.only === "raw" || !S.only);
  const rawMuted = S.muteRaw || S.only === "proc";
  const procMuted = S.muteProc || S.only === "raw";

  const setBtn = (id, playing, base, pauseText) => {
    const b = $(id);
    if (!b) return;
    b.textContent = playing ? (pauseText || "⏸") : (base || "▶");
    b.classList.toggle("playing", !!playing);
    b.title = playing ? "暂停" : "播放";
  };
  setBtn("btnScrubPlay", S.playing, "▶", "⏸");
  setBtn("btnPlayAll", S.playing, "▶ 播放", "⏸ 暂停");

  const rawBtn = $("btnRawPlay"), procBtn = $("btnProcPlay");
  if (rawBtn) {
    rawBtn.textContent = (S.playing && S.only === "raw") ? "⏸" : "▶";
    rawBtn.classList.toggle("playing", S.playing && S.only === "raw");
  }
  if (procBtn) {
    procBtn.textContent = (S.playing && S.only === "proc") ? "⏸" : "▶";
    procBtn.classList.toggle("playing", S.playing && S.only === "proc");
  }

  const state = (id, playing, muted, playWord) => {
    const b = $(id);
    if (!b) return;
    b.classList.toggle("play", !!playing);
    b.classList.toggle("mute", !playing && !!muted);
    b.textContent = playing ? (playWord || "播放中") : (muted ? "已静音" : "待命");
  };
  state("rawState", rawPlaying && !rawMuted, rawMuted);
  state("procState", procPlaying && !procMuted, procMuted);

  // 列表行：正在试听的那段显示 ⏸
  [...$("segList").children].forEach((row) => {
    const id = Number(row.dataset.id);
    const b = row.querySelector('button[data-play="1"]');
    if (!b) return;
    const on = S.playing && S.playSeg === id;
    b.textContent = on ? "⏸" : "▶";
    b.classList.toggle("playing", on);
    b.title = on ? "暂停这一段" : "试听这一段";
  });
}
function stopPlay() {
  [$("auProc"), $("auRaw")].forEach((a) => { if (a) a.pause(); });
  S.playing = false;
  S.stopAt = 0;
  S.only = "";
  S.playSeg = null;
  applyMute();
  paintPlayBtn();
}
function playSeg(i, only) {
  const s = S.segs[i];
  if (!s) return;
  if (S.playing && S.playSeg === s._id && !only) return stopPlay();
  seekAndPlay(s.start, s.end, only, s._id);
}
function togglePlayAll() {
  if (S.playing) return stopPlay();
  seekAndPlay(curTime(), 0);
}

/* ---------------- 选择 ---------------- */
function selectOnly(i) {
  S.sel.clear();
  if (i >= 0 && S.segs[i]) S.sel.add(S.segs[i]._id);
  S.curSeg = i;
  S.anchor = i;
  updateSel(); paintRows();
}
function toggleSel(i) {
  const s = S.segs[i];
  if (!s) return;
  if (S.sel.has(s._id)) S.sel.delete(s._id); else S.sel.add(s._id);
  S.curSeg = i; S.anchor = i;
  updateSel(); paintRows();
}
function rangeSel(i) {
  if (S.anchor < 0) return selectOnly(i);
  const a = Math.min(S.anchor, i), b = Math.max(S.anchor, i);
  S.sel.clear();
  for (let k = a; k <= b; k++) if (S.segs[k]) S.sel.add(S.segs[k]._id);
  S.curSeg = i;
  updateSel(); paintRows();
}
function selIdx() {
  const out = [];
  S.segs.forEach((s, i) => { if (S.sel.has(s._id)) out.push(i); });
  return out;
}

function updateSel() {
  const alive = new Set(S.segs.map((x) => x._id));
  [...S.sel].forEach((id) => { if (!alive.has(id)) S.sel.delete(id); });
  [...S.dup].forEach((id) => { if (!alive.has(id)) S.dup.delete(id); });
  const pick = selIdx();
  const dur = pick.reduce((a, i) => a + S.segs[i].dur, 0);
  $("selStat").textContent = pick.length
    ? `已选 ${pick.length} / ${S.segs.length} 段 · 合计 ${dur.toFixed(1)}s`
    : `已选 0 / ${S.segs.length} 段`;
  $("btnSave").disabled = pick.length === 0;
  if ($("btnFootSave")) {
    $("btnFootSave").disabled = pick.length === 0;
    const lib = { sfx: "音效库", ref: "音色库", media: "导入台" }[$("target").value] || "库";
    $("btnFootSave").textContent = pick.length ? `存入${lib}（${pick.length} 段）` : `存入${lib}`;
  }
  // 写入工程：没勾就默认整批（和「一键全流程」一致），所以只要有片段就能点
  $("btnInsert").disabled = !S.segs.length || !$("tlSid").value || !S.job;
  if ($("btnMapPreview")) $("btnMapPreview").disabled = !S.segs.length || !$("tlSid").value;
  const all = S.segs.length && S.sel.size === S.segs.length;
  $("selAll").checked = !!all;
  // 选中集合变了就把行也刷一遍：不然外部（快捷键 / 菜单 / 测试）改了 sel，
  // 列表上的高亮还停在旧状态，看起来像"点了没反应"
  paintRows();
  if (typeof paintSaveFolder === "function") paintSaveFolder();   // 「会存进哪儿」跟着段数变
}

/* ---------------- 编辑操作（都进撤销栈） ---------------- */
function snap() {
  S.undo.push(S.segs.map((s) => ({ _id: s._id, start: s.start, end: s.end,
    dur: s.dur, name: s.name, rms_db: s.rms_db, ops: s.ops ? JSON.parse(JSON.stringify(s.ops)) : null })));
  if (S.undo.length > 40) S.undo.shift();
  S.edited = true;                      // 有快照 = 有手工改动（重新切分前要提醒）
  $("toolUndo").disabled = false;
}
function undo() {
  if (!S.undo.length) return toast("没有可撤销的操作");
  const prev = S.undo.pop();
  const now = S.segs.map((s) => ({ _id: s._id, start: s.start, end: s.end,
    dur: s.dur, name: s.name, rms_db: s.rms_db, ops: s.ops ? JSON.parse(JSON.stringify(s.ops)) : null }));
  S.segs = prev;
  S.curSeg = Math.min(S.curSeg, S.segs.length - 1);
  S.redo = S.redo || [];
  S.redo.push(now);
  if (S.redo.length > 40) S.redo.shift();
  S.edited = true;
  updateSel(); renderSegs(); redrawAll();
  $("toolUndo").disabled = !S.undo.length;
  $("toolRedo").disabled = false;
  toast("已撤销");
}

function redo() {
  if (!S.redo || !S.redo.length) return toast("没有可重做的操作");
  S.undo = S.undo || [];
  S.undo.push(S.segs.map((s) => ({ _id: s._id, start: s.start, end: s.end,
    dur: s.dur, name: s.name, rms_db: s.rms_db, ops: s.ops ? JSON.parse(JSON.stringify(s.ops)) : null })));
  S.segs = S.redo.pop();
  S.curSeg = Math.min(S.curSeg, S.segs.length - 1);
  updateSel(); renderSegs(); redrawAll();
  $("toolUndo").disabled = false;
  $("toolRedo").disabled = !S.redo.length;
  toast("已重做");
}

/* 在播放头处切分：选中了就在每条的播放头处切；没选就切播放头所在那段 */
function splitSeg(i) {
  const t = curTime();
  let targets;
  if (typeof i === "number" && S.segs[i]) targets = [i];
  else {
    const pick = selIdx();
    targets = pick.length ? pick : S.segs
      .map((s, k) => (t > s.start + 0.05 && t < s.end - 0.05 ? k : -1))
      .filter((k) => k >= 0).slice(0, 1);
  }
  const ok = targets.filter((k) => {
    const s = S.segs[k];
    return s && t > s.start + 0.05 && t < s.end - 0.05;
  });
  if (!ok.length) {
    return toast(targets.length
      ? "播放头不在这些片段内部（离边界太近也切不了）"
      : "先把播放头拖到某一段中间，或先选中要切的片段", true);
  }
  snap();
  // 从后往前插，避免索引漂移
  ok.sort((a, b) => b - a).forEach((k) => {
    const s = S.segs[k];
    const b = { ...s, _id: ++S.seq, start: +t.toFixed(3), end: s.end,
                dur: +(s.end - t).toFixed(3), name: "" };
    s.end = +t.toFixed(3);
    s.dur = +(t - s.start).toFixed(3);
    s.rms_db = levelOf(s.start, s.end);
    b.rms_db = levelOf(b.start, b.end);
    if (S.sel.has(s._id)) S.sel.add(b._id);
    S.segs.splice(k + 1, 0, b);
  });
  renderSegs(); redrawAll();
  toast(`在 ${mmssc(t)} 切分 ${ok.length} 处`);
}

/* 合并：选中多段时并成一段（跨过中间空隙）；只选一段就并入下一段 */
function mergeSeg(i) {
  const pick = selIdx();
  let group = pick.length >= 2 ? pick : null;
  if (!group && typeof i === "number" && S.segs[i] && S.segs[i + 1]) group = [i, i + 1];
  if (!group || group.length < 2) return toast("合并至少要选中两段（Shift 点选或拖框）", true);
  group.sort((a, b) => a - b);
  snap();
  const first = S.segs[group[0]];
  const last = S.segs[group[group.length - 1]];
  first.end = last.end;
  first.dur = +(last.end - first.start).toFixed(3);
  first.rms_db = levelOf(first.start, first.end);
  if (!first.name && last.name) first.name = last.name;
  const drop = new Set(group.slice(1).map((k) => S.segs[k]._id));
  S.sel.delete(first._id);
  S.sel.add(first._id);
  drop.forEach((id) => S.sel.delete(id));
  S.segs = S.segs.filter((s) => !drop.has(s._id));
  S.curSeg = -1;
  renderSegs(); redrawAll();
  toast(`合并成 1 段（${first.start.toFixed(2)}–${first.end.toFixed(2)}）`);
}

function delSeg(i) {
  let targets;
  if (typeof i === "number" && S.segs[i]) targets = [i];
  else targets = selIdx();
  if (!targets.length) return toast("先选中要删除的片段", true);
  snap();
  const drop = new Set(targets.map((k) => S.segs[k]._id));
  drop.forEach((id) => { S.sel.delete(id); S.dup.delete(id); });
  S.segs = S.segs.filter((s) => !drop.has(s._id));
  S.curSeg = Math.min(S.curSeg, S.segs.length - 1);
  renderSegs(); redrawAll();
  toast(`删掉 ${targets.length} 段（只是不保存，不动原素材）`);
}

/* 用包络估一个电平（dBFS）。新片段、拖过边界的片段都要重算，
   否则列表里永远写着新建时的 -60dB，看着像"没声音"。 */
function levelOf(a, b) {
  if (!S.env.length) return -60;
  const per = (S.dur || 1) / S.env.length;
  const i0 = Math.max(0, Math.floor(a / per));
  const i1 = Math.min(S.env.length, Math.ceil(b / per));
  let sum = 0, n = 0;
  for (let i = i0; i < i1; i++) { sum += S.env[i] * S.env[i]; n++; }
  if (!n) return -60;
  return Math.round(20 * Math.log10(Math.sqrt(sum / n) + 1e-9) * 10) / 10;
}

/* 片段按时间排好再显示。合并跨段或手动标记之后，数组顺序可能和视觉顺序不一致，
   列表就会"跳来跳去"；这里统一排一次，curSeg 用 id 找回来。 */
function normalize() {
  const curId = S.segs[S.curSeg] ? S.segs[S.curSeg]._id : null;
  S.segs.sort((a, b) => (a.start - b.start) || (a.end - b.end));
  if (curId != null) {
    const k = S.segs.findIndex((x) => x._id === curId);
    if (k >= 0) S.curSeg = k;
  }
}

function newSeg(a, b, quiet) {
  a = Math.max(0, Math.min(S.dur, a));
  b = Math.max(0, Math.min(S.dur, b));
  if (b - a < 0.05) return null;
  const seg = { _id: ++S.seq, start: +a.toFixed(3), end: +b.toFixed(3),
                dur: +(b - a).toFixed(3), name: "", rms_db: levelOf(a, b), peak: 0 };
  // 插到按时间排好的位置上，列表顺序 = 时间顺序（否则插完列表乱）
  let k = S.segs.findIndex((s) => s.start > seg.start);
  if (k < 0) k = S.segs.length;
  S.segs.splice(k, 0, seg);
  if (!quiet) { selectOnly(k); renderSegs(); }
  redrawAll();
  return k;
}

function nudgeEdge(side) {
  const pick = selIdx();
  if (!pick.length) return toast("先选中片段", true);
  const t = curTime();
  snap();
  pick.forEach((k) => {
    const s = S.segs[k];
    if (side === "start") {
      s.start = Math.min(+t.toFixed(3), s.end - 0.05);
    } else {
      s.end = Math.max(+t.toFixed(3), s.start + 0.05);
    }
    s.dur = +(s.end - s.start).toFixed(3);
  });
  renderSegs(); redrawAll();
  toast(`已把 ${pick.length} 段的${side === "start" ? "起点" : "终点"}移到 ${mmssc(t)}`);
}

/* ---------------- 片段列表 ---------------- */
function renderSegs() {
  const box = $("segList");
  normalize();
  box.innerHTML = "";
  const has = S.segs.length > 0;
  box.hidden = !has;
  $("foot").hidden = !has;
  if (!has) { $("empty").hidden = !!S.job; return; }
  $("empty").hidden = true;

  const limit = S.limit || 240;
  const shown = S.segs.slice(0, Math.min(PARAM_LIMIT, limit));
  shown.forEach((s, i) => {
    const dup = S.dup.has(s._id);
    const on = S.sel.has(s._id);
    const row = el("div", "sb-row" + (i === S.curSeg ? " cur" : "") + (on ? " sel" : "") + (dup ? " dup" : ""));
    row.dataset.id = s._id;
    row.dataset.ix = i;

    // 点行 = 只选它；Ctrl/⌘ = 加减选；Shift = 选一段范围
    row.onclick = (e) => {
      if (e.target.closest("input, button")) return;
      if (e.shiftKey) rangeSel(i);
      else if (e.ctrlKey || e.metaKey) toggleSel(i);
      else selectOnly(i);
    };
    row.ondblclick = (e) => {
      if (e.target.closest("input, button")) return;
      S.curSeg = i; playSeg(i);
    };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      // 这里必须读实时的 sel：on 是渲染那一刻的快照，多选之后早就过期了
      if (!S.sel.has(s._id)) selectOnly(i);
      openCtxMenu(e.clientX, e.clientY, i);
    };

    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = on;
    chk.onchange = () => {
      if (chk.checked) S.sel.add(s._id); else S.sel.delete(s._id);
      S.curSeg = i;
      updateSel(); paintRows(); redrawAll();
    };
    row.appendChild(chk);

    row.appendChild(el("span", "ix", String(i + 1).padStart(2, "0")));

    const nm = el("span", "nm");
    const inp = document.createElement("input");
    inp.value = s.name || "";
    inp.placeholder = suggestName(s) || "给这一段起个名字（不填就自动编号）";
    inp.oninput = () => { s.name = inp.value; S.edited = true; };
    nm.appendChild(inp);
    row.appendChild(nm);

    if (dup) row.appendChild(el("span", "tagdup", "重复"));
    const fx = fxLabels(s.ops);
    if (fx.length) {
      const tag = el("span", "fx", "FX");
      tag.title = "已处理：" + fx.join(" / ") + "（点一下修改，右键可清除）";
      tag.onclick = (e) => { e.stopPropagation(); selectOnly(i); openOps(); };
      row.appendChild(tag);
    }

    // 起止时间可编辑：切点对不齐时，手改数字比来回调参数快
    const timeBox = el("span", "te-box");
    const t0 = el("input", "te");
    t0.type = "number"; t0.step = "0.01"; t0.min = "0"; t0.max = String(S.dur);
    t0.value = s.start.toFixed(2);
    const sep = el("span", "te-sep", "–");
    const t1 = el("input", "te");
    t1.type = "number"; t1.step = "0.01"; t1.min = "0"; t1.max = String(S.dur);
    t1.value = s.end.toFixed(2);
    const mt = el("span", "mt", `${s.dur.toFixed(2)}s · ${Math.round(s.rms_db)}dB`);
    const commit = () => {
      let a = parseFloat(t0.value), b = parseFloat(t1.value);
      if (!isFinite(a)) a = s.start;
      if (!isFinite(b)) b = s.end;
      a = Math.max(0, Math.min(S.dur, a));
      b = Math.max(0, Math.min(S.dur, b));
      if (b - a < 0.05) b = Math.min(S.dur, a + 0.05);
      s.start = +a.toFixed(2); s.end = +b.toFixed(2);
      s.dur = +(b - a).toFixed(3);
      s.rms_db = levelOf(s.start, s.end);
      t0.value = s.start.toFixed(2); t1.value = s.end.toFixed(2);
      // 行尾的时长/电平、以及占位提示都得跟着变，否则会出现"20.00–20.05 但写着 4.56s"
      mt.textContent = `${s.dur.toFixed(2)}s · ${Math.round(s.rms_db)}dB`;
      inp.placeholder = suggestName(s) || "给这一段起个名字（不填就自动编号）";
      redrawAll();
    };
    t0.onchange = commit; t1.onchange = commit;
    timeBox.appendChild(t0); timeBox.appendChild(sep); timeBox.appendChild(t1);
    row.appendChild(timeBox);

    row.appendChild(mt);

    const playingMe = S.playing && S.playSeg === s._id;
    const pb = el("button", "ib" + (playingMe ? " playing" : ""), playingMe ? "⏸" : "▶");
    pb.dataset.play = "1";
    pb.title = playingMe ? "暂停这一段" : "试听这一段";
    pb.onclick = (e) => {
      e.stopPropagation();
      S.curSeg = i;
      playSeg(i);                 // 再点一次同一段 = 暂停（playSeg 内部判断）
      paintRows(); paintPlayStates(); redrawAll();
    };
    row.appendChild(pb);

    const sp = el("button", "ib", "✂");
    sp.title = "在播放头处把这一段拆成两段";
    sp.onclick = () => splitSeg(i);
    row.appendChild(sp);

    const mg = el("button", "ib", "⤵");
    mg.title = "和下一段合并";
    mg.onclick = () => mergeSeg(i);
    row.appendChild(mg);

    const dl = el("button", "ib del", "✕");
    dl.title = "删掉这一段（只是不保存，不动原素材）";
    dl.onclick = () => delSeg(i);
    row.appendChild(dl);

    box.appendChild(row);
  });

  if (S.segs.length > shown.length) {
    // 几百上千段一次性铺满 DOM 会明显卡（每行 8 个控件），分批加载更跟手。
    const more = el("div", "sb-more");
    const b = el("button", "btn mini", `再显示 ${Math.min(240, S.segs.length - shown.length)} 段`);
    b.onclick = () => { S.limit = (S.limit || 240) + 240; renderSegs(); paintPlayStates(); };
    more.appendChild(b);
    more.appendChild(el("span", "hint",
      `已显示 ${shown.length} / ${S.segs.length} 段。段数太多时先调大门限，比一屏一屏翻更快。`));
    box.appendChild(more);
  }
  updateSel();
  paintPlayStates();
}

function paintRows() {
  [...$("segList").children].forEach((row) => {
    const id = Number(row.dataset.id);
    row.classList.toggle("sel", S.sel.has(id));
    row.classList.toggle("cur", Number(row.dataset.ix) === S.curSeg);
    const chk = row.querySelector('input[type="checkbox"]');
    if (chk) chk.checked = S.sel.has(id);
  });
}

/* 有字幕时，给个"这一段在第几条字幕之后"的提示名，命名时省得回看波形 */
function nameFor(t) {
  const inside = S.cues.find((c) => t >= c.t0 && t <= c.t1);
  if (inside) return `第${inside.i + 1}条内`;
  const before = S.cues.filter((c) => c.t1 <= t + 0.02).pop();
  if (before) return `第${before.i + 1}条后`;
  return "片头";
}
function suggestName(s) {
  return S.cues.length ? nameFor(s.start) : "";
}

function autoNameBySrt() {
  if (!S.cues.length) return toast("先载入 SRT 才能按字幕命名", true);
  snap();
  S.segs.forEach((s) => { s.name = nameFor(s.start); });
  renderSegs();
  toast(`已按字幕命名 ${S.segs.length} 段（可再手改）`);
}

/* ---------------- 右键菜单 ---------------- */
function closeCtxMenu() {
  const m = $("ctxMenu");
  if (m) m.hidden = true;
}
function openCtxMenu(x, y, i) {
  const m = $("ctxMenu");
  const s = S.segs[i];
  if (!s) return;
  const pick = selIdx();
  const many = pick.length > 1;
  const t = curTime();
  const items = [];

  items.push({ label: "▶ 试听这一段", fn: () => { S.curSeg = i; playSeg(i); } });
  items.push({ label: "🔁 循环试听这一段", fn: () => {
    $("loopSeg").checked = true; S.loop = true; S.curSeg = i; playSeg(i);
  } });
  items.push({ label: "🎧 只放原音这一段（A/B）", dis: !S.envRaw.length,
    fn: () => playSeg(i, "raw") });
  items.push({ sep: true });
  items.push({ label: "✂ 在播放头处切分", k: "S", dis: !(t > s.start + 0.05 && t < s.end - 0.05),
    fn: () => splitSeg() });
  items.push({ label: many ? `⤵ 合并选中的 ${pick.length} 段` : "⤵ 与下一段合并",
    k: "M", dis: many ? false : !S.segs[i + 1], fn: () => mergeSeg() });
  items.push({ label: "⤓ 只保留这一段", dis: !many, fn: () => {
    S.sel.clear(); S.sel.add(s._id); updateSel(); paintRows(); redrawAll();
    toast("已只选中这一段");
  } });
  items.push({ sep: true });
  items.push({ label: "[ 起点 = 播放头", fn: () => nudgeEdge("start") });
  items.push({ label: "] 终点 = 播放头", fn: () => nudgeEdge("end") });
  items.push({ label: "✎ 重命名…", dis: many, fn: () => {
    const v = window.prompt("给这一段起个名字（留空 = 自动编号）：", s.name || "");
    if (v === null) return;
    s.name = v.trim();
    renderSegs(); paintRows();
  } });
  items.push({ label: "🔍 在导航窗里看这一段", fn: () => {
    const pad = Math.max(0.3, s.dur * 0.6);
    S.view.a = Math.max(0, s.start - pad);
    S.view.b = Math.min(S.dur, s.end + pad);
    clampView(); redrawAll();
  } });
  items.push({ sep: true });
  items.push({ sep: true });
  items.push({ label: many ? `⚙ 处理选中的 ${pick.length} 段…` : "⚙ 处理这一段…",
    fn: () => openOps() });
  if (s.ops) {
    items.push({ label: "✕ 清除选中的处理参数", fn: () => {
      pick.forEach((k) => { delete S.segs[k].ops; });
      renderSegs(); toast("已清除处理参数");
    } });
  }
  items.push({ label: "🎙 存入音色库", fn: () => saveSegs("ref", pick) });
  items.push({ label: "🔔 存入音效库", fn: () => saveSegs("sfx", pick) });
  items.push({ label: many ? `🗑 删除选中的 ${pick.length} 段` : "🗑 删除这一段",
    k: "Del", danger: true, fn: () => delSeg() });
  renderMenu(m, x, y, items);
}

/* 素材行的右键菜单（第 1 张卡）：整理目录、定位、重新准备 */
function openMatCtx(x, y, mm) {
  const m = $("ctxMenu");
  if (!mm) return;
  const items = [];
  items.push({ label: `选「${mm.name || mm.file}」`, fn: () => {
    S.curMid = mm.id; renderMats(); $("btnPrepare").disabled = false;
    $("prepHint").textContent = `已选「${mm.name || mm.file}」，时长 ${mmss(mm.dur || 0)}。点上面按钮开始去人声。`;
  } });
  items.push({ sep: true });
  items.push({ label: "📁 移动到文件夹…", fn: () => {
    if (!window.LibFolders) return toast("文件夹组件没加载", true);
    LibFolders.moveItems("media", [mm.id], { onDone: () => loadMats() });
  } });
  items.push({ label: "＋ 新建文件夹…", fn: async () => {
    if (!window.LibFolders) return;
    const name = await LibFolders.ask("新建文件夹", "",
      "新建后可以再把这几个素材移进去；导入台 / 时间轴里看到的是同一套目录。", "例如：ASMR 原片");
    if (!name) return;
    try {
      await LibFolders.create("media", S.matPath ? S.matPath + "/" + name : name);
      toast(`已建「${name}」`);
      await loadMats();
    } catch (e) { toast("新建失败：" + e.message, true); }
  } });
  if (mm.folder) {
    items.push({ label: `↥ 从「${mm.folder.split("/").pop()}」移出`, fn: async () => {
      try {
        await LibFolders.assign("media", [mm.id], "");
        toast("已移出文件夹");
        await loadMats();
      } catch (e) { toast("移动失败：" + e.message, true); }
    } });
  }
  items.push({ sep: true });
  items.push({ label: "▶ 试听这条原素材", fn: async () => {
    try {
      const a = new Audio(`${API}/media/${encodeURIComponent(mm.id)}/audio?t=${Date.now()}`);
      a.play().catch(() => toast("这条读不出来", true));
    } catch (e) { /* 忽略 */ }
  } });
  items.push({ label: "⟳ 刷新素材列表", fn: () => loadMats() });
  renderMenu(m, x, y, items);
}

function renderMenu(m, x, y, items) {
  m.innerHTML = "";
  items.forEach((it) => {
    if (it.sep) { m.appendChild(el("div", "msep")); return; }
    const row = el("div", "mi" + (it.danger ? " danger" : "") + (it.dis ? " dis" : ""));
    row.appendChild(el("span", null, it.label));
    if (it.k) row.appendChild(el("span", "k", it.k));
    row.onclick = () => { closeCtxMenu(); if (!it.dis) it.fn(); };
    m.appendChild(row);
  });
  m.hidden = false;
  // 先放到左上角再量：不清掉旧位置的话，量到的尺寸会被上一次的定位影响
  m.style.left = "0px";
  m.style.top = "0px";
  const r = m.getBoundingClientRect();
  const px = Math.max(6, Math.min(x, window.innerWidth - r.width - 8));
  // 下面放不下就整体上移，保证最后一项也点得到
  const py = Math.max(6, Math.min(y, window.innerHeight - r.height - 8));
  m.style.left = `${px}px`;
  m.style.top = `${py}px`;
}

/* ---------------- 波形上的鼠标操作 ---------------- */
function hitSeg(t) {
  // 从后往前找，最后画的那条优先（重叠时符合直觉）
  for (let i = S.segs.length - 1; i >= 0; i--) {
    const s = S.segs[i];
    if (t >= s.start && t <= s.end) return i;
  }
  return -1;
}
function hitEdge(x, W) {
  /* 找最近的边界。两条相邻片段共享一条边界时（切分出来的片段几乎总是这样），
     一律按「左边的终点」处理 —— 拖边界通常是「把上一段拉长」，这也符合手感。 */
  let best = null;
  S.segs.forEach((s, i) => {
    [[tx(s.start, W), "start"], [tx(s.end, W), "end"]].forEach(([px, side]) => {
      const d = Math.abs(x - px);
      if (d > EDGE_PX) return;
      if (!best || d < best.d - 0.6 || (Math.abs(d - best.d) <= 0.6 && side === "end")) {
        best = { i, side, d };
      }
    });
  });
  return best;
}

function onProcDown(e) {
  if (e.button !== 0) return;
  const cv = $("wave");
  const p = pos(e, cv);
  const t = xt(p.x, p.w);
  // 合成事件（自动化测试 / 某些触控板）没有真实 pointerId，setPointerCapture 会抛，兜一下
  try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }

  if (S.tool === "mark") {
    S.drag = { mode: "mark", t0: t, t1: t, moved: false };
    return;
  }
  const edge = hitEdge(p.x, p.w);
  if (edge) {
    S.drag = { mode: "resize", i: edge.i, side: edge.side, moved: false };
    S.curSeg = edge.i;
    if (!S.sel.has(S.segs[edge.i]._id)) selectOnly(edge.i);
    return;
  }
  const hit = hitSeg(t);
  if (hit >= 0) {
    const wasSel = S.sel.has(S.segs[hit]._id);
    S.drag = { mode: "move", i: hit, t0: t, started: wasSel, moved: false };
    if (wasSel && (e.ctrlKey || e.metaKey)) { /* 保持多选 */ }
    else if (wasSel && S.sel.size > 1) { /* 多选里拖任意一条 = 整体平移 */ }
    else selectOnly(hit);
    return;
  }
  S.drag = { mode: "mark", t0: t, t1: t, moved: false };
}

function onProcMove(e) {
  const cv = $("wave");
  const p = pos(e, cv);
  const t = xt(p.x, p.w);
  const d = S.drag;

  if (!d) {
    // 悬停：边界给拉伸光标，片段给信息
    const edge = hitEdge(p.x, p.w);
    cv.style.cursor = edge ? "ew-resize" : (hitSeg(t) >= 0 ? "grab" : "crosshair");
    const hit = hitSeg(t);
    if (hit >= 0 && !edge) {
      const s = S.segs[hit];
      showTip(e.clientX + 14, e.clientY + 16,
        `#${hit + 1} ${mmssc(s.start)}–${mmssc(s.end)} · ${s.dur.toFixed(2)}s`,
        s.name || suggestName(s) || "（未命名）");
    } else hideTip();
    return;
  }

  if (d.mode === "mark") {
    d.t1 = t;
    if (Math.abs(tx(t, p.w) - tx(d.t0, p.w)) > 3) d.moved = true;
    if (d.moved) drawProc();
    return;
  }
  if (d.mode === "resize") {
    const s = S.segs[d.i];
    if (!s) return;
    if (!d.moved) { snap(); d.moved = true; }
    if (d.side === "start") {
      s.start = Math.max(0, Math.min(t, s.end - 0.05));
    } else {
      s.end = Math.min(S.dur, Math.max(t, s.start + 0.05));
    }
    s.start = +s.start.toFixed(3); s.end = +s.end.toFixed(3);
    s.dur = +(s.end - s.start).toFixed(3);
    s.rms_db = levelOf(s.start, s.end);
    drawProc(); drawRaw();
    return;
  }
  if (d.mode === "move") {
    const dt = t - d.t0;
    if (!d.moved && Math.abs(dt) * (p.w / viewSpan()) < 3) return;
    if (!d.moved) { snap(); d.moved = true; }
    const s = S.segs[d.i];
    // 整段平移：夹在两端之内，拖不出边界
    const width = d.origDur != null ? d.origDur : (s.end - s.start);
    d.origDur = width;
    if (d.origStart == null) d.origStart = s.start;
    const a = Math.max(0, Math.min(S.dur - width, d.origStart + dt));
    s.start = +a.toFixed(3);
    s.end = +(a + width).toFixed(3);
    s.dur = +width.toFixed(3);
    s.rms_db = levelOf(s.start, s.end);
    drawProc(); drawRaw();
  }
}

function onProcUp(e) {
  const d = S.drag;
  S.drag = null;
  const cv = $("wave");
  if (!d) return;
  if (d.mode === "mark") {
    if (d.moved) {
      const a = Math.min(d.t0, d.t1), b = Math.max(d.t0, d.t1);
      if (b - a >= 0.05) {
        snap();
        newSeg(a, b);
        toast(`新片段 ${a.toFixed(2)}–${b.toFixed(2)}（${(b - a).toFixed(2)}s）`);
      } else {
        seekAll(a);
      }
    } else {
      // 单击空白：把播放头放到这里；顺便把选中取消（避免误以为还在编辑上一段）
      const pp = pos(e, cv);
      seekAll(xt(pp.x, pp.w));
      S.curSeg = -1; S.sel.clear(); updateSel(); paintRows();
    }
    redrawAll();
    return;
  }
  if (d.mode === "resize" || d.mode === "move") {
    if (d.moved) renderSegs();
    redrawAll();
  }
}

/* 字幕轨：点一句就跳过去 */
function onSrtDown(e) {
  const cv = $("waveSrt");
  const p = pos(e, cv);
  const t = xt(p.x, p.w);
  const i = cueAt(t);
  if (i < 0) { seekAll(t); redrawAll(); return; }
  S.cueCur = i;
  seekAndPlay(S.cues[i].t0, S.cues[i].t1);
  redrawAll();
}
function onSrtMove(e) {
  const cv = $("waveSrt");
  const p = pos(e, cv);
  const t = xt(p.x, p.w);
  const i = cueAt(t);
  if (i < 0) {
    cv.style.cursor = "pointer";
    return hideTip();
  }
  const c = S.cues[i];
  cv.style.cursor = "pointer";
  showTip(e.clientX + 14, e.clientY + 16,
    `第 ${i + 1} 条 · ${mmssc(c.t0)}–${mmssc(c.t1)} · ${(c.t1 - c.t0).toFixed(2)}s`,
    c.text || "（这一条没有文本）");
}

/* 原音轨：点一下就把播放头放过去（A/B 对比时最常用） */
function onRawDown(e) {
  const cv = $("waveRaw");
  const p = pos(e, cv);
  seekAll(xt(p.x, p.w));
  redrawAll();
}

/* ---------------- 悬浮提示 ---------------- */
function showTip(x, y, head, body) {
  const tip = $("tip");
  tip.innerHTML = "";
  tip.appendChild(el("div", "t-h", head));
  tip.appendChild(el("div", "t-b", body));
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(x, window.innerWidth - r.width - 10)}px`;
  tip.style.top = `${Math.min(y, window.innerHeight - r.height - 10)}px`;
}
function hideTip() {
  const tip = $("tip");
  if (tip) tip.hidden = true;
}

/* ---------------- 查重 ---------------- */
async function doDedupe() {
  if (!S.segs.length) return;
  const btn = $("btnDup");
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "查重中…";
  try {
    const r = await api("/sfxb/dedupe", {
      method: "POST",
      body: { job: S.job, items: S.segs.map((s) => ({ start: s.start, end: s.end })) },
    });
    S.dupGroups = r.groups || [];
    S.dup.clear();
    S.dupGroups.forEach((g) => (g.dups || []).forEach((i) => {
      if (S.segs[i]) S.dup.add(S.segs[i]._id);
    }));
    renderSegs(); redrawAll();
    const box = $("dupHint");
    box.hidden = false;
    if (S.dup.size) {
      box.textContent = `查到 ${S.dupGroups.length} 组相似片段，共 ${S.dup.size} 段（标了「重复」）。`
        + "同一段声音在原片里出现多次时，通常只入库一次就够。";
      $("btnDupDel").hidden = false;
    } else {
      box.textContent = "没有发现相似片段。";
      $("btnDupDel").hidden = true;
    }
  } catch (e) {
    toast("查重失败：" + e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

function dropDupes() {
  const before = S.segs.length;
  snap();
  S.segs = S.segs.filter((s) => !S.dup.has(s._id));
  S.dup.clear();
  $("btnDupDel").hidden = true;
  $("dupHint").textContent = `已删掉 ${before - S.segs.length} 段重复（只影响这次导出，不动原素材）。`;
  renderSegs(); redrawAll();
}

/* ---------------- 导出清单 ---------------- */
function exportCsv() {
  const picked = S.segs.filter((s) => S.sel.has(s._id));
  const rows = (picked.length ? picked : S.segs);
  if (!rows.length) return toast("还没有片段", true);
  const head = ["序号", "名字", "开始", "结束", "时长", "电平dB", "来源素材"];
  const esc = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const body = rows.map((s, i) => [i + 1, s.name || "", s.start.toFixed(3), s.end.toFixed(3),
    s.dur.toFixed(3), Math.round(s.rms_db), $("waveHint").textContent.split(" · ")[0]]
    .map(esc).join(","));
  const csv = "\ufeff" + head.map(esc).join(",") + "\n" + body.join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = `音效片段_${(S.curMid || "list")}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(`导出 ${rows.length} 条（${picked.length ? "勾选的" : "全部"}）`);
}

/* ---------------- 插进时间轴 ---------------- */
async function loadProjects() {
  try {
    const r = await api("/scripts");
    S.projects = r.scripts || r.items || [];
  } catch (e) {
    S.projects = [];
  }
  const sel = $("tlSid");
  sel.innerHTML = "";
  const cueSel = $("cueSid");
  if (cueSel) cueSel.innerHTML = "";
  if (!S.projects.length) {
    sel.appendChild(new Option("（还没有台本）", ""));
    if (cueSel) cueSel.appendChild(new Option("（还没有台本）", ""));
    return;
  }
  sel.appendChild(new Option("（选一个工程…）", ""));
  if (cueSel) cueSel.appendChild(new Option("（用下面工程自己的台本）", ""));
  S.projects.slice(0, 80).forEach((p) => {
    const label = `${p.title || p.id}（${p.id.slice(0, 6)}）`;
    sel.appendChild(new Option(label, p.id));
    if (cueSel) cueSel.appendChild(new Option(label, p.id));
  });
}

/* 右键直接存某个库：勾了几个就存几个，不动底部的目标选择 */
async function saveSegs(target, idxs, folder) {
  const list = (idxs || []).map((i) => S.segs[i]).filter(Boolean);
  if (!list.length) return toast("先勾选要保存的片段", true);
  const where = { sfx: "音效库", ref: "音色库", media: "导入台" }[target] || "库";
  try {
    const r = await api("/sfxb/save", {
      method: "POST",
      body: {
        job: S.job, target, folder: folder == null ? "" : folder,
        items: list.map((x) => ({ start: x.start, end: x.end, name: x.name || "",
                                  ops: x.ops || undefined })),
      },
    });
    toast(`已存入 ${r.count} 段到${where}${r.folder ? `「${r.folder}」` : ""}`
      + (r.skipped ? `（跳过 ${r.skipped} 段）` : ""));
  } catch (e) {
    toast("保存失败：" + e.message, true);
  }
}

/* ---------------- 入库 ---------------- */
async function doSave() {
  const picked = S.segs.filter((s) => S.sel.has(s._id));
  if (!picked.length) return toast("先勾选要保存的片段", true);
  const btn = $("btnSave");
  btn.disabled = true;
  if ($("btnFootSave")) $("btnFootSave").disabled = true;
  const old = btn.textContent;
  const old2 = $("btnFootSave") ? $("btnFootSave").textContent : "";
  btn.textContent = "保存中…";
  if ($("btnFootSave")) $("btnFootSave").textContent = "保存中…";
  try {
    const target = $("target").value;
    const r = await api("/sfxb/save", {
      method: "POST",
      body: {
        job: S.job,
        target,
        folder: effectiveFolder(),
        items: picked.map((s) => ({
          start: s.start, end: s.end, name: s.name || "", ops: s.ops || undefined,
        })),
      },
    });
    const where = { sfx: "音效库", ref: "音色库", media: "导入台" }[r.target] || "库";
    toast(`已存入 ${r.count} 段到${where}`
      + (r.folder ? `「${r.folder}」` : "") + (r.skipped ? `（跳过 ${r.skipped} 段）` : "")
      + (r.failed && r.failed.length ? `，${r.failed.length} 段处理失败` : ""));
    if (r.failed && r.failed.length) console.warn("[sfxb save]", r.failed);
    S.sel.clear();
    renderSegs(); redrawAll();
  } catch (e) {
    toast("保存失败：" + e.message, true);
  } finally {
    btn.textContent = old;
    if ($("btnFootSave")) $("btnFootSave").textContent = old2;
    updateSel();
  }
}

/* ---------------- 帮助气泡 ---------------- */
const HELP = {
  mat: {
    title: "① 选素材",
    body: `<p>这里列的是<b>素材导入台</b>里的东西 —— 不是原始文件列表，是导入并处理过的那一份。
      处理台只读不写，切出来的片段另存，不会动原素材。</p>
      <dl>
        <dt>＋ 直接加入</dt><dd>不用回导入台：直接选本机音频/视频，会先存进导入台再自动选中。
          也可以把文件拖到这个页面（拖到素材列表上）。</dd>
        <dt>搜索框</dt><dd>按名字 / 来源过滤。素材多了很有用。</dd>
        <dt>文件夹</dt><dd>和导入台、时间轴共用同一套目录：点文件夹只看那一类，右键素材可以「移动到文件夹」。
          在这里新建的文件夹，回导入台也能看到。</dd>
        <dt>点一行</dt><dd>选中这条，然后点右边「① 准备素材」。长音声建议先在导入台里裁出要处理的那一段（几十秒到几分钟）。</dd>
      </dl>
      <div class="warnline">分离是整条跑的。40 分钟的整轨去人声要好几分钟，先裁到要用的段落更划算。</div>`,
  },
  sep: {
    title: "② 处理（可选）",
    body: `<p>用一个分离模型把音频拆成两半，只留你要的那一半。这一步<b>不是必须的</b>：
      本来就是纯音效的素材选「原样」，直接进切分。这是唯一慢的一步，结果会落盘成作业文件，
      之后改切分参数不会重跑。</p>
      <dl>
        <dt>留下 → 伴奏</dt><dd>去掉台词人声，留环境 / 动作 / 音乐。切音效最常用。</dd>
        <dt>留下 → 人声</dt><dd>去掉伴奏和背景乐，只留人声。切喘息、气声、耳语这类
          「是人声但没有台词」的素材用这一档。</dd>
        <dt>留下 → 原样</dt><dd>不分离，直接在原音上切。纯音效素材、或者分离反而更差时用。</dd>
        <dt>引擎</dt><dd>
          <b>BS-Roformer</b>：最干净，需要先在「模型拓展」里放模型；<br>
          <b>Demucs</b>：内置，80MB，够用；<br>
          <b>中置提取</b>：最快，只适合人声居中的立体声。</dd>
        <dt>精度（只对 Demucs）</dt><dd>快速 1 次 / 标准 2 次 / 精细 4 次随机时移平均。越精细越干净，时间线性变长。</dd>
        <dt>残留抑制</dt><dd>只在「只要伴奏」时有用：把伴奏里残留的人声再压一档。0–15% 通常够，调太高会把音效也压薄。</dd>
      </dl>
      <div class="warnline">分离后如果提示「几乎全是人声」，说明这条素材里本来就没有音效可切 —— 改用「不分离」直接听原音，别在空轨上白挑。</div>`,
  },
  seg: {
    title: "③ 切成片段",
    body: `<p>按「声音事件」把整条切开，切完的每一段就是候选音效。切法不同结果差很多，参数也值得反复试 ——
      这一步很快（几毫秒到一秒），随便改。</p>
      <dl>
        <dt>按静音间隔（默认）</dt><dd>逐帧算电平，找连续有声段。最稳，适合对白/动作之间有停顿的素材。</dd>
        <dt>按字幕间隔</dt><dd>把字幕区间当「在说话」，取补集就是音效候选区。有字幕时这个最准 ——
          电平检测只知道「有没有声音」，而台词和音效都有声音。</dd>
        <dt>先减稳态背景再切</dt><dd>沿时间对每个频点取中位数当噪声床减掉，再按间隔切。雨声、风扇、空调底下的短促事件才会浮出来。</dd>
        <dt>按起始点</dt><dd>谱通量峰检测，节奏型、打击类更贴。</dd>
        <dt>最小间隔</dt><dd>小于这个长度的停顿不切开（越大越会把相邻声音并成一段）。</dd>
        <dt>什么时候能点</dt><dd>准备素材之前这张卡是灰的（还没有作业可切）；点完「① 准备素材」就会亮起来，之后只改参数随时重切。</dd>
        <dt>最短片段</dt><dd>短于这个的直接丢掉，用来滤掉咔哒杂音。</dd>
        <dt>门限 dB</dt><dd>越大越严格（只留明显的），越小切得越碎。默认 10。</dd>
        <dt>前后留白</dt><dd>每段往外扩一点，避免切掉起音/尾音。默认 0.03 秒。</dd>
      </dl>
      <div class="warnline">切出上千段说明门限太低或最短片段太短 —— 那不是「挑音效」，是切碎了。</div>`,
  },
  srt: {
    title: "④ 字幕参考",
    body: `<p>把<b>原音声</b>的字幕（.srt）放进来。载入后会多出一条青色<b>字幕轨</b>：
      每句一块，两端的竖线就是这句的开始与结束；点一下就跳到那句，悬停能看到完整台词。</p>
      <dl>
        <dt>支持的格式</dt><dd>标准 SRT（<code>00:00:01,000 --&gt; 00:00:03,000</code>）。
          拖文件、点「选 .srt 文件」、或者直接粘贴文本都行。</dd>
        <dt>编码</dt><dd>自动识别：先按 UTF-8 严格解，失败退 GBK / GB18030 / Big5。
          中文 SRT 一大半是 GBK，按 UTF-8 读会整篇乱码。</dd>
        <dt>或从台本载入</dt><dd>直接选工作台里某个台本：它从 SRT 导入时记下的 t0/t1 会原样搬过来，
          不用再手工导一遍同一个文件。「一键全流程」会自动用工程自己的台本时间码。</dd>
        <dt>显示字幕轨</dt><dd>关掉只是不画，字幕数据还在（命名、跳转照常用）。</dd>
        <dt>跳到下一条</dt><dd>按播放头位置找下一条字幕，对齐切点时很好用。</dd>
      </dl>
      <div class="warnline">字幕的时间基准是<b>原音</b>，不是配完中文的时间。所以它只用来看"哪一句在原音的哪儿"，不要拿它当成品字幕。</div>`,
  },
  plan: {
    title: "⑤ 处理方案（保存 / 恢复）",
    body: `<p>切分参数是试出来的：门限调到刚好之后，还想再试下一组，就得先把这一组记住。
      这里把「分离引擎 + 切分参数 + 手工改过的片段清单」打包存一份，随时恢复。</p>
      <dl>
        <dt>保存</dt><dd>输入名字（留空自动按时间命名）。最多留 20 个，存在浏览器本地，不占项目空间。</dd>
        <dt>恢复</dt><dd>参数和片段一起回来；当前片段先进「撤销」栈，恢复错了还能撤。
          方案里记着它来自哪个素材：换了素材恢复时只搬参数与清单，试听 / 插入仍需重新准备。</dd>
        <dt>重新切分前自动存一份</dt><dd>默认打开。重新切分会覆盖手工改动，先兜一份最稳。</dd>
        <dt>撤销 / 重做</dt><dd>Ctrl+Z / Ctrl+Shift+Z。连「重新切分」这一步也能撤回到上一份片段。</dd>
      </dl>
      <div class="warnline">重新切分时如果检测到手工改动，会先弹一个确认窗；取消就能保住当前结果。</div>`,
  },
  ins: {
    title: "⑥ 输出与对位",
    body: `<p>勾选的片段有两条出路：<b>入库</b>（音效库 / 音色库 / 导入台），或者
      <b>按原片时间对位写进时间轴工程</b>。两件事都用「处理后的音频」。</p>

      <p style="margin-top:10px"><b>入库：三步</b></p>
      <dl>
        <dt>① 选库</dt><dd>「存入」下拉：音效库 / 音色库 / 导入台。</dd>
        <dt>② 落在哪</dt><dd>默认勾着「<b>为这一批新建文件夹</b>」——文件夹名 = 素材名，
          这批几十段全进同一个夹子，事后一眼能找到。想放别处就取消勾选，点 📁 自己挑
          （没有的文件夹现场就能建）。</dd>
        <dt>③ 存入</dt><dd>勾几段存几段，名字留空会按这批的总数自动编号（120 段 → <code>_001…_120</code>），
          按名字排序永远是对的。</dd>
      </dl>

      <p style="margin-top:10px"><b>按句对位进工程：只看一条规则就够</b></p>
      <div class="warnline" style="margin:6px 0 10px">
        <b>字幕必须跟「素材」同一版，不是跟工程同一版。</b><br>
        · 素材是<b>原片 mp3</b>（绝大多数情况）→ 载入<b>原片那份 srt</b>；<br>
        · 素材是<b>工程导出的混音</b> → 载入<b>工程字幕</b>（「或从台本」读出来的就是这份）。</div>
      <ol style="margin:4px 0 0 18px;padding:0">
        <li><b>为什么不能混</b>：载入的字幕决定「这个音效算第几句」，素材的时间码决定「这个音效在第几秒」。
            两者不是同一版，句子就整体错位（实测 13 句里能错 10 句）。</li>
        <li><b>「素材时间」保持「自动」就好</b>：系统拿素材总长去比两边末尾，自己判断该按字幕还是按工程算，
            判断结果写在预览顶部。选错了确实会整段偏，所以别手改，除非你明确知道自己在做什么。</li>
        <li><b>工程这边：句子别增删、顺序别动、字幕别改</b>。对位靠「第几条字幕 ↔ 第几句」，
            中间插一句 / 删一句，后面的全错位一档。</li>
        <li><b>改完句子重新生成后，时间轴要刷新一次</b>（重新打开工程或点刷新），
            让片段的起止跟新音频对上，再来做对位。</li>
      </ol>
      <dl>
        <dt>按句对位（推荐）</dt><dd>先判「这个音效落在第几条字幕」，再找工程里对应的那条，
          按句内相对位置放进去。所以换音色后整句变长变短，音效仍然跟着那句话走。
          预览顶部会写「字幕对位：按序号，43/43 条对上」；对不上会明确警告。</dd>
        <dt>对位预览</dt><dd>只算不写：每一段列出「第几句 / 句内 +几秒 / 目标时间 / 句内还是句间」。
          确认没问题再点「写入工程」——预览和写入用的是同一段后端代码，不会有出入。</dd>
        <dt>一键全流程</dt><dd>自动做四步：用工程台本载入字幕 →（未处理就先按②的处理方式处理）→
          按字幕切分 → 对位预览。你只需要在预览窗里点「写入工程」。</dd>
        <dt>跟句子起点（老算法）</dt><dd>按相邻两句的起点做分段线性，句内位置是估算。兼容老工程用。</dd>
        <dt>按全片比例 / 吸附句边界 / 不做换算</dt><dd>环境音用全片比例；「说完才响」的音效用吸附；
          手打台本（没有时间码）用不做换算，直接接在末尾。</dd>
      </dl>
      <div class="warnline">压缩比超过 ±30% 的片段会在预览里标红：一句 0.3 秒的台词重新生成成 5 秒，
      句内位置必然被拉长，这种句子建议单独听一遍再决定要不要拖一下。
      写入后还能在时间轴上拖动微调。</div>`,
  },
  keys: {
    title: "操作速查",
    body: `<p><b>鼠标</b></p>
      <dl>
        <dt>拖空白处</dt><dd>圈出一个新片段（绿色框），松手即生效。</dd>
        <dt>拖片段两端</dt><dd>改起止（光标变成 ↔）。</dd>
        <dt>拖片段中间</dt><dd>整体平移这一段。</dd>
        <dt>点字幕块</dt><dd>跳到那一句并播放。</dd>
        <dt>右键</dt><dd>片段菜单：试听 / 切分 / 合并 / 改名 / 删除 / 只放原音对照…</dd>
        <dt>播放头条</dt><dd>最上面那条带刻度的：按住拖 = 只改播放头，不会新建或移动片段。双击 = 看全长。</dd>
        <dt>每轨左上角</dt><dd>状态胶囊（播放中 / 已静音 / 待命）+ 播放、静音、音量；播放键点一下变暂停。</dd>
      </dl>
      <p style="margin-top:8px"><b>键盘</b>（焦点不在输入框时）</p>
      <dl>
        <dt>空格</dt><dd>播放 / 暂停</dd>
        <dt>← / →</dt><dd>播放头 ±50ms（按住 Shift 是 ±10ms）</dd>
        <dt>S / M / Del</dt><dd>在播放头切分 / 合并选中 / 删除选中</dd>
        <dt>[ / ]</dt><dd>把选中片段的起点 / 终点移到播放头</dd>
        <dt>Ctrl+A / Ctrl+Z</dt><dd>全选 / 撤销（Ctrl+Shift+Z 重做）</dd>
        <dt>⚙ 处理选中</dt><dd>对勾选的片段批量套「首尾静音 / 淡入淡出 / 音量 / 变速 / 变调 / 标准化 / 降噪 / 高低通 / 反向」；
          行上的 FX 小标可以点开改，右键能清掉。</dd>
      </dl>`,
  },
};

function showHelp(key, anchor) {
  const box = $("helpPop");
  const h = HELP[key];
  if (!h || !box) return;
  $("helpTitle").textContent = h.title;
  $("helpBody").innerHTML = h.body;
  box.hidden = false;
  const r = anchor ? anchor.getBoundingClientRect() : null;
  const bw = box.getBoundingClientRect().width;
  const bh = box.getBoundingClientRect().height;
  let x = r ? r.right + 8 : 300;
  let y = r ? r.top - 6 : 80;
  if (x + bw > window.innerWidth - 8) x = Math.max(8, (r ? r.left : 300) - bw - 8);
  if (y + bh > window.innerHeight - 8) y = Math.max(8, window.innerHeight - bh - 8);
  box.style.left = `${x}px`;
  box.style.top = `${y}px`;
}
function hideHelp() {
  const b = $("helpPop");
  if (b) b.hidden = true;
}

/* ---------------- 播放头（独立拖动条） ---------------- */
/* 交互约定：按下就停（正在播也先停），拖动时只改位置，松手后如果本来在播就接着播。
   这样拖的时候不会有"声音追着手指乱跳"的杂音，也不会因为拖动而意外改变播放状态。 */
function paintTimeLabels() {
  const t = curTime();
  const s = mmssc(t);
  if ($("scrubTime")) $("scrubTime").textContent = s;
  if ($("rawTime")) $("rawTime").textContent = `${t.toFixed(1)}s`;
  if ($("procTime")) $("procTime").textContent = `${t.toFixed(1)}s`;
}

function scrubT(e) {
  const cv = $("scrub");
  const p = pos(e, cv);
  return Math.max(0, Math.min(S.dur, xt(p.x, p.w)));
}

function bindScrub() {
  const cv = $("scrub");
  if (!cv) return;
  const down = (e) => {
    if (e.button !== 0 || !S.dur) return;
    e.preventDefault();
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件没有 pointerId */ }
    S.scrub = { was: S.playing, only: S.only };
    if (S.playing) stopPlay();
    $("scrubBox").classList.add("drag");
    seekAll(scrubT(e));
    paintTimeLabels();
    redrawAll();
  };
  const move = (e) => {
    if (!S.scrub) return;
    seekAll(scrubT(e));
    paintTimeLabels();
    redrawAll();
  };
  const up = (e) => {
    if (!S.scrub) return;
    const was = S.scrub.was, only = S.scrub.only;
    S.scrub = null;
    $("scrubBox").classList.remove("drag");
    if (was) seekAndPlay(curTime(), 0, only);
    else { paintTimeLabels(); redrawAll(); }
  };
  cv.addEventListener("pointerdown", down);
  cv.addEventListener("pointermove", move);
  cv.addEventListener("pointerup", up);
  cv.addEventListener("pointercancel", () => {
    S.scrub = null;
    $("scrubBox").classList.remove("drag");
  });
  // 双击 = 看全长（和导航窗一致）
  cv.addEventListener("dblclick", () => { resetView(); redrawAll(); });
}

/* ---------------- 片段修整（首尾静音 / 变速变调 / 标准化 …） ----------------
   和导入台用的是同一套服务端处理（_apply_ops）：前端只收集参数，
   试听和最终写文件都走服务端，保证「听到的」就是「入库/进工程的那份」。
   选多条 = 批量套同一套参数；每段各自记自己的 ops，互不干扰。 */
function opsOf(seg) { return (seg && seg.ops) || {}; }

function fxLabels(ops) {
  const o = ops || {};
  const out = [];
  if (o.trim_silence) out.push("首尾静音");
  if (o.fade) out.push("淡入淡出");
  if (o.gain_db) out.push(`${o.gain_db > 0 ? "+" : ""}${o.gain_db}dB`);
  if (o.speed) out.push(`${o.speed}×`);
  if (o.pitch) out.push(`${o.pitch > 0 ? "+" : ""}${o.pitch}半音`);
  if (o.normalize) out.push("标准化");
  if (o.denoise) out.push("降噪");
  if (o.filter) out.push("滤波");
  if (o.reverse) out.push("反向");
  return out;
}

function opsRow(id, label, controls, hint) {
  const row = el("div", "ops-row");
  const lab = document.createElement("label");
  const chk = document.createElement("input");
  chk.type = "checkbox";
  chk.id = `op${id.charAt(0).toUpperCase()}${id.slice(1)}`;
  chk.dataset.fx = id;
  lab.appendChild(chk);
  lab.appendChild(el("span", null, label));
  row.appendChild(lab);
  (controls || []).forEach((c) => row.appendChild(c));
  if (hint) row.appendChild(el("span", "hint", hint));
  return row;
}

function numInput(id, val, min, max, step, unit) {
  const i = document.createElement("input");
  i.className = "inp";
  i.id = id;
  i.type = "number";
  i.min = String(min); i.max = String(max); i.step = String(step);
  i.value = String(val);
  const wrap = el("span", "ops-field");
  wrap.appendChild(i);
  if (unit) wrap.appendChild(el("span", "unit", unit));
  wrap.style.display = "inline-flex";
  wrap.style.alignItems = "center";
  wrap.style.gap = "3px";
  return wrap;
}

function openOps() {
  const idxs = selIdx();
  if (!idxs.length) return toast("先勾选要处理的片段（可多选，批量套同一套参数）", true);
  const seed = opsOf(S.segs[idxs[0]]);
  const body = $("opsBody");
  body.innerHTML = "";
  $("opsTitle").textContent = `处理 ${idxs.length} 段片段`;
  const grid = el("div", "ops-grid");

  grid.appendChild(opsRow("ts", "首尾静音", [
    numInput("opTsDb", seed.trim_silence ? seed.trim_silence.threshold_db : -45, -80, -10, 1, "dB"),
    numInput("opTsPad", seed.trim_silence ? seed.trim_silence.pad : 0.06, 0, 1, 0.01, "秒留白"),
  ], "把开头结尾的底噪切掉"));
  grid.appendChild(opsRow("fd", "淡入淡出", [
    numInput("opFdIn", seed.fade ? seed.fade["in"] : 0.02, 0, 2, 0.01, "秒入"),
    numInput("opFdOut", seed.fade ? seed.fade.out : 0.05, 0, 2, 0.01, "秒出"),
  ], "去掉咔哒声 / 突兀收尾"));
  grid.appendChild(opsRow("gn", "音量", [
    numInput("opGn", seed.gain_db || 0, -40, 40, 0.5, "dB"),
  ]));
  grid.appendChild(opsRow("sp", "变速", [
    numInput("opSp", seed.speed || 1, 0.25, 4, 0.01, "×"),
  ], "0.5 = 慢一倍"));
  grid.appendChild(opsRow("pt", "变调", [
    numInput("opPt", seed.pitch || 0, -12, 12, 1, "半音"),
  ]));
  const nmSel = document.createElement("select");
  nmSel.className = "sel";
  nmSel.id = "opNmMode";
  nmSel.innerHTML = '<option value="peak">峰值</option><option value="rms">RMS</option>';
  nmSel.value = (seed.normalize && seed.normalize.mode) || "peak";
  grid.appendChild(opsRow("nm", "标准化", [nmSel,
    numInput("opNmDb", (seed.normalize && seed.normalize.target_db) || -1, -30, 0, 0.5, "dB")]));
  grid.appendChild(opsRow("dn", "降噪", [
    numInput("opDn", seed.denoise || 0.5, 0, 1, 0.05, "强度"),
  ], "底噪明显时用"));
  grid.appendChild(opsRow("fl", "高低通", [
    numInput("opFlHp", (seed.filter && seed.filter.hp) || 0, 0, 8000, 10, "Hz 高通"),
    numInput("opFlLp", (seed.filter && seed.filter.lp) || 0, 0, 20000, 100, "Hz 低通"),
  ], "0 = 不滤"));
  grid.appendChild(opsRow("rv", "反向", [], "环境音 / 转场用"));

  body.appendChild(grid);
  const note = el("div", "ops-note",
    "「首尾静音 / 变速 / 变调」会改变片段长度：入库和写入工程时按处理后的实际长度算，"
    + "时间轴上的起点仍按原位置换算。试听走服务端同一套算法，听到的就是最终结果。");
  body.appendChild(note);
  const stat = el("div", "ops-labels");
  stat.id = "opsStat";
  body.appendChild(stat);
  ["opTs", "opFd", "opGn", "opSp", "opPt", "opNm", "opDn", "opFl", "opRv"].forEach((id) => {
    const c = $(id);
    if (c) c.checked = !!seed[{ opTs: "trim_silence", opFd: "fade", opGn: "gain_db",
      opSp: "speed", opPt: "pitch", opNm: "normalize", opDn: "denoise",
      opFl: "filter", opRv: "reverse" }[id]];
  });
  $("opsPop").hidden = false;
  S.opsOpen = true;
}

function readOpsForm() {
  const ops = {};
  if ($("opTs").checked) {
    ops.trim_silence = { threshold_db: clampNum($("opTsDb").value, -80, -10, -45),
                         pad: clampNum($("opTsPad").value, 0, 1, 0.06) };
  }
  if ($("opFd").checked) {
    ops.fade = { "in": clampNum($("opFdIn").value, 0, 2, 0.02),
                 out: clampNum($("opFdOut").value, 0, 2, 0.05) };
  }
  if ($("opGn").checked) {
    const v = clampNum($("opGn").value, -40, 40, 0);
    if (Math.abs(v) > 0.05) ops.gain_db = v;
  }
  if ($("opSp").checked) {
    const v = clampNum($("opSp").value, 0.25, 4, 1);
    if (Math.abs(v - 1) > 0.001) ops.speed = v;
  }
  if ($("opPt").checked) {
    const v = clampNum($("opPt").value, -12, 12, 0);
    if (Math.abs(v) > 0.05) ops.pitch = v;
  }
  if ($("opNm").checked) {
    ops.normalize = { mode: $("opNmMode").value, target_db: clampNum($("opNmDb").value, -30, 0, -1) };
  }
  if ($("opDn").checked) {
    const v = clampNum($("opDn").value, 0, 1, 0.5);
    if (v > 0) ops.denoise = v;
  }
  if ($("opFl").checked) {
    const hp = clampNum($("opFlHp").value, 0, 8000, 0);
    const lp = clampNum($("opFlLp").value, 0, 20000, 0);
    if (hp > 0 || lp > 0) ops.filter = { hp: hp || null, lp: lp || null };
  }
  if ($("opRv").checked) ops.reverse = true;
  return ops;
}

function clampNum(v, lo, hi, dflt) {
  const n = parseFloat(v);
  if (!isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

function applyOps() {
  const idxs = selIdx();
  const ops = readOpsForm();
  if (!Object.keys(ops).length) {
    if (!confirm("面板上什么都没勾 —— 要把选中片段的处理全部清掉吗？")) return;
    idxs.forEach((i) => { delete S.segs[i].ops; });
    toast(`已清除 ${idxs.length} 段的处理`);
  } else {
    idxs.forEach((i) => {
      S.segs[i].ops = JSON.parse(JSON.stringify(ops));
      S.edited = true;      // 处理会改变输出，重新切分会丢 —— 和手工改动一样要提醒
    });
    toast(`已给 ${idxs.length} 段套上：${fxLabels(ops).join(" / ")}`);
  }
  $("opsPop").hidden = true;
  S.opsOpen = false;
  renderSegs(); paintPlayStates();
}

function clearOpsOfSelection() {
  const idxs = selIdx();
  if (!idxs.length) return;
  idxs.forEach((i) => { delete S.segs[i].ops; S.edited = true; });
  $("opsPop").hidden = true;
  S.opsOpen = false;
  renderSegs();
  toast(`已清除 ${idxs.length} 段的处理参数（音频文件本身没动）`);
}

async function auditionOps() {
  const idxs = selIdx();
  if (!idxs.length) return;
  const s0 = S.segs[idxs[0]];
  const ops = readOpsForm();
  const btn = $("opsAudition");
  btn.disabled = true;
  btn.textContent = "处理中…";
  try {
    const r = await api("/sfxb/preview", {
      method: "POST",
      body: { job: S.job, start: s0.start, end: s0.end, ops },
    });
    const note = $("opsStat");
    if (note) note.textContent = `试听：处理后 ${r.dur.toFixed(2)}s（原 ${s0.dur.toFixed(2)}s）`
      + (r.labels && r.labels.length ? " · " + r.labels.join(" / ") : " · 原样（没勾处理）");
    const a = new Audio(r.url + "?t=" + Date.now());
    a.play().catch(() => toast("试听播放失败", true));
  } catch (e) {
    toast("试听失败：" + e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "▶ 试听第一条";
  }
}

/* ---------------- 按句对位进工程 ---------------- */
function pickedSegs() {
  const picked = S.segs.filter((s) => S.sel.has(s._id));
  return picked.length ? picked : S.segs.slice();
}

function insertItems(list) {
  return list.map((s) => ({
    start: s.start, end: s.end, name: s.name || "",
    ops: s.ops || undefined,
  }));
}

function fmtClock(t) {
  const sec = Math.max(0, +t || 0);
  const m = Math.floor(sec / 60);
  const s2 = sec - m * 60;
  return `${String(m).padStart(2, "0")}:${s2.toFixed(2).padStart(5, "0")}`;
}

const MAP_KIND = {
  in: ["句内", "in"], gap: ["句间", "gap"], head: ["片头", ""],
  tail: ["片尾", ""], seq: ["接末尾", ""], abs: ["全片比例", ""],
  follow: ["跟句子", ""], manual: ["手动", ""],
};

function renderMap(r) {
  const box = $("mapBody");
  box.innerHTML = "";
  const rows = el("div", "maplist");
  r.items.forEach((m, k) => {
    const mp = m.map || {};
    const row = el("div", "maprow");
    row.appendChild(el("span", "mi", String(k + 1).padStart(2, "0")));
    row.appendChild(el("span", "mt", fmtClock(m.start) + " → " + fmtClock(m.start + m.dur)));
    const kind = MAP_KIND[mp.kind] || [mp.kind || "—", ""];
    const tag = el("span", "mk " + (kind[1] || "") + (m.warn ? " warn" : ""), kind[0]);
    row.appendChild(tag);
    let where = "";
    if (mp.kind === "in" && mp.prev) {
      where = `第 ${mp.prev.idx} 句 +${(mp.offset || 0).toFixed(2)}s · 「${mp.prev.text}」`;
    } else if (mp.kind === "gap" && mp.prev) {
      where = `第 ${mp.prev.idx} 句后 +${(mp.offset || 0).toFixed(2)}s`
        + (mp.next ? `（下一句 ${mp.next.idx}）` : "");
    } else if (mp.kind === "head" && mp.next) {
      where = `第 ${mp.next.idx} 句前 ${(mp.offset || 0).toFixed(2)}s · 「${mp.next.text}」`;
    } else if (mp.kind === "tail" && mp.prev) {
      where = `第 ${mp.prev.idx} 句后 +${(mp.offset || 0).toFixed(2)}s（片尾）`;
    } else if (mp.kind === "seq") {
      where = "接在素材轨末尾";
    } else if (mp.kind === "abs") {
      where = `按全片比例 ×${(mp.ratio || 1).toFixed(2)}`;
    } else {
      where = "按句子起点估算";
    }
    const w = el("span", "mw", where);
    w.title = where;
    row.appendChild(w);
    if (m.labels && m.labels.length) {
      const lb = el("span", "mk", "FX " + m.labels.length);
      lb.title = m.labels.join(" / ");
      row.appendChild(lb);
    }
    rows.appendChild(row);
  });
  box.appendChild(rows);
  const al = r.align || null;
  const note = el("div", "mapnote",
    `共 ${r.count} 段 · 按「${$("insPolicy").selectedOptions[0].textContent}」换算`
    + (r.units ? ` · 可对位 ${r.units} 句` : "")
    + (al ? ` · 字幕对位：${alignText(al)}`
      + (al.timebase === "cue" ? " · 素材时间：跟载入的字幕" : " · 素材时间：原片") : "")
    + (r.warn ? ` · ${r.warn} 段压缩超过 ±30%，位置可能对不上画面` : "")
    + "。句内偏移 = 音效在原音里相对这句开头的秒数；写入后还能在时间轴上拖。");
  box.appendChild(note);
  const alWarn = alignWarn(al);
  if (alWarn) {
    const w = el("div", "mapnote warnline", alWarn);
    box.appendChild(w);
  }
  $("mapSum").textContent = `${r.count} 段 → 第 ${r.units || "?"} 句范围`;
}

/* 「素材时间」只在按句对位时有意义：其它换算不区分时间基准 */
function paintTimebase() {
  const on = $("insPolicy") && $("insPolicy").value === "sentence";
  if ($("insTimebaseRow")) $("insTimebaseRow").hidden = !on;
  if ($("insTimebaseHint")) $("insTimebaseHint").hidden = !on;
  if (!on) return;
  const v = $("insTimebase") ? $("insTimebase").value : "auto";
  const txt = v === "auto"
    ? "自动：比「素材总长」和「载入字幕的末尾 / 台本里的原片时间末尾」，谁近算谁的。判断结果写在预览里，一般不用手改。"
    : v === "cue"
      ? "素材是重新生成后的音频：先用载入的字幕定位第几条，再按序号找工程里那条。"
      : "素材是原版音频：对位按工程自己的字幕时间码算，换音色只影响长度、不影响第几句。";
  if ($("insTimebaseHint")) $("insTimebaseHint").textContent = txt;
}

/* 把后端的对齐结论翻成人话 */
function alignText(al) {
  if (!al) return "";
  const mode = al.mode === "index" ? "按序号（条数一致）"
    : al.mode === "text" ? "按文本匹配"
      : "按时间码（没法对齐）";
  let t = `${mode}，${al.matched}/${al.src} 条对上`;
  t += ` · 素材时间：${tbLabel(al)}`;
  if (al.mode === "time") t += " · ⚠ 会按绝对时间换算";
  return t;
}

/* 「素材时间」是怎么定的，翻成一句人话 */
function tbLabel(al) {
  if (!al) return "";
  const n = al.timebase_note || "";
  const auto = al.timebase_auto ? "自动·" : "";
  const map = {
    match_cue: "按载入的字幕（素材＝这一版）",
    match_orig: "按台本里的原片时间码",
    both: "两边一致（没换过音色）",
    mismatch: "⚠ 素材对不上这两版",
    manual: al.timebase === "cue" ? "手动：跟载入的字幕" : "手动：原片",
    no_info: "按工程时间轴",
  };
  return auto + (map[n] || (al.timebase === "cue" ? "跟载入的字幕" : "原片"));
}

/* 对位有风险时的明确提示（不拦着，只让人知道哪里可能不对） */
function alignWarn(al) {
  if (!al) return "";
  const note = al.timebase_note || "";
  const off = Math.abs(al.offset || 0) >= 0.5
    ? `${al.offset > 0 ? "+" : ""}${(al.offset || 0).toFixed(2)}s` : "";
  if (note === "mismatch") {
    return `⚠ 这段素材 ${al.src_dur || "?"}s，既不像「载入的字幕」（到 ${al.cue_end || "?"}s），`
      + `也不像「台本里的原片」（到 ${al.orig_end || "?"}s）。`
      + "多半是字幕或素材载错了版本 —— 字幕必须跟素材同一版。"
      + "现在先按台本里的原片时间码兜底算，落点可能偏，建议先核对一下素材。";
  }
  if (note === "match_orig" && off) {
    return `ℹ 这段素材是原片（${al.src_dur || "?"}s），对位已经自动按台本里的原片时间码算，`
      + `**落点不受影响**。但你载入的字幕是另一版（末尾 ${al.cue_end || "?"}s，比工程时间码差 ${off}）`
      + "—— 第 ⑤ 步「按字幕切分」会照它切，切点会偏。做原片素材时请载原片那份 srt。";
  }
  if (note === "match_cue" && off) {
    return `ℹ 字幕和工程时间码整体差 ${off}（正常：换音色后时长变了）。`
      + "对位按字幕序号走，所以每段仍然跟着它原来那句。";
  }
  if (al.mode === "time") {
    return "⚠ 处理台里载入的字幕和这份工程对不上（条数/文本都不匹配），"
      + "现在只能按绝对时间换算，音效可能落到别的句子附近。"
      + "建议在「④ 字幕」里载入这份工程当初用的那份 srt，或用「从台本」直接读工程字幕。";
  }
  if (al.mode === "index" && (al.text_ratio || 0) < 0.6) {
    return `⚠ 条数一样但文本只对上 ${Math.round((al.text_ratio || 0) * 100)}%，`
      + "这条字幕可能不是同一份稿子（或断句改过）——先看一眼预览里的「第几句」再写入。";
  }
  if (al.mode === "text" && al.matched < al.src) {
    return `⚠ 有 ${al.src - al.matched} 条字幕没匹配上工程里的句子，这些段会退回按时间换算。`;
  }
  if (Math.abs(al.offset || 0) >= 0.5) {
    return `ℹ 两边的字幕时间码整体差 ${al.offset > 0 ? "+" : ""}${(al.offset || 0).toFixed(2)}s`
      + "（不影响按序号对位，只是说明两份稿子的时间基准不同）。";
  }
  return "";
}

/* 这次对位用的字幕：随请求一起发，后端按「第几条字幕」对齐工程里的那条。
   不发的话后端只能按绝对时间猜 —— 载入的 srt 一旦和工程不同源（重新断句、整体平移）
   音效就会串到别的句子上去。 */
function cuePayload() {
  return (S.cues || []).slice(0, 5000).map((c) => ({ t0: c.t0, t1: c.t1, text: c.text || "" }));
}

async function previewMap() {
  const sid = $("tlSid").value;
  if (!sid) return toast("先选一个要写入的工程", true);
  if (!S.job) return toast("先选素材并点「② 开始处理」", true);
  const list = pickedSegs();
  if (!list.length) return toast("还没有可插入的片段", true);
  const btn = $("btnMapPreview");
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "计算中…";
  try {
    const r = await api(`/tl/${encodeURIComponent(sid)}/import-sfx`, {
      method: "POST",
      body: {
        job: S.job, policy: $("insPolicy").value, dry_run: true,
        timebase: $("insTimebase") ? $("insTimebase").value : "auto",
        cues: cuePayload(),
        items: insertItems(list),
      },
    });
    S.mapPlan = r;
    S.mapSid = sid;
    renderMap(r);
    $("mapPop").hidden = false;
  } catch (e) {
    toast("对位失败：" + e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

async function doInsert(policy) {
  const sid = $("tlSid").value;
  if (!sid) return toast("先选一个要写入的工程", true);
  const list = pickedSegs();
  if (!list.length) return toast("还没有可插入的片段", true);
  const btn = $("btnInsert");
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "写入中…";
  try {
    const r = await api(`/tl/${encodeURIComponent(sid)}/import-sfx`, {
      method: "POST",
      body: {
        job: S.job, policy: policy || $("insPolicy").value,
        timebase: $("insTimebase") ? $("insTimebase").value : "auto",
        cues: cuePayload(),
        items: insertItems(list),
      },
    });
    const warn = r.warn ? `，其中 ${r.warn} 段压缩超过 ±30%` : "";
    const skipped = r.skipped ? `，跳过 ${r.skipped} 段` : "";
    $("insHint").className = r.warn ? "hint warn" : "hint";
    $("insHint").textContent = `已写入 ${r.count} 段（${$("insPolicy").selectedOptions[0].textContent}）`
      + `${warn}${skipped}。打开时间轴就能看到，位置还能拖。`;
    $("mapPop").hidden = true;
    $("btnGoTl").hidden = false;
    S.lastSid = sid;
    toast(`已写入 ${r.count} 段到工程${warn}`);
  } catch (e) {
    toast("写入失败：" + e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
    updateSel();
  }
}

/* 一键全流程：载字幕 → 按字幕切 → 对位预览 →（确认后）写入 */
async function runPipeline() {
  const sid = $("tlSid").value;
  if (!sid) return toast("先在下面选一个要写入的工程", true);
  if (!S.curMid) return toast("先在①选素材（或直接加入一个音频）", true);
  const btn = $("btnPipeline");
  const old = btn.textContent;
  btn.disabled = true;
  try {
    btn.textContent = "① 载入字幕…";
    if (!S.cues.length) {
      let ok = await loadCuesFromScript($("cueSid").value || sid, true);
      if (!ok) ok = await loadCuesFromScript(sid, true);
      if (!ok) {
        toast("这个工程没有字幕时间码：先在台本里从 SRT 导入，或手工载入 SRT", true);
        return;
      }
    }
    btn.textContent = "② 准备音频…";
    if (!S.job || S.jobMid !== S.curMid) {
      await doPrepare();
      if (!S.job) return;
    }
    btn.textContent = "③ 按字幕切分…";
    $("segMode").value = "srt";
    await doSegment();
    if (!S.segs.length) {
      toast("按字幕没切出片段：字幕几乎盖满整条音频（说明没有音效空档）", true);
      return;
    }
    if (!S.sel.size) S.segs.forEach((x) => S.sel.add(x._id));
    updateSel();
    btn.textContent = "④ 对位预览…";
    await previewMap();
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/* ---------------- 存库目标文件夹 ---------------- */
/* 这一批自动用哪个文件夹：素材名（没名字就用「音效」）。
   同一素材分几次存会落在同一个文件夹里 —— 想分开就取消勾选自己挑。 */
function batchFolderName() {
  const m = (S.mats || []).find((x) => x.id === S.curMid) || {};
  let n = String(m.name || m.file || "").replace(/\.[a-z0-9]+$/i, "").trim();
  if (!n) n = "音效";
  return n.slice(0, 40);
}

/* 这次实际会存到哪个文件夹（批量建文件夹优先） */
function effectiveFolder() {
  if (S.batchFolder) return batchFolderName();
  return S.saveFolder || "";
}

function paintSaveFolder() {
  const b = $("btnSaveFolder");
  const chk = $("saveBatchFolder");
  if (chk) chk.checked = !!S.batchFolder;
  const target = { sfx: "音效库", ref: "音色库", media: "导入台" }[$("target").value] || "库";
  const hint = $("saveDestHint");
  const folder = effectiveFolder();
  if (b) {
    b.disabled = !!S.batchFolder;
    b.textContent = S.batchFolder
      ? `📁 自动：${folder}`
      : (S.saveFolder ? `📁 ${S.saveFolder.split("/").pop()}` : "📁 未归档");
    b.title = S.batchFolder
      ? "勾着「为这一批新建文件夹」时，这里由素材名自动决定；取消勾选才能自己挑"
      : `这次存的片段会放进${target}的「${S.saveFolder || "未归档"}」；点一下换文件夹`;
    b.classList.toggle("on", !!folder);
  }
  if (hint) {
    const n = S.sel.size;
    hint.textContent = S.batchFolder
      ? `会存进「${target} / ${folder}」${n ? `（这批 ${n} 段都在一起）` : ""}；`
        + "上面的 📁 由复选框决定，想自己挑就先取消勾选。"
      : (folder
        ? `会存进「${target} / ${folder}」${n ? `（这批 ${n} 段都在一起）` : ""}。`
        : `会存到「${target}」根目录（未归档）${n ? `，一共 ${n} 段` : ""}。`);
  }
}

async function chooseSaveFolder() {
  if (!window.LibFolders) return toast("文件夹组件没加载", true);
  const kind = $("target").value === "media" ? "media" : "sfx";
  const p = await LibFolders.picker(kind, {
    value: S.saveFolder, title: "存到哪个文件夹",
  });
  if (p === null) return;
  S.saveFolder = p;
  S.batchFolder = false;          // 手动挑过就以手动的为准
  paintSaveFolder();
  toast(p ? `会存进「${p}」` : "会存在根目录（未归档）");
}

/* ---------------- 绑定 ---------------- */
function showEditor(on) {
  $("editor").hidden = !on;
  $("empty").hidden = on;
}

function bind() {
  $("btnBack").onclick = () => { location.href = "/longform?desk=1"; };
  $("matSearch").oninput = renderMats;
  $("eng").onchange = () => {
    if (($("stem").value || "instrumental") === "none") return paintStem();
    const v = $("eng").value;
    $("qRow").hidden = v !== "demucs";
    $("resRow").hidden = false;
  };
  $("residual").oninput = () => {
    $("vRes").textContent = Math.round(parseFloat($("residual").value || "0") * 100) + "%";
  };
  $("btnPrepare").onclick = doPrepare;
  $("btnSeg").onclick = doSegment;
  $("btnPlayAll").onclick = togglePlayAll;
  $("btnPlanSave").onclick = () => {
    savePlan($("planName").value);
    $("planName").value = "";
  };
  $("btnSaveFolder").onclick = chooseSaveFolder;
  const bf = $("saveBatchFolder");
  if (bf) bf.onchange = () => { S.batchFolder = !!bf.checked; paintSaveFolder(); };
  $("target").onchange = () => {
    S.saveFolder = "";
    S.batchFolder = true;        // 换库时回到「按这批建文件夹」的默认
    paintSaveFolder();
    updateSel();
  };
  $("btnScrubPlay").onclick = togglePlayAll;
  $("btnScrubPrev").onclick = () => { seekAll(Math.max(0, curTime() - 1)); paintTimeLabels(); redrawAll(); };
  $("btnScrubNext").onclick = () => { seekAll(Math.min(S.dur, curTime() + 1)); paintTimeLabels(); redrawAll(); };
  $("btnExport").onclick = exportCsv;
  $("btnAutoName").onclick = autoNameBySrt;
  $("btnDup").onclick = doDedupe;
  $("btnDupDel").onclick = dropDupes;
  $("btnInsert").onclick = () => doInsert();
  $("btnMapPreview").onclick = previewMap;
  paintTimebase();
  $("insPolicy").onchange = paintTimebase;
  if ($("insTimebase")) $("insTimebase").onchange = paintTimebase;
  $("btnPipeline").onclick = runPipeline;
  $("mapCancel").onclick = () => { $("mapPop").hidden = true; };
  $("mapOk").onclick = () => doInsert();
  $("btnGoTl").onclick = () => {
    const sid = S.lastSid || $("tlSid").value;
    if (sid) window.open(`/timeline?sid=${encodeURIComponent(sid)}`, "_blank");
  };
  $("tlSid").onchange = () => {
    updateSel();
    // 换工程时顺手把字幕来源切到「这个工程自己的台本」
    if ($("cueSid")) $("cueSid").value = "";
    const p = (S.projects || []).find((x) => x.id === $("tlSid").value);
    if (p) $("insHint").textContent = `已选工程「${p.title || p.id}」。点「🔎 对位预览」看每一段落在哪一句。`;
  };
  $("stem").onchange = paintStem;
  ["dragover", "dragenter"].forEach((ev) => {
    $("matList").addEventListener(ev, (e) => { e.preventDefault(); });
  });
  $("matList").addEventListener("drop", (e) => {
    e.preventDefault();
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (files.length) addMaterialFiles(files);
  });
  $("fileMatAdd").onchange = (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    addMaterialFiles(files);
  };
  $("btnCueLoad").onclick = () => {
    const sid = $("cueSid").value || $("tlSid").value;
    if (!sid) return toast("先在下面选工程，或在「或从台本」里选一个台本", true);
    loadCuesFromScript(sid);
  };
  $("toolFx").onclick = openOps;
  $("opsCancel").onclick = () => { $("opsPop").hidden = true; S.opsOpen = false; };
  $("opsOk").onclick = applyOps;
  $("opsClear").onclick = clearOpsOfSelection;
  $("opsAudition").onclick = auditionOps;
  $("btnFootSave").onclick = doSave;
  $("loopSeg").onchange = () => { S.loop = $("loopSeg").checked; };
  $("speed").onchange = () => { applyRate(); };
  $("volProc").oninput = applyVol;
  $("volRaw").oninput = applyVol;
  $("selAll").onchange = () => {
    S.sel.clear();
    if ($("selAll").checked) S.segs.forEach((s) => S.sel.add(s._id));
    updateSel(); paintRows(); redrawAll();
  };
  $("btnSave").onclick = doSave;

  // 三条轨的独立控制（播放键自己会变成暂停键：再点一次就停）
  $("btnProcPlay").onclick = () => {
    if (S.playing && S.only === "proc") return stopPlay();
    const pick = selIdx();
    if (pick.length) playSeg(pick[0], "proc");
    else seekAndPlay(curTime(), 0, "proc");
  };
  $("btnRawPlay").onclick = () => {
    if (S.playing && S.only === "raw") return stopPlay();
    const pick = selIdx();
    if (pick.length) playSeg(pick[0], "raw");
    else seekAndPlay(curTime(), 0, "raw");
  };
  $("btnCuePlay").onclick = () => {
    const i = S.cueCur >= 0 ? S.cueCur : cueAt(curTime());
    if (i < 0) return toast("播放头不在任何一条字幕里：点字幕轨上的色块先选一条", true);
    if (S.playing && S.playSeg === `cue${i}`) return stopPlay();
    S.cueCur = i;
    seekAndPlay(S.cues[i].t0, S.cues[i].t1, "", `cue${i}`);
    redrawAll();
  };
  $("btnProcMute").onclick = () => { S.muteProc = !S.muteProc; applyMute(); };
  $("btnRawMute").onclick = () => { S.muteRaw = !S.muteRaw; applyMute(); };

  // 工具条
  $("toolMark").onclick = () => {
    S.tool = S.tool === "mark" ? "select" : "mark";
    $("toolMark").classList.toggle("on", S.tool === "mark");
    $("toolHint").textContent = S.tool === "mark"
      ? "圈选模式：在波形上拖出任意区域即可新建片段（可以压住已有片段）"
      : "";
    $("wave").style.cursor = S.tool === "mark" ? "crosshair" : "crosshair";
  };
  $("toolSplit").onclick = () => splitSeg();
  $("toolMerge").onclick = () => mergeSeg();
  $("toolDel").onclick = () => delSeg();
  $("toolUndo").onclick = undo;
  $("toolUndo").disabled = true;
  $("toolRedo").onclick = redo;
  $("toolRedo").disabled = true;
  $("toolAll").onclick = () => {
    S.segs.forEach((s) => S.sel.add(s._id));
    updateSel(); paintRows(); redrawAll();
  };
  $("toolInv").onclick = () => {
    S.segs.forEach((s) => {
      if (S.sel.has(s._id)) S.sel.delete(s._id); else S.sel.add(s._id);
    });
    updateSel(); paintRows(); redrawAll();
  };

  // 缩放
  $("btnZoomIn").onclick = () => zoomAt(midTime(), 0.5);
  $("btnZoomOut").onclick = () => zoomAt(midTime(), 2);
  $("btnZoomFit").onclick = () => { resetView(); redrawAll(); };

  // SRT
  $("srtFile").onchange = (e) => loadSrtFile(e.target.files && e.target.files[0]);
  $("srtShow").onchange = () => {
    S.showSrt = $("srtShow").checked;
    $("trkSrt").hidden = !(S.showSrt && S.cues.length);
    redrawAll();
  };
  $("btnSrtClear").onclick = clearSrt;
  $("btnSrtPaste").onclick = () => {
    const t = window.prompt("把 SRT 文本粘进来（整段，含时间轴那几行）：");
    if (t && t.trim()) applySrt(t, "粘贴的字幕");
  };
  $("btnSrtNext").onclick = () => {
    const i = cueAfter(curTime());
    if (i < 0) return toast("已经是最后一条字幕了");
    S.cueCur = i;
    seekAndPlay(S.cues[i].t0, S.cues[i].t1);
  };
  $("btnCueNext").onclick = () => {
    const i = cueAfter(curTime(), true);
    if (i < 0) return;
    S.cueCur = i;
    seekAndPlay(S.cues[i].t0, S.cues[i].t1);
  };
  $("btnCuePrev").onclick = () => {
    const i = cueBefore(curTime(), true);
    if (i < 0) return;
    S.cueCur = i;
    seekAndPlay(S.cues[i].t0, S.cues[i].t1);
  };
  const drop = $("srtDrop");
  ["dragover", "dragenter"].forEach((k) => drop.addEventListener(k, (e) => {
    e.preventDefault(); drop.classList.add("hot");
  }));
  ["dragleave", "drop"].forEach((k) => drop.addEventListener(k, (e) => {
    e.preventDefault(); drop.classList.remove("hot");
  }));
  drop.addEventListener("drop", (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadSrtFile(f);
  });

  bindScrub();
  paintSaveFolder();
  paintTimeLabels();

  // 波形：编辑（处理后）
  const cv = $("wave");
  cv.addEventListener("pointerdown", onProcDown);
  cv.addEventListener("pointermove", onProcMove);
  cv.addEventListener("pointerup", onProcUp);
  cv.addEventListener("pointercancel", () => { S.drag = null; redrawAll(); });
  cv.addEventListener("pointerleave", () => { hideTip(); });
  cv.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const p = pos(e, cv);
    const t = xt(p.x, p.w);
    const hit = hitSeg(t);
    if (hit < 0) return toast("这里没有片段（右键空白处不出菜单）", true);
    if (!S.sel.has(S.segs[hit]._id)) selectOnly(hit);
    openCtxMenu(e.clientX, e.clientY, hit);
  });
  cv.addEventListener("wheel", (e) => {
    if (!S.dur) return;
    e.preventDefault();
    const p = pos(e, cv);
    zoomAt(xt(p.x, p.w), e.deltaY > 0 ? 1.25 : 0.8);
  }, { passive: false });

  // 原音轨：只定位
  const cr = $("waveRaw");
  cr.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const p = pos(e, cr);
    seekAll(xt(p.x, p.w));
    redrawAll();
  });

  // 字幕轨：点 = 跳
  const cs = $("waveSrt");
  cs.addEventListener("pointerdown", (e) => { if (e.button === 0) onSrtDown(e); });
  cs.addEventListener("pointermove", onSrtMove);
  cs.addEventListener("pointerleave", hideTip);

  // 导航窗
  const nav = $("navBox");
  let navDrag = false;
  const navSeek = (e) => {
    const p = pos(e, $("nav"));
    const t = (Math.max(0, Math.min(1, p.x / p.w))) * S.dur;
    const span = viewSpan();
    S.view.a = Math.max(0, Math.min(S.dur - span, t - span / 2));
    S.view.b = S.view.a + span;
    clampView();
    redrawAll();
  };
  nav.addEventListener("pointerdown", (e) => {
    if (!S.dur) return;
    navDrag = true;
    navSeek(e);
    try { nav.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
  });
  nav.addEventListener("pointermove", (e) => { if (navDrag) navSeek(e); });
  nav.addEventListener("pointerup", () => { navDrag = false; });
  nav.addEventListener("dblclick", () => { resetView(); redrawAll(); });

  new ResizeObserver(() => redrawAll()).observe($("editor"));

  // 音频事件：两条轨同一个时间轴
  const auP = $("auProc"), auR = $("auRaw");
  auP.addEventListener("timeupdate", () => {
    // 漂移纠正：两轨相差超过 0.15s 就把原音拉回来（分离不改长度，正常几乎不会触发）
    if (auR.src && auR.readyState >= 1 && Math.abs(auR.currentTime - auP.currentTime) > 0.15) {
      try { auR.currentTime = auP.currentTime; } catch (e) { /* 忽略 */ }
    }
    if (S.stopAt && auP.currentTime >= S.stopAt - 0.02) {
      if (S.loop) {
        seekAll(S.stopAtStart || 0);
        [auP, auR].forEach((a) => { if (a.src) { const p = a.play(); if (p && p.catch) p.catch(() => {}); } });
      } else {
        stopPlay();
      }
    }
    $("playTime").textContent = `${mmss(auP.currentTime)} / ${mmss(auP.duration || S.dur)}`;
    paintTimeLabels();
    redrawAll();
  });
  auP.addEventListener("ended", () => { stopPlay(); });
  auP.addEventListener("loadedmetadata", () => { redrawAll(); });

  // 右键菜单 / 帮助 / 悬浮框的全局关闭
  document.addEventListener("pointerdown", (e) => {
    if (e.target.id !== "waveSrt" && e.target.id !== "wave") hideTip();
    if (!$("ctxMenu").hidden && !e.target.closest("#ctxMenu")) closeCtxMenu();
    if (!$("helpPop").hidden && !e.target.closest("#helpPop") && !e.target.closest(".sb-hbtn")) hideHelp();
  });
  window.addEventListener("resize", () => { hideHelp(); closeCtxMenu(); redrawAll(); });
  document.addEventListener("scroll", () => { closeCtxMenu(); hideTip(); }, true);

  document.querySelectorAll(".sb-hbtn").forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); showHelp(b.dataset.help, b); };
  });
  $("helpClose").onclick = hideHelp;

  // 键盘
  document.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    const typing = tag === "input" || tag === "select" || tag === "textarea";
    if (e.key === "Escape") {
      closeCtxMenu(); hideHelp();
      if (S.tool === "mark") { S.tool = "select"; $("toolMark").classList.remove("on"); $("toolHint").textContent = ""; }
      return;
    }
    if (typing) return;
    if (!$("editor").hidden) {
      if (e.code === "Space") { e.preventDefault(); togglePlayAll(); return; }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const step = (e.shiftKey ? 0.01 : 0.05) * (e.key === "ArrowLeft" ? -1 : 1);
        seekAll(Math.max(0, Math.min(S.dur, curTime() + step)));
        redrawAll();
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      if (e.key.toLowerCase() === "a") {
        e.preventDefault();
        S.segs.forEach((s) => S.sel.add(s._id));
        updateSel(); paintRows(); redrawAll();
      }
      if (e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
      }
      if (e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); delSeg(); return; }
    if (e.key === "[" ) { e.preventDefault(); nudgeEdge("start"); return; }
    if (e.key === "]" ) { e.preventDefault(); nudgeEdge("end"); return; }
    if (e.key.toLowerCase() === "s") { e.preventDefault(); splitSeg(); return; }
    if (e.key.toLowerCase() === "m") { e.preventDefault(); mergeSeg(); return; }
  });
}

/* 按播放头位置缩放（没在播就用视窗中点） */
function midTime() {
  const t = curTime();
  return Math.max(S.view.a, Math.min(S.view.b, t || (S.view.a + S.view.b) / 2));
}

( async function init() {
  bind();
  paintStem();
  loadPlans();
  paintPlayStates();
  $("eng").onchange();
  $("toolHint").textContent = "";
  await loadMats();
  await loadProjects();
  const mid = new URLSearchParams(location.search).get("mid");
  if (mid && S.mats.some((m) => m.id === mid)) {
    S.curMid = mid;
    renderMats();
    $("btnPrepare").disabled = false;
    const m = S.mats.find((x) => x.id === mid);
    $("prepHint").textContent = `已带过来「${m.name || ""}」，点上面按钮开始。`;
  }
  $("topHint").textContent = "原音 / 处理后 双轨对照 · 拖拽编辑 · 按字幕对位进工程";
  initSbTheme();
  // 挂到 window 上：自动化测试和浏览器控制台都要能直接看状态
  try {
    window.S = S;
    window.SFXB = { redrawAll, selectOnly, updateSel, applySrt, savePlan, applyPlan,
                    renderPlans, paintPlayStates, paintTimeLabels, askConfirm };
  } catch (e) { /* 忽略 */ }
})();
