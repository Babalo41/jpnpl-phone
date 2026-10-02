/* ui.js - shared helpers for every page, desktop and phone (UI_STANDARD.md U9, U11, U12).
   Exposes two globals and nothing else:
     UI  - icon, esc, toast, confirm, modal, skeleton, empty, busy, copy, countUp, sparkline,
           setWidth, motionOn, dur, token, debounce, prefs, onPrefs
     Fmt - inr, inrCompact, num, qty, pct, date, dateTime, month, pl, delta
   ES2017, one IIFE. phone_app/ keeps a byte-identical copy (P2), so nothing here may call a
   desktop-only API; the desktop shell syncs the prefs with the server itself. */
(function () {
  'use strict';

  const doc = document;
  const root = doc.documentElement;
  const me = doc.currentScript;
  const BASE = me && me.src ? me.src.replace(/ui\.js([?#].*)?$/, '') : '/web/';
  const ICONS = BASE + 'icons.svg';
  const PREF_KEY = 'jpnpl.ui';
  const THEMES = ['light', 'dark', 'auto'];
  const DENSITIES = ['comfortable', 'compact'];
  const SIDEBAR = ['open', 'collapsed'];

  // ------------------------------------------------------------ small helpers

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
  }

  function icon(name, cls) {
    return '<svg class="i' + (cls ? ' ' + cls : '') + '" aria-hidden="true" focusable="false"><use href="' +
      ICONS + '#' + esc(name) + '"/></svg>';
  }

  function make(tag, cls, html) {
    const el = doc.createElement(tag);
    if (cls) el.className = cls;
    if (html != null) el.innerHTML = html;
    return el;
  }

  function media(q) {
    return !!(window.matchMedia && window.matchMedia(q).matches);
  }

  function motionOn() {
    return root.getAttribute('data-motion') !== 'off' && !media('(prefers-reduced-motion: reduce)');
  }

  function token(name) {
    return getComputedStyle(root).getPropertyValue(name).trim();
  }

  // A motion token in milliseconds ('200ms', '.2s'); 0 while motion is off.
  function dur(name) {
    const v = token(name || '--dur');
    const n = parseFloat(v) || 0;
    return /ms$/.test(v) ? n : n * 1000;
  }

  function debounce(fn, ms) {
    let t = null;
    return function () {
      const args = arguments;
      const self = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(self, args), ms);
    };
  }

  function setWidth(el, pct) {
    if (el) el.style.setProperty('--w', Math.max(0, Math.min(100, Number(pct) || 0)) + '%');
  }

  // Callbacks for buttons rendered as HTML strings (UI.empty): data-ui-act="<id>".
  const acts = {};
  let actSeq = 0;
  function registerAct(fn) {
    const id = 'a' + (++actSeq);
    acts[id] = fn;
    delete acts['a' + (actSeq - 300)];
    return id;
  }
  doc.addEventListener('click', (e) => {
    const b = e.target.closest ? e.target.closest('[data-ui-act]') : null;
    if (b && acts[b.getAttribute('data-ui-act')]) acts[b.getAttribute('data-ui-act')](e);
  });

  // ------------------------------------------------------------ preferences

  // The <script data-ui-prefs> snippet in each page's <head> has already applied the stored
  // prefs to <html> before paint, so the attributes are the current truth.
  function readPrefs() {
    return {
      theme: root.getAttribute('data-theme-pref') || root.getAttribute('data-theme') || 'light',
      help_tips: root.getAttribute('data-tips') !== 'off',
      motion: root.getAttribute('data-motion') !== 'off',
      density: root.getAttribute('data-density') === 'compact' ? 'compact' : 'comfortable',
      sidebar: root.getAttribute('data-sidebar') === 'collapsed' ? 'collapsed' : 'open',
    };
  }

  function clean(p) {
    const cur = readPrefs();
    const out = {};
    out.theme = THEMES.indexOf(p.theme) >= 0 ? p.theme : cur.theme;
    out.help_tips = typeof p.help_tips === 'boolean' ? p.help_tips : cur.help_tips;
    out.motion = typeof p.motion === 'boolean' ? p.motion : cur.motion;
    out.density = DENSITIES.indexOf(p.density) >= 0 ? p.density : cur.density;
    out.sidebar = SIDEBAR.indexOf(p.sidebar) >= 0 ? p.sidebar : cur.sidebar;
    return out;
  }

  function applyPrefs(p) {
    const dark = p.theme === 'dark' || (p.theme === 'auto' && media('(prefers-color-scheme: dark)'));
    root.setAttribute('data-theme-pref', p.theme);
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
    root.setAttribute('data-motion', p.motion ? 'on' : 'off');
    root.setAttribute('data-density', p.density);
    root.setAttribute('data-tips', p.help_tips ? 'on' : 'off');
    root.setAttribute('data-sidebar', p.sidebar);
  }

  const listeners = [];
  function notify(p) {
    listeners.slice().forEach((fn) => {
      try { fn(p); } catch (e) { /* one listener must not stop the others */ }
    });
    try { doc.dispatchEvent(new CustomEvent('ui:prefs', {detail: p})); } catch (e) { /* old browser */ }
  }

  const prefs = {
    get: readPrefs,
    // Merge, validate, apply, cache on this device and tell listeners. Returns the new prefs.
    set(patch) {
      const p = clean(Object.assign(readPrefs(), patch || {}));
      applyPrefs(p);
      try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch (e) { /* private window */ }
      notify(p);
      return p;
    },
  };

  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const follow = () => {
      const p = readPrefs();
      if (p.theme === 'auto') { applyPrefs(p); notify(p); }
    };
    if (mq.addEventListener) mq.addEventListener('change', follow);
    else if (mq.addListener) mq.addListener(follow);
  }

  // ------------------------------------------------------------ toast

  const TOAST_ICON = {ok: 'circle-check', err: 'circle-alert', warn: 'triangle-alert', info: 'info'};

  function toast(msg, kind, opts) {
    opts = opts || {};
    kind = TOAST_ICON[kind] ? kind : 'ok';
    let stack = doc.querySelector('.toast-stack');
    if (!stack) {
      stack = make('div', 'toast-stack no-print');
      stack.setAttribute('aria-live', 'polite');
      doc.body.appendChild(stack);
    }
    const t = make('div', 'toast ' + kind, icon(TOAST_ICON[kind]) + '<div class="toast-msg"></div>' +
      '<button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Dismiss">' + icon('x', 'i-sm') +
      '</button>');
    t.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    t.querySelector('.toast-msg').textContent = String(msg == null ? '' : msg);
    if (opts.action) {
      const a = make('button', 'btn btn-secondary btn-sm');
      a.type = 'button';
      a.textContent = opts.action.label;
      a.addEventListener('click', () => { close(); if (opts.action.onClick) opts.action.onClick(); });
      t.insertBefore(a, t.lastChild);
    }
    stack.appendChild(t);
    while (stack.children.length > 4) stack.removeChild(stack.firstChild);

    const ms = opts.ms || (kind === 'err' ? 9000 : 4500);
    let timer = setTimeout(close, ms);
    t.addEventListener('mouseenter', () => clearTimeout(timer));
    t.addEventListener('mouseleave', () => { timer = setTimeout(close, 2000); });
    t.lastChild.addEventListener('click', close);

    function close() {
      clearTimeout(timer);
      if (t.classList.contains('is-leaving')) return;
      t.classList.add('is-leaving');
      setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, dur('--dur'));
    }
    return {el: t, close: close};
  }

  // ------------------------------------------------------------ modal, confirm

  let modalSeq = 0;
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),' +
    'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  // opts: title, body (HTML string or Node), actions [{label, kind, value, onClick, autofocus}],
  // size 'sm'|'md'|'lg'|'xl', dismissible (default true), onClose(value).
  // An action's onClick(handle) may return false (stay open) or a Promise (button shows busy).
  function modal(opts) {
    opts = opts || {};
    const id = 'ui-modal-' + (++modalSeq);
    const back = make('div', 'modal-backdrop');
    const size = {lg: ' modal-lg', xl: ' modal-xl'}[opts.size] || '';
    const box = make('div', 'modal' + size);
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', id);
    if (opts.size === 'sm') box.classList.add('modal-sm');
    box.innerHTML = '<div class="modal-head"><h2 class="modal-title" id="' + id + '"></h2>' +
      (opts.dismissible === false ? '' : '<button type="button" class="btn btn-ghost btn-icon btn-sm" ' +
        'aria-label="Close" data-close>' + icon('x') + '</button>') + '</div><div class="modal-body"></div>';
    box.querySelector('.modal-title').textContent = opts.title || '';
    const body = box.querySelector('.modal-body');
    if (opts.body instanceof Node) body.appendChild(opts.body);
    else body.innerHTML = opts.body || '';

    let closed = false;
    const before = doc.activeElement;
    const handle = {el: box, body: body, backdrop: back, close: close};

    (opts.actions || []).forEach((a, i) => {
      let foot = box.querySelector('.modal-foot');
      if (!foot) { foot = make('div', 'modal-foot'); box.appendChild(foot); }
      const b = make('button', 'btn btn-' + (a.kind || (i ? 'primary' : 'secondary')));
      b.type = 'button';
      b.textContent = a.label;
      if (a.autofocus) b.setAttribute('data-autofocus', '');
      b.addEventListener('click', () => {
        const r = a.onClick ? a.onClick(handle) : undefined;
        if (r && typeof r.then === 'function') {
          busy(b, true);
          r.then((v) => { busy(b, false); if (v !== false) close(a.value); },
            (err) => { busy(b, false); toast(err && err.message ? err.message : String(err), 'err'); });
        } else if (r !== false) {
          close(a.value);
        }
      });
      foot.appendChild(b);
    });

    back.appendChild(box);
    doc.body.appendChild(back);
    back.addEventListener('mousedown', (e) => {
      if (e.target === back && opts.dismissible !== false) close();
    });
    box.addEventListener('click', (e) => {
      if (e.target.closest && e.target.closest('[data-close]')) close();
    });
    back.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && opts.dismissible !== false) { e.stopPropagation(); close(); }
      if (e.key !== 'Tab') return;
      const f = Array.prototype.filter.call(box.querySelectorAll(FOCUSABLE), (el) => el.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && doc.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && doc.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    });
    const first = box.querySelector('[autofocus],[data-autofocus]') ||
      body.querySelector('input:not([type=hidden]),select,textarea') ||
      box.querySelector('.modal-foot .btn:last-child') || box.querySelector(FOCUSABLE);
    if (first) setTimeout(() => first.focus(), 0);

    function close(value) {
      if (closed) return;
      closed = true;
      if (back.parentNode) back.parentNode.removeChild(back);
      if (before && before.focus) { try { before.focus(); } catch (e) { /* gone */ } }
      if (opts.onClose) opts.onClose(value);
    }
    return handle;
  }

  // Resolves true when the person picks the action, false otherwise. Name the action with a
  // verb: UI.confirm('Delete this bill?', {ok: 'Delete bill', danger: true}).
  function confirmBox(msg, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const p = make('p');
      p.textContent = msg;
      modal({
        title: opts.title || 'Please confirm', body: p, size: 'sm',
        actions: [{label: opts.cancel || 'Cancel', kind: 'secondary', value: false},
          {label: opts.ok || 'Continue', kind: opts.danger ? 'danger' : 'primary', value: true, autofocus: true}],
        onClose: (v) => resolve(v === true),
      });
    });
  }

  // ------------------------------------------------------------ loading, empty, busy

  function skeleton(kind, n) {
    n = n || (kind === 'kpis' ? 4 : 5);
    const loading = '<span class="sr-only">Loading</span>';
    if (kind === 'kpis') {
      return '<div class="kpi-grid" role="status" aria-busy="true">' + loading +
        new Array(n + 1).join('<div class="skeleton sk-kpi"></div>') + '</div>';
    }
    if (kind === 'chart') return '<div class="skeleton sk-chart" role="status" aria-busy="true">' + loading + '</div>';
    let rows = '';
    for (let i = 0; i < n; i++) rows += '<div class="skeleton sk-line' + (i === n - 1 ? ' short' : '') + '"></div>';
    return '<div class="sk-table" role="status" aria-busy="true">' + loading + rows + '</div>';
  }

  // action: {label, href} for a link or {label, onClick, kind} for a button.
  function empty(msg, action, opts) {
    opts = opts || {};
    let a = '';
    const kind = action && action.kind ? action.kind : 'secondary';
    if (action && action.href) {
      a = `<a class="btn btn-${kind}" href="${esc(action.href)}">${esc(action.label)}</a>`;
    } else if (action && action.onClick) {
      a = `<button type="button" class="btn btn-${kind}" data-ui-act="${registerAct(action.onClick)}">` +
        esc(action.label) + '</button>';
    }
    return '<div class="empty">' + icon(opts.icon || 'layers', 'i-xl') +
      (opts.title ? '<div class="empty-title">' + esc(opts.title) + '</div>' : '') +
      '<p>' + esc(msg) + '</p>' + a + '</div>';
  }

  function busy(btn, on) {
    if (!btn) return;
    btn.classList.toggle('is-loading', !!on);
    btn.disabled = !!on;
    if (on) btn.setAttribute('aria-busy', 'true'); else btn.removeAttribute('aria-busy');
  }

  function copy(text, msg) {
    const done = () => toast(msg || 'Copied', 'ok', {ms: 2000});
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(String(text)).then(done, () => fallback());
    }
    return Promise.resolve(fallback());
    function fallback() {
      const ta = make('textarea', 'sr-only');
      ta.value = String(text);
      doc.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = doc.execCommand('copy'); } catch (e) { ok = false; }
      doc.body.removeChild(ta);
      if (ok) done(); else toast('Could not copy. Select the text and press Ctrl+C.', 'warn');
    }
  }

  // ------------------------------------------------------------ numbers in motion

  // Animates el's text from its last value to `to` (motion-aware). fmt defaults to Fmt.num.
  function countUp(el, to, fmt) {
    if (!el) return;
    fmt = fmt || Fmt.num;
    to = Number(to) || 0;
    const from = Number(el.getAttribute('data-count') || 0);
    el.setAttribute('data-count', String(to));
    const ms = dur('--dur-count');
    if (!motionOn() || !ms || from === to || !window.requestAnimationFrame) { el.textContent = fmt(to); return; }
    let t0 = 0;
    const step = (ts) => {
      if (!t0) t0 = ts;
      const k = Math.min(1, (ts - t0) / ms);
      const eased = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt(k < 1 ? from + (to - from) * eased : to);
      if (k < 1 && el.getAttribute('data-count') === String(to)) window.requestAnimationFrame(step);
    };
    window.requestAnimationFrame(step);
  }

  // A tiny inline-SVG trend line (no Chart.js; used on phones and in KPI tiles).
  function sparkline(values, opts) {
    opts = opts || {};
    const v = (values || []).map(Number).filter((x) => isFinite(x));
    if (v.length < 2) return '';
    const w = 100;
    const h = 30;
    const min = Math.min.apply(null, v);
    const max = Math.max.apply(null, v);
    const span = max - min || 1;
    const pts = v.map((y, i) => [i / (v.length - 1) * w, h - 2 - (y - min) / span * (h - 4)]);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join('');
    return '<svg class="spark' + (opts.neg ? ' neg' : '') + '" viewBox="0 0 ' + w + ' ' + h +
      '" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path class="spark-area" d="' + line +
      'L' + w + ' ' + h + 'L0 ' + h + 'Z"/><path class="spark-line" d="' + line + '"/></svg>';
  }

  // ------------------------------------------------------------ Fmt: every number the person sees

  const DASH = '—';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const nfs = {};
  function nf(min, max) {
    const k = min + ':' + max;
    if (!nfs[k]) nfs[k] = new Intl.NumberFormat('en-IN', {minimumFractionDigits: min, maximumFractionDigits: max});
    return nfs[k];
  }
  function toNum(n) {
    if (n === null || n === undefined || n === '') return NaN;
    return typeof n === 'number' ? n : Number(String(n).replace(/[,\s₹]/g, ''));
  }
  function isNeg(x, dec) {
    return x < 0 && Math.round(Math.abs(x) * Math.pow(10, dec)) !== 0;
  }
  function toDate(s) {
    if (s instanceof Date) return s;
    const str = String(s);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str.slice(0, 10));
    if (m && (str.length === 10 || /^\d{4}-\d{2}-\d{2}[ T]00:00(:00)?$/.test(str))) {
      return new Date(+m[1], +m[2] - 1, +m[3]);
    }
    return new Date(str.replace(' ', 'T'));
  }

  const Fmt = {
    // ₹1,23,456 (en-IN). dec = decimals shown (default 0). Missing values show a dash.
    inr(n, dec) {
      const x = toNum(n);
      const d = dec == null ? 0 : dec;
      if (!isFinite(x)) return DASH;
      return (isNeg(x, d) ? '-' : '') + '₹' + nf(d, d).format(Math.abs(x));
    },
    // ₹950, ₹12.5K, ₹1.2L, ₹3.4Cr - only for chart axes and KPI subtitles.
    inrCompact(n) {
      const x = toNum(n);
      if (!isFinite(x)) return DASH;
      const a = Math.abs(x);
      let s;
      if (a >= 1e7) s = nf(0, 2).format(a / 1e7) + 'Cr';
      else if (a >= 1e5) s = nf(0, 2).format(a / 1e5) + 'L';
      else if (a >= 1e3) s = nf(0, 1).format(a / 1e3) + 'K';
      else s = nf(0, 0).format(a);
      return (isNeg(x, 0) ? '-' : '') + '₹' + s;
    },
    // 1,23,456 - dec is the most decimals shown (default 0).
    num(n, dec) {
      const x = toNum(n);
      if (!isFinite(x)) return DASH;
      return nf(0, dec == null ? 0 : dec).format(x);
    },
    qty(n) { return Fmt.num(n, 3); },
    // Takes a percentage (12.34 -> "12.3%"), not a fraction.
    pct(n, dec) {
      const x = toNum(n);
      const d = dec == null ? 1 : dec;
      if (!isFinite(x)) return DASH;
      return (isNeg(x, d) ? '-' : '') + nf(d, d).format(Math.abs(x)) + '%';
    },
    // 28 Sep 2026
    date(s) {
      if (!s) return '';
      const d = toDate(s);
      return isNaN(d) ? String(s) : d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
    },
    // 28 Sep 2026, 3:05 pm
    dateTime(s) {
      if (!s) return '';
      const d = toDate(s);
      if (isNaN(d)) return String(s);
      const h = d.getHours();
      return Fmt.date(d) + ', ' + (h % 12 || 12) + ':' + String(d.getMinutes()).padStart(2, '0') + (h < 12 ? ' am' : ' pm');
    },
    // '2026-09' -> Sep 2026
    month(s) {
      const m = /^(\d{4})-(\d{2})/.exec(String(s || ''));
      return m ? MONTHS[+m[2] - 1] + ' ' + m[1] : String(s || '');
    },
    // Profit or loss as HTML: sign, arrow and colour together (never colour alone).
    pl(n, dec) {
      const x = toNum(n);
      const d = dec == null ? 0 : dec;
      if (!isFinite(x)) return DASH;
      if (!isNeg(x, d) && Math.round(x * Math.pow(10, d)) === 0) return '<span class="pl">' + Fmt.inr(0, d) + '</span>';
      const up = x > 0;
      return '<span class="pl ' + (up ? 'pos' : 'neg') + '">' + (up ? '▲ ' : '▼ ') + Fmt.inr(x, d) + '</span>';
    },
    // Change against a previous period, as HTML for .kpi-delta. invert: a rise is bad (returns).
    delta(cur, prev, opts) {
      opts = opts || {};
      const c = toNum(cur);
      const p = toNum(prev);
      if (!isFinite(c) || !isFinite(p) || p === 0) return '';
      const ch = (c - p) / Math.abs(p) * 100;
      if (Math.abs(ch) < 0.05) return '<span class="kpi-delta">0.0%' + (opts.label ? ' ' + esc(opts.label) : '') + '</span>';
      const up = ch > 0;
      const good = opts.invert ? !up : up;
      return '<span class="kpi-delta ' + (good ? 'up' : 'down') + '">' + (up ? '▲ ' : '▼ ') +
        nf(1, 1).format(Math.abs(ch)) + '%' + (opts.label ? ' <span class="muted">' + esc(opts.label) + '</span>' : '') +
        '</span>';
    },
  };

  const UI = {
    icon: icon,
    esc: esc,
    toast: toast,
    confirm: confirmBox,
    modal: modal,
    skeleton: skeleton,
    empty: empty,
    busy: busy,
    copy: copy,
    countUp: countUp,
    sparkline: sparkline,
    setWidth: setWidth,
    motionOn: motionOn,
    dur: dur,
    token: token,
    debounce: debounce,
    prefs: prefs,
    onPrefs(fn) { if (typeof fn === 'function') listeners.push(fn); },
  };

  // Keyboard: Left/Right (and Home/End) move between the tabs of a .tabs or .segmented group.
  doc.addEventListener('keydown', (e) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].indexOf(e.key) < 0 || !e.target.closest) return;
    const group = e.target.closest('.tabs, .segmented');
    if (!group || e.target.tagName !== 'BUTTON') return;
    const tabs = Array.prototype.filter.call(group.querySelectorAll('button'), (b) => !b.disabled && b.offsetParent !== null);
    const i = tabs.indexOf(e.target);
    if (i < 0) return;
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 :
      (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[n].focus();
    e.preventDefault();
  });

  window.UI = UI;
  window.Fmt = Fmt;
})();
