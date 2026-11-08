// TOTP (RFC 6238) / HOTP (RFC 4226) using WebCrypto. Works in browsers and Node 18+.

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input) {
  const s = String(input || '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (!s) throw new Error('empty secret');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of s) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32 character: ' + ch);
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return new Uint8Array(out);
}

export function base32Encode(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

const ALGOS = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };

export async function hotp(keyBytes, counter, digits = 6, algo = 'SHA1') {
  const name = ALGOS[String(algo).toUpperCase().replace('-', '')] || 'SHA-1';
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: name }, false, ['sign']);
  const msg = new Uint8Array(8);
  let c = BigInt(counter);
  for (let i = 7; i >= 0; i--) { msg[i] = Number(c & 0xffn); c >>= 8n; }
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export async function totp(keyBytes, timeMs = Date.now(), { digits = 6, period = 30, algo = 'SHA1' } = {}) {
  const counter = Math.floor(timeMs / 1000 / period);
  return hotp(keyBytes, counter, digits, algo);
}

export function secondsLeft(timeMs = Date.now(), period = 30) {
  return period - (Math.floor(timeMs / 1000) % period);
}

// Parses otpauth://totp/Issuer:account?secret=...&issuer=...&digits=6&period=30&algorithm=SHA1
export function parseOtpauth(uri) {
  const u = new URL(String(uri).trim());
  if (u.protocol !== 'otpauth:') throw new Error('not an otpauth URI');
  const type = (u.hostname || u.host || '').toLowerCase() || u.pathname.split('/').filter(Boolean)[0];
  if (type !== 'totp') throw new Error('only TOTP is supported');
  let label = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
  if (label.toLowerCase().startsWith('totp/')) label = label.slice(5);
  let issuer = u.searchParams.get('issuer') || '';
  let account = label;
  if (label.includes(':')) {
    const i = label.indexOf(':');
    if (!issuer) issuer = label.slice(0, i).trim();
    account = label.slice(i + 1).trim();
  }
  const secret = (u.searchParams.get('secret') || '').replace(/\s/g, '').toUpperCase();
  base32Decode(secret); // validate
  const digits = parseInt(u.searchParams.get('digits') || '6', 10);
  const period = parseInt(u.searchParams.get('period') || '30', 10);
  const algo = (u.searchParams.get('algorithm') || 'SHA1').toUpperCase();
  if (![6, 7, 8].includes(digits)) throw new Error('bad digits');
  if (!(period > 0 && period <= 300)) throw new Error('bad period');
  if (!ALGOS[algo]) throw new Error('bad algorithm');
  return { issuer, account, secret, digits, period, algo };
}
