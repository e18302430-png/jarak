// اللي يميّز جارك: «بقالتي» و«مشوار الجيران» و«الدفتر»
import { q, one } from './db.js';
import { cfg } from './config.js';
import { emit } from './events.js';
import { inZone } from './catalog.js';
import { distM, round2, bad, HttpError } from './util.js';

/* ---------------- بقالتي ---------------- */
export async function setHomeStore(customer, storeId) {
  if (!storeId) { await q('update customers set home_store_id=null where id=$1', [customer.id]); return null; }
  const c = await cfg();
  const s = await one('select id, name, lat, lng from stores where id=$1 and suspended=false', [storeId]);
  if (!s || !inZone(c, s.lat, s.lng, 100)) throw bad('البقالة مو موجودة في حينا');
  await q('update customers set home_store_id=$2 where id=$1', [customer.id, s.id]);
  return s;
}

export async function homeStore(customer, lat, lng) {
  if (!customer.home_store_id) return null;
  const s = await one('select id, name, area, lat, lng, is_open, rating_sum, rating_n from stores where id=$1 and suspended=false', [customer.home_store_id]);
  if (!s) return null;
  return { ...s, dist: lat != null ? Math.round(distM(lat, lng, s.lat, s.lng)) : null, rating: s.rating_n ? round2(s.rating_sum / s.rating_n) : null };
}

// «المعتاد»: الأغراض اللي تكررت في طلباتك، بالكمية اللي تطلبها عادة
export async function usualBasket(customerId) {
  const orders = await q(`select items from orders where customer_id=$1 and status='delivered' order by delivered_at desc limit 12`, [customerId]);
  const m = new Map();
  for (const o of orders) for (const i of o.items) { const h = m.get(i.product_id) || { product_id: i.product_id, name_ar: i.name_ar, n: 0, qty: [] }; h.n++; h.qty.push(i.qty); m.set(i.product_id, h); }
  const min = orders.length >= 3 ? 2 : 1;
  return [...m.values()].filter(h => h.n >= min).sort((a, b) => b.n - a.n).slice(0, 15)
    .map(h => ({ product_id: h.product_id, name_ar: h.name_ar, times: h.n, qty: h.qty.sort((a, b) => a - b)[Math.floor(h.qty.length / 2)] }));
}

/* ---------------- مشوار الجيران ----------------
   طلب عنده مندوب ولسه ما استلم من البقالة، وبيته قريب من بيتك: تنضم له بتوصيل رخيص،
   ونفس المندوب يستلم الطلبين من نفس البقالة ويوصّلهم في مشوار واحد. */
export async function openTrips(customerId, lat, lng) {
  const c = await cfg();
  const rows = await q(`select o.id, o.lat, o.lng, o.status, o.created_at, o.driver_id, p.store_id, s.name as store_name, s.lat as slat, s.lng as slng, d.name as driver_name, d.lat as dlat, d.lng as dlng,
      (select count(*)::int from orders j where j.join_of=o.id and j.status not in ('cancelled','pending_payment')) as joined
    from orders o join order_parts p on p.order_id=o.id and p.status in ('preparing','ready') join stores s on s.id=p.store_id left join drivers d on d.id=o.driver_id
    where o.status in ('preparing','ready') and o.join_of is null and o.driver_id is not null and o.customer_id <> $1 and o.created_at > now() - ($2 || ' minutes')::interval
      and (select count(*) from order_parts x where x.order_id=o.id and x.status <> 'cancelled') = 1`, [customerId, String(c.join_window_min)]);
  return rows.filter(r => r.joined < c.join_max && distM(r.lat, r.lng, lat, lng) <= c.join_radius_m)
    .map(r => {
      const toStore = r.dlat != null ? distM(r.dlat, r.dlng, r.slat, r.slng) : 600;
      return { id: r.id, store_id: r.store_id, store_name: 'جارك', driver: r.driver_name ? r.driver_name.split(' ')[0] : null,
        leaves_in: Math.max(2, Math.round(toStore * 1.3 / 330) + (r.status === 'preparing' ? 4 : 1)),
        dist: Math.round(distM(r.lat, r.lng, lat, lng)), fee: Number(c.join_fee), normal_fee: Number(c.delivery_fee), min_order: Number(c.join_min_order), seats: c.join_max - r.joined };
    }).sort((a, b) => a.dist - b.dist);
}

export async function tripFor(customerId, lat, lng, tripId) {
  const t = (await openTrips(customerId, lat, lng)).find(x => x.id === tripId);
  if (!t) throw bad('المشوار تحرك أو امتلى، اطلب عادي');
  return t;
}

// بعد ما البقالة تقبل الطلب المنضم: نعطيه لنفس المندوب لو لسه ما استلم
export async function attachToTrip(order) {
  if (!order.join_of) return false;
  const c = await cfg();
  const parent = await one(`select o.driver_id, o.status from orders o where o.id=$1`, [order.join_of]);
  if (!parent || !parent.driver_id || !['preparing', 'ready'].includes(parent.status)) return false;
  const pickedParent = await one(`select count(*)::int n from order_parts where order_id=$1 and status='picked'`, [order.join_of]);
  if (pickedParent.n) return false;
  const o = await one(`update orders set driver_id=$2, driver_pay=$3 where id=$1 and driver_id is null returning *`, [order.id, parent.driver_id, c.join_driver_pay]);
  if (!o) return false;
  const d = await one('select name from drivers where id=$1', [parent.driver_id]);
  emit('order:' + o.id, { type: 'update', text: `انضميت لمشوار ${d.name}، يجيك مع جارك` });
  emit('driver:' + parent.driver_id, { type: 'job' });
  return true;
}

/* ---------------- الدفتر ---------------- */
export async function myTabs(customerId) {
  return q(`select t.id, t.store_id, 'جارك' as store_name, t.status, t.credit_limit::float as credit_limit, t.balance::float as balance from tabs t join stores s on s.id=t.store_id where t.customer_id=$1 and t.status <> 'closed'`, [customerId]);
}

export async function requestTab(customer, storeId) {
  if (!storeId) {
    const a = await one('select lat, lng from addresses where customer_id=$1 order by created_at desc limit 1', [customer.id]);
    const all = a ? await q('select id, lat, lng from stores where suspended=false and is_open=true') : [];
    const near = all.map(x => ({ ...x, d: distM(a.lat, a.lng, x.lat, x.lng) })).sort((x, y) => x.d - y.d)[0];
    if (near) { storeId = near.id; await q('update customers set home_store_id = coalesce(home_store_id, $2) where id=$1', [customer.id, near.id]); }
  }
  const s = await one('select id, name from stores where id=$1 and suspended=false', [storeId]);
  if (!s) throw bad('اختر بقالتك أول');
  const t = await one(`insert into tabs (customer_id, store_id) values ($1,$2) on conflict (customer_id, store_id) do update set status = case when tabs.status='closed' then 'requested' else tabs.status end returning *`, [customer.id, s.id]);
  if (t.status === 'requested') emit('store:' + s.id, { type: 'tab_request', name: customer.name || 'عميل' });
  return t;
}

export async function storeTabs(storeId) {
  const rows = await q(`select t.id, t.status, t.credit_limit::float as credit_limit, t.balance::float as balance, t.created_at, c.name, c.phone,
      (select count(*)::int from orders o where o.customer_id=c.id and o.status='delivered' and exists (select 1 from order_parts p where p.order_id=o.id and p.store_id=$1)) as orders_here
    from tabs t join customers c on c.id=t.customer_id where t.store_id=$1 and t.status <> 'closed' order by (t.status='requested') desc, t.balance desc`, [storeId]);
  return rows.map(r => ({ ...r, phone: '0' + String(r.phone).slice(3) }));
}

export async function storeTabAction(storeId, tabId, b) {
  const c = await cfg();
  const t = await one('select * from tabs where id=$1 and store_id=$2', [tabId, storeId]);
  if (!t) throw new HttpError(404, 'الدفتر غير موجود');
  if (b.action === 'approve' || b.action === 'limit') {
    const lim = Number(b.limit);
    if (!(lim >= 50 && lim <= c.tab_max)) throw bad(`الحد بين 50 و ${c.tab_max} ريال`);
    const r = await one(`update tabs set status='open', credit_limit=$2 where id=$1 returning *`, [t.id, lim]);
    if (b.action === 'approve') emit('customer:' + t.customer_id, { type: 'tab_open' });
    return r;
  }
  if (b.action === 'pay') {
    const amt = round2(Number(b.amount));
    if (!(amt > 0 && amt <= Number(t.balance) + 0.001)) throw bad('المبلغ أكبر من اللي عليه');
    await q(`insert into tab_entries (tab_id, amount, note) values ($1,$2,'سدّد للبقالة')`, [t.id, -amt]);
    return one('update tabs set balance = balance - $2 where id=$1 returning *', [t.id, amt]);
  }
  if (b.action === 'reject' || b.action === 'close') {
    if (Number(t.balance) > 0.009 && b.action === 'close') throw bad('ما تقدر تقفل الدفتر وعليه مبلغ');
    return one(`update tabs set status='closed' where id=$1 returning *`, [t.id]);
  }
  throw bad('إجراء غير معروف');
}

// الطلب على الدفتر: يتسجّل على العميل عند التسليم بالمبلغ النهائي بعد أي نقص
export async function chargeTab(order) {
  if (order.payment_method !== 'tab') return;
  const part = await one(`select store_id from order_parts where order_id=$1 and status <> 'cancelled' limit 1`, [order.id]);
  const t = part && await one(`select * from tabs where customer_id=$1 and store_id=$2`, [order.customer_id, part.store_id]);
  if (!t) return;
  const amt = round2(Number(order.paid_amount) - Number(order.refunded_amount));
  if (amt <= 0) return;
  await q(`insert into tab_entries (tab_id, order_id, amount, note) values ($1,$2,$3,$4)`, [t.id, order.id, amt, 'طلب #' + order.number]);
  await q('update tabs set balance = balance + $2 where id=$1', [t.id, amt]);
  // البقالة بتاخذ المبلغ كامل من العميل آخر الشهر، فهي اللي عليها عمولة جارك والتوصيل
  await q(`insert into ledger (kind, order_id, store_id, amount, note) values ('tab_offset', $1, $2, $3, 'على دفتر العميل عند البقالة')`, [order.id, part.store_id, -amt]);
}
