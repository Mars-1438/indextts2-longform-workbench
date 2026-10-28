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

  window.GenParams = {
    FIELDS, SAMPLING, MODE_NAMES,
    normalize, normalizeSampling, merge, diffKeys, summary, isEmpty,
    label: (k) => (byKey[k] ? byKey[k].label : k),
  };
})();
