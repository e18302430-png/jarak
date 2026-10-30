import crypto from 'node:crypto';
import { q, one } from './db.js';
import { sendSms } from './sms.js';
import { normPhone, validSaudiMobile, checkSecret, token, code4, HttpError, bad, limit } from './util.js';

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
    const row = await one(`select id, suspended from ${t} where ${col}=$1`, [phone]);
    // ما نقول إذا الرقم مسجّل أو لا (عشان محد يجرب أرقام)، بس ما نرسل رسالة لرقم غير مسجّل
    if (!row) return { phone, sent: true };
    if (row.suspended) throw new HttpError(403, 'الحساب موقوف، تواصل مع إدارة جارك');
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
      if (role === 'driver') { req.driver = await one('select * from drivers where id=$1', [s.subject_id]); if (!req.driver || req.driver.suspended) return res.status(403).json({ error: 'الحساب موقوف' }); }
      next();
    } catch (e) { next(e); }
  };
}

export async function adminLogin(tokenGiven) {
  if (!process.env.ADMIN_TOKEN || tokenGiven !== process.env.ADMIN_TOKEN) throw new HttpError(401, 'غير مصرح');
  return newSession('admin', null, 7);
}
