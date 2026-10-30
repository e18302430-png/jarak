// محرك التوزيع: الطلب يروح لأقرب 3 بقالات، أول وحدة تقول «عندي» تاخذه.
// لو ما فيه بقالة عندها كل شي، السلة تتقسم على أكثر من بقالة قريبة من بعض.
import { q, one } from './db.js';
import { cfg } from './config.js';
import { emit } from './events.js';
import { nearbyStores, storeCoverage, reliability, onTheWay } from './catalog.js';
import { settleRefunds } from './money.js';
import { attachToTrip } from './hood.js';
import { distM, round2, money } from './util.js';

const timers = new Set();
function later(ms, fn) { if (process.env.JARAK_NO_TIMERS) return; const t = setTimeout(() => { timers.delete(t); fn().catch(e => console.error('[timer]', e)); }, ms); t.unref?.(); timers.add(t); }

const notify = (o, text, extra = {}) => emit('order:' + o.id, { type: 'update', text, ...extra });
const adminPing = (o) => emit('admin', { type: 'order', id: o.id, status: o.status });

// items of the order that no part has taken yet
async function unassigned(order) {
  const parts = await q(`select items from order_parts where order_id=$1 and status <> 'cancelled'`, [order.id]);
  const taken = new Set(parts.flatMap(p => p.items.map(i => i.product_id)));
  return order.items.filter(i => !taken.has(i.product_id));
}

export async function startDispatch(orderId) {
  const o = await one(`update orders set status='searching' where id=$1 and status='pending_payment' returning *`, [orderId]);
  if (!o) return;
  notify(o, 'استلمنا طلبك، وجارك يجهّزه الحين');
  adminPing(o);
  await nextRound(o.id);
}

export async function nextRound(orderId) {
  const c = await cfg();
  const order = await one('select * from orders where id=$1', [orderId]);
  if (!order || order.status !== 'searching') return;
  const pending = await one(`select count(*)::int n from offers where order_id=$1 and status='pending'`, [orderId]);
  if (pending.n) return;
  const left = await unassigned(order);
  if (!left.length) return finishAssignment(orderId);
  const round = order.dispatch_round + 1;
  if (round > c.max_rounds) return finishAssignment(orderId);

  const tried = await q(`select store_id, status from offers where order_id=$1`, [orderId]);
  const refused = new Set(tried.filter(t => t.status === 'declined').map(t => t.store_id));
  const slow = new Set(tried.filter(t => t.status === 'expired').map(t => t.store_id));
  const parts = await q(`select p.store_id, s.lat, s.lng from order_parts p join stores s on s.id=p.store_id where p.order_id=$1 and p.status <> 'cancelled'`, [orderId]);
  const inOrder = new Set(parts.map(p => p.store_id));
  let stores = (await nearbyStores(order.lat, order.lng, c.radius_m)).filter(s => !refused.has(s.id) && !inOrder.has(s.id));
  // باقي الطلب يتكمّل بس من بقالة على طريق المندوب، عشان ما يلف ويتأخر
  if (parts.length) stores = stores.filter(s => onTheWay(parts[0], s, order, c));
  // بقالتك أول: الجولة الأولى لها لحالها. وطلب الدفتر أو مشوار الجيران لها بس
  if (order.prefer_store_id && (order.exclusive || round === 1)) {
    const mine = stores.filter(s => s.id === order.prefer_store_id);
    if (mine.length || order.exclusive) stores = mine;
  }
  const tol = 1 + c.price_tolerance_pct / 100;
  // basket-level price guard: the store may be a little dearer on some items (we absorb up to the tolerance),
  // the most overpriced items are dropped until the basket fits
  const cov = (await storeCoverage(stores, left)).map(x => {
    let ok = x.covered.slice().sort((a, b) => (b.price / (b.quote_price || b.price)) - (a.price / (a.quote_price || a.price)));
    const sum = (arr, k) => arr.reduce((a, i) => a + (k === 'q' ? (i.quote_price ?? i.price) : i.price) * i.qty, 0);
    while (ok.length && sum(ok, 'p') > sum(ok, 'q') * tol + 0.001) ok.shift();
    return { ...x, covered: ok, total: round2(sum(ok, 'p')) };
  }).filter(x => x.covered.length);
  if (!cov.length) return finishAssignment(orderId);
  cov.sort((a, b) => (slow.has(a.store.id) - slow.has(b.store.id)) || (b.covered.length - a.covered.length) || (a.total - b.total) || (a.store.dist - b.store.dist) || (reliability(b.store) - reliability(a.store)));
  const picks = cov.slice(0, c.stores_per_round);
  await q('update orders set dispatch_round=$2 where id=$1', [orderId, round]);
  for (const x of picks) {
    const items = x.covered.map(i => ({ product_id: i.product_id, name_ar: i.name_ar, size: i.size, unit: i.unit, qty: i.qty, price: i.price, quote_price: i.quote_price }));
    const off = await one(`insert into offers (order_id, store_id, round, items, basket_price, expires_at) values ($1,$2,$3,$4,$5, now() + ($6 || ' seconds')::interval) returning *`, [orderId, x.store.id, round, JSON.stringify(items), x.total, String(c.offer_seconds)]);
    await q('update stores set offers_n = offers_n + 1 where id=$1', [x.store.id]);
    emit('store:' + x.store.id, { type: 'offer', offer: off });
  }
  later(c.offer_seconds * 1000 + 300, () => sweep());
}

// a store answers: accept (all), partial (missing list), decline
export async function respondOffer(storeId, offerId, action, missingIds = []) {
  const off = await one(`select * from offers where id=$1 and store_id=$2`, [offerId, storeId]);
  if (!off) throw Object.assign(new Error('الطلب غير موجود'), { status: 404 });
  if (off.status !== 'pending') return { status: off.status, late: true };
  if (new Date(off.expires_at) < new Date()) { await expireOffer(off); return { status: 'expired', late: true }; }
  const ms = Date.now() - new Date(off.created_at).getTime();
  await q('update stores set respond_ms_sum = respond_ms_sum + $2, respond_n = respond_n + 1 where id=$1', [storeId, ms]);

  const missing = new Set(action === 'decline' ? off.items.map(i => i.product_id) : missingIds);
  // learn the shelf: what they said they don't have gets less likely to be offered again
  for (const pid of missing) await q(`update store_products set confidence = greatest(0, confidence * 0.4), available = case when confidence * 0.4 < 0.25 then false else available end, updated_at = now() where store_id=$1 and product_id=$2`, [storeId, pid]);

  const order = await one('select * from orders where id=$1', [off.order_id]);
  const free = new Set((await unassigned(order)).map(i => i.product_id));
  const take = off.items.filter(i => !missing.has(i.product_id) && free.has(i.product_id));

  if (!take.length || order.status !== 'searching') {
    await q(`update offers set status=$2, responded_at=now() where id=$1`, [off.id, action === 'decline' ? 'declined' : 'lost']);
    await maybeNextRound(order.id);
    return { status: action === 'decline' ? 'declined' : 'lost' };
  }
  for (const i of take) await q(`update store_products set confidence = least(1, confidence + 0.05), available = true, updated_at = now() where store_id=$1 and product_id=$2`, [storeId, i.product_id]);
  const c = await cfg();
  const store = await one('select * from stores where id=$1', [storeId]);
  const pct = store.commission_pct != null ? Number(store.commission_pct) : c.commission_pct;
  const items = take.map(i => ({ ...i, customer_price: Math.min(i.price, i.quote_price ?? i.price), status: 'ok' }));
  const subtotal = round2(items.reduce((a, i) => a + i.price * i.qty, 0));
  const part = await one(`insert into order_parts (order_id, store_id, items, subtotal, commission) values ($1,$2,$3,$4,$5) returning *`, [order.id, storeId, JSON.stringify(items), subtotal, round2(subtotal * pct / 100)]);
  await q(`update offers set status=$2, responded_at=now() where id=$1`, [off.id, missing.size ? 'partial' : 'accepted']);
  await q('update stores set accepted_n = accepted_n + 1 where id=$1', [storeId]);
  // the round is decided: others lose this round, remaining items go to the next round
  const others = await q(`update offers set status='lost', responded_at=now() where order_id=$1 and status='pending' returning store_id, id`, [order.id]);
  for (const o of others) emit('store:' + o.store_id, { type: 'offer_closed', offer_id: o.id });
  emit('store:' + storeId, { type: 'part', part });
  notify(order, 'بدأنا نجهّز طلبك');
  const left = await unassigned(await one('select * from orders where id=$1', [order.id]));
  if (left.length) await nextRound(order.id); else await finishAssignment(order.id);
  return { status: 'accepted', part };
}

async function expireOffer(off) {
  const r = await one(`update offers set status='expired', responded_at=now() where id=$1 and status='pending' returning *`, [off.id]);
  if (!r) return;
  for (const i of off.items) await q(`update store_products set confidence = greatest(0, confidence - 0.03) where store_id=$1 and product_id=$2`, [off.store_id, i.product_id]);
  emit('store:' + off.store_id, { type: 'offer_closed', offer_id: off.id });
}

async function maybeNextRound(orderId) {
  const p = await one(`select count(*)::int n from offers where order_id=$1 and status='pending'`, [orderId]);
  if (!p.n) await nextRound(orderId);
}

// no more stores to ask: whatever is still unassigned is removed and refunded
async function finishAssignment(orderId) {
  const order = await one('select * from orders where id=$1', [orderId]);
  if (!order || order.status !== 'searching') return;
  const left = await unassigned(order);
  const parts = await q(`select * from order_parts where order_id=$1 and status <> 'cancelled'`, [orderId]);
  if (!parts.length) {
    const o = await one(`update orders set status='cancelled', cancelled_at=now(), cancel_reason='no_store' where id=$1 returning *`, [orderId]);
    await settleRefunds(orderId, 'طلبك مو متوفر الحين');
    notify(o, 'نعتذر منك، أغراضك مو متوفرة في جارك الحين. رجعنا لك كامل المبلغ.');
    adminPing(o); return;
  }
  const o = await one(`update orders set status='preparing', assigned_at=now(), customer_prompt=$2 where id=$1 returning *`, [orderId, left.length ? JSON.stringify({ missing: left.map(i => i.name_ar) }) : null]);
  await settleRefunds(orderId, left.length ? 'منتجات ما توفرت: ' + left.map(i => i.name_ar).join('، ') : 'فرق السعر لصالحك');
  notify(o, 'طلبك يتجهّز الحين، ويجيك في مشوار واحد');
  adminPing(o);
  await dispatchDriver(orderId);
}

// ---------------- drivers ----------------
export async function dispatchDriver(orderId) {
  const c = await cfg();
  const order = await one('select * from orders where id=$1', [orderId]);
  if (!order || !['preparing', 'ready'].includes(order.status) || order.driver_id) return;
  if (order.join_of && await attachToTrip(order)) return;
  const parts = await q(`select p.*, s.lat, s.lng, s.self_delivery, s.name from order_parts p join stores s on s.id=p.store_id where p.order_id=$1 and p.status <> 'cancelled'`, [orderId]);
  if (parts.length === 1 && parts[0].self_delivery) { await q(`update orders set driver_pay=0 where id=$1`, [orderId]); return; }
  const pend = await one(`select count(*)::int n from driver_offers where order_id=$1 and status='pending'`, [orderId]);
  if (pend.n) return;
  const tried = new Set((await q(`select driver_id from driver_offers where order_id=$1 and status='declined' and created_at > now() - interval '3 minutes'`, [orderId])).map(r => r.driver_id));
  const slowD = new Set((await q(`select driver_id from driver_offers where order_id=$1 and status='expired'`, [orderId])).map(r => r.driver_id));
  const busy = new Set((await q(`select driver_id from orders where driver_id is not null and status in ('preparing','ready','delivering')`)).map(r => r.driver_id));
  const drivers = (await q(`select * from drivers where online and seen_at > now() - interval '3 minutes'`))
    .filter(d => !tried.has(d.id) && d.lat != null)
    .map(d => ({ ...d, dist: distM(d.lat, d.lng, parts[0].lat, parts[0].lng), busy: busy.has(d.id) }))
    .filter(d => d.dist <= 6000).sort((a, b) => (a.busy - b.busy) || (slowD.has(a.id) - slowD.has(b.id)) || (a.dist - b.dist)).slice(0, 3);
  if (!drivers.length) { emit('admin', { type: 'no_driver', id: orderId }); return; }
  const pay = round2(c.driver_pay + c.driver_pay_extra_pickup * (parts.length - 1));
  for (const d of drivers) {
    const off = await one(`insert into driver_offers (order_id, driver_id, pay, expires_at) values ($1,$2,$3, now() + ($4 || ' seconds')::interval) returning *`, [orderId, d.id, pay, String(c.driver_offer_seconds)]);
    emit('driver:' + d.id, { type: 'offer', offer: off });
  }
  later(c.driver_offer_seconds * 1000 + 300, () => sweep());
}

export async function respondDriver(driverId, offerId, accept) {
  const off = await one(`select * from driver_offers where id=$1 and driver_id=$2`, [offerId, driverId]);
  if (!off) throw Object.assign(new Error('العرض غير موجود'), { status: 404 });
  if (off.status !== 'pending' || new Date(off.expires_at) < new Date()) return { status: 'expired' };
  if (!accept) { await q(`update driver_offers set status='declined' where id=$1`, [offerId]); await dispatchDriverIfIdle(off.order_id); return { status: 'declined' }; }
  const o = await one(`update orders set driver_id=$2, driver_pay=$3 where id=$1 and driver_id is null and status in ('preparing','ready') returning *`, [off.order_id, driverId, off.pay]);
  if (!o) { await q(`update driver_offers set status='lost' where id=$1`, [offerId]); return { status: 'lost' }; }
  await q(`update driver_offers set status='accepted' where id=$1`, [offerId]);
  const others = await q(`update driver_offers set status='lost' where order_id=$1 and status='pending' returning driver_id, id`, [off.order_id]);
  for (const x of others) emit('driver:' + x.driver_id, { type: 'offer_closed', offer_id: x.id });
  const d = await one('select name from drivers where id=$1', [driverId]);
  notify(o, `المندوب ${d.name} بيستلم طلبك`);
  return { status: 'accepted', order: o };
}
async function dispatchDriverIfIdle(orderId) {
  const p = await one(`select count(*)::int n from driver_offers where order_id=$1 and status='pending'`, [orderId]);
  if (!p.n) await dispatchDriver(orderId);
}

// ---------------- the sweeper: expiries and retries ----------------
export async function sweep() {
  const c = await cfg();
  const expired = await q(`select * from offers where status='pending' and expires_at < now()`);
  for (const off of expired) await expireOffer(off);
  const searching = await q(`select id from orders where status='searching'`);
  for (const o of searching) await maybeNextRound(o.id);
  await q(`update driver_offers set status='expired' where status='pending' and expires_at < now()`);
  const needDriver = await q(`select id from orders where status in ('preparing','ready') and driver_id is null`);
  for (const o of needDriver) await dispatchDriverIfIdle(o.id);
  // substitutions nobody answered = rejected (item removed, money back)
  const subs = await q(`select id from substitutions where status='pending' and expires_at < now()`);
  if (subs.length) { const { answerSubstitution } = await import('./orders.js'); for (const s of subs) await answerSubstitution(null, s.id, false, true); }
}
export function clearTimers() { for (const t of timers) clearTimeout(t); timers.clear(); }
