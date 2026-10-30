// إشعارات Web Push: توصل للجوال حتى والتطبيق مقفول
import webpush from 'web-push';
import { q, one } from './db.js';
import { setEmitHook } from './events.js';

let ready = false, publicKey = '';
export const pushKey = () => publicKey;

export async function initPush() {
  let pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    const row = await one(`select value from settings where key='vapid'`);
    if (row) ({ pub, priv } = typeof row.value === 'string' ? JSON.parse(row.value) : row.value);
    else { const k = webpush.generateVAPIDKeys(); pub = k.publicKey; priv = k.privateKey; await q(`insert into settings (key, value) values ('vapid', $1) on conflict (key) do nothing`, [JSON.stringify({ pub, priv })]); }
  }
  webpush.setVapidDetails('mailto:' + (process.env.CONTACT_EMAIL || 'support@jarak.sa'), pub, priv);
  publicKey = pub; ready = true;
  setEmitHook(onEvent);
}

export async function subscribe(role, subjectId, sub) {
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) throw Object.assign(new Error('اشتراك غير صالح'), { status: 400 });
  await q(`insert into push_subs (role, subject_id, endpoint, p256dh, auth) values ($1,$2,$3,$4,$5)
           on conflict (endpoint) do update set role=excluded.role, subject_id=excluded.subject_id, p256dh=excluded.p256dh, auth=excluded.auth`,
    [role, subjectId, sub.endpoint.slice(0, 600), String(sub.keys.p256dh).slice(0, 200), String(sub.keys.auth).slice(0, 100)]);
  return { ok: true };
}

export async function pushTo(role, subjectId, msg) {
  if (!ready) return 0;
  const subs = await q(`select * from push_subs where role=$1 and ($2::uuid is null or subject_id=$2)`, [role, subjectId]);
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(msg), { TTL: msg.urgent ? 60 : 3600, urgency: msg.urgent ? 'high' : 'normal' });
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await q('delete from push_subs where id=$1', [s.id]);
    }
  }));
  return sent;
}

// نحوّل أحداث النظام لإشعارات (المهم بس، مو كل حركة)
function onEvent(channel, d) {
  const [kind, id] = channel.split(':');
  let target = null;
  if (kind === 'store' && d.type === 'offer') target = ['store', id, { title: 'طلب جديد 🔔', body: 'عندك طلب من الحي، اقبله قبل لا يروح لغيرك', url: '/store/', tag: 'offer', urgent: true }];
  else if (kind === 'store' && d.type === 'sub_answer') target = ['store', id, { title: 'العميل رد على البديل', body: d.approved ? 'وافق على البديل' : 'رفض البديل، شيل المنتج', url: '/store/', tag: 'sub' }];
  else if (kind === 'driver' && d.type === 'offer') target = ['driver', id, { title: 'مشوار جديد 🛵', body: 'طلب جاهز قريب منك، اقبله الحين', url: '/driver/', tag: 'offer', urgent: true }];
  else if (kind === 'driver' && d.type === 'job') target = ['driver', id, { title: 'تحديث على مشوارك', body: 'البقالة جهّزت الطلب', url: '/driver/', tag: 'job' }];
  else if (kind === 'admin' && d.type === 'no_driver') target = ['admin', null, { title: 'ما فيه مندوب متاح', body: 'طلب جاهز ينتظر مندوب', url: '/admin/#live', tag: 'nodrv', urgent: true }];
  else if (kind === 'order' && (d.text || d.type === 'substitution')) {
    one('select customer_id from orders where id=$1', [id]).then(o => o && pushTo('customer', o.customer_id, {
      title: d.type === 'substitution' ? 'منتج خلص، نبي رأيك' : 'جارك', body: d.type === 'substitution' ? `${d.sub.original} خلص، تبي ${d.sub.name} بداله؟` : d.text,
      url: '/#order/' + id, tag: 'order-' + id, urgent: d.type === 'substitution' })).catch(() => {});
    return;
  }
  if (target) pushTo(...target).catch(() => {});
}
