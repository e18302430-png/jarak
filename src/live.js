// الخريطة الحية: موقع المندوب يوصل للعميل وللإدارة لحظة بلحظة
import { q, one } from './db.js';
import { emit } from './events.js';
import { distM } from './util.js';

const realGps = new Map(); // driverId -> آخر مرة أرسل جواله موقع حقيقي

export function markRealGps(driverId) { realGps.set(driverId, Date.now()); }

export async function pushDriverPos(driverId) {
  const d = await one('select id, name, lat, lng, online from drivers where id=$1', [driverId]);
  if (!d || d.lat == null) return;
  const active = await q(`select id from orders where driver_id=$1 and status in ('preparing','ready','delivering')`, [driverId]);
  for (const o of active) emit('order:' + o.id, { type: 'driver', lat: d.lat, lng: d.lng });
  emit('admin', { type: 'driver', id: d.id, lat: d.lat, lng: d.lng, online: d.online, busy: active.length > 0 });
  emit('driver:' + d.id, { type: 'pos', lat: d.lat, lng: d.lng });
}

// وين رايح المندوب الحين: البقالة اللي ما استلم منها، وبعدها بيت العميل
export async function targetOf(order) {
  if (order.status === 'delivering') return { lat: order.lat, lng: order.lng, kind: 'home' };
  const p = await one(`select s.lat, s.lng from order_parts p join stores s on s.id=p.store_id where p.order_id=$1 and p.status not in ('picked','cancelled') order by p.created_at limit 1`, [order.id]);
  return p ? { lat: p.lat, lng: p.lng, kind: 'store' } : { lat: order.lat, lng: order.lng, kind: 'home' };
}

// وضع التجربة: المناديب التجريبيين يمشون على الخريطة لحالهم (المندوب الحقيقي يرسل موقعه من جواله)
const SPEED = 9; // متر بالثانية، تقريباً 32 كم/س داخل الحي
export async function simTick(seconds = 2) {
  const rows = await q(`select o.id, o.status, o.lat, o.lng, o.driver_id, d.lat as dlat, d.lng as dlng from orders o join drivers d on d.id=o.driver_id where o.status in ('preparing','ready','delivering') and d.lat is not null`);
  const moved = new Set();
  for (const o of rows) {
    if (moved.has(o.driver_id) || Date.now() - (realGps.get(o.driver_id) || 0) < 45000) continue;
    const t = await targetOf(o);
    const dist = distM(o.dlat, o.dlng, t.lat, t.lng);
    if (dist < 15) continue;
    const f = Math.min(1, (SPEED * seconds) / dist);
    const lat = o.dlat + (t.lat - o.dlat) * f, lng = o.dlng + (t.lng - o.dlng) * f;
    await q('update drivers set lat=$2, lng=$3 where id=$1', [o.driver_id, lat, lng]);
    moved.add(o.driver_id);
    await pushDriverPos(o.driver_id);
  }
}

export async function liveBoard() {
  const drivers = await q(`select d.id, d.name, d.online, d.lat, d.lng, d.seen_at,
      (select o.number from orders o where o.driver_id=d.id and o.status in ('preparing','ready','delivering') order by o.created_at limit 1) as order_number,
      (select o.status from orders o where o.driver_id=d.id and o.status in ('preparing','ready','delivering') order by o.created_at limit 1) as order_status
    from drivers d where d.lat is not null order by d.online desc, d.name`);
  const orders = await q(`select id, number, status, lat, lng, driver_id from orders where status in ('searching','preparing','ready','delivering') order by created_at desc limit 50`);
  const stores = await q(`select id, name, lat, lng, is_open from stores where suspended = false`);
  return { drivers: drivers.map(d => ({ ...d, busy: !!d.order_number })), orders, stores };
}
