// A bill as a PDF, made on the phone with no internet and no library - so it can be
// shared into WhatsApp while the shop PC is off. Same content as app/invoice_pdf.py,
// simpler layout. Standard PDF fonts cannot print the rupee sign, so amounts say "Rs.".

const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556,
  556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667,
  556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556,
  500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
  500, 334, 260, 334, 584];
const HELV_B = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556,
  556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722,
  611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611,
  556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556,
  500, 389, 280, 389, 584];

const W = 595, H = 842, M = 36;

function clean(text) {
  return String(text == null ? '' : text).replace(/₹/g, 'Rs.').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-').replace(/[^\x20-\x7e]/g, '?');
}
function width(text, size, bold) {
  const t = bold ? HELV_B : HELV;
  let w = 0;
  for (const ch of clean(text)) w += t[ch.charCodeAt(0) - 32] || 556;
  return w * size / 1000;
}
function fit(text, size, bold, max) {
  let t = clean(text);
  if (width(t, size, bold) <= max) return t;
  while (t && width(t + '...', size, bold) > max) t = t.slice(0, -1);
  return t + '...';
}
function wrap(text, size, bold, max) {
  const out = [];
  for (const para of clean(text).split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const next = line ? line + ' ' + word : word;
      if (width(next, size, bold) <= max || !line) line = next;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}
const esc = (t) => clean(t).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

export function money(v) {
  const n = Number(v || 0);
  const s = Math.abs(n).toFixed(2).split('.');
  let whole = s[0];
  if (whole.length > 3) {
    let head = whole.slice(0, -3);
    const groups = [];
    while (head.length > 2) { groups.unshift(head.slice(-2)); head = head.slice(0, -2); }
    if (head) groups.unshift(head);
    whole = groups.join(',') + ',' + whole.slice(-3);
  }
  return (n < 0 ? '-' : '') + 'Rs.' + whole + '.' + s[1];
}

// billing.amount_in_words
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const two = (n) => n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
const three = (n) => [Math.floor(n / 100) ? ONES[Math.floor(n / 100)] + ' Hundred' : '', n % 100 ? two(n % 100) : '']
  .filter(Boolean).join(' ');
function words(n) {
  if (n === 0) return 'Zero';
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const thousand = Math.floor(n / 1000); n %= 1000;
  return [crore ? words(crore) + ' Crore' : '', lakh ? two(lakh) + ' Lakh' : '',
    thousand ? two(thousand) + ' Thousand' : '', n ? three(n) : ''].filter(Boolean).join(' ');
}
export function amountInWords(amount) {
  const v = Math.round(Math.abs(Number(amount || 0)) * 100);
  const rupees = Math.floor(v / 100), paise = v % 100;
  return 'Rupees ' + words(rupees) + (paise ? ' and ' + two(paise) + ' Paise' : '') + ' Only';
}

class Doc {
  constructor() { this.pages = []; this.newPage(); }
  newPage() { this.ops = []; this.pages.push(this.ops); this.y = H - M; }
  text(x, y, t, size = 9, bold = false, align = 'left') {
    if (align === 'right') x -= width(t, size, bold);
    if (align === 'center') x -= width(t, size, bold) / 2;
    this.ops.push('BT /' + (bold ? 'F2' : 'F1') + ' ' + size + ' Tf ' + x.toFixed(2) + ' ' + y.toFixed(2) +
      ' Td (' + esc(t) + ') Tj ET');
  }
  line(x1, y1, x2, y2, w = 0.5) { this.ops.push(w + ' w 0.75 G ' + x1 + ' ' + y1 + ' m ' + x2 + ' ' + y2 + ' l S 0 G'); }
  box(x, y, w, h, grey = 0.93) { this.ops.push(grey + ' g ' + x + ' ' + y + ' ' + w + ' ' + h + ' re f 0 g'); }
  need(h) { if (this.y - h < M + 20) { this.newPage(); return true; } return false; }
  bytes(title) {
    const objs = [];
    const add = (s) => { objs.push(s); return objs.length; };
    add('<< /Type /Catalog /Pages 2 0 R >>');
    add('');                                                    // pages, filled below
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids = [];
    this.pages.forEach((ops, i) => {
      ops.push('BT /F1 7 Tf ' + (W - M) + ' 20 Td (' + esc('Page ' + (i + 1) + ' of ' + this.pages.length) + ') Tj ET');
      const stream = ops.join('\n');
      const content = add('<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream');
      kids.push(add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + W + ' ' + H + '] /Contents ' + content +
        ' 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>'));
    });
    objs[1] = '<< /Type /Pages /Kids [' + kids.map((k) => k + ' 0 R').join(' ') + '] /Count ' + kids.length + ' >>';
    const info = add('<< /Title (' + esc(title) + ') /Producer (JP No Profit Loss phone) >>');
    let out = '%PDF-1.4\n';
    const offsets = [];
    objs.forEach((o, i) => { offsets.push(out.length); out += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
    const xref = out.length;
    out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' +
      offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('') +
      'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R /Info ' + info + ' 0 R >>\nstartxref\n' + xref + '\n%%EOF';
    return Uint8Array.from(out, (c) => c.charCodeAt(0) & 255);
  }
}

// bill: {label, doc_no, doc_date, party_name, party_phone, party_gstin, party_address, lines[{description, sku, hsn,
//   qty, uom, rate, discount_amount, gst_rate, taxable, total}], totals{...}, taxType, placeOfSupply, notes, terms,
//   received, balance}; firm: snapshot.firm
export function billPdf(bill, firm) {
  const d = new Doc();
  const right = W - M;
  d.text(W / 2, d.y, bill.label, 14, true, 'center');
  d.y -= 24;
  const top = d.y;
  d.text(M, d.y, firm.display_name || firm.trade_name || '', 12, true);
  d.y -= 14;
  for (const l of [firm.trade_name !== firm.display_name ? firm.trade_name : '', firm.address,
    [firm.phone, firm.email].filter(Boolean).join(' . '), firm.gstin ? 'GSTIN: ' + firm.gstin : '']) {
    for (const w of wrap(l || '', 8.5, false, 300).filter(Boolean)) { d.text(M, d.y, w, 8.5); d.y -= 11; }
  }
  let ry = top;
  const info = [['No.', bill.doc_no], ['Date', bill.doc_date]];
  if (bill.placeOfSupply) info.push(['Place of supply', bill.placeOfSupply]);
  for (const [k, v] of info) { d.text(right - 150, ry, k, 8); d.text(right, ry, v, 9, true, 'right'); ry -= 12; }
  d.y = Math.min(d.y, ry) - 6;
  d.line(M, d.y, right, d.y);
  d.y -= 14;
  d.text(M, d.y, 'Bill to', 7.5);
  d.y -= 12;
  d.text(M, d.y, bill.party_name || 'Cash Sale', 10, true);
  d.y -= 12;
  for (const l of [bill.party_address, [bill.party_phone, bill.party_gstin ? 'GSTIN: ' + bill.party_gstin : '']
    .filter(Boolean).join(' . ')]) {
    for (const w of wrap(l || '', 8.5, false, 400).filter(Boolean)) { d.text(M, d.y, w, 8.5); d.y -= 11; }
  }
  d.y -= 8;

  const taxed = bill.taxType !== 'NONE';
  const cols = taxed ? [[M, '#', 'left'], [M + 18, 'Item', 'left'], [355, 'Qty', 'right'], [420, 'Rate', 'right'],
    [465, 'GST', 'right'], [right, 'Amount', 'right']] :
    [[M, '#', 'left'], [M + 18, 'Item', 'left'], [380, 'Qty', 'right'], [460, 'Rate', 'right'], [right, 'Amount', 'right']];
  const header = () => {
    d.box(M, d.y - 4, right - M, 15);
    cols.forEach(([x, t, a]) => d.text(x, d.y, t, 8.5, true, a));
    d.y -= 16;
  };
  header();
  bill.lines.forEach((l, i) => {
    const name = wrap(l.description || l.sku, 8.5, false, (taxed ? 300 : 320) - M - 18);
    const sub = [l.sku, l.hsn ? 'HSN ' + l.hsn : ''].filter(Boolean).join(' . ');
    if (d.need(12 * name.length + 14)) header();
    d.text(M, d.y, String(i + 1), 8.5);
    name.forEach((t, j) => d.text(M + 18, d.y - j * 11, t, 8.5));
    const qty = String(Math.round(l.qty * 1000) / 1000) + ' ' + (l.uom || '');
    const vals = taxed ? [qty, money(l.rate), l.gst_rate + '%', money(l.total)] : [qty, money(l.rate), money(l.total)];
    vals.forEach((v, j) => d.text(cols[j + 2][0], d.y, v, 8.5, false, 'right'));
    d.y -= 11 * name.length;
    if (sub) { d.text(M + 18, d.y, sub, 7, false); d.y -= 9; }
    if (l.discount_amount) { d.text(M + 18, d.y, 'Discount ' + money(l.discount_amount), 7); d.y -= 9; }
    d.line(M, d.y + 3, right, d.y + 3, 0.3);
    d.y -= 6;
  });

  const t = bill.totals;
  const rows = [['Taxable value', t.taxable_total]];
  if (t.cgst) rows.push(['CGST', t.cgst]);
  if (t.sgst) rows.push(['SGST', t.sgst]);
  if (t.igst) rows.push(['IGST', t.igst]);
  if (t.other_charges) rows.push([bill.other_label || 'Other charges', t.other_charges]);
  if (t.round_off) rows.push(['Round off', t.round_off]);
  d.need(14 * rows.length + 90);
  d.y -= 4;
  const tx = right - 190;
  rows.forEach(([k, v]) => { d.text(tx, d.y, k, 9); d.text(right, d.y, money(v), 9, false, 'right'); d.y -= 13; });
  d.line(tx, d.y + 9, right, d.y + 9, 0.8);
  d.text(tx, d.y - 2, 'Total', 11, true);
  d.text(right, d.y - 2, money(t.total), 11, true, 'right');
  d.y -= 18;
  if (bill.received) {
    d.text(tx, d.y, 'Received', 9); d.text(right, d.y, money(bill.received), 9, false, 'right'); d.y -= 13;
    d.text(tx, d.y, 'Balance due', 9, true); d.text(right, d.y, money(t.total - bill.received), 9, true, 'right');
    d.y -= 13;
  }
  d.y -= 4;
  d.text(M, d.y, 'Amount in words', 7.5);
  d.y -= 11;
  for (const w of wrap(amountInWords(t.total), 9, true, right - M)) { d.text(M, d.y, w, 9, true); d.y -= 11; }
  if (firm.upi_vpa && bill.doc_type === 'INVOICE' && t.total - (bill.received || 0) > 0) {
    d.y -= 4;
    d.text(M, d.y, 'Pay by UPI: ' + firm.upi_vpa, 9, true);
    d.y -= 12;
  }
  if (firm.bank_account && bill.doc_type === 'INVOICE') {
    d.text(M, d.y, 'Bank: ' + [firm.bank_name, 'A/c ' + firm.bank_account, 'IFSC ' + firm.bank_ifsc]
      .filter(Boolean).join(' . '), 8.5);
    d.y -= 12;
  }
  for (const [k, v] of [['Notes', bill.notes], ['Terms', bill.terms]]) {
    if (!v) continue;
    d.need(30);
    d.y -= 4;
    d.text(M, d.y, k, 7.5);
    d.y -= 11;
    for (const w of wrap(v, 8.5, false, right - M)) { d.need(12); d.text(M, d.y, w, 8.5); d.y -= 11; }
  }
  d.need(50);
  d.y -= 14;
  d.text(right, d.y, 'For ' + (firm.display_name || ''), 9, true, 'right');
  d.y -= 30;
  d.text(right, d.y, firm.signature_label || 'Authorised Signatory', 8.5, false, 'right');
  if (firm.footer) { d.y -= 20; d.text(W / 2, d.y, fit(firm.footer, 8, false, right - M), 8, false, 'center'); }
  return d.bytes(bill.label + ' ' + bill.doc_no);
}

export function billFileName(bill) {
  return (bill.label.replace(/[^A-Za-z0-9]+/g, '-') + '-' + bill.doc_no.replace(/[^A-Za-z0-9-]+/g, '-'))
    .replace(/^-+|-+$/g, '') + '.pdf';
}
