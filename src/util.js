import crypto from 'node:crypto';

export const round2 = (n) => Math.round(Number(n) * 100) / 100;
export const money = (n) => { const v = round2(n); return Number.isInteger(v) ? String(v) : v.toFixed(2); };

// distance in metres
export function distM(lat1, lng1, lat2, lng2) {
  const R = 6371000, r = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lng2 - lng1) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export const normPhone = (p) => {
  let d = String(p || '').replace(/[٠-٩]/g, c => '٠١٢٣٤٥٦٧٨٩'.indexOf(c)).replace(/[^\d]/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('05') && d.length === 10) d = '966' + d.slice(1);
  if (d.startsWith('5') && d.length === 9) d = '966' + d;
  return d;
};
export const validSaudiMobile = (p) => /^9665\d{8}$/.test(p);
export const localPhone = (p) => String(p || '').replace(/^966/, '0');

export function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(String(secret), salt, 32).toString('hex');
}
export function checkSecret(secret, stored) {
  const [salt, h] = String(stored || '').split(':');
  if (!salt || !h) return false;
  const a = crypto.scryptSync(String(secret), salt, 32), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export const token = () => crypto.randomBytes(24).toString('base64url');
export const code4 = () => String(crypto.randomInt(1000, 10000));

export class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
export const bad = (msg) => new HttpError(400, msg);

// simple in-memory limiter: key -> timestamps
const hits = new Map();
export function limit(key, max, windowMs) {
  if (process.env.NO_RATE_LIMIT === '1') return; // للاختبارات الآلية فقط
  const now = Date.now(), arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) throw new HttpError(429, 'محاولات كثيرة، جرّب بعد شوي');
  arr.push(now); hits.set(key, arr);
}
