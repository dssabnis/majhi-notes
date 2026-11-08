// PIN / passcode hashing (PBKDF2-SHA256). Only salted hashes are stored, never the PIN itself.
import { bytesToBase64, base64ToBytes } from './util.js';

const ITER = 150000;

export async function hashPin(pin, saltB64) {
  const salt = saltB64 ? base64ToBytes(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER }, key, 256);
  return { salt: bytesToBase64(salt), hash: bytesToBase64(new Uint8Array(bits)) };
}

export async function verifyPin(pin, salt, hash) {
  if (!salt || !hash) return false;
  const h = await hashPin(pin, salt);
  // constant-time-ish compare
  if (h.hash.length !== hash.length) return false;
  let d = 0;
  for (let i = 0; i < hash.length; i++) d |= h.hash.charCodeAt(i) ^ hash.charCodeAt(i);
  return d === 0;
}
