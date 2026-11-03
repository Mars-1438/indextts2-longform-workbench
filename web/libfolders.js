/* 素材文件夹（三个库共用：音色 refs / 音效 sfx / 导入台 media）
   ----------------------------------------------------------------------------
   素材一多，「一长条平铺列表」就没法用了：找一个音效要滚三十屏。
   这里给三个库补一层最薄的目录：**文件夹只是索引里的一个字段**，不搬文件、
   不改路径，所以移动 / 改名 / 删除都是毫秒级，删文件夹也不会丢音频。

   三个页面（全能音声工作台 / 时间轴 / 高级音频处理台）共用这一份，行为和样式
   完全一致，改一处三处都对。

   用法：
     LibFolders.load("sfx")                       -> Promise<[{path,name,parent,depth,count}]>
     LibFolders.bar(host, {kind, path, items, onPick, onChanged})
     LibFolders.picker(kind, {value, allowRoot})  -> Promise<string|null>
     LibFolders.moveItems(kind, ids, {onDone})
     LibFolders.assign(kind, ids, path)           -> Promise<{moved}>
     LibFolders.create(kind, path) / rename / remove

   path 的语义："" = 全部（含所有子目录）；"ASMR" = 这棵子树（含 "ASMR/喘息"）。
   ---------------------------------------------------------------------------- */
(function () {
  const API = "/api/v1/lf";
  const CACHE = {};
  const CSS_ID = "libfolders-css";

  const CSS = `
.lfb { display: flex; flex-direction: column; gap: 5px; margin: 2px 0 6px; }
.lfb-crumb {
  display: flex; align-items: center; gap: 3px; flex-wrap: wrap;
  font-size: 11px; color: var(--muted, #6f6b63); min-height: 22px;
}
.lfb-crumb button {
  font: inherit; font-size: 11px; line-height: 1; padding: 4px 6px;
  border: 1px solid transparent; border-radius: 6px; background: transparent;
  color: var(--muted, #6f6b63); cursor: pointer; max-width: 150px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.lfb-crumb button:hover { border-color: var(--border-2, #d4cfc5); color: var(--ink, #2b2a27); }
.lfb-crumb .cur { color: var(--ink, #2b2a27); font-weight: 600; }
.lfb-crumb .sep { opacity: .45; }
.lfb-sp { flex: 1; }
.lfb-act {
  font: inherit; font-size: 10.5px; line-height: 1; padding: 4px 7px;
  border: 1px solid var(--border-2, #d4cfc5); border-radius: 6px;
  background: var(--surface, #fff); color: var(--muted, #6f6b63); cursor: pointer;
  white-space: nowrap;
}
.lfb-act:hover { border-color: var(--primary, #534ab7); color: var(--primary, #534ab7); }
.lfb-act.danger:hover { border-color: var(--danger, #a32d2d); color: var(--danger, #a32d2d); }
.lfb-chips { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.lfb-chip {
  display: inline-flex; align-items: center; gap: 4px; max-width: 190px;
  font: inherit; font-size: 11px; line-height: 1; padding: 5px 8px;
  border: 1px solid var(--border-2, #d4cfc5); border-radius: 999px;
  background: var(--surface, #fff); color: var(--muted, #6f6b63); cursor: pointer;
  white-space: nowrap; overflow: hidden;
}
.lfb-chip:hover { border-color: var(--primary, #534ab7); color: var(--primary, #534ab7); }
.lfb-chip.on {
  background: color-mix(in srgb, var(--primary, #534ab7) 12%, var(--surface, #fff));
  border-color: color-mix(in srgb, var(--primary, #534ab7) 45%, var(--border-2, #d4cfc5));
  color: var(--primary, #534ab7); font-weight: 600;
}
.lfb-chip .n {
  font-family: ui-monospace, Consolas, monospace; font-size: 9.5px; opacity: .7;
}
.lfb-chip .ico { opacity: .8; }
.lfb-empty { font-size: 10.5px; color: var(--faint, #9a958c); }
.lfb-drop { outline: 2px dashed var(--primary, #534ab7); outline-offset: 1px; }

/* 选择器 / 输入卡：三页共用一套，避免一页原生 prompt、一页自定义 */
.lfb-mask {
  position: fixed; inset: 0; z-index: 240; background: rgba(20,19,17,.28);
  display: flex; align-items: flex-start; justify-content: center; padding-top: 12vh;
}
.lfb-card {
  width: 330px; max-width: calc(100vw - 24px); max-height: 70vh; display: flex;
  flex-direction: column; background: var(--surface, #fff); color: var(--ink, #2b2a27);
  border: 1px solid var(--border-2, #d4cfc5); border-radius: 12px;
  box-shadow: 0 14px 40px rgba(20,19,17,.22); font-size: 12px;
  font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
.lfb-head {
  display: flex; align-items: center; gap: 8px; padding: 10px 12px;
  border-bottom: 1px solid var(--border, #e2ded6); font-weight: 600;
}
.lfb-head .x { margin-left: auto; }
.lfb-body { padding: 8px 10px; overflow: auto; }
.lfb-item {
  display: flex; align-items: center; gap: 6px; padding: 6px 8px;
  border-radius: 7px; cursor: pointer; white-space: nowrap;
}
.lfb-item:hover { background: var(--surface-2, #f1efea); }
.lfb-item.on { background: color-mix(in srgb, var(--primary, #534ab7) 12%, var(--surface, #fff)); color: var(--primary, #534ab7); }
.lfb-item .p { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.lfb-item .c { font-family: ui-monospace, Consolas, monospace; font-size: 10px; opacity: .6; }
.lfb-item .d { font-size: 9.5px; opacity: .5; }
.lfb-item.new { color: var(--primary, #534ab7); }
.lfb-foot { display: flex; gap: 6px; padding: 8px 10px 10px; border-top: 1px solid var(--border, #e2ded6); }
.lfb-inp {
  flex: 1; min-width: 0; height: 30px; padding: 0 8px; font: inherit;
  border: 1px solid var(--border-2, #d4cfc5); border-radius: 7px;
  background: var(--surface, #fff); color: var(--ink, #2b2a27); outline: none;
}
.lfb-inp:focus { border-color: var(--primary, #534ab7); }
.lfb-btn {
  height: 30px; padding: 0 12px; font: inherit; font-size: 12px; cursor: pointer;
  border: 1px solid var(--border-2, #d4cfc5); border-radius: 7px;
  background: var(--surface, #fff); color: var(--ink, #2b2a27); white-space: nowrap;
}
.lfb-btn.primary { background: var(--primary, #534ab7); border-color: var(--primary, #534ab7); color: #fff; }
.lfb-btn:disabled { opacity: .45; cursor: default; }
.lfb-tip { padding: 0 12px 10px; font-size: 10.5px; color: var(--faint, #9a958c); line-height: 1.5; }
`;

  function injectCss() {
    if (document.getElementById(CSS_ID)) return;
    const st = document.createElement("style");
    st.id = CSS_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
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
    try { data = await r.json(); } catch (e) { /* 空响应 */ }
    if (!r.ok) throw new Error(data.detail || `HTTP ${r.status}`);
    return data;
  }

  /* ---------------- 数据 ---------------- */
  async function load(kind, force) {
    if (!force && CACHE[kind]) return CACHE[kind];
    const r = await api(`/folders?kind=${encodeURIComponent(kind)}`);
    CACHE[kind] = r.folders || [];
    return CACHE[kind];
  }

  function norm(p) { return String(p == null ? "" : p).replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""); }
  function parentOf(p) { return p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ""; }
  function childOf(p, cur) {
    if (!p || p === cur) return false;
    const rest = cur ? p.slice(cur.length + 1) : p;
    return rest && !rest.includes("/");
  }
  function inTree(itemFolder, cur) {
    const f = norm(itemFolder);
    if (!cur) return true;
    return f === cur || f.startsWith(cur + "/");
  }

  async function op(kind, action, payload) {
    const r = await api("/folders", { method: "POST", body: { kind, action, ...payload } });
    CACHE[kind] = r.folders || [];
    document.dispatchEvent(new CustomEvent("libfolders:change", { detail: { kind, action, ...r } }));
    return r;
  }

  const create = (kind, path) => op(kind, "create", { path });
  const rename = (kind, path, new_path) => op(kind, "rename", { path, new_path });
  const remove = (kind, path) => op(kind, "delete", { path });
  const assign = (kind, ids, path) => op(kind, "assign", { ids, path: path || "" });

  /* ---------------- 小卡片（替代原生 prompt，三页一致） ---------------- */
  function miniCard(title, hint) {
    injectCss();
    const mask = el("div", "lfb-mask");
    const card = el("div", "lfb-card");
    const head = el("div", "lfb-head");
    head.appendChild(el("span", null, title));
    const x = el("button", "lfb-act x", "✕");
    head.appendChild(x);
    card.appendChild(head);
    if (hint) card.appendChild(el("div", "lfb-tip", hint));
    mask.appendChild(card);
    document.body.appendChild(mask);
    const close = (v) => { mask.remove(); resolve(v); };
    let resolve = () => {};
    const p = new Promise((res) => { resolve = res; });
    x.onclick = () => close(null);
    mask.addEventListener("mousedown", (e) => { if (e.target === mask) close(null); });
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); close(null); }
    };
    document.addEventListener("keydown", onKey, true);
    p.finally(() => document.removeEventListener("keydown", onKey, true));
    return { p, card, close };
  }

  /* 输入卡：返回输入值（空字符串也算有效值，取消返回 null） */
  function ask(title, value, hint, placeholder) {
    const { p, card, close } = miniCard(title, hint);
    const body = el("div", "lfb-body");
    const inp = el("input", "lfb-inp");
    inp.value = value == null ? "" : String(value);
    inp.placeholder = placeholder || "例如：ASMR/喘息";
    body.appendChild(inp);
    card.appendChild(body);
    const foot = el("div", "lfb-foot");
    const ok = el("button", "lfb-btn primary", "确定");
    const cancel = el("button", "lfb-btn", "取消");
    foot.appendChild(ok); foot.appendChild(cancel);
    card.appendChild(foot);
    ok.onclick = () => close(inp.value.trim());
    cancel.onclick = () => close(null);
    inp.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); close(inp.value.trim()); }
      e.stopPropagation();
    };
    setTimeout(() => { inp.focus(); inp.select(); }, 20);
    return p;
  }

  /* 目录选择器：列出全部文件夹（缩进树），可现场新建 */
  async function picker(kind, opt = {}) {
    injectCss();
    let folders = [];
    try { folders = await load(kind, true); } catch (e) { folders = []; }
    const { p, card, close } = miniCard(opt.title || "移动到文件夹", "只能选一个文件夹；子文件夹会缩进显示。");
    const body = el("div", "lfb-body");
    card.appendChild(body);

    const draw = (list, cur) => {
      body.innerHTML = "";
      if (opt.allowRoot !== false) {
        const r = el("div", "lfb-item" + (cur === "" ? " on" : ""));
        r.appendChild(el("span", "p", "🏠 不放进文件夹（根目录）"));
        r.onclick = () => close("");
        body.appendChild(r);
      }
      if (!list.length) body.appendChild(el("div", "lfb-empty", "还没有文件夹 —— 点下面「新建」建一个"));
      list.forEach((f) => {
        const row = el("div", "lfb-item" + (cur === f.path ? " on" : ""));
        const pad = el("span");
        pad.style.width = (f.depth * 13) + "px";
        pad.style.flex = "none";
        row.appendChild(pad);
        row.appendChild(el("span", "p", "📁 " + f.name));
        row.appendChild(el("span", "c", String(f.count || 0)));
        row.appendChild(el("span", "d", f.depth ? "" : "顶层"));
        row.title = f.path;
        row.onclick = () => { if (opt.onPick) { opt.onPick(f.path); close(null); } else close(f.path); };
        body.appendChild(row);
      });
    };
    draw(folders, opt.value == null ? "" : norm(opt.value));

    const foot = el("div", "lfb-foot");
    const inp = el("input", "lfb-inp");
    inp.placeholder = "新建文件夹…";
    const add = el("button", "lfb-btn", "＋ 新建");
    const cancel = el("button", "lfb-btn", "取消");
    foot.appendChild(inp); foot.appendChild(add); foot.appendChild(cancel);
    card.appendChild(foot);
    add.onclick = async () => {
      const v = inp.value.trim();
      if (!v) { inp.focus(); return; }
      try {
        await create(kind, v);
        folders = await load(kind, true);
        inp.value = "";
        draw(folders, v);
        if (opt.onPick) { opt.onPick(v); close(null); } else close(v);
      } catch (e) {
        toastSafe("新建失败：" + e.message);
      }
    };
    inp.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); add.onclick(); }
      e.stopPropagation();
    };
    cancel.onclick = () => close(null);
    setTimeout(() => inp.focus(), 20);
    return p;
  }

  function toastSafe(msg, bad) {
    if (typeof window.toast === "function") { window.toast(msg, bad); return; }
    // eslint-disable-next-line no-console
    console.warn("[folders]", msg);
  }

  /* 选中一批素材 → 移到某个文件夹（用于右键 / 批量工具条） */
  async function moveItems(kind, ids, opt = {}) {
    const list = (ids || []).filter(Boolean);
    if (!list.length) { toastSafe("先选中要移动的素材", true); return null; }
    const where = await picker(kind, { title: `把 ${list.length} 个素材移到…` });
    if (where === null) return null;
    try {
      const r = await assign(kind, list, where);
      toastSafe(where ? `已移入「${where}」（${r.moved} 个）` : `已移出文件夹（${r.moved} 个）`);
      if (opt.onDone) opt.onDone(r);
      return r;
    } catch (e) {
      toastSafe("移动失败：" + e.message, true);
      return null;
    }
  }

  /* ---------------- 目录条 ---------------- */
  /* host 里会整块重画；path 变化只通过 onPick 回调交给页面（页面自己保存筛选状态）。 */
  function bar(host, opt) {
    injectCss();
    const kind = opt.kind;
    const cur = norm(opt.path);
    const items = opt.items || [];
    host.innerHTML = "";
    const wrap = el("div", "lfb");
    host.appendChild(wrap);

    const countIn = (p) => items.filter((x) => inTree(x.folder, p)).length;

    // 面包屑：全部 › A › B
    const crumb = el("div", "lfb-crumb");
    const all = el("button", null, "全部");
    all.classList.toggle("cur", !cur);
    all.onclick = () => opt.onPick("");
    crumb.appendChild(all);
    let acc = "";
    cur.split("/").filter(Boolean).forEach((seg, i, arr) => {
      crumb.appendChild(el("span", "sep", "›"));
      acc = acc ? acc + "/" + seg : seg;
      const b = el("button", i === arr.length - 1 ? "cur" : null, seg);
      b.title = acc;
      b.onclick = () => opt.onPick(acc);
      crumb.appendChild(b);
    });
    const cnt = el("span", "lfb-empty", `${countIn(cur)} 个`);
    cnt.style.marginLeft = "4px";
    crumb.appendChild(cnt);
    crumb.appendChild(el("span", "lfb-sp"));

    if (opt.editable !== false) {
      const nw = el("button", "lfb-act", "＋ 文件夹");
      nw.title = cur ? `在「${cur}」里新建子文件夹` : "新建顶层文件夹";
      nw.onclick = async () => {
        const name = await ask("新建文件夹", "", cur ? `会在「${cur}」里新建一个子文件夹。` : "顶层文件夹；之后还能建子文件夹。", "例如：ASMR 音效");
        if (!name) return;
        const path = cur ? cur + "/" + name : name;
        try {
          await create(kind, path);
          toastSafe(`已建「${path}」`);
          if (opt.onChanged) opt.onChanged();
          else drawSelf();
        } catch (e) { toastSafe("新建失败：" + e.message, true); }
      };
      crumb.appendChild(nw);
      if (cur) {
        const rn = el("button", "lfb-act", "改名");
        rn.onclick = async () => {
          const name = await ask("文件夹改名", cur.split("/").pop(), `整个「${cur}」连同子文件夹一起改名；里面的素材跟着走，文件不动。`);
          if (!name) return;
          const np = parentOf(cur) ? parentOf(cur) + "/" + name : name;
          try {
            await rename(kind, cur, np);
            toastSafe(`已改名为「${np}」`);
            opt.onPick(np);
            if (opt.onChanged) opt.onChanged();
          } catch (e) { toastSafe("改名失败：" + e.message, true); }
        };
        crumb.appendChild(rn);
        const del = el("button", "lfb-act danger", "删除");
        del.title = "只删文件夹本身，里面的素材会回到「未归档」，不会删音频";
        del.onclick = async () => {
          const n = countIn(cur);
          if (!window.confirm(`删除文件夹「${cur}」？\n\n里面的 ${n} 个素材不会删，只会回到「未归档」。`)) return;
          try {
            await remove(kind, cur);
            toastSafe(`已删除「${cur}」（${n} 个素材回到未归档）`);
            opt.onPick(parentOf(cur));
            if (opt.onChanged) opt.onChanged();
          } catch (e) { toastSafe("删除失败：" + e.message, true); }
        };
        crumb.appendChild(del);
      }
    }
    wrap.appendChild(crumb);

    // 子文件夹 chips：只画当前层的直接子目录
    // numeric: true —— 名字里带序号时按数字比（1、2、10），不然会是 1、10、2
    const kids = (opt.folders || []).filter((f) => childOf(f.path, cur))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), "zh", { numeric: true }));
    if (kids.length) {
      const chips = el("div", "lfb-chips");
      kids.forEach((f) => {
        const c = el("button", "lfb-chip");
        c.appendChild(el("span", "ico", "📁"));
        c.appendChild(el("span", null, f.name));
        const n = el("span", "n", String(countIn(f.path)));
        c.appendChild(n);
        c.title = `${f.path} · ${countIn(f.path)} 个（含子文件夹）`;
        c.onclick = () => opt.onPick(f.path);
        chips.appendChild(c);
      });
      wrap.appendChild(chips);
    } else if (!cur) {
      wrap.appendChild(el("div", "lfb-empty",
        opt.emptyHint || "还没有文件夹。素材多了可以按场景分：点「＋ 文件夹」。"));
    } else if (opt.editable !== false) {
      wrap.appendChild(el("div", "lfb-empty", "这个文件夹里没有子文件夹。"));
    }

    function drawSelf() {
      if (!opt.onChanged) bar(host, opt);
    }
    return wrap;
  }

  window.LibFolders = {
    load, create, rename, remove, assign, picker, moveItems, bar,
    ask, norm, inTree,
    invalidate(kind) { delete CACHE[kind]; },
    cache(kind) { return CACHE[kind] || []; },
    api,
  };
})();
