// دورة حياة الطلب كاملة
import { q, one } from './db.js';
import { cfg } from './config.js';
import { emit } from './events.js';
import { quote } from './catalog.js';
import { startDispatch, dispatchDriver } from './dispatch.js';
import { settleRefunds } from './money.js';
import { createCheckout, verifyInvoice, paymentMode, onlineEnabled } from './payments.js';
import { tripFor, myTabs, chargeTab } from './hood.js';
import { round2, money, code4, bad, HttpError } from './util.js';

const notify = (id, text, extra = {}) => emit('order:' + id, { type: 'update', text, ...extra });

// ---------- create + pay ----------
export async function createOrder(customer, body, baseUrl) {
  const c = await cfg();
  const addr = await one('select * from addresses where id=$1 and customer_id=$2', [body.address_id, customer.id]);
  if (!addr) throw bad('اختر عنوان التوصيل');
  const ids = (body.items || []).map(i => i.product_id).filter(Boolean);
  if (!ids.length) throw bad('السلة فاضية');
  const prods = await q('select * from products where id = any($1) and active', [ids]);
  const items = (body.items || []).map(i => { const p = prods.find(x => x.id === i.product_id); const qty = Math.min(99, Math.max(1, Math.round(Number(i.qty) || 1))); return p ? { product_id: p.id, name_ar: p.name_ar, size: p.size, unit: p.unit, icon: p.icon, image: p.image, qty } : null; }).filter(Boolean);
  // وين يروح الطلب: مشوار جيران، أو الدفتر عند بقالتك، أو بقالتك أول وبعدها الأقرب
  let prefer = customer.home_store_id || null, exclusive = false, fee = null, joinOf = null;
  if (body.join) { const t = await tripFor(customer.id, addr.lat, addr.lng, body.join); prefer = t.store_id; exclusive = true; fee = t.fee; joinOf = t.id; }
  let tab = null;
  if (body.payment === 'tab') {
    tab = (await myTabs(customer.id)).find(t => t.status === 'open' && t.store_id === prefer);
    if (!tab) throw bad('دفتر جارك مو مفتوح لك للحين');
    exclusive = true;
  }
  const qt = await quote(addr.lat, addr.lng, items, { prefer, exclusive, fee });
  if (!qt.items.length) throw bad('هالأغراض مو متوفرة في جارك الحين');
  const minOrder = joinOf ? Number(c.join_min_order) : c.min_order;
  if (qt.subtotal < minOrder) throw bad(`أقل طلب ${minOrder} ريال`);
  if (body.expected_total != null && Math.abs(Number(body.expected_total) - qt.total) > 0.01) throw Object.assign(new HttpError(409, 'تغيّرت الأسعار، راجع السلة'), { quote: qt });
  let discount = 0, promo = null;
  if (body.promo) {
    const p = await one('select * from promos where code=$1 and active', [String(body.promo).trim().toUpperCase()]);
    if (!p) throw bad('الكود غير صحيح');
    const used = await one('select 1 from promo_uses where code=$1 and customer_id=$2', [p.code, customer.id]);
    const prev = await one(`select count(*)::int n from orders where customer_id=$1 and status='delivered'`, [customer.id]);
    if (used || (p.first_order_only && prev.n)) throw bad('الكود لأول طلب بس');
    discount = Math.min(Number(p.amount), qt.subtotal); promo = p.code;
  }
  const total = round2(qt.total - discount);
  const method = body.payment === 'cod' ? 'cod' : body.payment === 'tab' ? 'tab' : 'online';
  if (tab && tab.balance + total > tab.credit_limit + 0.001) throw bad(`باقي لك في الدفتر ${round2(tab.credit_limit - tab.balance)} ريال بس`);
  if (method === 'cod' && !Number(c.cod_enabled)) throw bad('الدفع عند الاستلام مقفل حالياً');
  if (method === 'cod' && total > Number(c.cod_max)) throw bad(`الدفع عند الاستلام لحد ${c.cod_max} ريال، ادفع إلكتروني أو قلل الطلب`);
  if (method === 'online' && !onlineEnabled()) throw bad('الدفع الإلكتروني مو متاح الحين، اختر الدفع عند الاستلام');
  const o = await one(`insert into orders (customer_id, lat, lng, address_details, items, quote_subtotal, delivery_fee, discount, quote_total, promo_code, source, transcript, note, delivery_code)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
    [customer.id, addr.lat, addr.lng, addr.details, JSON.stringify(qt.items.map(({ store_id, ...i }) => i)), qt.subtotal, qt.delivery_fee, discount, total, promo, body.source === 'voice' ? 'voice' : body.source === 'repeat' ? 'repeat' : 'app', body.transcript || null, (body.note || '').slice(0, 300) || null, code4()]);
  if (promo) await q('insert into promo_uses (code, customer_id, order_id) values ($1,$2,$3) on conflict do nothing', [promo, customer.id, o.id]);
  await q('update orders set prefer_store_id=$2, exclusive=$3, join_of=$4 where id=$1', [o.id, prefer, exclusive, joinOf]);
  if (method === 'cod' || method === 'tab') {
    await q(`update orders set payment_method=$2 where id=$1`, [o.id, method]);
    await markPaid(o.id, total, method);
    return { order: await one('select * from orders where id=$1', [o.id]), payment: { mode: 'cod' }, unavailable: qt.unavailable };
  }
  const pay = await createCheckout(o, baseUrl);
  if (pay.ref) await q('update orders set payment_ref=$2 where id=$1', [o.id, pay.ref]);
  return { order: o, payment: pay, unavailable: qt.unavailable };
}

export async function markPaid(orderId, amount, ref) {
  const o = await one(`update orders set payment_status='paid', paid_amount=$2, paid_at=now(), payment_ref=coalesce($3, payment_ref) where id=$1 and payment_status='pending' returning *`, [orderId, amount, ref || null]);
  if (!o) return null;
  await q(`insert into ledger (kind, order_id, amount) values ('customer_payment', $1, $2)`, [orderId, amount]);
  await startDispatch(orderId);
  return o;
}

export async function payTest(customer, orderId) {
  if (paymentMode() !== 'test') throw bad('الدفع التجريبي مقفل');
  const o = await one('select * from orders where id=$1 and customer_id=$2', [orderId, customer.id]);
  if (!o) throw new HttpError(404, 'الطلب غير موجود');
  return markPaid(o.id, Number(o.quote_total), 'test-' + o.id.slice(0, 8));
}

export async function moyasarWebhook(body) {
  if (!process.env.MOYASAR_WEBHOOK_SECRET || body.secret_token !== process.env.MOYASAR_WEBHOOK_SECRET) throw new HttpError(401, 'bad secret');
  const invoiceId = body.data && (body.data.invoice_id || body.data.id);
  if (!invoiceId) return;
  const inv = await verifyInvoice(invoiceId);
  if (inv.status !== 'paid' || !inv.orderId) return;
  const o = await one('select * from orders where id=$1', [inv.orderId]);
  if (!o || Math.abs(inv.amount - Number(o.quote_total)) > 0.01) { console.error('[moyasar] amount mismatch', inv, o && o.quote_total); return; }
  await markPaid(o.id, inv.amount, invoiceId);
}

// customer cancels before any store accepted
export async function cancelByCustomer(customer, orderId) {
  const o = await one('select * from orders where id=$1 and customer_id=$2', [orderId, customer.id]);
  if (!o) throw new HttpError(404, 'الطلب غير موجود');
  const parts = await one(`select count(*)::int n from order_parts where order_id=$1`, [orderId]);
  if (parts.n || !['pending_payment', 'searching'].includes(o.status)) throw bad('بدأنا نجهّز طلبك، ما نقدر نلغيه الحين');
  await q(`update offers set status='lost' where order_id=$1 and status='pending'`, [orderId]);
  const x = await one(`update orders set status='cancelled', cancelled_at=now(), cancel_reason='customer' where id=$1 returning *`, [orderId]);
  await settleRefunds(orderId, 'إلغاء الطلب');
  notify(orderId, 'ألغينا طلبك');
  return x;
}

// ---------- store side ----------
async function myPart(store, partId) {
  const p = await one('select * from order_parts where id=$1 and store_id=$2', [partId, store.id]);
  if (!p) throw new HttpError(404, 'الطلب غير موجود');
  return p;
}
async function savePartItems(p, items) {
  const c = await cfg();
  const store = await one('select commission_pct from stores where id=$1', [p.store_id]);
  const pct = store.commission_pct != null ? Number(store.commission_pct) : c.commission_pct;
  const subtotal = round2(items.reduce((a, i) => a + (i.status === 'ok' ? i.price * i.qty : i.status === 'sub' ? i.sub.price * i.qty : 0), 0));
  return one('update order_parts set items=$2, subtotal=$3, commission=$4 where id=$1 returning *', [p.id, JSON.stringify(items), subtotal, round2(subtotal * pct / 100)]);
}

// item turned out to be out of stock while picking
export async function storeItemMissing(store, partId, index) {
  const p = await myPart(store, partId);
  if (p.status !== 'preparing') throw bad('الطلب ما عاد قيد التجهيز');
  const items = p.items; const it = items[index];
  if (!it || it.status !== 'ok') throw bad('المنتج غير موجود');
  it.status = 'removed';
  await savePartItems(p, items);
  await q(`update store_products set available=false, confidence=0.1 where store_id=$1 and product_id=$2`, [store.id, it.product_id]);
  await settleRefunds(p.order_id, `${it.name_ar} خلص`);
  await checkEmptyOrder(p.order_id);
  return { ok: true };
}

export async function proposeSubstitution(store, partId, index, productId) {
  const c = await cfg();
  const p = await myPart(store, partId);
  if (p.status !== 'preparing') throw bad('الطلب ما عاد قيد التجهيز');
  const it = p.items[index];
  if (!it || it.status !== 'ok') throw bad('المنتج غير موجود');
  const sp = await one(`select sp.price, pr.name_ar, pr.size from store_products sp join products pr on pr.id=sp.product_id where sp.store_id=$1 and sp.product_id=$2 and sp.available`, [store.id, productId]);
  if (!sp) throw bad('البديل مو موجود في منتجاتك');
  const pend = await one(`select 1 from substitutions where part_id=$1 and item_index=$2 and status='pending'`, [partId, index]);
  if (pend) throw bad('فيه بديل ينتظر رد العميل');
  const s = await one(`insert into substitutions (order_id, part_id, item_index, product_id, name_ar, price, expires_at) values ($1,$2,$3,$4,$5,$6, now() + ($7 || ' seconds')::interval) returning *`,
    [p.order_id, partId, index, productId, sp.name_ar + (sp.size ? ' ' + sp.size : ''), sp.price, String(c.substitution_seconds)]);
  const customerPrice = Math.min(Number(sp.price), it.customer_price);
  emit('order:' + p.order_id, { type: 'substitution', sub: { id: s.id, original: it.name_ar, name: s.name_ar, qty: it.qty, price: customerPrice, original_price: it.customer_price, expires_at: s.expires_at } });
  return s;
}

// customer (or timeout) answers a substitution
export async function answerSubstitution(customer, subId, approve, byTimeout = false) {
  const s = await one('select * from substitutions where id=$1', [subId]);
  if (!s) throw new HttpError(404, 'غير موجود');
  if (customer) { const o = await one('select customer_id from orders where id=$1', [s.order_id]); if (o.customer_id !== customer.id) throw new HttpError(404, 'غير موجود'); }
  const upd = await one(`update substitutions set status=$2 where id=$1 and status='pending' returning *`, [subId, byTimeout ? 'expired' : approve ? 'approved' : 'rejected']);
  if (!upd) return { status: s.status };
  const p = await one('select * from order_parts where id=$1', [s.part_id]);
  const items = p.items, it = items[s.item_index];
  if (approve && !byTimeout) { it.status = 'sub'; it.sub = { product_id: s.product_id, name_ar: s.name_ar, price: Number(s.price), customer_price: Math.min(Number(s.price), it.customer_price) }; }
  else it.status = 'removed';
  await savePartItems(p, items);
  emit('store:' + p.store_id, { type: 'sub_answer', part_id: p.id, index: s.item_index, approved: approve && !byTimeout });
  await settleRefunds(s.order_id, approve && !byTimeout ? 'البديل أرخص' : `شلنا ${it.name_ar}`);
  await checkEmptyOrder(s.order_id);
  return { status: upd.status };
}

async function checkEmptyOrder(orderId) {
  const parts = await q(`select * from order_parts where order_id=$1 and status <> 'cancelled'`, [orderId]);
  for (const p of parts) if (p.items.every(i => i.status === 'removed')) await q(`update order_parts set status='cancelled' where id=$1`, [p.id]);
  const alive = await one(`select count(*)::int n from order_parts where order_id=$1 and status <> 'cancelled'`, [orderId]);
  if (!alive.n) {
    await one(`update orders set status='cancelled', cancelled_at=now(), cancel_reason='all_missing' where id=$1 and status not in ('delivered','cancelled') returning id`, [orderId]);
    await settleRefunds(orderId, 'كل المنتجات خلصت');
    notify(orderId, 'نعتذر منك، المنتجات خلصت. رجعنا لك كامل المبلغ.');
  } else await refreshOrderStatus(orderId);
}

export async function storePartReady(store, partId) {
  const p = await myPart(store, partId);
  if (p.status !== 'preparing') throw bad('الطلب مو قيد التجهيز');
  const pend = await one(`select 1 from substitutions where part_id=$1 and status='pending'`, [partId]);
  if (pend) throw bad('فيه بديل ينتظر رد العميل');
  await q(`update order_parts set status='ready', ready_at=now() where id=$1`, [partId]);
  await refreshOrderStatus(p.order_id);
  return { ok: true };
}

async function refreshOrderStatus(orderId) {
  const o = await one('select * from orders where id=$1', [orderId]);
  if (!['preparing', 'ready'].includes(o.status)) return;
  const parts = await q(`select * from order_parts where order_id=$1 and status <> 'cancelled'`, [orderId]);
  if (parts.length && parts.every(p => ['ready', 'picked'].includes(p.status)) && o.status === 'preparing') {
    await q(`update orders set status='ready', ready_at=now() where id=$1`, [orderId]);
    notify(orderId, o.driver_id ? 'طلبك جاهز، والمندوب بيستلمه الحين' : 'طلبك جاهز');
    if (o.driver_id) emit('driver:' + o.driver_id, { type: 'job' });
  }
}

// store delivers by itself (self_delivery stores, single part)
export async function storeSelfDeliver(store, partId, action, code) {
  const p = await myPart(store, partId);
  const o = await one('select * from orders where id=$1', [p.order_id]);
  if (o.driver_id) throw bad('هالطلب مع مندوب');
  if (action === 'out') {
    if (p.status !== 'ready') throw bad('جهّز الطلب أول');
    await q(`update order_parts set status='picked', picked_at=now() where id=$1`, [p.id]);
    await q(`update orders set status='delivering', picked_at=now() where id=$1`, [o.id]);
    notify(o.id, 'طلبك طلع لك 🛵'); return { ok: true };
  }
  if (action === 'delivered') return deliver(o, code);
  throw bad('إجراء غير معروف');
}

// ---------- driver side ----------
export async function driverPickup(driver, partId) {
  const p = await one('select p.*, o.driver_id from order_parts p join orders o on o.id=p.order_id where p.id=$1', [partId]);
  if (!p || p.driver_id !== driver.id) throw new HttpError(404, 'غير موجود');
  if (p.status !== 'ready') throw bad('البقالة لسه ما جهّزت');
  await q(`update order_parts set status='picked', picked_at=now() where id=$1`, [partId]);
  const rest = await one(`select count(*)::int n from order_parts where order_id=$1 and status not in ('picked','cancelled')`, [p.order_id]);
  if (!rest.n) { await q(`update orders set status='delivering', picked_at=now() where id=$1`, [p.order_id]); notify(p.order_id, 'المندوب استلم طلبك وهو في الطريق لك 🛵'); }
  return { ok: true, all_picked: !rest.n };
}
export async function driverDeliver(driver, orderId, code) {
  const o = await one('select * from orders where id=$1 and driver_id=$2', [orderId, driver.id]);
  if (!o) throw new HttpError(404, 'غير موجود');
  return deliver(o, code);
}

async function deliver(o, code) {
  const c = await cfg();
  if (o.status !== 'delivering') throw bad('الطلب ما طلع للتوصيل');
  if (String(code || '').trim() !== o.delivery_code) throw bad('رمز التسليم غلط. اطلبه من العميل');
  const late = (Date.now() - new Date(o.paid_at).getTime()) / 60000 > c.late_minutes;
  if (late && Number(o.delivery_fee) > 0) await q('update orders set delivery_fee=0 where id=$1', [o.id]);
  await q(`update orders set status='delivered', delivered_at=now() where id=$1`, [o.id]);
  if (late) await settleRefunds(o.id, 'تأخرنا عليك، رجعنا رسوم التوصيل');
  // the books
  const parts = await q(`select * from order_parts where order_id=$1 and status <> 'cancelled'`, [o.id]);
  let gap = 0;
  for (const p of parts) {
    await q(`insert into ledger (kind, order_id, store_id, amount) values ('store_earning', $1, $2, $3), ('commission', $1, $2, $4)`, [o.id, p.store_id, round2(p.subtotal - p.commission), p.commission]);
    for (const it of p.items) { if (it.status === 'ok') gap += (it.price - it.customer_price) * it.qty; if (it.status === 'sub') gap += (it.sub.price - it.sub.customer_price) * it.qty; }
  }
  const fresh = await one('select * from orders where id=$1', [o.id]);
  if (Number(fresh.delivery_fee) > 0) await q(`insert into ledger (kind, order_id, amount) values ('delivery_fee', $1, $2)`, [o.id, fresh.delivery_fee]);
  if (fresh.driver_id) await q(`insert into ledger (kind, order_id, driver_id, amount) values ('driver_pay', $1, $2, $3)`, [o.id, fresh.driver_id, fresh.driver_pay]);
  if (fresh.payment_method === 'cod') {
    const collect = round2(Number(fresh.paid_amount) - Number(fresh.refunded_amount));
    // المندوب استلم المبلغ من العميل، فهو عليه لجارك وينخصم من مستحقاته
    if (collect > 0) await q(`insert into ledger (kind, order_id, driver_id, amount, note) values ('driver_cash', $1, $2, $3, 'حصّله من العميل عند الاستلام')`, [o.id, fresh.driver_id || null, -collect]);
  }
  await chargeTab(fresh);
  // البقالة اللي خدمته تصير «بقالته» من ورا الكواليس: طلباته الجاية تروح لها أول
  if (parts[0]) await q('update customers set home_store_id = coalesce(home_store_id, $2) where id=$1', [fresh.customer_id, parts[0].store_id]);
  if (gap > 0.009) await q(`insert into ledger (kind, order_id, amount, note) values ('price_gap', $1, $2, 'نتحمل فرق السعر عن العميل')`, [o.id, -round2(gap)]);
  if (Number(fresh.discount) > 0) await q(`insert into ledger (kind, order_id, amount, note) values ('promo', $1, $2, $3)`, [o.id, -fresh.discount, fresh.promo_code]);
  notify(o.id, 'وصل طلبك ✅ بالعافية!', { delivered: true });
  emit('admin', { type: 'order', id: o.id, status: 'delivered' });
  return { ok: true, late };
}

// ---------- after delivery ----------
export async function rate(customer, orderId, storeStars, driverStars, note) {
  const o = await one(`select * from orders where id=$1 and customer_id=$2 and status='delivered'`, [orderId, customer.id]);
  if (!o) throw bad('قيّم بعد ما يوصلك الطلب');
  if (o.rating_store) throw bad('قيّمت هالطلب قبل');
  const s = Math.max(1, Math.min(5, Math.round(storeStars || 5))), d = driverStars ? Math.max(1, Math.min(5, Math.round(driverStars))) : null;
  await q('update orders set rating_store=$2, rating_driver=$3, rating_note=$4 where id=$1', [orderId, s, d, (note || '').slice(0, 300) || null]);
  const parts = await q(`select store_id from order_parts where order_id=$1 and status <> 'cancelled'`, [orderId]);
  for (const p of parts) await q('update stores set rating_sum = rating_sum + $2, rating_n = rating_n + 1 where id=$1', [p.store_id, s]);
  if (d && o.driver_id) await q('update drivers set rating_sum = rating_sum + $2, rating_n = rating_n + 1 where id=$1', [o.driver_id, d]);
  return { ok: true };
}

// damaged / expired / wrong item: refunded on the spot, charged to the store
export async function complain(customer, orderId, partId, index, kind, note, photo) {
  const c = await cfg();
  const o = await one(`select * from orders where id=$1 and customer_id=$2 and status='delivered'`, [orderId, customer.id]);
  if (!o) throw bad('الشكوى تكون بعد التوصيل');
  if ((Date.now() - new Date(o.delivered_at).getTime()) / 3600000 > c.complaint_hours) throw bad(`الشكوى خلال ${c.complaint_hours} ساعة من التوصيل`);
  const p = await one('select * from order_parts where id=$1 and order_id=$2', [partId, orderId]);
  if (!p) throw bad('اختر المنتج');
  const items = p.items, it = items[index];
  if (!it || !['ok', 'sub'].includes(it.status)) throw bad('هالمنتج مسترجع قبل');
  if (!['damaged', 'expired', 'wrong', 'missing'].includes(kind)) throw bad('اختر نوع المشكلة');
  if (!photo && kind !== 'missing') throw bad('أرفق صورة للمنتج');
  const amount = round2((it.status === 'sub' ? it.sub.customer_price : it.customer_price) * it.qty);
  const storeCost = round2((it.status === 'sub' ? it.sub.price : it.price) * it.qty);
  it.status_before = it.status; it.status = 'complaint';
  await q('update order_parts set items=$2 where id=$1', [p.id, JSON.stringify(items)]);
  await q(`insert into complaints (order_id, part_id, item_product_id, kind, note, photo, refund) values ($1,$2,$3,$4,$5,$6,$7)`, [orderId, p.id, it.product_id, kind, (note || '').slice(0, 300), photo ? String(photo).slice(0, 1_500_000) : null, amount]);
  await q(`insert into ledger (kind, order_id, store_id, amount, note) values ('store_penalty', $1, $2, $3, $4)`, [orderId, p.store_id, -storeCost, kind]);
  await settleRefunds(orderId, 'شكوى: ' + it.name_ar);
  return { refunded: amount };
}

// ---------- settlements ----------
export async function createSettlements() {
  const out = [];
  const stores = await q(`select store_id, sum(amount)::float total from ledger where settled=false and store_id is not null and kind in ('store_earning','store_penalty','tab_offset') group by store_id`);
  for (const r of stores) {
    if (r.total <= 0) continue;
    const s = await one(`insert into settlements (party, party_id, amount) values ('store', $1, $2) returning *`, [r.store_id, round2(r.total)]);
    await q(`update ledger set settled=true, settlement_id=$2 where settled=false and store_id=$1 and kind in ('store_earning','store_penalty','tab_offset')`, [r.store_id, s.id]);
    out.push(s);
  }
  const drivers = await q(`select driver_id, sum(amount)::float total from ledger where settled=false and driver_id is not null and kind in ('driver_pay','driver_cash') group by driver_id`);
  for (const r of drivers) {
    const s = await one(`insert into settlements (party, party_id, amount) values ('driver', $1, $2) returning *`, [r.driver_id, round2(r.total)]);
    await q(`update ledger set settled=true, settlement_id=$2 where settled=false and driver_id=$1 and kind in ('driver_pay','driver_cash')`, [r.driver_id, s.id]);
    out.push(s);
  }
  return out;
}
