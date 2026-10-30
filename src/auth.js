import crypto from 'node:crypto';
import { q, one } from './db.js';
import { sendSms } from './sms.js';
import { normPhone, validSaudiMobile, checkSecret, hashSecret, token, code4, HttpError, bad, limit } from './util.js';

const hashCode = (phone, code) => crypto.createHash('sha256').update(phone + ':' + code + ':' + (process.env.OTP_PEPPER || 'jarak')).digest('hex');

const ROLE_TABLE = { store: ['stores', 'owner_phone'], driver: ['drivers', 'phone'] };
const otpKey = (role, phone) => role === 'customer' ? phone : role + ':' + phone;
// يظهر الرمز في الاستجابة فقط وقت الاختبارات الآلية، أبداً للمستخدم الحقيقي
const showCode = () => process.env.DEV_SHOW_OTP === '1' && (process.env.SMS_PROVIDER || 'dev') === 'dev';

export async function startOtp(rawPhone, ip, role = 'customer') {
  const phone = normPhone(rawPhone);
  if (!validSaudiMobile(phone)) throw bad('اكتب رقم جوال سعودي صحيح يبدأ بـ 05');
  limit('otp-ip:' + ip, 10, 60 * 60e3);
  limit('otp:' + role + ':' + phone, 1, 45e3);
  if (ROLE_TABLE[role]) {
    const [t, col] = ROLE_TABLE[role];
    const row = await one(`select id, suspended, status, review_note from ${t} where ${col}=$1`, [phone]);
    // ما نقول إذا الرقم مسجّل أو لا (عشان محد يجرب أرقام)، بس ما نرسل رسالة لرقم غير مسجّل
    if (!row) return { phone, sent: true };
    accountOk(role, row);
  }
  const code = code4();
  const key = otpKey(role, phone);
  await q(`insert into otps (phone, code_hash, expires_at) values ($1,$2, now() + interval '5 minutes')
           on conflict (phone) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`, [key, hashCode(key, code)]);
  const app = role === 'store' ? 'جارك للأعمال' : role === 'driver' ? 'كابتن جارك' : 'جارك';
  // السطر الأخير يخلي الجوال يقرأ الرمز ويعبّيه لحاله (Android WebOTP، وiPhone يقترحه فوق الكيبورد)
  let host = ''; try { host = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).host : ''; } catch (e) { host = ''; }
  await sendSms(phone, `رمز الدخول لـ${app}: ${code}\nلا تعطيه لأحد.` + (host ? `\n\n@${host} #${code}` : ''));
  return { phone, sent: true, ...(showCode() ? { dev_code: code } : {}) };
}

export async function verifyOtp(rawPhone, code, role = 'customer') {
  const phone = normPhone(rawPhone), key = otpKey(role, phone);
  const row = await one('select * from otps where phone=$1', [key]);
  if (!row || new Date(row.expires_at) < new Date()) throw bad('الرمز انتهى، اطلب رمز جديد');
  if (row.attempts >= 5) throw new HttpError(429, 'محاولات كثيرة، اطلب رمز جديد');
  if (row.code_hash !== hashCode(key, String(code).trim())) {
    await q('update otps set attempts = attempts + 1 where phone=$1', [key]);
    throw bad('الرمز غلط، تأكد منه');
  }
  await q('delete from otps where phone=$1', [key]);
  if (ROLE_TABLE[role]) {
    const [t, col] = ROLE_TABLE[role];
    const r = await one(`select * from ${t} where ${col}=$1`, [phone]);
    if (!r) throw bad('الرقم مو مسجّل عندنا، تواصل مع إدارة جارك');
    accountOk(role, r);
    return { token: await newSession(role, r.id, 60), row: r };
  }
  let c = await one('select * from customers where phone=$1', [phone]);
  const isNew = !c;
  if (!c) c = await one('insert into customers (phone) values ($1) returning *', [phone]);
  return { token: await newSession('customer', c.id, 365), customer: c, isNew };
}

export async function newSession(role, subjectId, days = 60) {
  const t = token();
  await q(`insert into sessions (token, role, subject_id, expires_at) values ($1,$2,$3, now() + ($4 || ' days')::interval)`, [t, role, subjectId, String(days)]);
  return t;
}

export async function loginWithPin(table, rawPhone, pin, ip) {
  const phone = normPhone(rawPhone);
  limit('pin:' + table + ':' + ip + ':' + phone, 8, 15 * 60e3);
  const row = await one(`select * from ${table === 'stores' ? 'stores' : 'drivers'} where ${table === 'stores' ? 'owner_phone' : 'phone'}=$1`, [phone]);
  if (!row || !checkSecret(pin, row.pin_hash)) throw new HttpError(401, 'الرقم أو الرمز غير صحيح');
  if (row.suspended) throw new HttpError(403, 'الحساب موقوف، تواصل مع إدارة جارك');
  return { token: await newSession(table === 'stores' ? 'store' : 'driver', row.id, 30), row };
}

export function requireRole(role) {
  return async (req, res, next) => {
    try {
      const t = (req.headers.authorization || '').replace(/^Bearer /, '') || req.query.token;
      if (!t) return res.status(401).json({ error: 'سجّل دخولك' });
      const s = await one('select * from sessions where token=$1 and expires_at > now()', [t]);
      if (!s || s.role !== role) return res.status(401).json({ error: 'انتهت الجلسة، سجّل دخولك من جديد' });
      req.sub = s.subject_id; req.sessionToken = t;
      if (role === 'customer') req.customer = await one('select * from customers where id=$1', [s.subject_id]);
      if (role === 'store') { req.store = await one('select * from stores where id=$1', [s.subject_id]); if (!req.store || req.store.suspended) return res.status(403).json({ error: 'الحساب موقوف' }); }
      if (role === 'driver') { req.driver = await one('select * from drivers where id=$1', [s.subject_id]); if (!req.driver || req.driver.suspended || (req.driver.status && req.driver.status !== 'active')) return res.status(403).json({ error: 'الحساب غير مفعّل' }); }
      next();
    } catch (e) { next(e); }
  };
}

export async function adminLogin(tokenGiven) {
  if (!process.env.ADMIN_TOKEN || tokenGiven !== process.env.ADMIN_TOKEN) throw new HttpError(401, 'غير مصرح');
  return newSession('admin', null, 7);
}

/* ---------- الكباتن: تسجيل بكلمة سر وحساب تحت المراجعة ---------- */
export const DRIVER_STATUS_MSG = {
  pending: 'طلبك تحت المراجعة. بنبلغك برسالة أول ما نفعّل حسابك، وعادة ما ياخذ أكثر من يوم.',
  rejected: 'ما قدرنا نقبل طلبك هالمرة. تواصل مع إدارة جارك لو عندك سؤال.'
};
export function checkDriverOk(d) {
  if (d.suspended) throw new HttpError(403, 'الحساب موقوف، تواصل مع إدارة جارك');
  if (d.status && d.status !== 'active') { const e = new HttpError(403, (DRIVER_STATUS_MSG[d.status] || 'الحساب غير مفعّل') + (d.status === 'rejected' && d.review_note ? ' (السبب: ' + d.review_note + ')' : '')); e.code = 'driver_' + d.status; throw e; }
}
export function validPassword(p) {
  p = String(p || '');
  if (p.length < 6) throw bad('كلمة السر لازم 6 حروف أو أرقام على الأقل');
  if (p.length > 64) throw bad('كلمة السر طويلة');
  return p;
}
export async function driverApply(b, ip) {
  limit('apply:' + ip, 5, 60 * 60e3);
  const phone = normPhone(b.phone), name = String(b.name || '').trim().slice(0, 60);
  if (name.length < 3) throw bad('اكتب اسمك الكامل');
  if (!validSaudiMobile(phone)) throw bad('اكتب رقم جوال سعودي صحيح يبدأ بـ 05');
  const pass = validPassword(b.password);
  const old = await one('select id, status from drivers where phone=$1', [phone]);
  if (old && old.status !== 'rejected') throw bad(old.status === 'pending' ? 'عندك طلب تحت المراجعة بهالرقم. سجّل دخول عشان تشوف حالته' : 'الرقم هذا مسجّل. سجّل دخول بكلمة السر');
  const vehicle = ['motorbike', 'car', 'bicycle'].includes(b.vehicle) ? b.vehicle : 'motorbike';
  const vals = [name, phone, hashSecret(pass), vehicle, String(b.area || '').trim().slice(0, 80) || null];
  const d = old
    ? await one(`update drivers set name=$1, pin_hash=$3, has_password=true, vehicle=$4, home_area=$5, status='pending', review_note=null, created_at=now() where phone=$2 returning id, name`, vals)
    : await one(`insert into drivers (name, phone, pin_hash, has_password, vehicle, home_area, status, company) values ($1,$2,$3,true,$4,$5,'pending',null) returning id, name`, vals);
  return d;
}
export async function driverPasswordLogin(rawPhone, password, ip) {
  const phone = normPhone(rawPhone);
  if (!validSaudiMobile(phone)) throw bad('اكتب رقم جوالك صح، يبدأ بـ 05');
  limit('dpw:' + ip + ':' + phone, 8, 15 * 60e3);
  const d = await one('select * from drivers where phone=$1', [phone]);
  if (!d || !d.has_password || !checkSecret(String(password || ''), d.pin_hash)) throw new HttpError(401, 'الجوال أو كلمة السر غلط');
  checkDriverOk(d);
  return newSession('driver', d.id, 90);
}
export async function setDriverPassword(driverId, password) {
  await q('update drivers set pin_hash=$2, has_password=true where id=$1', [driverId, hashSecret(validPassword(password))]);
}

/* ---------- البقالات: نفس الفكرة ---------- */
const STORE_MSG = {
  pending: 'طلب بقالتك تحت المراجعة. فريق جارك بيتواصل معك ويفعّل الحساب، وعادة خلال يوم.',
  rejected: 'ما قدرنا نقبل طلب البقالة هالمرة. تواصل مع إدارة جارك لو عندك سؤال.'
};
export function accountOk(role, r) {
  if (role === 'driver') return checkDriverOk(r);
  if (role === 'store') {
    if (r.status && r.status !== 'active') { const e = new HttpError(403, (STORE_MSG[r.status] || 'الحساب غير مفعّل') + (r.status === 'rejected' && r.review_note ? ' (السبب: ' + r.review_note + ')' : '')); e.code = 'store_' + r.status; throw e; }
    if (r.suspended) throw new HttpError(403, 'الحساب موقوف، تواصل مع إدارة جارك');
  }
}
export async function storeApply(b, ip) {
  limit('sapply:' + ip, 5, 60 * 60e3);
  const phone = normPhone(b.phone), name = String(b.name || '').trim().slice(0, 60), owner = String(b.owner_name || '').trim().slice(0, 60);
  if (name.length < 2) throw bad('اكتب اسم البقالة');
  if (owner.length < 3) throw bad('اكتب اسمك الكامل');
  if (!validSaudiMobile(phone)) throw bad('اكتب رقم جوال سعودي صحيح يبدأ بـ 05');
  const pass = validPassword(b.password);
  const lat = Number(b.lat), lng = Number(b.lng);
  if (!(lat > 16 && lat < 33 && lng > 34 && lng < 56)) throw bad('حدد مكان البقالة على الخريطة');
  const old = await one('select id, status from stores where owner_phone=$1', [phone]);
  if (old && old.status !== 'rejected') throw bad(old.status === 'pending' ? 'عندك طلب تحت المراجعة بهالرقم. سجّل دخول عشان تشوف حالته' : 'الرقم هذا مسجّل لبقالة. سجّل دخول بكلمة السر');
  const vals = [name, phone, hashSecret(pass), lat, lng, String(b.area || '').trim().slice(0, 120) || null, owner, String(b.cr_number || '').replace(/\D/g, '').slice(0, 12) || null, !!b.self_delivery];
  return old
    ? one(`update stores set name=$1, pin_hash=$3, has_password=true, lat=$4, lng=$5, area=$6, owner_name=$7, cr_number=$8, self_delivery=$9, status='pending', suspended=true, review_note=null where owner_phone=$2 returning id, name`, vals)
    : one(`insert into stores (name, owner_phone, pin_hash, has_password, lat, lng, area, owner_name, cr_number, self_delivery, status, suspended) values ($1,$2,$3,true,$4,$5,$6,$7,$8,$9,'pending',true) returning id, name`, vals);
}
export async function passwordLogin(role, rawPhone, password, ip) {
  const phone = normPhone(rawPhone);
  if (!validSaudiMobile(phone)) throw bad('اكتب رقم جوالك صح، يبدأ بـ 05');
  limit('pw:' + role + ':' + ip + ':' + phone, 8, 15 * 60e3);
  const [t, col] = ROLE_TABLE[role];
  const r = await one(`select * from ${t} where ${col}=$1`, [phone]);
  if (!r || !r.has_password || !checkSecret(String(password || ''), r.pin_hash)) throw new HttpError(401, 'الجوال أو كلمة السر غلط');
  accountOk(role, r);
  return newSession(role, r.id, 90);
}
export async function setPassword(role, id, password) {
  await q(`update ${ROLE_TABLE[role][0]} set pin_hash=$2, has_password=true where id=$1`, [id, hashSecret(validPassword(password))]);
}
