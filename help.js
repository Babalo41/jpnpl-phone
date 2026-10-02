/* help.js - the (i) help icons (UI_STANDARD.md U7). Exposes window.Help.

   Every element with data-help="<page>.<field>" gets a small (i) button beside its label -
   also for content rendered later (a MutationObserver watches the page). Hover, focus or
   click opens a popover with the words from HELP_TEXTS (help_texts.js): what it is, how it is
   calculated, and what to do. On a phone (narrow or touch screen) a tap opens a bottom sheet.
   <html data-tips="off"> hides every icon through CSS alone, so switching tips off needs no
   re-render. The first time a page shows a few icons, a one-time hint points at the switch
   (any element marked data-tips-toggle).
   phone_app/ keeps a byte-identical copy (P2): nothing here may call a desktop-only API. */
(function () {
  'use strict';

  const doc = document;
  const root = doc.documentElement;
  const HINT_KEY = 'jpnpl.tipsHint';
  const OPEN_DELAY = 250;
  const CLOSE_DELAY = 180;
  let seq = 0;
  let pop = null;            // {el, btn, key, pinned}
  let openTimer = null;
  let closeTimer = null;
  let refocusing = false;
  const done = typeof WeakSet === 'function' ? new WeakSet() : null;

  function texts() { return window.HELP_TEXTS || {}; }
  function esc(s) { return window.UI ? UI.esc(s) : String(s == null ? '' : s); }
  function phone() {
    return !!(window.matchMedia && (window.matchMedia('(max-width: 600px)').matches ||
      window.matchMedia('(hover: none)').matches));
  }
  function tipsOn() { return root.getAttribute('data-tips') !== 'off'; }

  // ------------------------------------------------------------ where the (i) goes

  function labelFor(el) {
    if (el.id) {
      const byFor = doc.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]');
      if (byFor) return byFor;
    }
    const wrap = el.closest('label');
    if (wrap) return wrap;
    const field = el.closest('.field');
    if (field) {
      const lab = field.querySelector(':scope > label, :scope > .field-label');
      if (lab && !lab.contains(el)) return lab;
    }
    return null;
  }

  function place(el, btn) {
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      const lab = labelFor(el);
      if (lab && !lab.classList.contains('sr-only')) lab.appendChild(btn);
      else el.insertAdjacentElement('afterend', btn);
      return;
    }
    if (el.classList.contains('sum-row') && el.firstElementChild) {
      el.firstElementChild.appendChild(btn);
      return;
    }
    el.appendChild(btn);
  }

  function attach(el) {
    if (done ? done.has(el) : el.hasAttribute('data-help-ready')) return;
    const key = el.getAttribute('data-help');
    const t = texts()[key];
    if (done) done.add(el); else el.setAttribute('data-help-ready', '');
    if (!key || !t) return;
    const n = ++seq;
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'help-i';
    btn.setAttribute('aria-label', 'About ' + t.t);
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('data-help-key', key);
    btn.innerHTML = window.UI ? UI.icon('info', 'i-sm') : '(i)';
    const desc = doc.createElement('span');
    desc.className = 'sr-only';
    desc.id = 'help-desc-' + n;
    desc.textContent = t.what;
    btn.appendChild(desc);
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) {
      const had = el.getAttribute('aria-describedby');
      el.setAttribute('aria-describedby', (had ? had + ' ' : '') + desc.id);
    }
    place(el, btn);
  }

  function scan(scope) {
    const base = scope && scope.querySelectorAll ? scope : doc;
    if (base.nodeType === 1 && base.hasAttribute('data-help')) attach(base);
    base.querySelectorAll('[data-help]').forEach(attach);
    maybeHint();
  }

  // ------------------------------------------------------------ the popover / sheet

  function body(t) {
    return '<dl class="help-dl">' +
      '<dt>What it is</dt><dd>' + esc(t.what) + '</dd>' +
      '<dt>How it\'s calculated</dt><dd>' + esc(t.how) + '</dd>' +
      '<dt>What to do</dt><dd>' + esc(t.tip) + '</dd></dl>';
  }

  function tipsOff() {
    if (window.AppShell && AppShell.savePrefs) AppShell.savePrefs({help_tips: false});
    else if (window.UI) UI.prefs.set({help_tips: false});
    close();
    if (window.UI) UI.toast('Help tips are off. Turn them on again from the (i) button or the display menu.', 'info');
  }

  function position(el, btn) {
    const r = btn.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = doc.documentElement.clientWidth;
    const vh = doc.documentElement.clientHeight;
    let left = Math.min(Math.max(8, r.left + r.width / 2 - 24), vw - w - 8);
    let top = r.bottom + 8;
    if (top + h > vh - 8 && r.top - h - 8 > 8) top = r.top - h - 8;
    el.style.setProperty('--pop-x', Math.round(left) + 'px');
    el.style.setProperty('--pop-y', Math.round(top) + 'px');
  }

  function open(btn, pinned) {
    const key = btn.getAttribute('data-help-key');
    const t = texts()[key];
    if (!t) return;
    if (phone() && window.UI) {
      UI.modal({title: t.t, body: body(t) + '<div class="help-foot"><button type="button" class="btn btn-ghost btn-sm" ' +
        'data-help-off>Turn tips off</button></div>', size: 'sm'});
      const off = doc.querySelector('.modal [data-help-off]');
      if (off) off.addEventListener('click', tipsOff);
      return;
    }
    if (pop && pop.btn === btn) { pop.pinned = pop.pinned || pinned; return; }
    close();
    const el = doc.createElement('div');
    el.className = 'popover help-pop';
    el.id = 'help-pop-' + (++seq);
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', t.t);
    el.innerHTML = '<div class="help-title">' + esc(t.t) + '</div>' + body(t) +
      '<div class="help-foot"><button type="button" class="btn btn-ghost btn-sm" data-help-off>Turn tips off</button></div>';
    doc.body.appendChild(el);
    position(el, btn);
    btn.setAttribute('aria-expanded', 'true');
    btn.setAttribute('aria-controls', el.id);
    el.querySelector('[data-help-off]').addEventListener('click', tipsOff);
    el.addEventListener('mouseenter', () => clearTimeout(closeTimer));
    el.addEventListener('mouseleave', () => { if (pop && !pop.pinned) closeSoon(); });
    el.addEventListener('focusout', (e) => {
      if (pop && !el.contains(e.relatedTarget) && e.relatedTarget !== btn) closeSoon();
    });
    pop = {el: el, btn: btn, key: key, pinned: !!pinned};
  }

  function close(refocus) {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    if (!pop) return;
    const btn = pop.btn;
    pop.el.remove();
    btn.setAttribute('aria-expanded', 'false');
    btn.removeAttribute('aria-controls');
    pop = null;
    if (refocus && btn.isConnected) {
      refocusing = true;        // focusing the (i) again must not reopen what Esc just closed
      btn.focus();
      refocusing = false;
    }
  }

  function closeSoon() {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { if (pop && !pop.pinned) close(); }, CLOSE_DELAY);
  }

  // ------------------------------------------------------------ one-time hint by the switch

  function maybeHint() {
    if (!tipsOn() || phone() || doc.querySelectorAll('.help-i').length < 4) return;
    let seen = true;
    try { seen = localStorage.getItem(HINT_KEY) === '1'; } catch (e) { seen = true; }
    const anchor = doc.querySelector('[data-tips-toggle]');
    if (seen || !anchor || doc.querySelector('.tips-hint')) return;
    const el = doc.createElement('div');
    el.className = 'popover tips-hint';
    el.setAttribute('role', 'status');
    el.innerHTML = '<div>Too many (i)? Turn them off here.</div><button type="button" class="btn btn-secondary btn-sm" ' +
      'data-hint-ok>Got it</button>';
    doc.body.appendChild(el);
    const r = anchor.getBoundingClientRect();
    el.style.setProperty('--pop-x', Math.round(Math.max(8, r.right - el.offsetWidth)) + 'px');
    el.style.setProperty('--pop-y', Math.round(r.bottom + 10) + 'px');
    const dismiss = () => {
      try { localStorage.setItem(HINT_KEY, '1'); } catch (e) { /* private window */ }
      el.remove();
    };
    el.querySelector('[data-hint-ok]').addEventListener('click', dismiss);
    anchor.addEventListener('click', dismiss, {once: true});
  }

  // ------------------------------------------------------------ events

  function helpBtn(e) {
    return e.target && e.target.closest ? e.target.closest('.help-i') : null;
  }

  doc.addEventListener('click', (e) => {
    const b = helpBtn(e);
    if (b) {
      e.preventDefault();
      e.stopPropagation();       // a sortable table header must not sort
      if (pop && pop.btn === b && pop.pinned) close(); else open(b, true);
      return;
    }
    if (pop && !pop.el.contains(e.target)) close();
  }, true);
  doc.addEventListener('mouseover', (e) => {
    const b = helpBtn(e);
    if (!b || phone()) return;
    clearTimeout(closeTimer);
    clearTimeout(openTimer);
    openTimer = setTimeout(() => open(b, false), OPEN_DELAY);
  });
  doc.addEventListener('mouseout', (e) => {
    const b = helpBtn(e);
    if (!b) return;
    clearTimeout(openTimer);
    if (pop && pop.btn === b && !pop.pinned) closeSoon();
  });
  doc.addEventListener('focusin', (e) => {
    const b = helpBtn(e);
    if (b && !phone() && !refocusing) open(b, false);
  });
  doc.addEventListener('focusout', (e) => {
    const b = helpBtn(e);
    if (b && pop && pop.btn === b && !pop.el.contains(e.relatedTarget)) closeSoon();
  });
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pop) { e.stopPropagation(); close(true); }
  }, true);
  window.addEventListener('resize', () => close());
  window.addEventListener('scroll', () => { if (pop && !pop.pinned) close(); }, true);

  function start() {
    scan(doc);
    if (typeof MutationObserver === 'function') {
      new MutationObserver((list) => {
        for (const m of list) {
          m.addedNodes.forEach((n) => { if (n.nodeType === 1 && !n.classList.contains('help-i')) scan(n); });
        }
      }).observe(doc.body, {childList: true, subtree: true});
    }
  }

  window.Help = {
    scan: scan,
    text(key) { return texts()[key] || null; },
    open(key) {
      const b = doc.querySelector('.help-i[data-help-key="' + key + '"]');
      if (b) open(b, true);
    },
    close: close,
  };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();
})();
