// JP's No Profit Loss - the phone app that keeps billing when the shop PC is off.
// While the PC is reachable it downloads a snapshot (items, customers, numbers) and
// sends queued bills. Bills are always made here, in this phone's own number series
// (M1/26-27/0001), then synced - so it works the same with or without the PC.
// Look and feedback come from the shared m.css + ui.js (UI, Fmt) + help.js, loaded before this module.
import {kv, outbox, keepData} from './db.js';
import {computeBill, nextDocNo, BillError} from './gst.js';
import {billPdf, billFileName} from './pdf.js';
import {findPc} from './relay.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => window.UI.esc(s);
const icon = (name, cls) => window.UI.icon(name, cls);
const money = (v) => {
  const n = Number(v || 0);
  return window.Fmt.inr(n, Math.round(n * 100) % 100 === 0 ? 0 : 2);
};
const qtyText = (v) => window.Fmt.qty(v);
const pill = (t, k) => '<span class="badge ' + (k || '') + '">' + esc(t) + '</span>';
const empty = (msg) => window.UI.empty(msg);
const today = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() :
  'x' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12));

const S = {conn: null, snap: null, online: false, checking: false, view: 'home', synced: [], out: [], bill: null};

class Offline extends Error {}
class Unpaired extends Error {}

function toast(text, kind) { window.UI.toast(text, kind || 'ok'); }
// A bottom sheet: the handle's .body holds the html, .close() shuts it.
function sheet(title, html) { return window.UI.modal({title, body: html}); }
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ── talking to the shop PC ──────────────────────────────────
const DEAD_TUNNEL = [502, 503, 504, 521, 522, 523, 525, 530];

async function pc(path, opts = {}, retry = true) {
  if (!S.conn || !S.conn.pc) throw new Offline('Not paired with a shop PC.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || 12000);
  const headers = Object.assign({}, opts.headers || {});
  if (S.conn.token) headers.Authorization = 'Bearer ' + S.conn.token;
  let res;
  try {
    res = await fetch(S.conn.pc + path, Object.assign({}, opts, {headers, signal: ctrl.signal, credentials: 'omit'}));
  } catch (e) {
    res = null;
  } finally { clearTimeout(timer); }
  if (!res || DEAD_TUNNEL.includes(res.status)) {
    if (retry && await relocate()) return pc(path, opts, false);
    throw new Offline('The shop PC cannot be reached.');
  }
  if (res.status === 401) {
    const d = await res.json().catch(() => ({}));
    throw new Unpaired(d.error || 'This phone is not paired any more.');
  }
  if (opts.raw) {
    if (!res.ok) throw new Error('Error ' + res.status);
    return res;
  }
  const type = res.headers.get('Content-Type') || '';
  const data = type.includes('json') ? await res.json() : {error: (await res.text()).slice(0, 200)};
  if (!res.ok) throw new Error(data.error || 'Error ' + res.status);
  return data;
}

// The free tunnel link changes when the PC restarts; the PC posts the new one (sealed)
// to the relay and we pick it up here.
async function relocate() {
  if (!S.conn || !S.conn.topic || !S.conn.key) return false;
  try {
    const url = await findPc(S.conn.topic, S.conn.key);
    if (url && url !== S.conn.pc) {
      S.conn.pc = url;
      await kv.set('conn', S.conn);
      return true;
    }
  } catch (e) { /* relay unreachable too */ }
  return false;
}

async function refresh(quiet) {
  if (!S.conn || !S.conn.token || S.checking) return;
  S.checking = true;
  drawStatus();
  try {
    await takeSnapshot();
    const sent = await syncOutbox();
    if (sent) await takeSnapshot();
    S.online = true;
  } catch (e) {
    if (e instanceof Unpaired) { await unpaired(e.message); return; }
    S.online = false;
    if (!quiet) toast(e instanceof Offline ? 'Shop PC is off or offline - bills are kept on this phone.' : e.message,
      e instanceof Offline ? 'info' : 'err');
  } finally {
    S.checking = false;
  }
  render();
}

async function takeSnapshot() {
  const snap = await pc('/api/m/snapshot', {timeout: 30000});
  S.snap = snap;
  await kv.set('snap', snap);
}

async function syncOutbox() {
  const waiting = (await outbox.all()).filter((b) => b.state !== 'rejected');
  if (!waiting.length) return 0;
  const r = await pc('/api/m/sync', {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({bills: waiting.map((b) => b.payload)}), timeout: 60000});
  let ok = 0, bad = 0;
  const warns = [];
  for (const res of r.results) {
    const b = waiting.find((x) => x.uuid === res.uuid);
    if (!b) continue;
    if (res.status === 'ok') {
      ok++;
      await outbox.del(b.uuid);
      S.synced = [Object.assign({}, b, {state: 'synced', result: res})].concat(S.synced.filter((x) => x.uuid !== b.uuid))
        .slice(0, 60);
      (res.warnings || []).forEach((w) => warns.push(b.payload.doc_no + ': ' + w));
    } else {
      bad++;
      b.state = 'rejected';
      b.message = res.message;
      await outbox.put(b);
    }
  }
  await kv.set('synced', S.synced);
  S.out = await outbox.all();
  if (ok || bad) {
    toast((ok ? ok + ' bill(s) reached the PC.' : '') + (bad ? ' ' + bad + ' need attention - see Bills.' : '') +
      (warns.length ? ' ' + warns[0] : ''), bad ? 'err' : 'ok');
  }
  return ok;
}

async function unpaired(message) {
  S.conn.token = null;
  await kv.set('conn', S.conn);
  S.view = 'pair';
  render();
  toast(message, 'err');
}

// ── pairing ─────────────────────────────────────────────────
async function readPairLink() {
  if (!location.hash.includes('pc=')) return;
  const p = new URLSearchParams(location.hash.slice(1));
  const conn = Object.assign({}, S.conn || {});
  if (p.get('pc')) conn.pc = p.get('pc').replace(/\/+$/, '');
  if (p.get('topic')) conn.topic = p.get('topic');
  if (p.get('key')) conn.key = p.get('key');
  S.conn = conn;
  await kv.set('conn', conn);
  history.replaceState(null, '', location.pathname + location.search);   // the key never stays in the address bar
}

function viewPair() {
  const havePc = S.conn && S.conn.pc;
  return '<section class="card stack papp-pair"><h2 class="card-title" data-help="papp.pair.card">Pair this phone</h2>' +
    (havePc ? '<form id="pairForm" class="stack">' +
      '<div class="field"><label for="pName">Your name</label><input id="pName" autocomplete="username" required ' +
        'data-help="papp.pair.name"></div>' +
      '<div class="field"><label for="pPin">PIN (6-8 digits)</label><input id="pPin" type="password" inputmode="numeric" ' +
        'maxlength="8" autocomplete="current-password" required data-help="papp.pair.pin"></div>' +
      '<div class="field"><label for="pLabel">Name for this phone</label><input id="pLabel" placeholder="e.g. Jiju\'s Samsung" ' +
        'data-help="papp.pair.label"></div>' +
      '<button type="submit" class="btn btn-primary btn-block" id="pGo">Pair</button></form>' +
      '<p class="hint">Shop PC: ' + esc(S.conn.pc) + '</p>' :
      '<p class="muted">On the shop PC open <b>Settings &gt; Phone access</b>, switch it on and scan the QR code ' +
        'with this phone\'s camera.</p>') +
    '</section>';
}

async function pair(e) {
  e.preventDefault();
  $('pGo').classList.add('is-loading');
  try {
    const r = await pc('/api/m/pair', {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name: $('pName').value.trim(), pin: $('pPin').value, label: $('pLabel').value.trim()})});
    S.conn.token = r.token;
    S.conn.device = r.device;
    S.conn.user = r.user;
    await kv.set('conn', S.conn);
    await keepData();
    S.view = 'home';
    toast('Paired. Downloading the shop data...');
    render();
    refresh();
  } catch (err) {
    toast(err instanceof Offline ? 'Cannot reach the shop PC - is phone access on?' : err.message, 'err');
    $('pGo').classList.remove('is-loading');
  }
}

// ── derived data ────────────────────────────────────────────
function queuedQty() {
  const q = {};
  for (const b of S.out) {
    if (b.state === 'rejected' || b.payload.doc_type !== 'INVOICE') continue;
    for (const l of b.payload.lines) if (l.sku) q[l.sku] = (q[l.sku] || 0) + Number(l.qty);
  }
  return q;
}
function stockOf(item, queued) { return Number(item.stock || 0) - (queued[item.sku] || 0); }
const canBill = () => S.snap && ['owner', 'manager', 'billing'].includes(S.snap.user.role);

// ── views ───────────────────────────────────────────────────
function drawStatus() {
  const el = $('status');
  if (!el) return;
  const waiting = S.out.filter((b) => b.state !== 'rejected').length;
  const bad = S.out.filter((b) => b.state === 'rejected').length;
  el.hidden = S.view === 'pair';
  el.className = 'papp-status ' + (S.checking ? 'st-busy' : S.online ? 'st-on' : 'st-off');
  el.innerHTML = (S.checking ? 'Checking the shop PC...' : S.online ? 'Connected to the shop PC' :
    'Shop PC offline' + (S.snap ? ' - using data from ' + esc(S.snap.at) : '')) +
    (waiting ? ' · ' + waiting + ' bill(s) waiting' : '') + (bad ? ' · ' + bad + ' need attention' : '');
}

// key: help key under papp.<screen>.*; value is ready HTML.
function tile(screen, key, label, value, sub, kind) {
  return '<div class="kpi ' + (kind || '') + `"><div class="kpi-label" data-help="papp.${screen}.${key}">` + esc(label) +
    '</div><div class="kpi-value">' + value + '</div>' + (sub ? '<div class="kpi-sub">' + esc(sub) + '</div>' : '') + '</div>';
}

function viewHome() {
  if (!S.snap) return empty('Waiting for the shop data - keep the shop PC on and this phone online once.');
  const b = S.snap.metrics;
  const q = queuedQty();
  const low = S.snap.items.filter((i) => i.reorder > 0 && stockOf(i, q) <= i.reorder).length;
  return (canBill() ? '<button type="button" class="btn btn-primary btn-block" data-go="bill">' + icon('plus') +
      'New bill</button>' : '') +
    '<p class="hint">Numbers as of ' + esc(S.snap.at) + '</p>' +
    '<div class="kpi-grid">' +
    tile('home', 'today_sales', 'Sales today', money(b.today_sales), b.today_bills + ' bill(s)') +
    tile('home', 'collected', 'Collected today', money(b.collected_today), '', 'pos') +
    tile('home', 'month_sales', 'Sales this month', money(b.month_sales), b.month_bills + ' bill(s)') +
    tile('home', 'receivable', 'To receive', money(b.receivable), b.overdue > 0 ? money(b.overdue) + ' overdue' : '',
      b.overdue > 0 ? 'neg' : '') +
    tile('home', 'stock_value', 'Stock value', money(b.stock_value)) +
    tile('home', 'low_stock', 'Low stock', low + ' item(s)', '', low ? 'warn' : '') + '</div>' +
    (b.top_due.length ? '<section class="card"><h2 class="card-title" data-help="papp.home.due">Owe the most</h2>' +
      b.top_due.map((p) => '<div class="list-row"><div class="grow"><div class="name">' + esc(p.name) +
      '</div><div class="sub">oldest ' + p.oldest_days + ' days</div></div><div class="amt">' + money(p.total) +
      '</div></div>').join('') + '</section>' : '');
}

// Bill editor
function newBill() {
  const incl = S.snap.settings.price_includes_tax !== '0';
  S.bill = {type: 'INVOICE', party: null, partyQ: '', walkName: '', walkPhone: '', lines: [], notes: '', received: '',
    method: 'CASH', includes: incl};
}

function billView() {
  const b = S.bill;
  let calc = null, err = '';
  try { if (b.lines.length) calc = compute(); } catch (e) { err = e.message; }
  const q = queuedQty();
  return '<div class="segmented" id="bType" role="group" aria-label="Bill type">' + ['INVOICE', 'ESTIMATE'].map((t) =>
      '<button type="button" class="btn btn-ghost' + (b.type === t ? ' on' : '') + '" data-type="' + t +
      '" aria-pressed="' + (b.type === t) + '">' + (t === 'INVOICE' ? 'Invoice' : 'Estimate') + '</button>').join('') + '</div>' +
    '<section class="card stack-sm"><h2 class="card-title" data-help="papp.bill.customer">Customer</h2>' + (b.party ?
      '<div class="list-row"><div class="grow"><div class="name">' + esc(b.party.name) + '</div><div class="sub">' +
        esc(b.party.phone || 'no phone saved') + '</div></div><button type="button" class="btn btn-secondary btn-sm" ' +
        'data-act="unparty">Change</button></div>' :
      '<input id="partyQ" type="search" placeholder="Search customer" aria-label="Search customer" autocomplete="off" ' +
        'data-help="papp.bill.party_search" value="' + esc(b.partyQ) + '"><div id="partyList"></div>' +
      '<div class="field-row"><input id="walkName" placeholder="Or type a name" aria-label="Customer name" ' +
        'data-help="papp.bill.walk_name" value="' + esc(b.walkName) + '"><input id="walkPhone" placeholder="WhatsApp no." ' +
        'inputmode="tel" aria-label="WhatsApp number" data-help="papp.bill.walk_phone" value="' + esc(b.walkPhone) + '"></div>') +
    '</section>' +
    '<section class="card stack-sm"><h2 class="card-title" data-help="papp.bill.items">Items</h2><div class="field-row">' +
      '<input id="itemQ" type="search" placeholder="Search item, SKU or barcode" aria-label="Search item" autocomplete="off" ' +
      'data-help="papp.bill.item_search">' + ('BarcodeDetector' in window ? '<button type="button" ' +
      'class="btn btn-secondary btn-icon" data-act="scan" aria-label="Scan barcode">' + icon('scan-barcode') + '</button>' : '') +
      '</div><div id="itemList"></div>' +
    (b.lines.length ? '<div class="list">' + b.lines.map((l, i) => {
      const item = S.snap.items.find((x) => x.sku === l.sku);
      const left = item ? stockOf(item, q) : 0;
      return '<div class="list-row"><div class="grow"><div class="name">' + esc(l.description) + '</div><div class="sub">' +
        esc(l.sku) + ' · ' + (left - l.qty < 0 ? pill('only ' + qtyText(left) + ' in stock', 'warn') : 'stock ' + qtyText(left)) +
        '</div><div class="qty"><button type="button" class="btn btn-secondary" data-dec="' + i + '" aria-label="One less">' +
        icon('minus') + '</button><input data-qty="' + i + '" inputmode="decimal" aria-label="Quantity" ' +
        'data-help="papp.bill.qty" value="' + qtyText(l.qty) + '"><button type="button" class="btn btn-secondary" data-inc="' +
        i + '" aria-label="One more">' + icon('plus') + '</button><input class="rate" data-rate="' + i +
        '" inputmode="decimal" aria-label="Rate" data-help="papp.bill.rate" value="' + l.rate + '"></div></div><div class="amt">' +
        (calc ? money(calc.lines[i].total) : '') + '<div><button type="button" class="btn btn-ghost btn-icon btn-sm" ' +
        'data-del="' + i + '" aria-label="Remove item">' + icon('trash-2') + '</button></div></div></div>';
    }).join('') + '</div>' : empty('No items yet.')) +
    (calc ? '<div class="hint">Taxable ' + money(calc.totals.taxable_total) +
      (calc.totals.igst ? ' · IGST ' + money(calc.totals.igst) : calc.totals.cgst ? ' · CGST+SGST ' +
        money(calc.totals.cgst + calc.totals.sgst) : '') + (calc.totals.round_off ? ' · round off ' +
        money(calc.totals.round_off) : '') + '</div>' : '') +
    (err ? '<div class="callout bad">' + esc(err) + '</div>' : '') + '</section>' +
    (b.type === 'INVOICE' ? '<section class="card stack-sm"><h2 class="card-title" data-help="papp.bill.received">Received now' +
      '</h2><div class="field-row"><input id="received" inputmode="decimal" placeholder="Amount" aria-label="Amount received" ' +
      'data-help="papp.bill.pay_amount" value="' + esc(b.received) + '"><select id="method" aria-label="Paid by" ' +
      'data-help="papp.bill.pay_method">' +
      Object.entries(S.snap.methods).map(([k, v]) => '<option value="' + esc(k) + '"' + (k === b.method ? ' selected' : '') +
        '>' + esc(v) + '</option>').join('') + '</select></div>' +
      (calc ? '<button type="button" class="btn btn-secondary btn-sm" data-act="full">Paid in full</button>' : '') +
      '</section>' : '') +
    '<section class="card"><div class="field"><label for="notes">Note on the bill</label><input id="notes" maxlength="300" ' +
      'data-help="papp.bill.notes" value="' + esc(b.notes) + '"></div></section>' +
    '<div class="m-bar"><div class="grow"><div class="xs muted">Total</div><div class="m-bar-total">' +
      money(calc ? calc.totals.total : 0) + '</div></div>' +
      '<button type="button" class="btn btn-primary" data-act="save">Save bill</button></div>';
}

function partyOf(b) {
  return b.party ? S.snap.customers.find((c) => c.id === b.party.id) || b.party : null;
}

function compute() {
  const b = S.bill;
  const party = partyOf(b);
  return computeBill({price_includes_tax: b.includes ? '1' : '0', party_gstin: party ? party.gstin : '',
    lines: b.lines.map((l) => ({sku: l.sku, description: l.description, qty: l.qty, rate: l.rate, gst_rate: l.gst_rate}))},
  S.snap.firm, party, {roundOff: S.snap.settings.round_off !== '0'});
}

function addItem(item) {
  const b = S.bill;
  const have = b.lines.find((l) => l.sku === item.sku);
  if (have) have.qty += 1;
  else {
    // Item prices are kept with GST included; a bill without GST in its rates takes it out.
    const rate = b.includes ? item.price : Math.round(item.price * 100 / (100 + (item.gst || 0)) * 100) / 100;
    b.lines.push({sku: item.sku, description: item.name, hsn: item.hsn, uom: item.uom, qty: 1, rate, gst_rate: item.gst || 0});
  }
  render();
}

function findItems(text) {
  const t = text.trim().toLowerCase();
  if (!t) return [];
  return S.snap.items.filter((i) => i.name.toLowerCase().includes(t) || i.sku.toLowerCase().includes(t) ||
    (i.ean && i.ean === t)).slice(0, 25);
}

async function scan() {
  let stream;
  const box = sheet('Point at the barcode', '<video class="scan" id="cam" playsinline muted></video>');
  const stop = () => { if (stream) stream.getTracks().forEach((t) => t.stop()); box.close(); };
  box.el.querySelector('[data-close]').addEventListener('click', stop);
  try {
    stream = await navigator.mediaDevices.getUserMedia({video: {facingMode: 'environment'}});
    const video = box.body.querySelector('#cam');
    video.srcObject = stream;
    await video.play();
    const detector = new BarcodeDetector();
    while (document.body.contains(box.el)) {
      const found = await detector.detect(video).catch(() => []);
      if (found.length) {
        stop();
        const code = found[0].rawValue;
        const item = S.snap.items.find((i) => i.ean === code || i.sku === code);
        if (item) addItem(item); else toast('No item has barcode ' + code, 'err');
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    stop();
  } catch (e) { stop(); toast('Camera not available: ' + e.message, 'err'); }
}

function billLabel(type, taxType) {
  if (type === 'ESTIMATE') return 'Estimate';
  return taxType === 'NONE' ? 'Bill of Supply' : 'Tax Invoice';
}

async function saveBill() {
  const b = S.bill;
  let calc;
  try { calc = compute(); } catch (e) { toast(e.message, 'err'); return; }
  const party = partyOf(b);
  const received = b.type === 'INVOICE' ? Math.max(0, Math.min(Number(b.received || 0), calc.totals.total)) : 0;
  const series = S.snap.series[b.type];
  const used = ((await kv.get('usedNos')) || []);
  const date = today();
  const docNo = nextDocNo(series.prefix, date, series.next, used, Number(S.snap.settings.series_digits || 4));
  // A search that found nobody still names the bill, rather than saving a "Cash Sale".
  const q = (b.partyQ || '').trim();
  const qIsPhone = /^[+\d][\d\s-]{6,}$/.test(q);
  const payload = {
    uuid: uuid(), doc_type: b.type, doc_no: docNo, doc_date: date,
    party_id: party ? party.id : null,
    party_name: party ? party.name : (b.walkName.trim() || (qIsPhone ? '' : q) || 'Cash Sale'),
    party_phone: party ? party.phone : (b.walkPhone.trim() || (qIsPhone ? q : '')),
    party_gstin: party ? party.gstin : '',
    party_address: party ? party.address : '', price_includes_tax: b.includes ? '1' : '0',
    lines: b.lines.map((l) => ({sku: l.sku, description: l.description, qty: l.qty, rate: l.rate, gst_rate: l.gst_rate})),
    notes: b.notes, received, method: b.method, total: calc.totals.total,
  };
  const entry = {uuid: payload.uuid, created: new Date().toISOString(), state: 'waiting', payload,
    view: {label: billLabel(b.type, calc.taxType), taxType: calc.taxType, placeOfSupply: calc.placeOfSupply,
      lines: calc.lines, totals: calc.totals, terms: S.snap.settings.invoice_terms}};
  await outbox.put(entry);
  await kv.set('usedNos', used.concat(docNo).slice(-500));
  S.out = await outbox.all();
  S.bill = null;
  S.view = 'done';
  S.done = entry;
  render();
  if (S.conn.token) refresh(true);
}

// Sharing a bill made on this phone
function pdfFile(entry) {
  const p = entry.payload, v = entry.view;
  const bill = Object.assign({}, p, v, {received: p.received});
  return new File([billPdf(bill, S.snap.firm)], billFileName(bill), {type: 'application/pdf'});
}

function shareText(entry) {
  const p = entry.payload, v = entry.view, f = S.snap.firm;
  const due = v.totals.total - (p.received || 0);
  const lines = ['Dear ' + (p.party_name || 'Customer') + ',', '',
    v.label + ' ' + p.doc_no + ' dated ' + p.doc_date + ' for ' + money(v.totals.total) + ' from ' +
    (f.trade_name || f.display_name) + '.'];
  if (p.doc_type === 'INVOICE') {
    if (due > 0.005) {
      lines.push('Amount due: ' + money(due) + '.');
      if (f.upi_vpa) {
        lines.push('Pay by UPI: upi://pay?pa=' + encodeURIComponent(f.upi_vpa) + '&pn=' +
          encodeURIComponent(f.upi_name || f.trade_name || '') + '&am=' + due.toFixed(2) + '&cu=INR&tn=' +
          encodeURIComponent(p.doc_no));
      }
    } else lines.push('Fully paid - thank you!');
  }
  lines.push('');
  v.lines.slice(0, 10).forEach((l) => lines.push('- ' + (l.description || l.sku) + ' x ' + qtyText(l.qty) + ' = ' +
    money(l.total)));
  if (f.footer) lines.push('', f.footer);
  return lines.join('\n');
}

function waLink(phone, text) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10) d = '91' + d;
  else if (d.length === 11 && d[0] === '0') d = '91' + d.slice(1);
  if (d.length < 11 || d.length > 15) d = '';
  return 'https://wa.me/' + d + '?text=' + encodeURIComponent(text);
}

async function shareFile(file, text) {
  if (navigator.canShare && navigator.canShare({files: [file]})) {
    try { await navigator.share({files: [file], title: file.name, text}); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  toast('PDF saved to Downloads - attach it in WhatsApp.', 'info');
}

function shareHtml(extra) {
  return '<div class="stack-sm mt-3"><button type="button" class="btn btn-secondary btn-wa btn-block" data-s="pdf">' +
    icon('send') + 'Send PDF on WhatsApp</button><div class="cluster">' +
    '<a class="btn btn-secondary" target="_blank" rel="noopener" data-s="text">Text on WhatsApp</a>' + (extra || '') +
    '</div></div>';
}

function localBillSheet(entry) {
  const p = entry.payload, v = entry.view;
  const state = entry.state === 'synced' ? pill('On the PC', 'ok') : entry.state === 'rejected' ?
    pill('Not accepted', 'bad') : pill('Waiting for the PC', 'warn');
  const box = sheet(v.label + ' ' + p.doc_no, '<div class="muted small">' + esc(p.party_name) +
    ' · ' + esc(Fmt.date(p.doc_date)) + ' · ' + state + '</div>' +
    (entry.message ? '<div class="callout bad mt-2">' + esc(entry.message) + '</div>' : '') +
    (entry.result && entry.result.warnings && entry.result.warnings.length ? '<div class="callout warn mt-2">' +
      entry.result.warnings.map(esc).join('<br>') + '</div>' : '') +
    '<div class="list mt-2">' + v.lines.map((l) => '<div class="list-row"><div class="grow"><div class="name">' +
      esc(l.description || l.sku) + '</div><div class="sub">' + qtyText(l.qty) + ' × ' + money(l.rate) +
      '</div></div><div class="amt">' + money(l.total) + '</div></div>').join('') + '</div>' +
    '<div class="total-row"><span>Total</span><span>' + money(v.totals.total) + '</span></div>' +
    shareHtml(entry.state === 'rejected' ? '<button type="button" class="btn btn-danger" data-s="del">Delete</button>' : ''));
  const text = shareText(entry);
  box.body.querySelector('[data-s="text"]').href = waLink(p.party_phone, text);
  box.body.querySelector('[data-s="pdf"]').onclick = () => shareFile(pdfFile(entry), text);
  const del = box.body.querySelector('[data-s="del"]');
  if (del) del.onclick = async () => {
    if (!await window.UI.confirm('Delete this bill from the phone? It never reached the PC.',
      {ok: 'Delete bill', danger: true})) return;
    await outbox.del(entry.uuid);
    S.out = await outbox.all();
    box.close();
    render();
  };
}

async function pcBillSheet(bill) {
  const box = sheet(bill.label + ' ' + bill.doc_no, '<div class="muted small">' + esc(bill.party_name) +
    ' · ' + esc(Fmt.date(bill.doc_date)) + ' · ' + money(bill.total) + '</div><div id="pcb">' +
    window.UI.skeleton('rows', 2) + '</div>');
  const body = box.body.querySelector('#pcb');
  try {
    const [pdf, info] = await Promise.all([pc('/api/billing/pdf/' + bill.id, {raw: true}), pc('/api/billing/share?id=' + bill.id)]);
    const file = new File([await pdf.blob()], bill.doc_no.replace(/[^A-Za-z0-9-]+/g, '-') + '.pdf', {type: 'application/pdf'});
    body.innerHTML = shareHtml() +
      (bill.balance > 0 && canBill() ? '<section class="card mt-3 stack-sm"><h2 class="card-title" ' +
        'data-help="papp.bills.receive">Receive payment</h2><div class="field-row">' +
        '<input id="payAmt" inputmode="decimal" aria-label="Amount received" data-help="papp.bills.pay_amount" value="' +
        bill.balance + '"><select id="payMethod" aria-label="Paid by" data-help="papp.bills.pay_method">' +
        Object.entries(S.snap.methods).map(([k, v]) => '<option value="' + esc(k) + '">' + esc(v) + '</option>').join('') +
        '</select></div><button type="button" class="btn btn-primary btn-block" id="paySave">Save payment</button></section>' : '');
    body.querySelector('[data-s="text"]').href = info.whatsapp;
    body.querySelector('[data-s="pdf"]').onclick = () => shareFile(file, info.text);
    const pay = body.querySelector('#paySave');
    if (pay) pay.onclick = async () => {
      const amt = Number(body.querySelector('#payAmt').value || 0);
      if (!(amt > 0)) { toast('Enter the amount.', 'err'); return; }
      pay.classList.add('is-loading');
      try {
        await pc('/api/payments/save', {method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({direction: 'IN', party_kind: 'customer', party_id: bill.party_id || '',
            party_name: bill.party_name, amount: amt,
            method: body.querySelector('#payMethod').value,
            allocations: [{doc_kind: 'sale', doc_id: bill.id, amount: Math.min(amt, bill.balance)}]})});
        toast('Payment saved.');
        box.close();
        refresh(true);
      } catch (e) { toast(e.message, 'err'); pay.classList.remove('is-loading'); }
    };
  } catch (e) {
    body.innerHTML = empty(e instanceof Offline ? 'Available when the shop PC is on.' : e.message);
  }
}

function viewBills() {
  const row = (key, name, sub, amt, p) => '<div class="list-row is-click" ' + key + '><div class="grow"><div class="name">' +
    esc(name) + '</div><div class="sub">' + esc(sub) + '</div></div><div class="amt">' + money(amt) + '<div>' + p +
    '</div></div></div>';
  const card = (key, title, body) => `<section class="card"><h2 class="card-title" data-help="papp.bills.${key}">` +
    esc(title) + '</h2>' + body + '</section>';
  const bad = S.out.filter((b) => b.state === 'rejected');
  const waiting = S.out.filter((b) => b.state !== 'rejected');
  const localNos = new Set(S.synced.map((b) => b.payload.doc_no));
  let html = '';
  if (bad.length) html += card('rejected', 'Not accepted by the PC', bad.map((b) => row('data-local="' + b.uuid + '"',
    b.payload.party_name, b.payload.doc_no + ' · ' + b.message, b.view.totals.total, pill('Fix', 'bad'))).join(''));
  if (waiting.length) html += card('waiting', 'Waiting to reach the PC', waiting.map((b) =>
    row('data-local="' + b.uuid + '"', b.payload.party_name, b.payload.doc_no + ' · ' + Fmt.date(b.payload.doc_date),
      b.view.totals.total, pill('Waiting', 'warn'))).join(''));
  if (S.synced.length) html += card('synced', 'Made on this phone', S.synced.slice(0, 20).map((b) =>
    row('data-local="' + b.uuid + '"', b.payload.party_name, b.payload.doc_no + ' · ' + Fmt.date(b.payload.doc_date),
      b.view.totals.total, pill('On PC', 'ok'))).join(''));
  const pcBills = (S.snap ? S.snap.bills : []).filter((b) => !localNos.has(b.doc_no));
  html += card('pc', 'Recent bills on the PC', pcBills.length ? pcBills.map((b) =>
    row('data-pcbill="' + b.id + '"', b.party_name, b.doc_no + ' · ' + Fmt.date(b.doc_date), b.total,
      pill(b.pay_status, {PAID: 'ok', OVERDUE: 'bad', UNPAID: 'warn', PARTIAL: 'warn'}[b.pay_status] || ''))).join('') :
    empty('None yet.'));
  return html;
}

function viewStock() {
  const q = queuedQty();
  const t = (S.stockQ || '').trim().toLowerCase();
  let items = S.snap ? S.snap.items : [];
  if (S.stockLow) items = items.filter((i) => i.reorder > 0 && stockOf(i, q) <= i.reorder);
  if (t) items = items.filter((i) => i.name.toLowerCase().includes(t) || i.sku.toLowerCase().includes(t) || i.ean === t);
  const badge = (i) => {
    const s = stockOf(i, q);
    return s <= 0 ? pill(s < 0 ? qtyText(s) : 'Out', 'bad') : i.reorder > 0 && s <= i.reorder ?
      pill(qtyText(s) + ' ' + i.uom, 'warn') : pill(qtyText(s) + ' ' + i.uom, 'ok');
  };
  const seg = (v, label) => '<button type="button" class="btn btn-ghost' + ((S.stockLow ? '1' : '0') === v ? ' on' : '') +
    '" data-low="' + v + '" aria-pressed="' + ((S.stockLow ? '1' : '0') === v) + '">' + label + '</button>';
  return '<div class="segmented" role="group" aria-label="Show">' + seg('0', 'All items') + seg('1', 'Low stock') + '</div>' +
    '<input id="stockQ" type="search" placeholder="Search name, SKU or barcode" aria-label="Search items" ' +
    'data-help="papp.stock.search" value="' + esc(S.stockQ || '') + '">' +
    '<section class="card card-flush">' + (items.length ? items.slice(0, 200).map((i) =>
      '<div class="list-row is-click" data-item="' + esc(i.sku) + '"><div class="grow"><div class="name">' + esc(i.name) +
      '</div><div class="sub">' + esc(i.sku) + (i.price ? ' · ' + money(i.price) : '') + '</div></div><div class="amt">' +
      badge(i) + '</div></div>').join('') : empty('No items.')) + '</section>' +
    (S.snap ? '<p class="hint center">Stock as of ' + esc(S.snap.at) + (Object.keys(q).length ?
      ', less bills waiting on this phone' : '') + '</p>' : '');
}

async function itemSheet(sku) {
  const i = S.snap.items.find((x) => x.sku === sku);
  if (!i) return;
  const q = queuedQty();
  const box = sheet(i.name, '<div class="stack"><div id="pic"></div><div class="muted small">' + esc(i.sku) +
    (i.ean ? ' · ' + esc(i.ean) : '') + (i.cat ? ' · ' + esc(i.cat) : '') + '</div><div class="kpi-grid">' +
    tile('stock', 'in_stock', 'In stock', qtyText(stockOf(i, q)) + ' ' + esc(i.uom)) +
    tile('stock', 'reorder', 'Reorder at', qtyText(i.reorder)) +
    tile('stock', 'price', 'Sale price', money(i.price), i.mrp ? 'MRP ' + money(i.mrp) : '') +
    tile('stock', 'gst', 'GST', Fmt.pct(i.gst || 0, 0), 'HSN ' + (i.hsn || '-')) + '</div>' +
    (canBill() ? '<button type="button" class="btn btn-primary btn-block" data-s="bill">Add to a new bill</button>' : '') +
    '</div>');
  const toBill = box.body.querySelector('[data-s="bill"]');
  if (toBill) toBill.onclick = () => { box.close(); if (!S.bill) newBill(); S.view = 'bill'; addItem(i); };
  if (i.pic && S.online) {
    try {
      const res = await pc('/api/items/picture/' + encodeURIComponent(i.pic), {raw: true});
      const url = URL.createObjectURL(await res.blob());
      box.body.querySelector('#pic').innerHTML = '<img class="pic-lg" src="' + url + '" alt="">';
    } catch (e) { /* picture only when the PC is on */ }
  }
}

function viewDone() {
  const e = S.done;
  return '<section class="card center stack"><div><span class="done-mark">' + icon('check') + '</span></div>' +
    '<h3>' + esc(e.view.label) + ' ' + esc(e.payload.doc_no) + '</h3><div class="muted">' + esc(e.payload.party_name) +
    ' · ' + money(e.view.totals.total) +
    (e.payload.received ? ' · ' + money(e.payload.received) + ' received' : '') + '</div>' +
    '<div class="hint">' + (S.online ? 'Sending to the shop PC...' :
      'Saved on this phone - it goes to the PC when the PC is on.') + '</div>' +
    '<button type="button" class="btn btn-secondary btn-wa btn-block" data-act="sharepdf">' + icon('send') +
      'Send PDF on WhatsApp</button>' +
    '<a class="btn btn-secondary btn-block" id="doneText" target="_blank" rel="noopener">Text on WhatsApp</a>' +
    '<button type="button" class="btn btn-secondary btn-block" data-go="bill">Make another bill</button></section>';
}

function viewSettings() {
  const c = S.conn || {};
  const p = window.UI.prefs.get();
  const line = (label, value, cls) => '<div class="list-row"><div class="grow">' + label + '</div><div class="amt' +
    (cls ? ' ' + cls : '') + '">' + value + '</div></div>';
  const theme = (v, label) => '<button type="button" class="btn btn-ghost' + (p.theme === v ? ' on' : '') +
    '" data-theme-set="' + v + '" aria-pressed="' + (p.theme === v) + '">' + label + '</button>';
  return '<section class="card"><h2 class="card-title" data-help="papp.settings.phone">This phone</h2>' +
    line('Signed in as', esc(c.user ? c.user.name + ' (' + c.user.role + ')' : '-')) +
    line('Bill series', esc(c.device ? c.device.prefix + '/...' : '-')) +
    line('Shop PC link', esc(c.pc || '-'), 'small papp-link') +
    line('Finds a new link by itself', c.topic ? 'Yes' : 'No - rescan the QR') + '</section>' +
    '<div class="stack-sm"><button type="button" class="btn btn-secondary btn-block" data-act="check">' + icon('refresh-cw') +
      'Check the shop PC now</button>' +
    '<button type="button" class="btn btn-secondary btn-block" data-act="relocate">' + icon('search') +
      'Find the shop PC again</button></div>' +
    '<p class="hint">If the shop PC was restarted and the phone cannot find it, open ' +
    'Settings &gt; Phone access on the PC and scan its QR code again - nothing on this phone is lost.</p>' +
    '<section class="card stack-sm"><h2 class="card-title" data-help="papp.settings.display">Display</h2>' +
    '<div class="segmented" role="group" aria-label="Theme">' + theme('auto', 'Auto') + theme('light', 'Light') +
      theme('dark', 'Dark') + '</div>' +
    '<label class="switch"><input type="checkbox" id="setTips" data-help="papp.settings.tips"' + (p.help_tips ? ' checked' : '') +
    '><span class="switch-track"></span><span class="grow">Show (i) help tips</span></label>' +
    '<label class="switch"><input type="checkbox" id="setMotion" data-help="papp.settings.motion"' + (p.motion ? ' checked' : '') +
    '><span class="switch-track"></span><span class="grow">Animations</span></label></section>' +
    '<button type="button" class="btn btn-danger btn-block" data-act="unpair">Unpair this phone</button>';
}

// The bottom tab bar (P3): one list, tabs the role cannot use are hidden.
const PHONE_NAV = [
  {go: 'home', label: 'Home', icon: 'house'},
  {go: 'bill', label: 'Bill', icon: 'plus', bill: true},
  {go: 'bills', label: 'Bills', icon: 'receipt'},
  {go: 'stock', label: 'Stock', icon: 'package'},
];

function render() {
  if (!S.conn || !S.conn.token) S.view = 'pair';
  const titles = {pair: 'Pair phone', home: S.snap ? (S.snap.firm.trade_name || S.snap.firm.display_name) : 'Shop',
    bill: 'New bill', bills: 'Bills', stock: 'Stock', done: 'Bill saved', settings: 'This phone'};
  $('title').textContent = titles[S.view] || 'Shop';
  $('who').textContent = S.view !== 'home' && S.snap ? (S.snap.firm.trade_name || S.snap.firm.display_name) : '';
  $('gear').hidden = S.view === 'pair';
  if (S.view === 'bill' && (!S.snap || !canBill())) S.view = 'home';
  if (S.view === 'bill' && !S.bill) newBill();
  const views = {pair: viewPair, home: viewHome, bill: billView, bills: viewBills, stock: viewStock, done: viewDone,
    settings: viewSettings};
  $('main').innerHTML = views[S.view]();
  $('tabs').hidden = S.view === 'pair';
  $('tabs').innerHTML = S.view === 'pair' ? '' : PHONE_NAV.filter((t) => !t.bill || canBill()).map((t) =>
    '<button type="button" class="m-tab tab' + (t.go === S.view ? ' active" aria-current="page' : '') + '" data-go="' + t.go +
    '">' + icon(t.icon) + '<span>' + t.label + '</span></button>').join('');
  document.body.classList.toggle('m-bare', S.view === 'pair');
  drawStatus();
  if (S.view === 'pair' && $('pairForm')) $('pairForm').onsubmit = pair;
  if (S.view === 'done') $('doneText').href = waLink(S.done.payload.party_phone, shareText(S.done));
  if (S.view === 'bill') wireBill();
  if (S.view === 'stock') {
    $('stockQ').oninput = debounce(() => { S.stockQ = $('stockQ').value; render(); $('stockQ').focus(); }, 250);
  }
  if (S.view === 'settings') wireSettings();
}

function wireSettings() {
  document.querySelectorAll('[data-theme-set]').forEach((b) => b.addEventListener('click', () => {
    window.UI.prefs.set({theme: b.dataset.themeSet});
    render();
  }));
  $('setTips').onchange = (e) => window.UI.prefs.set({help_tips: e.target.checked});
  $('setMotion').onchange = (e) => window.UI.prefs.set({motion: e.target.checked});
}

function wireBill() {
  const b = S.bill;
  const partyQ = $('partyQ');
  if (partyQ) {
    partyQ.oninput = debounce(() => {
      b.partyQ = partyQ.value;
      const t = partyQ.value.trim().toLowerCase();
      const hits = t ? S.snap.customers.filter((c) =>
        c.name.toLowerCase().includes(t) || (c.phone || '').includes(t)).slice(0, 15) : [];
      $('partyList').innerHTML = !t ? '' : hits.length ? '<div class="list-pop">' + hits.map((c) =>
        '<div class="list-row is-click" data-party="' + c.id + '"><div class="grow"><div class="name">' + esc(c.name) +
        '</div><div class="sub">' + esc(c.phone) + '</div></div>' + (c.balance > 0 ? '<div class="amt small">' +
        money(c.balance) + ' due</div>' : '') + '</div>').join('') + '</div>' :
        '<div class="hint">No match - the bill will be made out to "' + esc(partyQ.value.trim()) + '".</div>';
    }, 200);
    $('walkName').oninput = () => { b.walkName = $('walkName').value; };
    $('walkPhone').oninput = () => { b.walkPhone = $('walkPhone').value; };
  }
  $('itemQ').oninput = debounce(() => {
    const found = findItems($('itemQ').value);
    const q = queuedQty();
    $('itemList').innerHTML = found.length ? '<div class="list-pop">' + found.map((i) => '<div class="list-row is-click" ' +
      'data-add="' + esc(i.sku) + '"><div class="grow"><div class="name">' + esc(i.name) + '</div><div class="sub">' +
      esc(i.sku) + '</div></div><div class="amt">' + money(i.price) + '<div class="sub">stock ' + qtyText(stockOf(i, q)) +
      '</div></div></div>').join('') + '</div>' : ($('itemQ').value ? empty('No item matches.') : '');
  }, 200);
  const keep = (id, key) => { const el = $(id); if (el) el.oninput = () => { b[key] = el.value; }; };
  keep('received', 'received');
  keep('notes', 'notes');
  if ($('method')) $('method').onchange = () => { b.method = $('method').value; };
}

// One click handler for everything
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-go],[data-act],[data-type],[data-party],[data-add],[data-inc],[data-dec],[data-del],' +
    '[data-local],[data-pcbill],[data-item],[data-low]');
  if (!t) return;
  const b = S.bill;
  if (t.dataset.go) { S.view = t.dataset.go; if (S.view === 'bill' && !S.bill) newBill(); render(); window.scrollTo(0, 0); return; }
  if (t.dataset.type) { b.type = t.dataset.type; render(); return; }
  if (t.dataset.party) {
    b.party = S.snap.customers.find((c) => String(c.id) === t.dataset.party);
    b.partyQ = '';
    render();
    return;
  }
  if (t.dataset.add) { addItem(S.snap.items.find((i) => i.sku === t.dataset.add)); return; }
  if (t.dataset.inc) { b.lines[t.dataset.inc].qty += 1; render(); return; }
  if (t.dataset.dec) { const l = b.lines[t.dataset.dec]; l.qty = Math.max(1, l.qty - 1); render(); return; }
  if (t.dataset.del) { b.lines.splice(Number(t.dataset.del), 1); render(); return; }
  if (t.dataset.local) {
    const entry = S.out.find((x) => x.uuid === t.dataset.local) || S.synced.find((x) => x.uuid === t.dataset.local);
    if (entry) localBillSheet(entry);
    return;
  }
  if (t.dataset.pcbill) { pcBillSheet(S.snap.bills.find((x) => String(x.id) === t.dataset.pcbill)); return; }
  if (t.dataset.item) { itemSheet(t.dataset.item); return; }
  if (t.dataset.low) { S.stockLow = t.dataset.low === '1'; render(); return; }
  switch (t.dataset.act) {
    case 'unparty': b.party = null; render(); break;
    case 'scan': scan(); break;
    case 'full': try { b.received = String(compute().totals.total); render(); } catch (err) { /* no items */ } break;
    case 'save': saveBill(); break;
    case 'sharepdf': shareFile(pdfFile(S.done), shareText(S.done)); break;
    case 'check': refresh(); break;
    case 'relocate':
      toast((await relocate()) ? 'Found the shop PC at its new link.' : 'No new link found - scan the QR code on the PC.',
        'info');
      refresh(true);
      break;
    case 'unpair': {
      const msg = S.out.length ? S.out.length + ' bill(s) have not reached the PC yet. They stay on this phone ' +
        'and go when you pair again. Unpair?' : 'Unpair this phone?';
      if (!await window.UI.confirm(msg, {ok: 'Unpair phone', danger: true})) break;
      S.conn.token = null;
      await kv.set('conn', S.conn);
      render();
      break;
    }
    default: break;
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (!S.bill) return;
  const v = Number(t.value);
  if (t.dataset.qty && v > 0) { S.bill.lines[t.dataset.qty].qty = v; render(); }
  if (t.dataset.rate && v >= 0) { S.bill.lines[t.dataset.rate].rate = v; render(); }
});

$('gear').innerHTML = icon('settings');
$('gear').onclick = () => { S.view = 'settings'; render(); };

(async () => {
  S.conn = (await kv.get('conn')) || null;
  await readPairLink();
  // Opened straight from the PC (/app/) with nothing paired yet: that PC is the one.
  if ((!S.conn || !S.conn.pc) && /\/app\/?$/.test(location.pathname)) {
    S.conn = Object.assign({}, S.conn || {}, {pc: location.origin});
  }
  S.snap = (await kv.get('snap')) || null;
  S.synced = (await kv.get('synced')) || [];
  S.out = await outbox.all();
  S.view = S.conn && S.conn.token ? 'home' : 'pair';
  render();
  refresh(true);
  setInterval(() => { if (document.visibilityState === 'visible') refresh(true); }, 60000);
  window.addEventListener('online', () => refresh(true));
  window.addEventListener('offline', () => { S.online = false; drawStatus(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(true); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
