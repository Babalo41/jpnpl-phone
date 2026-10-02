// GST maths for bills made on the phone while the shop PC is off.
// A line-for-line port of app/billing.py (compute_line, compute_totals, tax_type_for,
// _place_of_supply) and payments.r2. The PC stays the judge: when the bill syncs it
// is worked out again in Python and any difference is reported back.
// phone_app/tests/gst.test.mjs checks these against numbers the Python code produced.

// Python: float(Decimal(str(value)).quantize(Decimal('0.01'), ROUND_HALF_UP)).
// JS and Python print floats the same shortest way, so rounding that text gives
// exactly what Python gives.
export function roundHalfUp(value, places = 2) {
  const v = Number(value || 0);
  if (!isFinite(v)) return 0;
  let text = String(Math.abs(v));
  let mantissa, exp = 0;
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!m) return v;
  const whole = m[1], frac = m[2] || '';
  exp = Number(m[3] || 0) - frac.length;
  mantissa = BigInt(whole + frac);
  // value = mantissa * 10^exp ; we want round(value * 10^places)
  const shift = exp + places;
  let scaled;
  if (shift >= 0) {
    scaled = mantissa * 10n ** BigInt(shift);
  } else {
    const div = 10n ** BigInt(-shift);
    scaled = mantissa / div;
    if ((mantissa % div) * 2n >= div) scaled += 1n;
  }
  const out = Number(scaled) / 10 ** places;
  return v < 0 && out !== 0 ? -out : out;
}

export const r2 = (v) => roundHalfUp(v, 2);

export function num(value, fallback = 0) {
  const text = String(value == null ? '' : value).replace(/,/g, '').replace(/₹/g, '').trim();
  if (text === '' || text === 'nan' || text === 'None') return fallback;
  const n = Number(text);
  return isNaN(n) ? fallback : n;
}

export class BillError extends Error {}

export function taxTypeFor(firmState, placeOfSupply, registered = true) {
  if (!registered) return 'NONE';
  if (placeOfSupply && firmState && placeOfSupply !== firmState) return 'IGST';
  return 'CGST';
}

export function placeOfSupply(bill, party, firm) {
  const pos = String(bill.place_of_supply || '').trim().slice(0, 2);
  if (pos) return pos;
  const gstin = String(bill.party_gstin || (party && party.gstin) || '').trim();
  if (/^\d\d/.test(gstin)) return gstin.slice(0, 2);
  const code = String((party && party.state) || '').trim();
  if (/^\d\d$/.test(code)) return code;
  return firm.state_code || '';
}

export function computeLine(raw, taxType, includesTax, index = 1) {
  const qty = num(raw.qty);
  if (qty <= 0) throw new BillError('Line ' + index + ': quantity must be more than zero.');
  const rate = num(raw.rate);
  if (rate < 0) throw new BillError('Line ' + index + ': rate cannot be negative.');
  const gst = taxType === 'NONE' ? 0 : num(raw.gst_rate);
  if (gst < 0 || gst > 100) throw new BillError('Line ' + index + ': GST must be between 0 and 100.');
  const discount = num(raw.discount);
  let discountType = String(raw.discount_type || 'amount').toLowerCase();
  if (!['amount', 'percent'].includes(discountType)) discountType = 'amount';
  const gross = r2(qty * rate);
  let discountAmount;
  if (discountType === 'percent') {
    if (discount < 0 || discount > 100) throw new BillError('Line ' + index + ': a discount percent must be between 0 and 100.');
    discountAmount = r2(gross * discount / 100.0);
  } else {
    if (discount < 0) throw new BillError('Line ' + index + ': the discount cannot be negative.');
    if (discount > gross + 0.005) throw new BillError('Line ' + index + ": the discount is more than the item's amount.");
    discountAmount = r2(discount);
  }
  const net = r2(gross - discountAmount);
  let taxable, tax;
  if (includesTax && gst) {
    taxable = r2(net * 100.0 / (100.0 + gst));
    tax = r2(net - taxable);
  } else {
    taxable = net;
    tax = r2(taxable * gst / 100.0);
  }
  let cgst = 0, sgst = 0, igst = 0;
  if (taxType === 'IGST') igst = tax;
  else if (taxType === 'CGST') { cgst = r2(tax / 2.0); sgst = r2(tax - cgst); }
  return {qty, rate, gst_rate: gst, discount, discount_type: discountType, discount_amount: discountAmount, gross,
    taxable, cgst, sgst, igst, cess: 0, total: r2(taxable + cgst + sgst + igst)};
}

export function computeTotals(lines, otherCharges = 0, roundOff = true) {
  const t = {gross_total: 0, discount_total: 0, taxable_total: 0, cgst: 0, sgst: 0, igst: 0, cess: 0};
  for (const line of lines) {
    t.gross_total += line.gross;
    t.discount_total += line.discount_amount;
    t.taxable_total += line.taxable;
    for (const k of ['cgst', 'sgst', 'igst', 'cess']) t[k] += line[k];
  }
  for (const k of Object.keys(t)) t[k] = r2(t[k]);
  const other = r2(Math.max(0, num(otherCharges)));
  const before = r2(t.taxable_total + t.cgst + t.sgst + t.igst + t.cess + other);
  const rounded = roundHalfUp(before, 0);
  t.other_charges = other;
  t.round_off = roundOff ? r2(rounded - before) : 0;
  t.total = r2(before + t.round_off);
  return t;
}

// The whole bill, as the PC would work it out.
export function computeBill(bill, firm, party, opts = {}) {
  const registered = !!firm.gstin;
  const pos = placeOfSupply(bill, party, firm);
  const taxType = taxTypeFor(firm.state_code, pos, registered);
  const includes = ['1', 'true', true, 1].includes(bill.price_includes_tax);
  const lines = [];
  (bill.lines || []).forEach((raw, i) => {
    if (!raw.sku && !raw.description) return;
    const line = computeLine(raw, taxType, includes, i + 1);
    lines.push(Object.assign({}, raw, line));
  });
  if (!lines.length) throw new BillError('Add at least one item.');
  const roundOff = opts.roundOff !== undefined ? opts.roundOff : true;
  return {taxType, placeOfSupply: pos, lines, totals: computeTotals(lines, bill.other_charges, roundOff)};
}

// "M1/26-27/0001" style numbers - billing.fy_of / format_doc_no.
export function fyOf(dateText) {
  const [y, m] = dateText.slice(0, 10).split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  const two = (n) => String(n % 100).padStart(2, '0');
  return two(start) + '-' + two(start + 1);
}

export function formatDocNo(prefix, fy, seq, digits = 4) {
  return prefix + '/' + fy + '/' + String(seq).padStart(digits, '0');
}

// Next number in this phone's own series, never below what the PC last said.
export function nextDocNo(prefix, dateText, pcNext, usedNos, digits = 4) {
  const fy = fyOf(dateText);
  const head = prefix + '/' + fy + '/';
  let top = 0;
  const take = (no) => {
    if (no && no.startsWith(head) && /^\d+$/.test(no.slice(head.length))) top = Math.max(top, Number(no.slice(head.length)));
  };
  if (pcNext && pcNext.startsWith(head)) take(pcNext.slice(0, head.length) + String(Number(pcNext.slice(head.length)) - 1));
  (usedNos || []).forEach(take);
  return formatDocNo(prefix, fy, top + 1, digits);
}
