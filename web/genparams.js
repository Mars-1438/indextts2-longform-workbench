/* 生成参数「中立层」— 台本页 / 时间轴 / 参数预设共用
   ----------------------------------------------------------------------------
   这套工作台要能移植到别的整合包上（不同模型的推理参数不一样），所以**所有**
   跟「这一句怎么生成」有关的字段只在这一个文件里声明一次：

     GenParams.FIELDS     字段表（界面标题、类型、范围、单位、说明）
     GenParams.SAMPLING   采样参数表
     GenParams.normalize  清洗（类型 + 范围，坏值丢掉而不是塞进去）
     GenParams.merge      在中立字段上做覆盖合并（emo_vec 整体替换）
     GenParams.diffKeys   两份参数之间真正变了的字段（批量改属性只提交这些）
     GenParams.summary    一句话摘要（菜单、预设列表、提示条用）

   移植到别的整合包时，按这个顺序改（其它地方不用动）：
     1. 本文件的 FIELDS / SAMPLING —— 换掉字段名和默认值；
     2. longform_api.py 的 `GEN_PARAM_SPEC`（与上面一一对应，负责后端校验）；
     3. longform_api.py 的 `_engine_kwargs()` —— **唯一**把中立参数翻成
        引擎 `infer(...)` 入参的地方；
     4. 前端渲染控件（emoctl.js 的情感组件、音色下拉）—— 只认字段名，不认引擎。
   注意：预设只保存中立字段，**不保存任何引擎专有结构**，所以换包之后预设还能用。
   ---------------------------------------------------------------------------- */
(function () {
  const FIELDS = [
    { k: "ref", label: "音色", kind: "ref", hint: "参考音频 id（空 = 跟随台本默认）" },
    { k: "emo_mode", label: "情感模式", kind: "int", min: 0, max: 3, def: 0,
      hint: "0 同音色 / 1 情感音频 / 2 情感向量 / 3 情感描述" },
    { k: "emo_weight", label: "情感权重", kind: "float", min: 0, max: 1, def: 0.65 },
    { k: "emo_vec", label: "情感向量", kind: "vec8", def: [0, 0, 0, 0, 0, 0, 0, 0],
      hint: "8 轴 0~1：喜悦/愤怒/悲伤/恐惧/厌恶/低落/惊喜/平静" },
    { k: "emo_ref", label: "情感参考音频", kind: "ref" },
    { k: "emo_text", label: "情感描述", kind: "text", max: 200 },
    { k: "pause", label: "句后停顿", kind: "int", min: 0, max: 30000, unit: "ms" },
    { k: "seg_tokens", label: "每段最大 Token", kind: "int", min: 20, max: 600, def: 120 },
    { k: "slow", label: "慢语速标记", kind: "bool", def: false,
      hint: "只做标记，不影响生成（导出时参考）" },
  ];

  const SAMPLING = [
    { k: "do_sample", kind: "bool", def: true },
    { k: "temperature", kind: "float", min: 0.1, max: 2, def: 0.8 },
    { k: "top_p", kind: "float", min: 0, max: 1, def: 0.8 },
    { k: "top_k", kind: "int", min: 1, max: 100, def: 30 },
    { k: "num_beams", kind: "int", min: 1, max: 10, def: 3 },
    { k: "repetition_penalty", kind: "float", min: 0.1, max: 20, def: 10 },
    { k: "max_mel_tokens", kind: "int", min: 50, max: 1815, def: 1500 },
    { k: "length_penalty", kind: "float", min: -2, max: 2, def: 0 },
  ];

  const byKey = {};
  FIELDS.forEach((f) => { byKey[f.k] = f; });

  function num(v, min, max, dflt) {
    const n = typeof v === "number" ? v : parseFloat(v);
    if (!isFinite(n)) return dflt;
    let out = n;
    if (typeof min === "number") out = Math.max(min, out);
    if (typeof max === "number") out = Math.min(max, out);
    return out;
  }

  function normField(f, v) {
    if (v == null) return null;
    switch (f.kind) {
      case "bool":
        return !!v;
      case "int": {
        const n = num(v, f.min, f.max, null);
        return n == null ? null : Math.round(n);
      }
      case "float": {
        const n = num(v, f.min, f.max, null);
        return n == null ? null : Math.round(n * 1000) / 1000;
      }
      case "ref":
        return String(v || "").replace(/[^0-9a-zA-Z_-]/g, "").slice(0, 20) || null;
      case "text":
        return String(v || "").slice(0, f.max || 200) || null;
      case "vec8": {
        if (!Array.isArray(v)) return null;
        const out = [];
        for (let i = 0; i < 8; i++) out.push(num(v[i], 0, 1, 0));
        return out.some((x) => x > 0) ? out : null;
      }
      default:
        return v;
    }
  }

  /** 清洗一份参数：只留认识的字段，坏值丢掉（null = 这一项没有覆盖）。 */
  function normalize(params) {
    const out = {};
    FIELDS.forEach((f) => {
      const v = normField(f, (params || {})[f.k]);
      if (v != null) out[f.k] = v;
    });
    return out;
  }

  function normalizeSampling(sampling) {
    const out = {};
    SAMPLING.forEach((f) => {
      const v = normField(f, (sampling || {})[f.k]);
      if (v != null) out[f.k] = v;
    });
    return out;
  }

  /** 覆盖合并：preset 里有的字段盖到 base 上（不认识的字段忽略）。 */
  function merge(base, over) {
    const out = Object.assign({}, base || {});
    const clean = normalize(over);
    Object.keys(clean).forEach((k) => { out[k] = clean[k]; });
    return out;
  }

  /** 两份参数之间真正变了的字段（批量改属性只提交这些，别把别人的值清掉）。 */
  function diffKeys(before, after) {
    const a = normalize(before), b = normalize(after);
    const keys = new Set(Object.keys(a).concat(Object.keys(b)));
    const out = [];
    keys.forEach((k) => {
      if (JSON.stringify(a[k] === undefined ? null : a[k]) !==
          JSON.stringify(b[k] === undefined ? null : b[k])) out.push(k);
    });
    return out;
  }

  const MODE_NAMES = ["同音色", "情感音频", "情感向量", "情感描述"];

  /** 一句话摘要：菜单 / 预设列表 / toast 里用，别把 8 轴向量打印出来。 */
  function summary(params, refName, opt) {
    const p = normalize(params);
    const brief = !!(opt && opt.brief);
    const bits = [];
    if (!brief) bits.push(p.ref ? (refName ? refName(p.ref) : "指定音色") : "跟随默认音色");
    const mode = p.emo_mode == null ? 0 : p.emo_mode;
    if (mode === 1) bits.push("情感音频" + (p.emo_ref ? "" : "（未选）"));
    else if (mode === 2) {
      const on = (p.emo_vec || []).filter((x) => x > 0).length;
      bits.push(on ? `情感向量 ${on} 轴` : "情感向量（空）");
    } else if (mode === 3) bits.push(p.emo_text ? `情感描述「${p.emo_text.slice(0, 8)}」` : "情感描述");
    else bits.push(MODE_NAMES[0]);
    if (mode !== 0 && p.emo_weight != null) bits.push(`权重 ${p.emo_weight}`);
    if (p.pause != null) bits.push(`停顿 ${p.pause}ms`);
    if (!brief && p.seg_tokens != null && p.seg_tokens !== 120) bits.push(`Token ${p.seg_tokens}`);
    if (p.slow) bits.push("慢语速");
    return bits.join(" · ");
  }

  function isEmpty(params) {
    return Object.keys(normalize(params)).length === 0;
  }

  /* ---------------------------- 参数预设快捷条 ----------------------------
     「批量改属性 / 编辑分组 / 时间轴改属性」共用同一个控件，样式自带
     （首次调用注入一次），所以移植时不用在每个页面的 CSS 里再补一遍。

     用法：
       GenParams.presetBar({
         presets: () => PRESETS,       // 数组或函数（每次开弹窗都重新读）
         onApply: (p) => {},           // 「套用」：点一下立刻写进句子
         onFill: (p) => {},            // 「填入」：只把参数灌进下面的控件
         onSave: async (name) => p,    // 「＋ 存为预设」：用当前面板参数新建，返回预设
         onManage: () => {},           // 「管理…」：去设置里建 / 删
         refName: (id) => name,        // 摘要里把音色 id 换成人话
         label: "预设",
       });

     设计约束（很重要）：**没有预设时也要显示**。以前这三个面板都写了
     `if (PRESETS.length)`，结果新用户第一次打开根本看不到「预设」两个字，
     自然以为这个功能不存在。 */
  let _pbarCss = false;
  function _injectPbarCss() {
    if (_pbarCss) return;
    _pbarCss = true;
    const st = document.createElement("style");
    st.id = "gp-pbar-css";
    st.textContent = [
      ".gp-pbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:0 0 9px;",
      "padding:5px 7px;border:1px solid var(--border,#d8d3cc);border-radius:8px;",
      "background:var(--inset,#f6f3ee)}",
      ".gp-pbar .gp-plab{flex:none;font-size:11.5px;color:var(--faint,#9a938a)}",
      ".gp-pbar select{flex:1;min-width:110px;height:26px;font:inherit;font-size:12px;",
      "padding:0 4px;border-radius:6px;border:1px solid var(--border,#d8d3cc);",
      "background:var(--surface,#fff);color:var(--ink,#2b2723)}",
      ".gp-pbar button{font:inherit;font-size:11.5px;line-height:20px;padding:2px 8px;",
      "border-radius:6px;cursor:pointer;border:1px solid var(--border,#d8d3cc);",
      "background:var(--surface,#fff);color:var(--ink,#2b2723);white-space:nowrap}",
      ".gp-pbar button:hover:not(:disabled){border-color:var(--primary,#c0392b);",
      "color:var(--primary,#c0392b)}",
      ".gp-pbar button.gp-main{background:var(--primary,#c0392b);",
      "border-color:var(--primary,#c0392b);color:#fff;font-weight:600}",
      ".gp-pbar button:disabled{opacity:.45;cursor:not-allowed}",
      ".gp-pbar .gp-save{display:flex;align-items:center;gap:4px;flex:1;min-width:160px}",
      ".gp-pbar .gp-save input{flex:1;min-width:0;height:24px;font:inherit;font-size:12px;",
      "padding:0 5px;border-radius:6px;border:1px solid var(--primary,#c0392b);",
      "background:var(--surface,#fff);color:var(--ink,#2b2723)}",
    ].join("");
    document.head.appendChild(st);
  }

  /* ---------------------------- 能力清单（移植用） ----------------------------
     后端 GET /api/v1/lf/manifest 会说清「这台机器上有什么」：引擎、参数表、
     Demucs / ffmpeg / 空间音频 / 导出的格式与采样率。
     前端据此**隐藏或灰掉**做不到的按钮，而不是让用户点了才报错。
     读不到清单时一律当作「支持」（can() 返回 true）——宁可多点一下，也别把功能藏了。 */
  let _manifest = null;
  let _manifestP = null;

  function manifest(force) {
    if (_manifest && !force) return Promise.resolve(_manifest);
    if (_manifestP && !force) return _manifestP;
    _manifestP = fetch("/api/v1/lf/manifest")
      .then((r) => (r.ok ? r.json() : { ok: false, capabilities: {} }))
      .catch(() => ({ ok: false, capabilities: {} }))
      .then((d) => { _manifest = d || {}; _manifestP = null; return _manifest; });
    return _manifestP;
  }

  function caps() {
    return (_manifest && _manifest.capabilities) || {};
  }

  function can(cap) {
    const c = caps();
    if (!(cap in c)) return true;
    const v = c[cap];
    return Array.isArray(v) ? v.length > 0 : !!v;
  }

  function presetBar(opts) {
    const o = opts || {};
    _injectPbarCss();
    const host = document.createElement("div");
    host.className = "gp-pbar";
    const say = (m, bad) => { if (o.toast) o.toast(m, bad); };
    const list = () => {
      const v = typeof o.presets === "function" ? o.presets() : o.presets;
      return Array.isArray(v) ? v : [];
    };
    const refName = o.refName || ((id) => id);

    const lab = document.createElement("span");
    lab.className = "gp-plab";
    lab.textContent = o.label || "预设";
    host.appendChild(lab);

    const sel = document.createElement("select");
    host.appendChild(sel);

    const pick = () => list().find((p) => p.id === sel.value) || null;
    let applyBtn = null, fillBtn = null, saveBtn = null, manageBtn = null;

    if (o.onApply) {
      applyBtn = document.createElement("button");
      applyBtn.type = "button";
      applyBtn.className = "gp-main";
      applyBtn.textContent = o.applyLabel || "套用";
      applyBtn.onclick = () => {
        const p = pick();
        if (!p) { say("先在下拉里选一个预设", true); return; }
        o.onApply(p);
      };
      host.appendChild(applyBtn);
    }
    if (o.onFill) {
      fillBtn = document.createElement("button");
      fillBtn.type = "button";
      fillBtn.textContent = o.fillLabel || "填入";
      fillBtn.onclick = () => {
        const p = pick();
        if (!p) { say("先在下拉里选一个预设", true); return; }
        o.onFill(p);
      };
      host.appendChild(fillBtn);
    }
    if (o.onSave) {
      saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.textContent = o.saveLabel || "＋ 存为预设";
      saveBtn.title = "用当前面板这套参数新建一个预设：只新增方案，不改句子、也不改台本默认";
      saveBtn.onclick = () => openSave();
      host.appendChild(saveBtn);
    }
    if (o.onManage) {
      manageBtn = document.createElement("button");
      manageBtn.type = "button";
      manageBtn.textContent = "管理…";
      manageBtn.title = "打开「⚙ 设置 → 参数预设」（新建 / 改名 / 编辑参数 / 删除）";
      manageBtn.onclick = () => o.onManage();
      host.appendChild(manageBtn);
    }

    function openSave() {
      /* 就地展开成 [名称][保存][取消]，不弹窗 ——
         台本页与时间轴的 modal 实现不同，走这里就不用两边各写一套。 */
      const row = document.createElement("div");
      row.className = "gp-save";
      const inp = document.createElement("input");
      inp.type = "text";
      inp.placeholder = o.savePlaceholder || "预设名称，如：哄睡低沉男声";
      inp.value = o.defaultName ? (o.defaultName() || "") : "";
      const ok = document.createElement("button");
      ok.type = "button"; ok.className = "gp-main"; ok.textContent = "保存";
      const no = document.createElement("button");
      no.type = "button"; no.textContent = "取消";
      row.appendChild(inp); row.appendChild(ok); row.appendChild(no);

      const hidden = [];
      [lab, sel, applyBtn, fillBtn, saveBtn, manageBtn].forEach((n) => {
        if (!n) return;
        hidden.push([n, n.style.display]);
        n.style.display = "none";
      });
      host.appendChild(row);
      inp.focus(); inp.select();

      const quit = () => {
        row.remove();
        hidden.forEach(([n, v]) => { n.style.display = v || ""; });
      };
      no.onclick = quit;
      const commit = async () => {
        const name = (inp.value || "").trim();
        if (!name) { inp.focus(); return; }
        ok.disabled = true; ok.textContent = "保存中…";
        try {
          const made = await o.onSave(name);
          quit();
          refresh();
          if (made && made.id) sel.value = made.id;
          syncBtns();
        } catch (e) {
          ok.disabled = false; ok.textContent = "保存";
          say("保存失败：" + ((e && e.message) || e), true);
        }
      };
      ok.onclick = commit;
      inp.onkeydown = (e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        else if (e.key === "Escape") { e.preventDefault(); quit(); }
      };
    }

    function syncBtns() {
      const none = !sel.value;
      [applyBtn, fillBtn].forEach((b) => { if (b) b.disabled = none; });
    }

    function refresh() {
      const arr = list();
      const prev = sel.value;
      sel.innerHTML = "";
      if (!arr.length) {
        const op = document.createElement("option");
        op.value = "";
        op.textContent = o.onSave ? "还没有预设（点右边 ＋ 用当前参数存一个）" : "还没有预设";
        sel.appendChild(op);
        sel.disabled = true;
      } else {
        sel.disabled = false;
        const ph = document.createElement("option");
        ph.value = "";
        ph.textContent = o.placeholder || "选一个预设…";
        sel.appendChild(ph);
        arr.forEach((p) => {
          const op = document.createElement("option");
          op.value = p.id;
          op.textContent = p.name;
          try { op.title = summary(p.params, refName, { brief: true }); } catch (e) { /* 忽略 */ }
          sel.appendChild(op);
        });
        if (arr.some((p) => p.id === prev)) sel.value = prev;
      }
      syncBtns();
    }

    sel.onchange = syncBtns;
    host.refresh = refresh;
    refresh();
    return host;
  }

  window.GenParams = {
    FIELDS, SAMPLING, MODE_NAMES,
    normalize, normalizeSampling, merge, diffKeys, summary, isEmpty,
    presetBar, manifest, caps, can,
    label: (k) => (byKey[k] ? byKey[k].label : k),
  };
})();
