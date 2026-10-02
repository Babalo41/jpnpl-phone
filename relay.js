// Finding the shop PC after its free tunnel link changed (app/phone_sync.py).
// The PC posts its link, sealed with the key from the pairing QR code, to a secret
// topic on ntfy.sh. Sealing = HMAC-SHA256 in counter mode + an HMAC-SHA256 tag, so
// the phone needs nothing but the browser's built-in crypto to open it.

export const RELAY_BASE = 'https://ntfy.sh';

function b64d(text) {
  const s = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - s.length % 4) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey('raw', keyBytes, {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

const enc = new TextEncoder();
const join = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

export async function unseal(keyText, sealed) {
  const key = b64d(keyText);
  const encKey = await hmac(key, enc.encode('jpnpl-enc'));
  const macKey = await hmac(key, enc.encode('jpnpl-mac'));
  const blob = b64d(sealed);
  if (blob.length < 48) throw new Error('Message too short.');
  const nonce = blob.slice(0, 16), ct = blob.slice(16, -32), tag = blob.slice(-32);
  const want = await hmac(macKey, join(nonce, ct));
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= want[i] ^ tag[i];
  if (diff) throw new Error('Message was changed or sealed with another key.');
  const out = new Uint8Array(ct.length);
  for (let block = 0; block * 32 < ct.length; block++) {
    const counter = new Uint8Array([block >>> 24, (block >>> 16) & 255, (block >>> 8) & 255, block & 255]);
    const ks = await hmac(encKey, join(nonce, counter));
    for (let i = 0; i < 32 && block * 32 + i < ct.length; i++) out[block * 32 + i] = ct[block * 32 + i] ^ ks[i];
  }
  return new TextDecoder().decode(out);
}

// The newest link the PC posted in the last 12 hours, or '' if none could be read.
export async function findPc(topic, keyText, base = RELAY_BASE, fetchFn = fetch) {
  const res = await fetchFn(base + '/' + encodeURIComponent(topic) + '/json?poll=1&since=12h');
  if (!res.ok) return '';
  let best = {pc: '', at: 0};
  for (const line of (await res.text()).split('\n')) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.event !== 'message' || !msg.message) continue;
      const data = JSON.parse(await unseal(keyText, msg.message));
      if (/^https:\/\//.test(data.pc || '') && (data.at || 0) >= best.at) best = data;
    } catch (e) { /* someone else's message, or tampered - skip it */ }
  }
  return best.pc || '';
}
