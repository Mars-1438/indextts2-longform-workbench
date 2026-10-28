/* 情感控制（共用组件）
   ----------------------------------------------------------------------------
   全能音声工作台和时间轴页都要改「情感」这一套参数，以前各写一份、各缺一块：
   台本页只有「点情绪」（一键单轴）没有情感参考音频，时间轴只有描述文本。
   这里收成一份，字段与主界面（web/index.html 的情感控制）对齐：

     情感模式 0 同音色 / 1 情感参考音频 / 2 情感向量 / 3 情感描述文本
     情感参考音频：可从音色库里挑、可试听、可从外部加入（入库 = 音色库）
     情感向量：8 轴，每轴有滑杆 + −/＋ 按钮，另有快捷填充
     情感权重：0~1

   用法（返回值都能读回一份干净的参数）：
     EmoCtl.mount(host, {mode, weight, vec, text, emoRef, refs, follow, api,
                         defaultMode, onUploaded}) -> {el, read(), setMode()}
     EmoCtl.audio(host, opts)  -> {el, get(), set(id), refreshRefs(refs)}
     EmoCtl.vector(host, opts) -> {el, get(), set(vec)}
   ---------------------------------------------------------------------------- */
(function () {
  const NAMES = ["喜悦", "愤怒", "悲伤", "恐惧", "厌恶", "低落", "惊喜", "平静"];
  const MODES = ["同音色", "情感音频", "情感向量", "情感文本"];
  // 复合情绪：单轴很难表达「委屈 / 紧张 / 强撑」，给几个常用组合
  const COMBOS = [
    { name: "委屈", v: [0, 0, 0.6, 0, 0, 0.45, 0, 0] },
    { name: "紧张", v: [0, 0, 0, 0.55, 0, 0, 0.35, 0] },
    { name: "强撑", v: [0.35, 0, 0.25, 0, 0, 0.2, 0, 0.1] },
    { name: "温柔", v: [0.3, 0, 0, 0, 0, 0, 0, 0.55] },
  ];

  const CSS = `
.emoctl { display: flex; flex-direction: column; gap: 9px; }
.ec-lab { font-size: 11.5px; color: var(--muted); }
.ec-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.ec-box {
  display: flex; flex-direction: column; gap: 7px;
  width: 100%; min-width: 0;
  padding: 8px; border-radius: 9px;
  background: var(--surface-2); border: 1px solid var(--border);
}
.ec-sel {
  flex: 1; min-width: 0; height: 28px; padding: 0 6px;
  font: inherit; font-size: 12px; color: var(--ink);
  background: var(--surface); border: 1px solid var(--border-2); border-radius: 7px;
}
.ec-btn {
  font: inherit; font-size: 11.5px; line-height: 1; padding: 6px 9px;
  border-radius: 7px; cursor: pointer; white-space: nowrap;
  border: 1px solid var(--border-2); background: var(--surface); color: var(--ink);
}
.ec-btn:hover:not(:disabled) { border-color: var(--primary); color: var(--primary); }
.ec-btn:disabled { opacity: .42; cursor: not-allowed; }
.ec-btn.slim { padding: 5px 7px; }
.ec-hint { font-size: 10.5px; color: var(--faint); line-height: 1.5; }
.ec-warn { font-size: 10.5px; color: var(--warn); line-height: 1.5; }
.ec-chips { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.ec-chip {
  font: inherit; font-size: 11px; line-height: 1; padding: 5px 8px;
  border-radius: 999px; cursor: pointer;
  border: 1px solid var(--border-2); background: var(--surface); color: var(--muted);
}
.ec-chip:hover { border-color: var(--primary); color: var(--primary); }
.ec-chip.on {
  background: color-mix(in srgb, var(--primary) 12%, var(--surface));
  border-color: color-mix(in srgb, var(--primary) 45%, var(--border));
  color: var(--primary); font-weight: 600;
}
.ec-grid {
  display: grid; gap: 5px 12px;
  grid-template-columns: repeat(auto-fit, minmax(178px, 1fr));
}
.ec-vrow { display: flex; align-items: center; gap: 5px; min-width: 0; }
.ec-vname {
  font-size: 11px; color: var(--muted); width: 34px; flex: none;
  white-space: nowrap; overflow: hidden;
}
.ec-vrow input[type=range] { flex: 1; min-width: 30px; height: 14px; accent-color: var(--primary); }
.ec-vval {
  font-size: 10.5px; font-family: var(--mono); color: var(--faint);
  width: 26px; text-align: right; flex: none;
}
.ec-step {
  width: 17px; height: 17px; flex: none; padding: 0; line-height: 1;
  font: inherit; font-size: 12px; cursor: pointer;
  border-radius: 5px; border: 1px solid var(--border-2);
  background: var(--surface); color: var(--muted);
}
.ec-step:hover { border-color: var(--primary); color: var(--primary); }
.ec-wrow { display: flex; align-items: center; gap: 8px; }
.ec-wrow input[type=range] { flex: 1; accent-color: var(--primary); }
.ec-wval { font-size: 11px; font-family: var(--mono); color: var(--muted); width: 32px; text-align: right; }
.ec-txt {
  width: 100%; height: 28px; padding: 0 8px; font: inherit; font-size: 12px;
  color: var(--ink); background: var(--surface);
  border: 1px solid var(--border-2); border-radius: 7px;
}
`;

  function injectCss() {
    if (document.getElementById("emoctl-css")) return;
    const s = document.createElement("style");
    s.id = "emoctl-css";
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function h(tag, cls, txt) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }

  function refIdOf(x) { return typeof x === "string" ? x : (x && x.id) || ""; }

  function refName(list, id) {
    if (!id) return "";
    const r = (list || []).find((x) => x.id === id);
    return r ? r.name : id.slice(0, 6);
  }

  /* ---------------------------------------------------------------- 音频块 -- */
  /* opts: {api, refs, value, onChange, onUploaded, follow, defaultName} */
  function audioBlock(opts) {
    injectCss();
    const api = opts.api || "/api/v1/lf";
    let refs = (opts.refs || []).slice();
    const wrap = h("div", "ec-box");

    const row = h("div", "ec-row");
    const sel = document.createElement("select");
    sel.className = "ec-sel";
    row.appendChild(sel);

    const btnPlay = h("button", "ec-btn slim", "▶");
    btnPlay.type = "button";
    btnPlay.title = "试听这段情感音频（前 10 秒）";
    row.appendChild(btnPlay);

    const btnIn = h("button", "ec-btn", "＋ 加入");
    btnIn.type = "button";
    btnIn.title = "从外部选一个音频文件；导入后会存进音色库（标记为情感参考）";
    row.appendChild(btnIn);

    const file = document.createElement("input");
    file.type = "file";
    file.accept = "audio/*,.wav,.mp3,.flac,.ogg,.m4a";
    file.hidden = true;
    row.appendChild(file);
    wrap.appendChild(row);

    const hint = h("div", "ec-hint",
      "从音色库挑，或点「＋ 加入」从外部导入（自动存进音色库）。");
    wrap.appendChild(hint);

    let player = null;
    function stopPlay() {
      if (player) { try { player.pause(); } catch (e) { /* noop */ } }
      player = null;
      btnPlay.textContent = "▶";
    }

    function fill() {
      const cur = sel.value || opts.value || "";
      sel.innerHTML = "";
      const follow = h("option", null,
        opts.follow === false
          ? (opts.emptyLabel || "— 请选择情感参考音频 —")
          : `跟随默认${opts.defaultName ? "（" + opts.defaultName + "）" : ""}`);
      follow.value = "";
      sel.appendChild(follow);
      const marked = refs.filter((r) => (r.uses || []).includes("emo"));
      const groups = {};
      refs.forEach((r) => {
        if ((r.uses || []).includes("emo")) return;
        const g = r.group || "我的音色";
        (groups[g] = groups[g] || []).push(r);
      });
      const addGroup = (label, list, prefix) => {
        if (!list.length) return;
        const og = document.createElement("optgroup");
        og.label = label;
        list.forEach((r) => {
          const op = h("option", null, (prefix || "") + r.name + (r.dur ? `（${r.dur}s）` : ""));
          op.value = r.id;
          og.appendChild(op);
        });
        sel.appendChild(og);
      };
      addGroup("情感参考音频（已标记）", marked, "🎭 ");
      Object.keys(groups).forEach((g) => addGroup(g, groups[g]));
      sel.value = refs.some((r) => r.id === cur) ? cur : (opts.value || "");
      syncButtons();
    }

    function syncButtons() {
      const id = sel.value;
      btnPlay.disabled = !id;
      hint.textContent = id
        ? `已选：${refName(refs, id)}${(refs.find((r) => r.id === id) || {}).dur ? "（" + (refs.find((r) => r.id === id) || {}).dur + "s）" : ""} · 换一个直接选，或「＋ 加入」新文件`
        : "从音色库挑，或点「＋ 加入」从外部导入（自动存进音色库）。";
    }

    sel.onchange = () => {
      stopPlay();
      syncButtons();
      if (opts.onChange) opts.onChange(sel.value || null);
    };

    btnPlay.onclick = () => {
      const id = sel.value;
      if (!id) return;
      if (player) { stopPlay(); return; }
      player = new Audio(`${api}/refs/${encodeURIComponent(id)}/audio?t=${Date.now()}`);
      btnPlay.textContent = "⏸";
      player.onended = () => stopPlay();
      player.onerror = () => { stopPlay(); if (opts.toast) opts.toast("这段读不出来", true); };
      player.play().catch(() => stopPlay());
    };

    btnIn.onclick = () => file.click();
    file.onchange = async () => {
      const f = (file.files || [])[0];
      file.value = "";
      if (!f) return;
      btnIn.disabled = true;
      btnIn.textContent = "导入中…";
      try {
        const fd = new FormData();
        fd.append("file", f);
        fd.append("name", f.name.replace(/\.[^.]+$/, ""));
        fd.append("purpose", "emo");
        const r = await fetch(`${api}/refs`, { method: "POST", body: fd });
        const j = await r.json();
        if (!r.ok) throw new Error(j.detail || "上传失败");
        const ref = j.ref || {};
        if (opts.onUploaded) {
          const next = await opts.onUploaded(ref);
          if (Array.isArray(next)) refs = next.slice();
        }
        if (!refs.some((x) => x.id === ref.id)) {
          refs = refs.concat([{ ...ref, group: "我的音色", editable: true, uses: ["emo"] }]);
        }
        fill();
        sel.value = ref.id;
        syncButtons();
        if (opts.onChange) opts.onChange(ref.id);
        if (opts.toast) opts.toast(`已加入音色库：${ref.name || f.name}`);
      } catch (e) {
        if (opts.toast) opts.toast("导入失败：" + e.message, true);
      } finally {
        btnIn.disabled = false;
        btnIn.textContent = "＋ 加入";
      }
    };

    fill();
    return {
      el: wrap,
      get: () => sel.value || null,
      set: (id) => { sel.value = id || ""; syncButtons(); },
      refreshRefs: (list) => { refs = (list || []).slice(); const cur = sel.value; fill(); sel.value = cur; },
      stop: stopPlay,
    };
  }

  /* ---------------------------------------------------------------- 向量块 -- */
  /* opts: {value:[8], onChange} */
  function vectorBlock(opts) {
    injectCss();
    const wrap = h("div", "ec-box");
    let vec = new Array(8).fill(0);
    (opts.value || []).slice(0, 8).forEach((v, i) => { vec[i] = Number(v) || 0; });

    const chips = h("div", "ec-chips");
    chips.appendChild(h("span", "ec-lab", "快捷填充"));
    const chipNodes = [];
    const mkChip = (label, arr, cls) => {
      const b = h("button", "ec-chip" + (cls ? " " + cls : ""), label);
      b.type = "button";
      b.onclick = () => { set(arr.slice()); };
      chips.appendChild(b);
      chipNodes.push(b);
      return b;
    };
    NAMES.forEach((n, i) => {
      const arr = new Array(8).fill(0);
      arr[i] = 0.85;
      mkChip(n, arr);
    });
    COMBOS.forEach((c) => mkChip(c.name, c.v, "combo"));
    mkChip("清零", new Array(8).fill(0));
    wrap.appendChild(chips);

    const grid = h("div", "ec-grid");
    const rows = [];
    NAMES.forEach((n, i) => {
      const row = h("div", "ec-vrow");
      row.appendChild(h("span", "ec-vname", n.slice(0, 2) === "喜" ? n : n));
      const sl = document.createElement("input");
      sl.className = "ec-axis";
      sl.type = "range"; sl.min = "0"; sl.max = "1"; sl.step = "0.05";
      const val = h("span", "ec-vval", "0.00");
      const dec = h("button", "ec-step", "−");
      dec.type = "button";
      dec.title = `把「${n}」减 0.05`;
      const inc = h("button", "ec-step", "＋");
      inc.type = "button";
      inc.title = `把「${n}」加 0.05`;
      dec.onclick = () => { vec[i] = Math.max(0, Math.round((vec[i] - 0.05) * 100) / 100); paint(); };
      inc.onclick = () => { vec[i] = Math.min(1, Math.round((vec[i] + 0.05) * 100) / 100); paint(); };
      sl.oninput = () => { vec[i] = Number(sl.value); paint(); };
      row.appendChild(sl); row.appendChild(val); row.appendChild(dec); row.appendChild(inc);
      grid.appendChild(row);
      rows.push({ sl, val });
    });
    wrap.appendChild(grid);
    wrap.appendChild(h("div", "ec-hint",
      "8 轴各 0~1；滑杆和 −/＋ 都能调，值会原样送进模型（模型内部再做归一化）。"));

    function paint(silent) {
      rows.forEach((r, i) => {
        const v = vec[i];
        if (Math.abs(Number(r.sl.value) - v) > 1e-6) r.sl.value = String(v);
        r.val.textContent = v.toFixed(2);
      });
      chipNodes.forEach((b, k) => {
        if (k < 8) b.classList.toggle("on", vec[k] > 0.05);
      });
      if (!silent && opts.onChange) opts.onChange(vec.slice());
    }

    function set(arr) {
      vec = new Array(8).fill(0);
      (arr || []).slice(0, 8).forEach((v, i) => { vec[i] = Math.max(0, Math.min(1, Number(v) || 0)); });
      paint(true);          // 程序赋值不回调，避免和“读进来 → 回写”打环
    }

    paint(true);
    return {
      el: wrap,
      get: () => vec.slice(),
      set,
      hasAny: () => vec.some((v) => v > 0),
    };
  }

  /* ---------------------------------------------------------------- 完整块 -- */
  /* opts: {mode, weight, vec, text, emoRef, refs, follow, api, defaultMode,
            defaultRef, defaultName, onUploaded, onChange, toast} */
  function mount(host, opts) {
    injectCss();
    opts = opts || {};
    const api = opts.api || "/api/v1/lf";
    const wrap = h("div", "emoctl");
    let refs = (opts.refs || []).slice();

    // 模式
    const modeRow = h("div", "ec-row");
    modeRow.appendChild(h("span", "ec-lab", "模式"));
    const modeSel = document.createElement("select");
    modeSel.className = "ec-sel ec-mode";
    modeSel.innerHTML = (opts.follow === false ? "" : '<option value="">跟随默认</option>')
      + MODES.map((n, i) => `<option value="${i}">${i} ${n}</option>`).join("");
    const curMode = opts.mode == null ? "" : String(opts.mode);
    modeSel.value = curMode;
    modeRow.appendChild(modeSel);
    wrap.appendChild(modeRow);

    const modeHint = h("div", "ec-hint");
    wrap.appendChild(modeHint);

    // 音频
    const audioBox = audioBlock({
      api, refs, value: opts.emoRef || "",
      follow: false,
      defaultName: opts.defaultName || refName(refs, opts.defaultRef),
      onUploaded: opts.onUploaded,
      toast: opts.toast,
      onChange: () => { if (opts.onChange) opts.onChange(); },
    });
    wrap.appendChild(audioBox.el);

    // 向量
    const vecBox = vectorBlock({ value: opts.vec || [], onChange: () => { if (opts.onChange) opts.onChange(); } });
    wrap.appendChild(vecBox.el);

    // 文本
    const txtBox = h("div", "ec-box");
    const txt = document.createElement("input");
    txt.className = "ec-txt";
    txt.placeholder = "例如：委屈巴巴、危险在悄悄逼近";
    txt.value = opts.text || "";
    txtBox.appendChild(txt);
    txtBox.appendChild(h("div", "ec-hint", "实验功能，生成结果可能不稳定。"));
    wrap.appendChild(txtBox);

    // 权重
    const wRow = h("div", "ec-row");
    wRow.appendChild(h("span", "ec-lab", "权重"));
    const wt = document.createElement("input");
    wt.className = "ec-weight";
    wt.type = "range"; wt.min = "0"; wt.max = "1"; wt.step = "0.01";
    wt.value = String(opts.weight == null ? 0.65 : opts.weight);
    const wtOut = h("span", "ec-wval", Number(wt.value).toFixed(2));
    wt.oninput = () => {
      wtOut.textContent = Number(wt.value).toFixed(2);
      if (opts.onChange) opts.onChange();
    };
    const wWrap = h("div", "ec-wrow");
    wWrap.appendChild(wt);
    wWrap.appendChild(wtOut);
    wWrap.style.flex = "1";
    wRow.appendChild(wWrap);
    wrap.appendChild(wRow);
    wrap.appendChild(h("div", "ec-hint", "权重只在模式 1 / 2 / 3 下生效（同音色模式不看它）。"));

    function curModeVal() { return modeSel.value === "" ? null : Number(modeSel.value); }

    function paintMode() {
      const m = curModeVal();
      const eff = m == null ? Number(opts.defaultMode || 0) : m;
      audioBox.el.hidden = eff !== 1;
      vecBox.el.hidden = eff !== 2;
      txtBox.hidden = eff !== 3;
      modeHint.textContent = {
        0: "用音色参考音频本身的情感，不做额外控制。",
        1: "另选一段「表达目标情绪」的音频做参考；必须选一个，否则这一行生成会报错。",
        2: "用 8 轴向量描述情绪：既可以把某一轴推高，也可以几轴组合（如委屈 = 悲伤 + 低落）。",
        3: "用一句话描述情绪（实验特性）。",
      }[eff] || "";
    }
    modeSel.onchange = () => {
      audioBox.stop();
      paintMode();
      if (opts.onChange) opts.onChange();
    };
    paintMode();

    if (host) host.appendChild(wrap);

    return {
      el: wrap,
      read() {
        const m = curModeVal();
        const v = vecBox.get();
        return {
          emo_mode: m,
          emo_weight: Number(wt.value),
          emo_vec: vecBox.hasAny() ? v : null,
          emo_text: txt.value.trim() || null,
          emo_ref: audioBox.get() || null,
        };
      },
      setMode(m) { modeSel.value = m == null ? "" : String(m); paintMode(); },
      /* 一次性灌一套参数（参数预设套用）。字段和 read() 对称：
         emo_mode / emo_weight / emo_vec / emo_text / emo_ref；缺的项不动。 */
      apply(p) {
        p = p || {};
        if (p.emo_mode != null) this.setMode(p.emo_mode);
        if (p.emo_weight != null) {
          wt.value = String(p.emo_weight);
          wt.dispatchEvent(new Event("input", { bubbles: true }));
        }
        if (Array.isArray(p.emo_vec)) vecBox.set(p.emo_vec);
        if (p.emo_text != null) txt.value = String(p.emo_text || "");
        if (p.emo_ref !== undefined) audioBox.set(p.emo_ref || "");
        paintMode();
      },
      refreshRefs(list) { refs = (list || []).slice(); audioBox.refreshRefs(refs); },
      stop() { audioBox.stop(); },
      get mode() { return curModeVal(); },
      get weight() { return Number(wt.value); },
      get vec() { return vecBox.get(); },
      get text() { return txt.value.trim(); },
      get emoRef() { return audioBox.get(); },
    };
  }

  window.EmoCtl = {
    mount,
    audio: (host, opts) => { const b = audioBlock(opts || {}); if (host) host.appendChild(b.el); return b; },
    vector: (host, opts) => { const b = vectorBlock(opts || {}); if (host) host.appendChild(b.el); return b; },
    NAMES, MODES, COMBOS,
  };
})();
