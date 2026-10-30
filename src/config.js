// إعدادات التشغيل: تتعدّل من لوحة الإدارة بدون برمجة
import { q, one } from './db.js';

export const DEFAULTS = {
  commission_pct: 8,          // عمولة البقالة من قيمة المنتجات
  delivery_fee: 7,            // رسوم التوصيل على العميل
  free_delivery_over: 150,    // توصيل مجاني فوق هالمبلغ
  min_order: 30,              // أقل طلب
  cod_enabled: 1,             // الدفع عند الاستلام (كاش أو شبكة مع المندوب): 1 شغّال، 0 مقفل
  cod_max: 400,               // أعلى مبلغ للدفع عند الاستلام
  join_fee: 2,                // توصيل «مشوار الجيران» على العميل
  join_driver_pay: 3,         // زيادة المندوب على كل طلب ينضم لمشواره
  join_radius_m: 450,         // أبعد مسافة بين بيتك وبيت الطلب الأصلي
  join_window_min: 20,        // المشوار يبقى مفتوح للانضمام كم دقيقة من بداية الطلب
  join_max: 2,
  join_min_order: 10,         // أقل طلب لما تنضم لمشوار جيران                // كم طلب ينضم لنفس المشوار
  tab_max: 1500,              // أعلى حد للدفتر تقدر البقالة تعطيه
  driver_pay: 7,              // أجرة المندوب للطلب (مشوار قصير داخل الحي)
  driver_pay_extra_pickup: 2, // زيادة لكل بقالة إضافية في نفس الطلب
  radius_m: 3000,             // نطاق البقالات حول العميل
  split_max_m: 1500,          // أقصى بعد بين بقالتين في نفس الطلب
  detour_max_m: 350,          // البقالة الثانية لازم تكون على طريق المندوب: أقصى لفّة زيادة بالمتر
  promise_min: 15,            // وعد التوصيل للعميل بالدقايق
  offer_seconds: 60,          // مهلة رد البقالة
  driver_offer_seconds: 45,
  stores_per_round: 3,
  max_rounds: 4,
  price_tolerance_pct: 5,     // نقبل سلة أغلى من التسعيرة بهالنسبة ونتحمل الفرق عن العميل
  substitution_seconds: 180,
  late_minutes: 20,           // تأخرنا أكثر من كذا؟ التوصيل علينا
  complaint_hours: 24,
  // الحي الوحيد اللي نشتغل فيه (نبدأ بحي واحد ونغطيه صح)
  zone_lat: 26.2855,
  zone_lng: 50.2105,
  zone_radius_m: 1500
};
// إعدادات نصية
export const TEXT_DEFAULTS = { zone_name: 'العقربية', gemini_api_key: '', map_tiles: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' };
let cache = null;
export async function cfg() {
  if (cache) return cache;
  const rows = await q('select key, value from settings');
  cache = { ...DEFAULTS, ...TEXT_DEFAULTS };
  for (const r of rows) cache[r.key] = r.value;
  return cache;
}
export async function setCfg(patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (k in TEXT_DEFAULTS) {
      if (typeof v !== 'string') continue;
      await q('insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [k, JSON.stringify(v.trim().slice(0, 300))]);
      continue;
    }
    if (!(k in DEFAULTS)) continue;
    const n = Number(v); if (!Number.isFinite(n) || (n < 0 && !/^zone_l/.test(k))) continue;
    await q('insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [k, JSON.stringify(n)]);
  }
  cache = null; return cfg();
}
export const cfgSync = () => cache || { ...DEFAULTS, ...TEXT_DEFAULTS };
export const resetCfgCache = () => { cache = null; };
