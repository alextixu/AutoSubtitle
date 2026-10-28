/* 字幕工房 — 介面語言
 * 中文是原文；選英文時，畫面上的文字（含程式動態產生的狀態、提示、錯誤）即時換成英文。
 * 字典在 i18n-en.js：exact 是整句對照，tpl 是含 {1}{2} 的樣板（數字、檔名等執行時才知道的值），
 * 樣板抓到的值本身是中文時也會再翻一次（例如「標準 · 速度與準確度平衡 · 已下載」）。
 * 使用者的內容（字幕、逐字稿、詞庫、專案名稱）不翻：SKIP 裡的區塊整個略過。
 * 載入順序：放在 <head>，比任何畫面元素都早，避免先閃一下中文。 */
'use strict';

(function () {
  const KEY = 'as.uiLang';
  const pick = pref => (pref === 'en' || pref === 'zh-Hant') ? pref
    : ((navigator.language || '').toLowerCase().startsWith('zh') ? 'zh-Hant' : 'en');
  let pref = 'auto';
  try { pref = localStorage.getItem(KEY) || 'auto'; } catch (e) { /* file:// 或私密模式 */ }
  const url = new URLSearchParams(location.search).get('lang');   // 開發用：?lang=en
  const lang = url ? pick(url) : pick(pref);
  const CJK = /[㐀-鿿]/;
  // 使用者內容：字幕文字、預覽字幕、逐字稿、詞庫的詞、專案與檔案名稱、檔名
  const SKIP = '.cue-text, .cue-edit, .sub-overlay, .tx-list, .glo-item b, .proj-card b, .meta.media, .q-main b, #txFileName, #projTitle, #npFile, [data-i18n-skip]';
  const ATTRS = ['title', 'placeholder', 'aria-label'];
  const dict = window.AS_I18N_EN || { exact: {}, tpl: {} };

  // 樣板編成 regex：字面部分照抄，{n} 變成擷取群組；字面越長越先比對（越具體）
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tpls = Object.entries(dict.tpl || {}).map(([src, en]) => {
    const order = [];
    const rx = new RegExp('^' + src.split(/(\{\d+\})/).map(p => {
      const m = /^\{(\d+)\}$/.exec(p);
      if (m) { order.push(+m[1]); return '([\\s\\S]*?)'; }    // 可以是空字串（例如沒有範圍時）
      return esc(p);
    }).join('') + '$');
    return { rx, order, en, weight: src.replace(/\{\d+\}/g, '').length };
  }).sort((a, b) => b.weight - a.weight);

  const cache = new Map();
  function tr(s, depth = 0) {
    if (lang !== 'en' || !s || !CJK.test(s)) return s;
    const lead = s.match(/^\s*/)[0], tail = s.match(/\s*$/)[0];
    const core = s.trim();
    if (cache.has(core)) return lead + cache.get(core) + tail;
    let out = translateCore(core, depth);
    if (out == null) out = core;
    if (depth === 0 && core.length < 200 && !core.includes('\n')) {   // 紀錄這種一直變長的文字不快取
      if (cache.size > 3000) cache.clear();
      cache.set(core, out);
    }
    return lead + out + tail;
  }
  function translateCore(s, depth) {
    if (Object.prototype.hasOwnProperty.call(dict.exact, s)) return dict.exact[s];
    if (depth > 3) return null;
    // 多行（例如紀錄）先逐行翻，樣板才不會跨行比對；多檔時狀態列前面的「[2/3] 」先拿掉
    if (s.includes('\n')) return s.split('\n').map(p => tr(p, depth)).join('\n');
    let m = /^(\[\d+\/\d+\]\s*)([\s\S]+)$/.exec(s);
    if (m) return m[1] + tr(m[2], depth + 1);
    for (const t of tpls) {
      const m = t.rx.exec(s);
      if (!m) continue;
      return t.en.replace(/\{(\d+)\}/g, (_, n) => {
        const v = m[t.order.indexOf(+n) + 1];
        return v == null ? '' : tr(v, depth + 1);
      });
    }
    // 組合字串：用「 · 」串起來的說明、「標題：內容」
    if (s.includes(' · ')) return s.split(' · ').map(p => tr(p, depth + 1)).join(' · ');
    m = /^([^：]{1,12}：)\s*([\s\S]+)$/.exec(s);
    if (m && Object.prototype.hasOwnProperty.call(dict.exact, m[1])) return dict.exact[m[1]].trimEnd() + ' ' + tr(m[2], depth + 1);
    m = /^([^：]{1,20})：([\s\S]+)$/.exec(s);           // 「標題：說明」
    if (m) return tr(m[1], depth + 1) + ': ' + tr(m[2], depth + 1);
    m = /^([\s\S]+?)\s*[（(]([^（）()]+)[）)]$/.exec(s);    // 結尾的括號補充說明
    if (m) return tr(m[1], depth + 1) + ' (' + tr(m[2], depth + 1) + ')';
    if (s.includes('，')) return s.split('，').map(p => tr(p, depth + 1)).join(', ');
    return null;
  }

  window.t = tr;
  window.__asI18n = {
    lang, pref,
    set(p) { try { localStorage.setItem(KEY, p); } catch (e) { /* 只在這次有效 */ } },
    // 開發與測試用：列出畫面上還沒翻到的中文
    missing() {
      const out = new Set();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n; (n = walker.nextNode());) {
        const el = n.parentElement;
        if (!el || el.closest(SKIP) || !CJK.test(n.nodeValue)) continue;
        if (el.offsetParent === null && el.tagName !== 'OPTION') continue;
        out.add(n.nodeValue.trim());
      }
      document.querySelectorAll('[title],[placeholder],[aria-label]').forEach(el => {
        if (el.closest(SKIP)) return;
        for (const a of ATTRS) { const v = el.getAttribute(a); if (v && CJK.test(v)) out.add(`@${a}: ${v}`); }
      });
      return [...out];
    },
  };
  document.documentElement.lang = lang;
  if (lang !== 'en') return;

  const skip = el => !!(el && el.closest && el.closest(SKIP));

  // 記住自己寫進去的譯文：譯文本身可能還含中文（例如「繁體中文 (Traditional Chinese)」），
  // 不記的話 MutationObserver 會把它當成新文字再翻一次，無限疊加
  const wroteText = new WeakMap(), wroteAttr = new WeakMap();
  function fixText(n) {
    const v = n.nodeValue;
    if (!v || !CJK.test(v) || wroteText.get(n) === v || skip(n.parentElement)) return;
    const out = tr(v);
    wroteText.set(n, out);
    if (out !== v) n.nodeValue = out;
  }
  function fixAttrs(el) {
    if (skip(el)) return;
    let mine = wroteAttr.get(el);
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (!v || !CJK.test(v) || (mine && mine[a] === v)) continue;
      const out = tr(v);
      if (!mine) wroteAttr.set(el, (mine = {}));
      mine[a] = out;
      if (out !== v) el.setAttribute(a, out);
    }
  }
  function walk(root) {
    if (root.nodeType === 3) { fixText(root); return; }
    if (root.nodeType !== 1 || skip(root)) return;
    fixAttrs(root);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: n => (n.nodeType === 1 && skip(n)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    for (let n; (n = w.nextNode());) { if (n.nodeType === 3) fixText(n); else fixAttrs(n); }
  }
  new MutationObserver(muts => {
    for (const m of muts) {
      if (m.type === 'characterData') fixText(m.target);
      else if (m.type === 'attributes') fixAttrs(m.target);
      else m.addedNodes.forEach(walk);
    }
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  document.addEventListener('DOMContentLoaded', () => { walk(document.body); document.title = tr(document.title); });

  // CSS 裡寫死的字
  const st = document.createElement('style');
  st.textContent = `.safe-frame::after{content:'Safe area'} .app.side-collapsed .update-banner::before{content:'Update'}`;
  document.head.append(st);
})();
